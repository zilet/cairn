import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(path.join(root, "public/js/09-plan-chat.js"), "utf8");
const chatClient = readFileSync(path.join(root, "public/js/chat-client.js"), "utf8");

test("chat photo capture compresses under the server upload cap before enqueue", () => {
  assert.match(chatClient, /const\s+CHAT_IMAGE_MAX_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  assert.match(chat, /const\s+CHAT_UPLOAD_IMAGE_MAX_BYTES\s*=\s*CairnChatClient\.CHAT_IMAGE_MAX_BYTES/);
  assert.match(chat, /function\s+base64DecodedBytes/);
  assert.match(chat, /CHAT_UPLOAD_IMAGE_EDGE_STEPS/);
  assert.match(chat, /CHAT_UPLOAD_IMAGE_QUALITY_STEPS/);
  assert.match(chat, /last\.bytes\s*<=\s*CHAT_UPLOAD_IMAGE_MAX_BYTES/);
  assert.match(chat, /new Error\("image-too-large"\)/);
  assert.match(chat, /try a closer crop/);
});

test("chat photo picker settles keyboard geometry before and after the native picker", () => {
  assert.match(chat, /const\s+settleChatAfterNativePicker\s*=\s*\(\)\s*=>/);
  assert.match(chat, /new CustomEvent\("cairn:keyboard-settle"\)/);
  assert.match(chat, /if\s*\(document\.activeElement\s*===\s*input\)\s*input\.blur\(\)/);
  assert.match(chat, /document\.body\.classList\.remove\("kb-open"\)/);
  assert.match(chat, /fileInput\.click\(\)/);
  assert.match(chat, /finally\s*\{\s*settleChatAfterNativePicker\(\)/);
});
