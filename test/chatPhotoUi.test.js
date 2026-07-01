import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(path.join(root, "public/js/09-plan-chat.js"), "utf8");
const chatClient = readFileSync(path.join(root, "public/js/chat-client.js"), "utf8");
const chatAttachment = readFileSync(path.join(root, "public/js/chat-attachment-client.js"), "utf8");
const chatComposerFocus = readFileSync(path.join(root, "public/js/chat-composer-focus-client.js"), "utf8");
const chatComposerController = readFileSync(path.join(root, "public/js/chat-composer-controller.js"), "utf8");

test("chat photo capture compresses under the server upload cap before enqueue", () => {
  assert.match(chatClient, /const\s+CHAT_IMAGE_MAX_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  assert.match(chatClient, /function\s+base64DecodedBytes/);
  assert.match(chatClient, /imagePayload: chatImagePayload/);
  assert.match(chatAttachment, /for\s*\(const maxEdge of CairnChatClient\.CHAT_IMAGE_EDGE_STEPS\)/);
  assert.match(chatAttachment, /for\s*\(const quality of CairnChatClient\.CHAT_IMAGE_QUALITY_STEPS\)/);
  assert.match(chatAttachment, /last\.bytes\s*<=\s*CairnChatClient\.CHAT_IMAGE_MAX_BYTES/);
  assert.match(chatAttachment, /new Error\("image-too-large"\)/);
  assert.match(chatComposerController, /CairnChatAttachment\.compressImage\(f\)/);
  assert.match(chatComposerController, /try a closer crop/);
  assert.match(chat, /CairnChatComposerController\.wire/);
  assert.doesNotMatch(chat, /CairnChatAttachment\.compressImage\(f\)/);
});

test("chat photo picker settles keyboard geometry before and after the native picker", () => {
  assert.match(chatComposerController, /const\s+resetChatFocusAfterNativePicker\s*=\s*\(\)\s*=>/);
  assert.match(chatComposerController, /CairnChatAttachment\.resetFocusAfterNativePicker/);
  assert.match(chatAttachment, /if\s*\(document\.activeElement\s*===\s*options\.input\)\s*options\.input\.blur\(\)/);
  assert.match(chatAttachment, /if\s*\(document\.activeElement\s*===\s*options\.fileInput\)\s*options\.fileInput\.blur\(\)/);
  assert.doesNotMatch(chatAttachment, /classList\.remove\("kb-open"\)/);
  assert.doesNotMatch(chatAttachment, /classList\.remove\("kb-geometry-open"\)/);
  assert.match(chatComposerController, /const\s+settleChatAfterNativePicker\s*=\s*\(\)\s*=>/);
  assert.match(chatComposerController, /CairnChatAttachment\.settleAfterNativePicker/);
  assert.match(chatAttachment, /chatFocusGraceMs:\s*options\.graceMs\s*\?\?\s*1200/);
  assert.match(chatAttachment, /nativePickerSuppressMs:\s*options\.nativePickerSuppressMs\s*\?\?\s*900/);
  assert.match(chatComposerController, /attachBtn\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*resetChatFocusAfterNativePicker\(\)/);
  assert.match(chatComposerController, /fileInput\.addEventListener\("change",\s*\(\)\s*=>\s*\{\s*resetChatFocusAfterNativePicker\(\)/);
  assert.match(chatComposerController, /fileInput\.click\(\)/);
  assert.match(chatComposerController, /finally\s*\{\s*settleChatAfterNativePicker\(\)/);
  assert.doesNotMatch(chat, /CairnChatAttachment\.resetFocusAfterNativePicker/);
});

test("chat photo composer can refocus the same textarea after the keyboard hides", () => {
  assert.match(chatComposerController, /CairnChatComposerFocus\.wireFocus/);
  assert.match(chatComposerFocus, /function\s+chatComposerReleaseStaleInputFocus/);
  assert.match(chatComposerFocus, /function\s+chatComposerRecoverInputFocusFromTap/);
  assert.match(chatComposerFocus, /document\.activeElement\s*===\s*options\.input\)\s*options\.input\.blur\(\)/);
  assert.match(chatComposerFocus, /chatComposerFocusInput\(options\.input\)/);
  assert.match(chatComposerFocus, /input\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.match(chatComposerFocus, /addEventListener\("pointerup",\s*recoverInputFocusFromTap,\s*\{\s*passive:\s*true\s*\}\)/);
  assert.match(chatComposerFocus, /addEventListener\("click",\s*recoverInputFocusFromTap\)/);
  assert.doesNotMatch(chat, /document\.body\.classList\.contains\("kb-open"\)/);
  assert.doesNotMatch(chat, /CairnChatComposerFocus\.wireFocus/);
  assert.doesNotMatch(chatComposerFocus, /setTimeout\(\(\)\s*=>\s*\{\s*[^}]*focus/);
});
