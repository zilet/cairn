import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(path.join(root, "public/js/09-plan-chat.js"), "utf8");
const chatClient = readFileSync(path.join(root, "public/js/chat-client.js"), "utf8");
const chatAttachment = readFileSync(path.join(root, "public/js/chat-attachment-client.js"), "utf8");

test("chat photo capture compresses under the server upload cap before enqueue", () => {
  assert.match(chatClient, /const\s+CHAT_IMAGE_MAX_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  assert.match(chatClient, /function\s+base64DecodedBytes/);
  assert.match(chatClient, /imagePayload: chatImagePayload/);
  assert.match(chatAttachment, /for\s*\(const maxEdge of CairnChatClient\.CHAT_IMAGE_EDGE_STEPS\)/);
  assert.match(chatAttachment, /for\s*\(const quality of CairnChatClient\.CHAT_IMAGE_QUALITY_STEPS\)/);
  assert.match(chatAttachment, /last\.bytes\s*<=\s*CairnChatClient\.CHAT_IMAGE_MAX_BYTES/);
  assert.match(chatAttachment, /new Error\("image-too-large"\)/);
  assert.match(chat, /CairnChatAttachment\.compressImage\(f\)/);
  assert.match(chat, /try a closer crop/);
});

test("chat photo picker settles keyboard geometry before and after the native picker", () => {
  assert.match(chat, /const\s+resetChatFocusAfterNativePicker\s*=\s*\(\)\s*=>/);
  assert.match(chat, /CairnChatAttachment\.resetFocusAfterNativePicker/);
  assert.match(chatAttachment, /if\s*\(document\.activeElement\s*===\s*options\.input\)\s*options\.input\.blur\(\)/);
  assert.match(chatAttachment, /if\s*\(document\.activeElement\s*===\s*options\.fileInput\)\s*options\.fileInput\.blur\(\)/);
  assert.match(chatAttachment, /document\.body\.classList\.remove\("kb-open"\)/);
  assert.match(chat, /const\s+settleChatAfterNativePicker\s*=\s*\(\)\s*=>/);
  assert.match(chat, /CairnChatAttachment\.settleAfterNativePicker/);
  assert.match(chatAttachment, /new CustomEvent\("cairn:keyboard-settle",\s*\{\s*detail:\s*\{\s*chatFocusGraceMs:\s*options\.graceMs\s*\?\?\s*1200\s*\}/);
  assert.match(chat, /attachBtn\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*resetChatFocusAfterNativePicker\(\)/);
  assert.match(chat, /fileInput\.addEventListener\("change",\s*\(\)\s*=>\s*\{\s*resetChatFocusAfterNativePicker\(\)/);
  assert.match(chat, /fileInput\.click\(\)/);
  assert.match(chat, /finally\s*\{\s*settleChatAfterNativePicker\(\)/);
});

test("chat photo composer can refocus the same textarea after the keyboard hides", () => {
  assert.match(chat, /const\s+recoverChatInputFocus\s*=\s*\(\)\s*=>/);
  assert.match(chat, /const\s+kbOpen\s*=\s*document\.body\.classList\.contains\("kb-open"\)/);
  assert.match(chat, /const\s+alreadyFocused\s*=\s*document\.activeElement\s*===\s*input/);
  assert.match(chat, /if\s*\(!kbOpen\s*&&\s*alreadyFocused\)\s*input\.blur\(\)/);
  assert.match(chat, /if\s*\(!alreadyFocused\s*\|\|\s*!kbOpen\)\s*\{/);
  assert.match(chat, /input\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.doesNotMatch(chat, /document\.body\.classList\.contains\("kb-open"\)\)\s*return/);
  assert.doesNotMatch(chat, /document\.activeElement\s*!==\s*input\)\s*return/);
  assert.match(chat, /input\.addEventListener\("pointerdown",\s*recoverChatInputFocus\)/);
  assert.match(chat, /input\.addEventListener\("pointerup"[\s\S]*settleChatViewport/);
});
