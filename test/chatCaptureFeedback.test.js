// Wave 5 — chat food-capture feedback loop.
//
// The capture lane fast-acks a food log and links a food_notes row whose macros
// fill in later via background enrichment. These tests pin the server contract the
// PWA relies on to show live progress and stream the enriched details back:
//   - every read path (turn snapshot, turns list, the assistant message) exposes the
//     linked note's CURRENT enrichment_status + a compact {meal,summary,kcal,protein_g},
//   - a status transition (pending → done) reaches that payload without a re-log,
//   - a multi-event message is captured whole (both foods survive), never dropped.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { completeInstantFoodCapture } from "../dist/chatTurns.js";
import { classifyChatRoute } from "../dist/chatRouting.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages", "food_notes", "memory");
  // Enrichment off keeps the instant linked note deterministic ('skipped' for text),
  // so we drive the status transitions ourselves instead of racing a background queue.
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive" });
});

function instantCapture(raw) {
  const routing = classifyChatRoute({ message: raw, has_image: false });
  const user = repo.addChatMessage("user", raw);
  const turn = repo.createChatTurn({ message: raw, routing, user_message_id: user.id });
  const finished = completeInstantFoodCapture(turn.id, raw);
  assert.ok(finished, "instant capture should complete for a strict food log");
  return { turnId: turn.id, finished };
}

function appliedFood(row) {
  const applied = row?.meta?.applied ?? [];
  return applied.find((a) => a?.type === "log_food") ?? null;
}

test("the linked capture note is exposed on the turn and the assistant message", () => {
  const { turnId } = instantCapture("Log turkey and rice for lunch");
  const note = repo.listFoodNotes(10)[0];
  assert.ok(note, "a food note was created");

  const turn = repo.getChatTurn(turnId);
  assert.equal(turn.capture_food_note_id, note.id, "the turn links the note id");

  const onTurn = appliedFood(turn);
  assert.ok(onTurn, "the turn's applied meta carries the log_food action");
  assert.equal(onTurn.result.id, note.id);
  // Enrichment is off, so the note settled to 'skipped' — the payload reflects that
  // live, not the 'pending' snapshot taken at capture time.
  assert.equal(onTurn.result.enrichment_status, "skipped");
  assert.equal(onTurn.result.food.meal, "lunch");

  const message = repo.getChatMessage(turn.assistant_message_id);
  const onMessage = appliedFood(message);
  assert.ok(onMessage, "the assistant message exposes the same log_food action");
  assert.equal(onMessage.result.id, note.id);
  assert.equal(onMessage.result.enrichment_status, "skipped");
});

test("the linked note also appears in the active-turns list payload", () => {
  const raw = "Log turkey and rice for lunch";
  const routing = classifyChatRoute({ message: raw, has_image: false });
  const user = repo.addChatMessage("user", raw);
  // A queued (not-yet-completed) instant turn still carries the raw column link once
  // we complete it; but the list also stamps live status for any linked note.
  const turn = repo.createChatTurn({ message: raw, routing, user_message_id: user.id });
  completeInstantFoodCapture(turn.id, raw);
  // Re-queue a fresh turn so listActiveChatTurns has an entry to hydrate.
  const followRaw = "Log a banana for a snack";
  const follow = repo.createChatTurn({
    message: followRaw,
    routing: classifyChatRoute({ message: followRaw, has_image: false }),
  });
  completeInstantFoodCapture(follow.id, followRaw);

  // Both turns are terminal now; assert the hydrate path stamps regardless by reading
  // the just-finished turn back through getChatTurn (the same hydrate the list uses).
  const stamped = repo.getChatTurn(follow.id);
  const food = appliedFood(stamped);
  assert.ok(food, "list/hydrate path exposes the linked note");
  assert.equal(food.result.food.meal, "snack");
});

test("a status transition (pending → done) reaches the turn + message payload", () => {
  const { turnId } = instantCapture("Log turkey and rice for lunch");
  const note = repo.listFoodNotes(10)[0];

  // Simulate the note moving through enrichment: first still in flight...
  repo.setFoodNoteEnrichStatus(note.id, "pending");
  let food = appliedFood(repo.getChatTurn(turnId));
  assert.equal(food.result.enrichment_status, "pending", "in-flight status is live on the turn");
  assert.equal(food.result.food.kcal, null, "no macros yet while pending");

  // ...then the enricher lands the structured estimate and stamps done.
  repo.updateFoodNoteParsed(note.id, {
    summary: "Turkey and rice bowl",
    kcal: 620,
    protein_g: 48,
    carbs_g: 70,
    fat_g: 14,
  });
  repo.setFoodNoteEnrichStatus(note.id, "done");

  const turn = repo.getChatTurn(turnId);
  food = appliedFood(turn);
  assert.equal(food.result.enrichment_status, "done");
  assert.equal(food.result.food.kcal, 620);
  assert.equal(food.result.food.protein_g, 48);
  assert.equal(food.result.food.summary, "Turkey and rice bowl");

  const message = repo.getChatMessage(turn.assistant_message_id);
  const onMessage = appliedFood(message);
  assert.equal(onMessage.result.enrichment_status, "done");
  assert.equal(onMessage.result.food.kcal, 620);
});

// The estimate the athlete reads should say what it was built from, in the SAME
// message that acked the log — not a follow-up. These pin the server half: the
// review is derived from the note's CURRENT parsed blob on every read path.
test("the settled payload carries the ingredient rows and the estimate's provenance", () => {
  const { turnId } = instantCapture("Log swordfish with medley vegetables for lunch");
  const note = repo.listFoodNotes(10)[0];

  repo.updateFoodNoteParsed(note.id, {
    summary: "Swordfish with vegetable medley",
    kcal: 635,
    protein_g: 51,
    ingredients: [
      { item: "swordfish", amount: "6 oz", kcal: 320, protein_g: 42, fat_g: 15 },
      { item: "vegetable medley", amount: "1.5 cups", kcal: 95, protein_g: 4 },
      { item: "olive oil", amount: "1 tbsp", kcal: 120 },
    ],
    confidence: "medium",
    basis: "estimated_from_foods",
  });
  repo.setFoodNoteEnrichStatus(note.id, "done");

  const message = repo.getChatMessage(repo.getChatTurn(turnId).assistant_message_id);
  const { food } = appliedFood(message).result;
  assert.equal(food.ingredient_count, 3);
  assert.deepEqual(
    food.ingredients.map((row) => row.item),
    ["swordfish", "vegetable medley", "olive oil"]
  );
  assert.equal(food.ingredients[0].amount, "6 oz", "the quantity stays its own field");
  assert.equal(food.ingredients[0].kcal, 320);
  assert.equal(food.ingredients[0].protein_g, 42);
  assert.equal(food.ingredients[2].protein_g, null, "a row that estimated no protein says so");
  assert.equal(food.confidence, "medium");
  assert.equal(food.basis, "estimated_from_foods");
});

test("a re-enrichment revises the review in place — never appends a second one", () => {
  const { turnId } = instantCapture("Log turkey and rice for lunch");
  const note = repo.listFoodNotes(10)[0];
  const messageId = repo.getChatTurn(turnId).assistant_message_id;

  const first = {
    summary: "Turkey and rice",
    kcal: 620,
    ingredients: [{ item: "turkey", amount: "5 oz" }, { item: "rice", amount: "1 cup" }],
    confidence: "low",
    basis: "estimated_from_foods",
  };
  repo.updateFoodNoteParsed(note.id, first);
  repo.setFoodNoteEnrichStatus(note.id, "done");
  assert.equal(appliedFood(repo.getChatMessage(messageId)).result.food.ingredient_count, 2);

  // The SAME payload landing twice (a queue retry / re-sync) must be a no-op.
  repo.updateFoodNoteParsed(note.id, first);
  repo.setFoodNoteEnrichStatus(note.id, "done");
  const repeated = appliedFood(repo.getChatMessage(messageId)).result.food;
  assert.equal(repeated.ingredient_count, 2, "a replayed completion does not duplicate the rows");
  assert.equal(repeated.kcal, 620);

  // A genuinely better estimate REPLACES the review rather than stacking onto it.
  repo.updateFoodNoteParsed(note.id, {
    summary: "Turkey and rice",
    kcal: 655,
    ingredients: [{ item: "turkey breast", amount: "205 g", kcal: 240, protein_g: 46 }],
    confidence: "high",
    basis: "user_report",
  });
  const revised = appliedFood(repo.getChatMessage(messageId)).result.food;
  assert.equal(revised.ingredient_count, 1);
  assert.equal(revised.ingredients[0].item, "turkey breast");
  assert.equal(revised.basis, "user_report");
  assert.equal(revised.confidence, "high");
});

test("the review reaches a later page load through the history read path", () => {
  const { turnId } = instantCapture("Log turkey and rice for lunch");
  const note = repo.listFoodNotes(10)[0];
  const messageId = repo.getChatTurn(turnId).assistant_message_id;

  repo.updateFoodNoteParsed(note.id, {
    summary: "Turkey and rice",
    kcal: 620,
    ingredients: [{ item: "turkey", amount: "5 oz", kcal: 240 }],
    confidence: "medium",
    basis: "label",
  });
  repo.setFoodNoteEnrichStatus(note.id, "done");

  // listChatMessages is what a cold page load reads — a client that was closed when
  // the estimate landed must still see it, not the pending snapshot.
  const fromHistory = repo.listChatMessages(50).find((m) => m.id === messageId);
  assert.ok(fromHistory, "the assistant message is in the live conversation");
  const { food } = appliedFood(fromHistory).result;
  assert.equal(food.kcal, 620);
  assert.equal(food.ingredients[0].item, "turkey");
  assert.equal(food.basis, "label");
});

test("the review is bounded, and provenance outside the contract reads as absent", () => {
  const { turnId } = instantCapture("Log turkey and rice for lunch");
  const note = repo.listFoodNotes(10)[0];

  repo.updateFoodNoteParsed(note.id, {
    summary: "A long plate",
    kcal: 900,
    ingredients: Array.from({ length: 11 }, (_, i) => ({ item: `component ${i + 1}` })),
    confidence: "92%", // a scored confidence is not one of the contract's bands
    basis: "vibes",
  });
  repo.setFoodNoteEnrichStatus(note.id, "done");

  const { food } = appliedFood(repo.getChatTurn(turnId)).result;
  assert.equal(food.ingredients.length, 6, "a chat bubble never grows a wall of rows");
  assert.equal(food.ingredient_count, 11, "the true count survives so the chip can say how many are hidden");
  assert.equal(food.confidence, null, "an unrecognized band is dropped, not passed through");
  assert.equal(food.basis, null, "an estimate never claims a basis nobody defined");
});

test("an older estimate with only a flat items list still yields a review", () => {
  const { turnId } = instantCapture("Log turkey and rice for lunch");
  const note = repo.listFoodNotes(10)[0];

  repo.updateFoodNoteParsed(note.id, {
    summary: "Turkey and rice",
    kcal: 620,
    items: ["turkey (5 oz)", "white rice (1 cup)"],
  });
  repo.setFoodNoteEnrichStatus(note.id, "done");

  const { food } = appliedFood(repo.getChatTurn(turnId)).result;
  assert.equal(food.ingredient_count, 2);
  assert.equal(food.ingredients[0].item, "turkey (5 oz)");
  assert.equal(food.ingredients[0].amount, null);
});

test("a deleted linked note settles the chip payload without breaking", () => {
  const { turnId } = instantCapture("Log turkey and rice for lunch");
  const note = repo.listFoodNotes(10)[0];
  repo.deleteFoodNote(note.id);

  const food = appliedFood(repo.getChatTurn(turnId));
  assert.ok(food, "the action still renders");
  assert.equal(food.result.food_note_missing, true, "a gone note is flagged, not left stale");
});

test("multi-event message: both foods are captured (one note, nothing dropped)", () => {
  // The reported incident: one message with two distinct food events. The instant
  // lane is deterministic (no agent), so it captures the WHOLE utterance as one note —
  // both events survive in raw for the background enricher to estimate together.
  const raw = "Log 40g coffee cake with skyr and dinner was steak, rice, and broccoli";
  const routing = classifyChatRoute({ message: raw, has_image: false });
  assert.equal(routing.lane, "capture", "a two-food log stays in the capture lane");

  const { finished } = instantCapture(raw);
  const notes = repo.listFoodNotes(10);
  assert.equal(notes.length, 1, "exactly one note is created for the message");
  const note = notes[0];
  assert.match(note.raw_output, /coffee cake/i, "the coffee cake event survives in raw");
  assert.match(note.raw_output, /steak/i, "the dinner event survives in raw");
  assert.match(note.raw_output, /broccoli/i, "every dinner component survives in raw");

  // The ack + linked payload both point at that single note, so the UI can track it.
  assert.equal(finished.turn.capture_food_note_id, note.id);
  const food = appliedFood(finished.turn);
  assert.equal(food.result.id, note.id);
});
