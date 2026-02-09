import sharp from "sharp";

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
 * Add text overlay to a sticker using SVG compositing.
 * Text is rendered with white fill and black stroke for maximum readability.
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

  // Auto-scale font size based on text length
  let fontSize: number;
  if (displayText.length <= 8) {
    fontSize = 64;
  } else if (displayText.length <= 15) {
    fontSize = 52;
  } else if (displayText.length <= 22) {
    fontSize = 42;
  } else {
    fontSize = 34;
  }

  const strokeWidth = Math.max(3, Math.round(fontSize / 12));
  const yPos = position === "top" ? `${fontSize + 10}` : `${512 - 15}`;

  // Build SVG text overlay (512x512 to match sticker dimensions)
  // Using DejaVu Sans Bold — it's installed in the Docker container and supports Cyrillic
  const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <text x="256" y="${yPos}" text-anchor="middle"
    font-family="DejaVu Sans" font-size="${fontSize}" font-weight="bold"
    fill="white" stroke="black" stroke-width="${strokeWidth}"
    stroke-linejoin="round" paint-order="stroke fill">${escapeXml(displayText)}</text>
</svg>`;

  const svgBuffer = Buffer.from(svg);
  console.log("addTextToSticker: SVG length:", svg.length, "text:", displayText, "fontSize:", fontSize, "pos:", yPos);

  // Composite SVG text over the sticker
  const result = await sharp(inputBuffer)
    .ensureAlpha()
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .composite([{ input: svgBuffer, blend: "over" }])
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
