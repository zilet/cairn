import { DATA_DIR } from "./dataDir.js";
import path from "node:path";


export { DATA_DIR };
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
