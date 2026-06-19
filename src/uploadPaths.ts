import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

export function safeUploadPath(filePath: unknown, root = UPLOADS_DIR): string | null {
  const raw = String(filePath ?? "").trim();
  if (!raw) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(raw);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}
