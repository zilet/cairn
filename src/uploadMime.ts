// Accepted upload types -> file extension. A concrete allowlist keeps SVG and
// other active content out of same-origin inline rendering paths.
export const ACCEPTED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "text/plain": "txt",
  "text/html": "html",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
};

export function extForMime(mime: string): string {
  return ACCEPTED_MIME[(mime || "").toLowerCase()] || "bin";
}

export function isAcceptedMime(mime: string): boolean {
  return !!ACCEPTED_MIME[(mime || "").toLowerCase()];
}

// Only raster images + PDF are ever served inline. zip/html/xml/text and
// anything unknown are attachments so markup-bearing files do not execute.
export function isInlineMime(mime: string): boolean {
  const m = (mime || "").toLowerCase();
  return m === "application/pdf" || (m.startsWith("image/") && isAcceptedMime(m));
}
