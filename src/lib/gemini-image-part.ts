export function buildInlineImagePart(buffer: Buffer, mimeType: string): {
  inlineData: { mimeType: string; data: string };
} {
  return {
    inlineData: {
      mimeType,
      data: buffer.toString("base64"),
    },
  };
}
