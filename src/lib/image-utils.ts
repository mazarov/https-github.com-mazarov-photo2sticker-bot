import sharp from "sharp";
import * as path from "path";

// Path to bundled font file (copied to dist/assets/ during Docker build)
const FONT_PATH = path.join(__dirname, "..", "assets", "Inter-Bold.otf");

/**
 * Morphological dilation of alpha channel.
 * Expands non-transparent pixels outward by `radius` pixels (circular kernel).
 */
function dilateAlpha(alpha: Buffer, w: number, h: number, radius: number): Buffer {
  const out = Buffer.alloc(w * h);
  const r2 = radius * radius;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let maxVal = 0;
      // Scan bounding box, check circular distance
      const yMin = Math.max(0, y - radius);
      const yMax = Math.min(h - 1, y + radius);
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(w - 1, x + radius);

      for (let ny = yMin; ny <= yMax; ny++) {
        const dy = ny - y;
        const dy2 = dy * dy;
        for (let nx = xMin; nx <= xMax; nx++) {
          const dx = nx - x;
          if (dx * dx + dy2 <= r2) {
            const val = alpha[ny * w + nx];
            if (val > maxVal) {
              maxVal = val;
              if (maxVal === 255) break; // Early exit — can't get higher
            }
          }
        }
        if (maxVal === 255) break;
      }
      out[y * w + x] = maxVal;
    }
  }
  return out;
}

/**
 * Add a white border/outline around the sticker by dilating the alpha channel.
 * The border is white (#FFFFFF), `borderWidth` pixels thick.
 * Returns a 512x512 WebP buffer ready for Telegram.
 *
 * Algorithm:
 * 1. Decode image to raw RGBA
 * 2. Extract alpha channel
 * 3. Dilate alpha (expand outward by borderWidth)
 * 4. Create white layer where dilated alpha > 0
 * 5. Composite: white border (bottom) + original (top)
 * 6. Resize to 512x512 + convert to WebP
 */
/**
 * Escape XML special characters for safe SVG embedding.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escape pango markup special characters.
 */
function escapePango(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Add text badge overlay to a sticker.
 * Renders a white rounded badge (SVG rect) with black text (Sharp text API + fontfile).
 * This approach bypasses librsvg text rendering entirely — uses pango with explicit font.
 * Returns a 512x512 WebP buffer ready for Telegram.
 *
 * @param inputBuffer - WebP/PNG sticker buffer
 * @param text - Text to overlay (truncated to 30 chars)
 * @param position - "top" or "bottom" (default: "bottom")
 */
export async function addTextToSticker(
  inputBuffer: Buffer,
  text: string,
  position: "top" | "bottom" = "bottom"
): Promise<Buffer> {
  // Truncate long text
  let displayText = text.trim();
  if (displayText.length > 30) {
    displayText = displayText.substring(0, 27) + "...";
  }

  // Auto-scale font size based on text length (pango uses points, roughly 1.33x pixels)
  let fontSizePt: number;
  if (displayText.length <= 8) {
    fontSizePt = 28;
  } else if (displayText.length <= 15) {
    fontSizePt = 22;
  } else if (displayText.length <= 22) {
    fontSizePt = 18;
  } else {
    fontSizePt = 15;
  }

  const STRIP_H = 52;
  const MARGIN = 8;

  // Step 1: Render text to PNG using Sharp's text API with explicit fontfile
  // This uses pango directly — NOT librsvg — so it works with the bundled font
  let textPng: Buffer;
  try {
    textPng = await (sharp as any)({
      text: {
        text: `<span foreground="#1a1a1a" font="${fontSizePt}">${escapePango(displayText)}</span>`,
        fontfile: FONT_PATH,
        font: "Inter Bold",
        rgba: true,
        width: 480,
        height: STRIP_H,
        align: "centre",
      },
    }).ensureAlpha().png().toBuffer();
    console.log("addTextToSticker: text rendered via Sharp text API, size:", textPng.length);
  } catch (err: any) {
    console.error("addTextToSticker: Sharp text API failed:", err.message);
    // If text API not available, return sticker with badge only (no text)
    textPng = Buffer.alloc(0);
  }

  // Get text image dimensions to calculate badge width
  let textMeta = { width: 200, height: 40 };
  if (textPng.length > 0) {
    const meta = await sharp(textPng).metadata();
    textMeta = { width: meta.width || 200, height: meta.height || 40 };
  }

  // Calculate badge dimensions — adapts to text width
  const PADDING = 24;
  const rectWidth = Math.min(500, Math.max(80, textMeta.width + PADDING * 2));
  const rectX = (512 - rectWidth) / 2;
  const yRect = position === "bottom" ? 512 - STRIP_H - MARGIN : MARGIN;

  // Step 2: Create badge (white rounded rect) as SVG — rect only, NO text in SVG
  const badgeSvg = Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect x="${rectX}" y="${yRect}" width="${rectWidth}" height="${STRIP_H}"
        fill="white" opacity="0.92" rx="14" ry="14"/>
</svg>`);

  // Step 3: Composite all layers: sticker → badge → text
  const layers: sharp.OverlayOptions[] = [
    { input: badgeSvg, blend: "over" },
  ];

  if (textPng.length > 0) {
    // Center text on badge
    const textLeft = Math.round((512 - textMeta.width) / 2);
    const textTop = Math.round(yRect + (STRIP_H - textMeta.height) / 2);
    layers.push({ input: textPng, left: textLeft, top: textTop, blend: "over" });
  }

  console.log("addTextToSticker: text:", displayText, "badgeW:", rectWidth,
    "textW:", textMeta.width, "pos:", position);

  const result = await sharp(inputBuffer)
    .ensureAlpha()
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .composite(layers)
    .webp()
    .toBuffer();

  return result;
}

export async function addWhiteBorder(inputBuffer: Buffer, borderWidth: number = 8): Promise<Buffer> {
  // Decode to raw RGBA
  const image = sharp(inputBuffer).ensureAlpha();
  const metadata = await image.metadata();
  const w = metadata.width!;
  const h = metadata.height!;

  const rawBuffer = await image.raw().toBuffer();

  // Extract alpha channel
  const alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    alpha[i] = rawBuffer[i * 4 + 3];
  }

  // Dilate alpha to create border mask
  const dilated = dilateAlpha(alpha, w, h, borderWidth);

  // Create white border layer (RGBA): white where dilated, transparent elsewhere
  const borderLayer = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (dilated[i] > 0) {
      borderLayer[i * 4] = 255;     // R
      borderLayer[i * 4 + 1] = 255; // G
      borderLayer[i * 4 + 2] = 255; // B
      borderLayer[i * 4 + 3] = dilated[i]; // A (use dilated alpha for smooth edges)
    }
    // else: all zeros (transparent) — already initialized by Buffer.alloc
  }

  // Composite: white border behind original image
  const composited = await sharp(borderLayer, { raw: { width: w, height: h, channels: 4 } })
    .composite([{
      input: rawBuffer,
      raw: { width: w, height: h, channels: 4 },
      blend: "over",
    }])
    .png()
    .toBuffer();

  // Trim, resize to 512x512, convert to WebP
  const result = await sharp(composited)
    .trim({ threshold: 2 })
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp()
    .toBuffer();

  return result;
}
