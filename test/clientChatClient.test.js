import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

function loadChatClient() {
  const context = { Math, Number, String, Date, RegExp, Set, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/chat-client.js"), "utf8"), context);
  return context.CairnChatClient;
}

test("chat image helpers count decoded bytes and normalize upload payloads", () => {
  const chat = loadChatClient();
  assert.equal(chat.base64DecodedBytes("TWFu"), 3);
  assert.equal(chat.base64DecodedBytes("TWE="), 2);
  assert.equal(chat.base64DecodedBytes(" TQ==\n"), 1);

  const payload = chat.imagePayload("data:image/png;base64,TWE=");
  assert.equal(payload.dataUrl, "data:image/png;base64,TWE=");
  assert.equal(payload.base64, "TWE=");
  assert.equal(payload.mime, "image/jpeg");
  assert.equal(payload.bytes, 2);
  assert.equal(chat.CHAT_IMAGE_MAX_BYTES, 4 * 1024 * 1024);
});

test("chat day keys use the device local clock helper and fall back cleanly", () => {
  const chat = loadChatClient();
  const calls = [];
  const localISO = (date) => {
    calls.push(date);
    return date ? "2026-06-30" : "2026-06-29";
  };

  assert.equal(chat.dayISO("2026-06-30 01:14:00", localISO), "2026-06-30");
  assert.equal(chat.dayISO("not-a-date", localISO), "2026-06-29");
  assert.equal(chat.dayISO(null, localISO), "2026-06-29");
  assert.ok(calls[0] instanceof Date);
});

test("chat fuel surface appears only for today's food-related thread", () => {
  const chat = loadChatClient();
  const dayISO = (ts) => String(ts).slice(0, 10);
  const options = { todayISO: "2026-06-29", dayISO };

  assert.equal(chat.wantsFuelSurface([
    { role: "user", content: "How is my shoulder?", created_at: "2026-06-29 12:00:00" },
    { role: "assistant", content: "Let's keep pressing light.", created_at: "2026-06-29 12:00:01" },
  ], options), false);

  assert.equal(chat.wantsFuelSurface([
    { role: "user", content: "Evaluate my lunch plate", created_at: "2026-06-29 12:00:00" },
  ], options), true);

  assert.equal(chat.wantsFuelSurface([
    { role: "user", content: "(photo)", meta: { image: "data:image/jpeg;base64,abc" }, created_at: "2026-06-29 12:00:00" },
  ], options), true);

  assert.equal(chat.wantsFuelSurface([
    { role: "user", content: "form check photo", meta: { image: "data:image/jpeg;base64,abc" }, created_at: "2026-06-29 12:00:00" },
  ], options), false);

  assert.equal(chat.wantsFuelSurface([
    { role: "user", content: "How am I doing?", created_at: "2026-06-29 12:00:00" },
    { role: "assistant", content: "Logged.", meta: { applied: [{ type: "log_food" }] }, created_at: "2026-06-29 12:00:02" },
  ], options), true);

  assert.equal(chat.wantsFuelSurface([
    { role: "user", content: "Evaluate my lunch plate", created_at: "2026-06-28 12:00:00" },
  ], options), false);
});

test("chat fuel and history HTML escape dynamic content", () => {
  const chat = loadChatClient();
  const fuel = chat.fuelHtml({
    count: 1,
    date: "2026-06-29",
    totals: { kcal: 1240, protein_g: 85, carbs_g: 120, fat_g: 40, fiber_g: 11 },
    entries: [],
    target: { kcal: 2200, protein_g: 170, mode: "maintain" },
    remaining: { kcal: 960, protein_g: 85 },
  });
  assert.match(fuel, /Today's fuel · 1 item/);
  assert.match(fuel, /1,240 kcal · 85g protein · ~960 left/);
  assert.doesNotMatch(fuel, /log something/i);

  const session = chat.historySessionRow({
    session_id: `sess"1`,
    preview: "<b>unsafe</b>",
    count: 2,
  }, "today");
  assert.match(session, /data-session="sess&quot;1"/);
  assert.match(session, /&lt;b&gt;unsafe&lt;\/b&gt;/);

  const hit = chat.historyHitRow({
    session_id: null,
    archived_at: null,
    role: "user",
    snippet: `protein.* <script>`,
  }, "protein.*", "today");
  assert.match(hit, /data-open="live"/);
  assert.match(hit, /<mark>protein\.\*<\/mark> &lt;script&gt;/);
  assert.match(hit, /You · today · current/);
});

test("chat shell, header, starter, and divider helpers preserve selectors safely", () => {
  const chat = loadChatClient();

  const shell = chat.shellHtml();
  assert.match(shell, /id="chatlog"/);
  assert.match(shell, /id="chatJump"/);
  assert.match(shell, /id="chatFuelSlot"/);
  assert.match(shell, /id="chatPreview"/);
  assert.match(shell, /id="chatAttach"/);
  assert.match(shell, /id="chatFile"/);
  assert.match(shell, /id="chatInput"/);
  assert.match(shell, /id="chatSend"/);
  assert.match(shell, /Logs save instantly/);

  const header = chat.headerActionsHtml();
  assert.match(header, /id="hdrChatActions"/);
  assert.match(header, /id="hdrHistory"/);
  assert.match(header, /aria-label="Past conversations &amp; search"/);
  assert.match(header, /id="hdrFresh"/);
  assert.match(header, /Start fresh\?/);

  const starters = chat.starterChipsHtml(["<meal>", `plan "week"`]);
  assert.match(starters, /class="chat-chips"/);
  assert.match(starters, /style="--i:0"/);
  assert.match(starters, /&lt;meal&gt;/);
  assert.match(starters, /plan "week"/);
  assert.doesNotMatch(starters, /<meal>/);

  const divider = chat.dividerHtml(`2026-06-30" onclick="x`, "<Today>");
  assert.match(divider, /class="chat-divider"/);
  assert.match(divider, /data-day="2026-06-30&quot; onclick=&quot;x"/);
  assert.match(divider, /&lt;Today&gt;/);

  assert.match(chat.earlierBarHtml(), /class="chat-earlierbar"/);
  assert.match(chat.emptyHtml(), /class="empty"/);
  assert.match(chat.freshPillHtml(2), /2 things remembered/);
  assert.match(chat.freshPillHtml(0), /Fresh start/);
});
