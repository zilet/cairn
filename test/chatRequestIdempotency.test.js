import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chatRouter } from "../dist/routes/chat.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { db, repo, resetTables } from "./_seed.js";

const createdUploads = new Set();

beforeEach(() => {
  resetTables("chat_turns", "chat_messages", "food_notes");
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive" });
});

afterEach(() => {
  db.exec("DROP TRIGGER IF EXISTS test_fail_instant_receipt");
  for (const filePath of createdUploads) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already absent */
    }
  }
  createdUploads.clear();
});

function post(body) {
  const layer = chatRouter.stack.find((entry) => entry.route?.path === "/" && entry.route.methods.post);
  const handler = layer.route.stack[0].handle;
  const result = { status: 200, body: null };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(value) {
      result.body = value;
      return this;
    },
  };
  handler({ body }, res);
  return result;
}

test("a lost-response retry with text and photo reuses one turn, message, note, and upload", async () => {
  const payload = {
    request_id: "chat-retry-12345678",
    message: "Log this lunch photo",
    image_mime: "image/jpeg",
    image_base64: Buffer.from("bounded-test-image").toString("base64"),
  };
  const first = post(payload); // model a committed response the client never received
  createdUploads.add(first.body.turn.image_path);
  const replay = post(payload);

  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.turn.id, first.body.turn.id);
  assert.equal(replay.body.user_message.id, first.body.user_message.id);
  assert.equal(replay.body.turn.idempotent_replays, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role='user'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 1);
  assert.equal(fs.existsSync(first.body.turn.image_path), true);
  assert.equal(
    fs.readdirSync(UPLOADS_DIR).filter((name) => name === first.body.turn.image_url.split("/").at(-1)).length,
    1
  );
  assert.match(first.body.turn.created_at, /\.\d{3}$/);
  assert.match(first.body.turn.finished_at, /\.\d{3}$/);
  const elapsed =
    Date.parse(`${first.body.turn.finished_at.replace(" ", "T")}Z`) -
    Date.parse(`${first.body.turn.created_at.replace(" ", "T")}Z`);
  assert.ok(elapsed >= 0 && elapsed < 1000, `instant turn latency retains sub-second precision (${elapsed}ms)`);
});

test("a retry resumes an instant capture that committed before its receipt failed", () => {
  const payload = {
    request_id: "chat-postcommit-failure-123",
    message: "Log turkey and rice for lunch",
  };
  db.exec(`CREATE TRIGGER test_fail_instant_receipt
    BEFORE INSERT ON chat_messages WHEN NEW.role = 'assistant'
    BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END;`);

  assert.throws(() => post(payload), /forced receipt failure/);
  const stranded = db.prepare("SELECT * FROM chat_turns WHERE request_id = ?").get(payload.request_id);
  assert.equal(stranded.status, "queued", "the simulated failure occurs after the durable request commit");
  assert.ok(stranded.capture_food_note_id, "the food side effect was already linked before receipt creation failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role='assistant'").get().n, 0);

  db.exec("DROP TRIGGER test_fail_instant_receipt");
  const replay = post(payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.turn.status, "done");
  assert.equal(replay.body.turn.capture_food_note_id, stranded.capture_food_note_id);
  assert.equal(replay.body.turn.idempotent_replays, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 1, "resume reuses the linked note");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role='assistant'").get().n, 1);
});

test("request_id remains optional for legacy clients", async () => {
  const first = post({ message: "Log breakfast: oats" });
  const second = post({ message: "Log breakfast: oats" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.turn.id, second.body.turn.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role='user'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 2);
});

test("request_id is bounded and URL-safe", async () => {
  const short = post({ request_id: "tiny", message: "hello" });
  const unsafe = post({ request_id: "chat retry with spaces", message: "hello" });
  assert.equal(short.status, 400);
  assert.equal(unsafe.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get().n, 0);
});
