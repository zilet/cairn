// @ts-check
// Chat attachment and native-picker helpers. Kept separate from the Chat screen so
// file/image handling and mobile keyboard settling can be tested as one seam.

type ChatAttachmentImagePayload = { dataUrl: string; base64: string; mime: "image/jpeg"; bytes: number };
type ChatAttachmentImageError = Error & { bytes?: number };
type ChatAttachmentFocusOptions = {
  input: HTMLTextAreaElement;
  fileInput: HTMLInputElement;
  isSoftKeyboard: () => boolean;
};
type ChatAttachmentSettleOptions = {
  isActive: () => boolean;
  measure: () => void;
  graceMs?: number;
};

function chatAttachmentPreviewImage(value: Element | null | undefined): HTMLImageElement | null {
  return value instanceof HTMLImageElement ? value : null;
}

// Downscale + re-encode a picked photo to JPEG before upload: phone camera
// shots are 3-12MB HEIC/JPEG; ~1280px @ q0.82 is plenty for a plate estimate
// (and Safari decodes HEIC natively, so re-encoding also normalizes the type).
// If the first pass still exceeds the server cap, step down deterministically
// instead of letting Express reject the whole JSON body with a generic 413.
async function chatAttachmentCompressImage(file: File): Promise<ChatAttachmentImagePayload> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image"));
      i.src = url;
    });
    let last: ChatAttachmentImagePayload | null = null;
    for (const maxEdge of CairnChatClient.CHAT_IMAGE_EDGE_STEPS) {
      const scale = Math.min(1, Number(maxEdge) / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      for (const quality of CairnChatClient.CHAT_IMAGE_QUALITY_STEPS) {
        last = CairnChatClient.imagePayload(c.toDataURL("image/jpeg", quality));
        if (last.bytes <= CairnChatClient.CHAT_IMAGE_MAX_BYTES) return last;
      }
    }
    const err: ChatAttachmentImageError = new Error("image-too-large");
    err.bytes = last ? last.bytes : 0;
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function chatAttachmentResetFocusAfterNativePicker(options: ChatAttachmentFocusOptions): void {
  if (!options.isSoftKeyboard()) return;
  if (document.activeElement === options.input) options.input.blur();
  if (document.activeElement === options.fileInput) options.fileInput.blur();
  document.body.classList.remove("kb-open");
  document.body.classList.remove("kb-geometry-open");
}

function chatAttachmentSettleAfterNativePicker(options: ChatAttachmentSettleOptions): void {
  document.dispatchEvent(new CustomEvent("cairn:keyboard-settle", { detail: { chatFocusGraceMs: options.graceMs ?? 1200 } }));
  options.measure();
  requestAnimationFrame(() => requestAnimationFrame(options.measure));
  for (const delay of [120, 280, 520, 900]) {
    setTimeout(() => { if (options.isActive()) options.measure(); }, delay);
  }
}

const CAIRN_CHAT_ATTACHMENT = {
  compressImage: chatAttachmentCompressImage,
  previewImage: chatAttachmentPreviewImage,
  resetFocusAfterNativePicker: chatAttachmentResetFocusAfterNativePicker,
  settleAfterNativePicker: chatAttachmentSettleAfterNativePicker,
};

Object.assign(globalThis, { CairnChatAttachment: CAIRN_CHAT_ATTACHMENT });

if (typeof window !== "undefined") {
  window.CairnChatAttachment = CAIRN_CHAT_ATTACHMENT;
}
