import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(path.join(root, "public/js/09-plan-chat.js"), "utf8");

test("chat photo capture compresses under the server upload cap before enqueue", () => {
  assert.match(chat, /const\s+CHAT_IMAGE_MAX_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  assert.match(chat, /function\s+base64DecodedBytes/);
  assert.match(chat, /CHAT_IMAGE_EDGE_STEPS/);
  assert.match(chat, /CHAT_IMAGE_QUALITY_STEPS/);
  assert.match(chat, /last\.bytes\s*<=\s*CHAT_IMAGE_MAX_BYTES/);
  assert.match(chat, /new Error\("image-too-large"\)/);
  assert.match(chat, /try a closer crop/);
});
