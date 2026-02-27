import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import opentype from "opentype.js";

// ============================================================
// Chroma Key — remove leftover green (#00FF00) pixels after rembg
// ============================================================

/**
 * Calculate the ratio of bright green pixels in an image buffer.
 * Used to decide whether chroma key cleanup is needed.
 * Run on the ORIGINAL generated image BEFORE rembg.
 */
export function getGreenPixelRatio(data: Buffer, channels: number): number {
  let greenCount = 0;
  let totalCount = 0;
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    totalCount++;
    if (g > 200 && r < 80 && b < 80) greenCount++;
  }
  return greenCount / totalCount;
}

/**
 * Full chroma key — remove ALL green (#00FF00) pixels from an image.
 * Used when greenRatio is high (>40%) and we skip rembg entirely.
 * Unlike chromaKeyGreen(), this works on ALL pixels (including fully opaque).
 * Edges get anti-aliased transparency based on distance from green.
 */
export async function fullChromaKey(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const targetR = 0, targetG = 255, targetB = 0;
  // Two thresholds: hard (definitely green) and soft (edge anti-aliasing)
  const hardThresholdSq = 90 * 90;   // definitely green → fully transparent
  const softThresholdSq = 160 * 160; // near-green → partial transparency (smooth edges)
  let cleaned = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const distSq = (r - targetR) ** 2 + (g - targetG) ** 2 + (b - targetB) ** 2;

    if (distSq < hardThresholdSq) {
      data[i + 3] = 0; // fully transparent
      cleaned++;
    } else if (distSq < softThresholdSq) {
      // Smooth edge: linearly interpolate alpha based on distance
      const t = (distSq - hardThresholdSq) / (softThresholdSq - hardThresholdSq);
      data[i + 3] = Math.round(t * data[i + 3]);
      cleaned++;
    }
  }

  console.log(`[fullChromaKey] Removed ${cleaned} green pixels out of ${data.length / channels} total`);

  return sharp(Buffer.from(data), { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

/**
 * Remove leftover green (#00FF00) pixels from an image after rembg.
 * Only affects semi-transparent pixels (alpha <= 220) to avoid
 * damaging green elements that are part of the character.
 */
export async function chromaKeyGreen(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const thresholdSq = 80 * 80; // ~80 units in RGB space
  const targetR = 0, targetG = 255, targetB = 0;
  let cleaned = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];

    // Don't touch opaque pixels — they're part of the character
    if (a > 220) continue;

    const distSq = (r - targetR) ** 2 + (g - targetG) ** 2 + (b - targetB) ** 2;
    if (distSq < thresholdSq) {
      data[i + 3] = 0; // make transparent
      cleaned++;
    }
  }

  console.log(`[chromaKey] Cleaned ${cleaned} green pixels out of ${data.length / channels} total`);

  return sharp(Buffer.from(data), { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

/**
 * Remove green fringing from edges after chroma key / rembg.
 * Multi-pass: finds pixels adjacent to transparent areas and removes
 * those with green tint. Each pass exposes new edge pixels for the next.
 */
export async function despillGreenEdges(buffer: Buffer, passes: number = 2): Promise<Buffer> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let totalCleaned = 0;

  for (let pass = 0; pass < passes; pass++) {
    let cleaned = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        const a = data[idx + 3];

        if (a < 10) continue; // already transparent

        // Check if adjacent to transparent pixel (8-connected)
        let nearTransparent = false;
        for (let dy = -1; dy <= 1 && !nearTransparent; dy++) {
          for (let dx = -1; dx <= 1 && !nearTransparent; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
              nearTransparent = true;
              continue;
            }
            if (data[(ny * width + nx) * channels + 3] < 10) {
              nearTransparent = true;
            }
          }
        }

        if (!nearTransparent) continue;

        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const maxRB = Math.max(r, b, 1);

        // Strong green dominance: remove entirely
        if (g > 150 && g > r * 1.5 && g > b * 1.5) {
          data[idx + 3] = 0;
          cleaned++;
        }
        // Moderate green tint: fade out
        else if (g > 100 && g > r * 1.3 && g > b * 1.3) {
          data[idx + 3] = Math.round(a * 0.3);
          cleaned++;
        }
        // Slight green tint on edge: desaturate green channel
        else if (g > 80 && g > maxRB * 1.15) {
          data[idx + 1] = Math.round((r + b) / 2); // replace G with avg of R,B
          cleaned++;
        }
      }
    }

    totalCleaned += cleaned;
    if (cleaned === 0) break; // no more edge pixels to clean
  }

  console.log(`[despill] Cleaned ${totalCleaned} green edge pixels (${passes} passes)`);

  return sharp(Buffer.from(data), { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

// Try multiple paths to find the font file (works both locally and in Docker)
function findFontPath(): string {
  const candidates = [
    path.join(__dirname, "..", "assets", "Inter-Bold.otf"),       // dist/assets/
    path.join(__dirname, "..", "..", "src", "assets", "Inter-Bold.otf"), // src/assets/ from dist/lib/
    path.join(process.cwd(), "src", "assets", "Inter-Bold.otf"), // CWD/src/assets/
    path.join(process.cwd(), "dist", "assets", "Inter-Bold.otf"), // CWD/dist/assets/
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log("Font found at:", p);
      return p;
    }
    console.log("Font not at:", p);
  }
  throw new Error("Inter-Bold.otf not found in any of: " + candidates.join(", "));
}

// Load font once at module init
let cachedFont: opentype.Font | null = null;
function getFont(): opentype.Font {
  if (!cachedFont) {
    const fontPath = findFontPath();
    const buf = fs.readFileSync(fontPath);
    // Node.js Buffer.buffer may contain extra data from memory pool — slice to exact range
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    cachedFont = opentype.parse(ab as ArrayBuffer);
    console.log("opentype.js: font loaded, glyphs:", cachedFont.glyphs.length);
  }
  return cachedFont;
}

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
 * Add text badge overlay to a sticker.
 * Uses opentype.js to convert text → SVG <path> outlines.
 * This completely bypasses pango/fontconfig/librsvg text rendering.
 * librsvg renders <path> elements perfectly — no font system needed.
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
    fontSize = 36;
  } else if (displayText.length <= 15) {
    fontSize = 30;
  } else if (displayText.length <= 22) {
    fontSize = 26;
  } else {
    fontSize = 22;
  }

  const STRIP_H = 52;
  const MARGIN = 8;
  const PADDING = 24;

  // Step 1: Use opentype.js to get text width and render as SVG path
  const font = getFont();
  const textWidthUnits = font.getAdvanceWidth(displayText, fontSize);
  const textWidth = Math.ceil(textWidthUnits);

  // Calculate badge dimensions — width adapts to text length
  const rectWidth = Math.min(500, Math.max(80, textWidth + PADDING * 2));
  const rectX = (512 - rectWidth) / 2;
  const yRect = position === "bottom" ? 512 - STRIP_H - MARGIN : MARGIN;

  // Calculate text position — centered on badge
  const textX = Math.round((512 - textWidth) / 2);
  // opentype y is baseline; place text vertically centered in badge
  const textBaseline = Math.round(yRect + STRIP_H / 2 + fontSize * 0.35);

  // Generate SVG path from text glyphs — this is pure vector, no font rendering needed
  const textPath = font.getPath(displayText, textX, textBaseline, fontSize);
  const pathData = (textPath as any).toSVG(2);  // returns <path d="..." />, precision 2

  // Build full SVG: white rounded badge + text as vector path
  const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect x="${rectX}" y="${yRect}" width="${rectWidth}" height="${STRIP_H}"
        fill="white" opacity="0.92" rx="14" ry="14"/>
  <g fill="#1a1a1a">${pathData}</g>
</svg>`;

  console.log("addTextToSticker: text:", displayText, "fontSize:", fontSize,
    "textW:", textWidth, "badgeW:", rectWidth, "pos:", position,
    "pathLen:", pathData.length);

  // Composite SVG over the sticker
  const result = await sharp(inputBuffer)
    .ensureAlpha()
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .webp()
    .toBuffer();

  return result;
}

/**
 * Fit sticker content into 512x512 with a margin around the edges.
 * Content area = (1 - 2 * marginRatio) of side; e.g. marginRatio 0.1 → 80% for content → 10% free at each edge.
 * Returns 512x512 PNG buffer (transparent background, content centered).
 */
export async function fitStickerIn512WithMargin(
  inputBuffer: Buffer,
  marginRatio: number = 0.1
): Promise<Buffer> {
  const size = 512;
  const contentSize = Math.round(size * (1 - 2 * marginRatio)); // 0.1 → 410
  const padded = await sharp(inputBuffer)
    .ensureAlpha()
    .resize(contentSize, contentSize, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();
  const meta = await sharp(padded).metadata();
  const w = meta.width || contentSize;
  const h = meta.height || contentSize;
  const left = Math.round((size - w) / 2);
  const top = Math.round((size - h) / 2);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: padded, left, top, blend: "over" }])
    .png()
    .toBuffer();
}

/**
 * Assemble N image buffers into a single 1024×1024 grid (WebP).
 * Each image is resized to fit its cell (preserving aspect ratio, centered).
 * @param buffers Up to 9 images (order: row by row)
 * @param cols Number of columns (e.g. 3 for 3×3)
 * @param rows Number of rows (e.g. 3 for 3×3)
 * @returns 1024×1024 WebP buffer
 */
export async function assembleGridTo1024(buffers: Buffer[], cols: number = 3, rows: number = 3): Promise<Buffer> {
  const size = 1024;
  const cellW = Math.floor(size / cols);
  const cellH = Math.floor(size / rows);
  const composites: { input: Buffer; left: number; top: number; blend: "over" }[] = [];

  for (let i = 0; i < buffers.length && i < cols * rows; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const left = col * cellW;
    const top = row * cellH;

    const resized = await sharp(buffers[i])
      .ensureAlpha()
      .resize(cellW, cellH, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();
    const meta = await sharp(resized).metadata();
    const w = meta.width || cellW;
    const h = meta.height || cellH;
    const dx = left + Math.round((cellW - w) / 2);
    const dy = top + Math.round((cellH - h) / 2);

    composites.push({ input: resized, left: dx, top: dy, blend: "over" });
  }

  const base = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  });

  if (composites.length === 0) {
    return base.webp().toBuffer();
  }

  return base
    .composite(composites)
    .webp()
    .toBuffer();
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
