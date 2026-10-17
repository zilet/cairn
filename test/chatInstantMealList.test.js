// The commonest food message has no verb: "breakfast 30g rolled oats 15g chia 3g psyllium
// 180g non fat skyr 20 grapes". It used to fall off the receipt lane (no "log", no "had",
// no "Breakfast:") and wait ~26 s on an agent turn to say "logged". A meal written as a
// list — a leading meal label, or words that open on written quantities — now takes the
// instant lane: the note and its receipt land inside the request, the athlete's own rows
// are split deterministically, and the agent only fills the numbers in the background.
// Anything that is not plainly one new meal (a question, a correction, a plan or future
// word, an answer to the coach's question) keeps the agent route.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { classifyChatRoute, readsAsMealList } from "../dist/chatRouting.js";
import {
  coachMessageAsks,
  foodListAnswersCoachQuestion,
  isInstantFoodCaptureDecision,
  mentionsWhen,
} from "../dist/chat-intent.js";
import { foodRowsFromWords, mealLabelLead } from "../dist/foodCapture.js";
import { completeInstantFoodCapture, enqueueChatTurn, onTurnEvent } from "../dist/chatTurns.js";
import { chatRouter } from "../dist/routes/chat.js";
import { applyFoodEstimate } from "../dist/enrich.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages", "food_notes", "agent_runs");
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive", disabled_agents: [] });
});

const GRAM_LIST = "breakfast 30g rolled oats 15g chia 3g psyllium 180g non fat skyr 20 grapes";

// [message, lane, instant, { recent? }]
const TABLE = [
  // ---- a meal written as a list: instant
  [GRAM_LIST, "capture", true],
  [GRAM_LIST, "capture", true, { recent: true }], // a second meal of the day is a new entry
  ["lunch 200g chicken breast 150g cooked rice 100g broccoli", "capture", true],
  ["Snack: 20g almonds and an apple", "capture", true],
  ["dinner - 250g salmon, 200g potatoes, salad", "capture", true],
  ["afternoon snack 1 banana 30g whey in 300ml milk", "capture", true],
  ["breakfast 40g steel cut oats 250ml oat milk 10g honey", "capture", true], // "cut" is not a cut
  ["lunch about 150 g rice and 200g chicken", "capture", true], // "about 150" is an amount, not 3 pm
  ["200g greek yogurt 30g granola 100g blueberries", "capture", true],
  ["2 eggs, 2 slices toast, flat white", "capture", true],
  ["oats 60g, milk 250 ml, banana", "capture", true],
  ["Breakfast\n30g oats\n200 ml milk\n1 banana", "capture", true],
  ["lunch 150g rice", "capture", true, { recent: true }],
  ["Lunch - rice 150g chicken 120g", "capture", true], // trailing amounts, one per food
  ["180g skyr around 20 grapes", "capture", true], // "around 20" travels with the grapes
  ["180g non fat skyr around 20 grapes", "capture", true],
  ["dinner - salmon 200g, potatoes 150g", "capture", true],
  ["snack: almonds 20g and dates 30g", "capture", true],
  // ---- a number left inside a food's name is never a receipt row: the agent reads it
  ["breakfast 2 eggs 2 slices of 7 grain toast", "coach", false],
  ["lunch 7 grain bread 2 slices ham 50g", "coach", false],
  ["lunch rice 150g chicken", "coach", false],
  // ---- a bare list right after a capture may be more of that meal: the agent reads it
  ["200g greek yogurt 30g granola", "capture", false, { recent: true }],
  ["2 eggs, 2 slices toast, flat white", "capture", false, { recent: true }],
  // ---- one bare amount is more often an answer than a meal
  ["150g rice", "coach", false],
  ["2 eggs", "coach", false],
  // ---- a correction, with or without a recent capture, is the agent's to apply
  ["lunch was 150g rice not 200g", "capture", false],
  ["lunch was 150g rice not 200g", "capture", false, { recent: true }],
  ["lunch 150g rice, make it 200g", "coach", false],
  ["lunch 150g rice, make it 200g", "coach", false, { recent: true }],
  ["lunch 150g rice not 200", "coach", false, { recent: true }],
  ["snack 1 piece lindt, not the whole bar", "coach", false, { recent: true }],
  // ---- a question, a comparison, a hypothetical or a lookup with no "?"
  ["lunch 200g chicken 150g rice is that enough protein", "coach", false],
  ["dinner 200g rice or 300g potatoes", "coach", false],
  ["150g chicken vs 150g tofu", "coach", false],
  ["if I eat 200g rice 150g chicken am I over", "coach", false],
  ["calories in 200g rice 150g chicken", "coach", false],
  ["macros 30g oats 15g chia", "coach", false],
  // ---- someone else's food, or a shared dish
  ["lunch for my wife 200g chicken 150g rice", "coach", false],
  ["dinner 200g salmon 150g rice for my wife", "coach", false],
  ["kids lunch 2 slices bread 50g ham", "coach", false],
  ["made dinner for the family: 500g chicken, 400g rice, 300g broccoli - I had about a third", "coach", false],
  // ---- a label the splitter cannot read leaves one row of the whole message: the agent reads it
  ["brekfast 30g oats 15g chia", "coach", false],
  ["dorucak 30g ovsa 200ml mleka 1 banana", "coach", false],
  // ---- corrections and amendments reach the agent
  ["no not the whole bar… one piece", "capture", false, { recent: true }],
  ["no not the whole bar… one piece", "coach", false],
  ["lunch 200g more rice", "capture", false, { recent: true }],
  ["breakfast 30g oats, actually make it 40g", "capture", false],
  ["snack 20g almonds plus an apple", "capture", false, { recent: true }],
  // ---- questions, ideas, plans and habits keep the coach
  ["lunch 200g chicken, is that enough protein?", "coach", false],
  ["dinner ideas with 200g salmon", "coach", false],
  ["breakfast tomorrow 2 eggs", "coach", false],
  ["snack 20g almonds every day", "coach", false],
  // ---- the eaten time and a second meal are the agent's to read
  ["breakfast at 7: 2 eggs and toast", "coach", false],
  ["breakfast 2 eggs. lunch 200g chicken", "coach", false],
  // ---- a bare amount, another domain, or a food named like a meal: unchanged
  ["150g", "coach", false],
  ["lunch 150g", "coach", false],
  ["5g creatine", "coach", false],
  ["20 min walk", "coach", false],
  ["breakfast burrito", "coach", false],
];

for (const [message, lane, instant, opts = {}] of TABLE) {
  test(`${JSON.stringify(message.slice(0, 60))}${opts.recent ? " (recent capture)" : ""} -> ${lane}${instant ? " instant" : ""}`, () => {
    const decision = classifyChatRoute({ message, recent_food_capture: opts.recent === true });
    assert.equal(decision.lane, lane, JSON.stringify(decision));
    assert.equal(isInstantFoodCaptureDecision(decision, message), instant, JSON.stringify(decision));
  });
}

test("the athlete's gram list splits into one row per written quantity, with no numbers invented", () => {
  assert.deepEqual(foodRowsFromWords(GRAM_LIST), [
    { item: "rolled oats", amount: "30g" },
    { item: "chia", amount: "15g" },
    { item: "psyllium", amount: "3g" },
    { item: "non fat skyr", amount: "180g" },
    { item: "grapes", amount: "20" },
  ]);
  assert.deepEqual(foodRowsFromWords("Lunch - 200g chicken and 150 g rice"), [
    { item: "chicken", amount: "200g" },
    { item: "rice", amount: "150 g" },
  ]);
  // An approximation stays with its number; a trailing amount is never split off.
  assert.deepEqual(foodRowsFromWords("about 150 g rice 2 eggs"), [
    { item: "rice", amount: "about 150 g" },
    { item: "eggs", amount: "2" },
  ]);
  assert.deepEqual(foodRowsFromWords("oats 60 g"), [{ item: "oats", amount: "60 g" }]);
  // A food named like a meal keeps its name; a number inside a name is not a quantity.
  assert.deepEqual(foodRowsFromWords("breakfast burrito"), [{ item: "breakfast burrito" }]);
  assert.deepEqual(foodRowsFromWords("200ml 2% milk 30g oats"), [
    { item: "2% milk", amount: "200ml" },
    { item: "oats", amount: "30g" },
  ]);
  // A number inside a food's name, or after "of", never opens a row (each was one row before).
  assert.deepEqual(foodRowsFromWords("1 cup 2 percent milk"), [{ item: "2 percent milk", amount: "1 cup" }]);
  assert.deepEqual(foodRowsFromWords("3 slices of 12 grain bread"), [{ item: "12 grain bread", amount: "3 slices" }]);
  assert.deepEqual(foodRowsFromWords("breakfast 2 eggs 2 slices of 7 grain toast"), [
    { item: "eggs", amount: "2" },
    { item: "7 grain toast", amount: "2 slices" },
  ]);
  assert.deepEqual(foodRowsFromWords("1 bowl 3 bean chili"), [{ item: "3 bean chili", amount: "1 bowl" }]);
  // The trailing form splits only when every part is <food> <amount with a unit>.
  assert.deepEqual(foodRowsFromWords("Lunch - rice 150g chicken 120g"), [
    { item: "rice", amount: "150g" },
    { item: "chicken", amount: "120g" },
  ]);
  assert.deepEqual(foodRowsFromWords("snack: almonds 20g and dates 30g"), [
    { item: "almonds", amount: "20g" },
    { item: "dates", amount: "30g" },
  ]);
  assert.deepEqual(foodRowsFromWords("lunch rice 150g chicken"), [{ item: "lunch rice 150g chicken" }]);
  // An approximation before a counted food stays with its count.
  assert.deepEqual(foodRowsFromWords("180g skyr around 20 grapes"), [
    { item: "skyr", amount: "180g" },
    { item: "grapes", amount: "around 20" },
  ]);
  assert.deepEqual(foodRowsFromWords("180g non fat skyr around 20 grapes"), [
    { item: "non fat skyr", amount: "180g" },
    { item: "grapes", amount: "around 20" },
  ]);
  assert.deepEqual(foodRowsFromWords("30g oats about 15g chia"), [
    { item: "oats", amount: "30g" },
    { item: "chia", amount: "about 15g" },
  ]);
  assert.deepEqual(mealLabelLead("afternoon snack: 1 banana"), { label: "snack", rest: "1 banana" });
  assert.equal(mealLabelLead("snack bar 40g"), null, "a food named like a meal is not a label lead");
});

test("a portion is never read as a clock time; a time still is", () => {
  assert.equal(mentionsWhen("lunch about 150 g rice"), false);
  assert.equal(mentionsWhen("around two slices of toast"), false);
  assert.equal(mentionsWhen("breakfast around 9"), true);
  assert.equal(mentionsWhen("had oats at 8, then coffee"), true);
  assert.equal(mentionsWhen("dinner at 7pm"), true);
});

test("a meal list straight after a coach question is the answer, unless it names another meal", () => {
  const list = "200g greek yogurt 30g granola";
  assert.equal(foodListAnswersCoachQuestion(list, "How much yogurt was that?"), true);
  assert.equal(foodListAnswersCoachQuestion(list, "Did you have rice with it? Roughly how much."), true);
  assert.equal(foodListAnswersCoachQuestion(list, "Logged your lunch."), false);
  assert.equal(foodListAnswersCoachQuestion("Log food: 200g rice 30g oats", "Anything else?"), false);
  // Under its own meal label it is a new entry — unless the question was about that meal or its food.
  assert.equal(foodListAnswersCoachQuestion("dinner 150g rice 200g salmon", "Anything else for today?"), false);
  assert.equal(foodListAnswersCoachQuestion("lunch 150g rice", "How much rice was in lunch?"), true);
  assert.equal(foodListAnswersCoachQuestion("lunch 150g rice", "Logged. Roughly how much rice was there."), true);
  assert.equal(coachMessageAsks("Logged your breakfast. I’ll fill in the nutrition details in the background."), false);
  assert.equal(readsAsMealList(list), true);
  assert.equal(readsAsMealList("150g rice"), false, "one bare amount alone is not a meal list");
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

test("a gram list sent in chat is logged inside the request: no agent runs, rows are the athlete's own", async () => {
  const { status, body } = post({ request_id: "meal-list-instant-0001", message: GRAM_LIST });
  assert.equal(status, 200);
  assert.equal(body.turn.status, "done", "the receipt is written before the response returns");
  assert.equal(body.turn.chosen_agent, null, "no agent answered it");
  assert.equal(body.turn.meta.instant_capture, true);
  assert.match(body.turn.reply, /^Logged your breakfast as 5 items, in your words\./);
  const note = repo.getFoodNote(body.turn.capture_food_note_id);
  assert.equal(note.meal, "breakfast");
  assert.equal(note.raw_output, GRAM_LIST, "the athlete's exact words are what the enricher reads");
  assert.deepEqual(
    note.parsed.ingredients.map((r) => [r.item, r.amount]),
    [
      ["rolled oats", "30g"],
      ["chia", "15g"],
      ["psyllium", "3g"],
      ["non fat skyr", "180g"],
      ["grapes", "20"],
    ]
  );
  assert.equal(note.parsed.kcal ?? null, null, "no number is invented");
  assert.equal(note.eaten_at ?? null, null, "no time is synthesized from the label");
  await new Promise((resolve) => setImmediate(resolve)); // the deferred effects run off the response
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs").get().n, 0, "the stub agent was never called");
});

test("a replayed gram-list request reuses its one note and receipt", () => {
  const payload = { request_id: "meal-list-replay-0001", message: "lunch 200g chicken breast 150g cooked rice" };
  const first = post(payload);
  const replay = post(payload);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.turn.id, first.body.turn.id);
  assert.equal(replay.body.turn.idempotent_replays, 1);
  assert.equal(replay.body.turn.capture_food_note_id, first.body.turn.capture_food_note_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role='assistant'").get().n, 1);
  // Driving the stored turn again is a no-op too.
  const again = completeInstantFoodCapture(first.body.turn.id, payload.message);
  assert.equal(again.message.id, replay.body.turn.assistant_message_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 1);
});

test("an instant meal's word rows give way to an estimate, but never over a person's edit", () => {
  const first = post({ request_id: "meal-list-estimate-01", message: "lunch 200g chicken breast 150g cooked rice" });
  const estimate = {
    summary: "Chicken and rice",
    ingredients: [
      { item: "chicken breast", amount: "200g", kcal: 330, protein_g: 62 },
      { item: "cooked rice", amount: "150g", kcal: 195, protein_g: 4 },
    ],
    confidence: "high",
    basis: "user_report",
  };
  assert.equal(applyFoodEstimate(first.body.turn.capture_food_note_id, estimate), true);
  assert.equal(repo.getFoodNote(first.body.turn.capture_food_note_id).parsed.kcal, 525);

  const second = post({ request_id: "meal-list-estimate-02", message: "dinner 250g salmon 200g potatoes" });
  const id = second.body.turn.capture_food_note_id;
  repo.updateFoodNote(id, {
    ingredients: [
      { item: "salmon", amount: "300g" },
      { item: "potatoes", amount: "200g" },
    ],
  });
  assert.equal(applyFoodEstimate(id, { ...estimate, summary: "Salmon" }), false, "the person's edit wins");
  const kept = repo.getFoodNote(id);
  assert.equal(kept.parsed.ingredients[0].amount, "300g");
  assert.equal(kept.parsed.kcal ?? null, null);
});

function storedTurn(message, { recent = false } = {}) {
  const routing = classifyChatRoute({ message, recent_food_capture: recent });
  const user = repo.addChatMessage("user", message);
  return repo.createChatTurn({ message, routing, user_message_id: user.id, agent: "stub" });
}

test("corrections and questions never take the receipt lane, so no new note is written", () => {
  repo.addFoodNote("snack", "1 bar of Lindt dark chocolate", null);
  for (const [message, recent] of [
    ["no not the whole bar… one piece", true],
    ["lunch 200g more rice", true],
    ["lunch 200g chicken, is that enough protein?", false],
    ["breakfast 30g oats, actually make it 40g", false],
    ["lunch was 150g rice not 200g", true],
    ["snack 1 piece lindt, not the whole bar", true],
    ["dinner 200g salmon 150g rice for my wife", false],
  ]) {
    const turn = storedTurn(message, { recent });
    assert.equal(completeInstantFoodCapture(turn.id, message), null, message);
    assert.equal(repo.getChatTurn(turn.id).status, "queued", `${message}: left for the agent`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 1, "only the original snack exists");
});

test("a bare list answering the coach's question goes to the agent; a new meal under its own label logs at once", () => {
  repo.addChatMessage("assistant", "Logged your breakfast. Was there anything with the yogurt?");
  const answer = storedTurn("200g greek yogurt 30g granola");
  assert.equal(isInstantFoodCaptureDecision(answer.routing, answer.message), true, "the words alone read as a meal");
  assert.equal(completeInstantFoodCapture(answer.id, answer.message), null, "but after a question they are its answer");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM food_notes").get().n, 0);

  repo.addChatMessage("assistant", "Anything else for today?");
  const labeled = storedTurn("dinner 150g rice 200g salmon");
  const done = completeInstantFoodCapture(labeled.id, labeled.message);
  assert.ok(done?.note, "a named meal is a new entry whatever the coach asked");
  assert.equal(done.turn.status, "done");
});

test("a turn the receipt lane declines runs as an ordinary agent turn instead of hanging", async () => {
  repo.addChatMessage("assistant", "How much yogurt was that?");
  const turn = storedTurn("200g greek yogurt 30g granola");
  const terminal = new Promise((resolve) => {
    const off = onTurnEvent(turn.id, (e) => {
      if (e.type === "done" || e.type === "error" || e.type === "canceled") {
        off();
        resolve(e);
      }
    });
  });
  enqueueChatTurn(turn.id);
  const event = await terminal;
  const finished = repo.getChatTurn(turn.id);
  assert.ok(["done", "error"].includes(finished.status), finished.status);
  assert.notEqual(finished.meta?.instant_capture, true, "the agent path answered it, not the receipt lane");
  assert.equal(finished.capture_food_note_id ?? null, null);
  assert.ok(event.message, "an assistant message closes the turn");
});
