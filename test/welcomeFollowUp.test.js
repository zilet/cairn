// Meet's ONE follow-up question (src/coachOps/welcome-follow-up.ts): asked only when the
// person mentioned running or a race and has not already said their run days (or, with a
// goal to anchor it, their weekly distance); the answer is read from their own words and
// lands through the existing setters — the stated endurance_schedule and the goal's
// weekly_km the race build starts from. Calm, one question, never a form.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import {
  WELCOME_FOLLOW_UP_QUESTIONS,
  answerWelcomeFollowUp,
  parseRunFollowUpAnswer,
  welcomeRunFollowUp,
} from "../dist/coachOps.js";
import { getEnduranceGoal, getEnduranceSchedule, setProfile } from "../dist/repo/profile.js";
import { setSettings } from "../dist/repo/settings.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { personContextRouter } from "../dist/routes/person-context.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { createFakeTimers, createHost, flush, loadClientModule } from "./_dom.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const race = () =>
  setProfile({
    endurance_goal: {
      mode: "race",
      event: "Half marathon",
      date: addDaysISO(localDateISO(), 40),
      distance_km: 21.1,
    },
  });

test("no running in their words and no goal: nothing is asked", () => {
  assert.equal(welcomeRunFollowUp("I want to get stronger, lifting Mon/Wed/Fri."), null);
});

test("a race with nothing said about days or distance asks both, in one question", () => {
  race();
  const ask = welcomeRunFollowUp("Half marathon in November, lifting upper/lower.");
  assert.deepEqual(plain(ask.asks), ["days", "volume"]);
  assert.ok(WELCOME_FOLLOW_UP_QUESTIONS.both.includes(ask.question));
  assert.equal((ask.question.match(/\?/g) || []).length, 1, "one question");
});

test("what was already said is not asked again", () => {
  race();
  setProfile({ endurance_schedule: { days: [{ dow: 3, kind: "quality" }], source: "chat" } });
  assert.deepEqual(plain(welcomeRunFollowUp("Half in November.").asks), ["volume"]);
  setProfile({ endurance_goal: { ...getEnduranceGoal(), weekly_km: 30 } });
  assert.equal(welcomeRunFollowUp("Half in November."), null, "days and distance both known");
});

test("running mentioned without a goal asks only the days (the distance has nowhere to land)", () => {
  const ask = welcomeRunFollowUp("I lift three days and run a bit too.");
  assert.deepEqual(plain(ask.asks), ["days"]);
  assert.ok(WELCOME_FOLLOW_UP_QUESTIONS.days.includes(ask.question));
});

test("only genuine running or race intent asks; an idiom or a negation does not", () => {
  for (const words of [
    "I don't run and have no races planned",
    "I run a tight ship at work and want to get stronger",
    "In the long run I want to be strong",
    "I'm running late most days, so short lifts please",
    "I run my own company, three lifting days",
    "I walk 10k steps a day and lift Mon/Wed/Fri",
  ]) {
    assert.equal(welcomeRunFollowUp(words), null, words);
  }
  for (const words of [
    "Half marathon in November",
    "I jog on weekends and lift three days",
    "Not a runner, but I want to do a 5k",
    "Lifting four days, and I run 3x a week",
    "Training for a 10k",
  ]) {
    assert.ok(welcomeRunFollowUp(words), words);
  }
});

// The reviewer's table: each answer must read exactly this, and nothing more.
const ANSWERS = [
  // A long run's distance is never the week's volume.
  ["I run 4 days a week; my long run is 15 km", [], null],
  // Count times a per-run distance, when it is the answer's one distance.
  ["3x a week, 5 km each", [], 15],
  ["twice a week, 8k each, plus a 15k long run", [], null],
  // A race distance is not a volume.
  ["Tuesdays and Sundays, training for a 10k", [2, 0], null],
  // "sat" the verb and "sun" the noun are not days.
  ["I sat out most of last month but usually Tue and Thu", [2, 4], null],
  ["in the sun on weekends", [6, 0], null],
  // A ruled-out day never lands.
  ["Not Mondays — Tue, Thu and Sun", [2, 4, 0], null],
  ["I don't run on Mondays, but Tue/Thu", [2, 4], null],
  ["Monday is rest, Tue/Thu/Sat", [2, 4, 6], null],
  ["Mon-Fri except Wednesday", [1, 2, 4, 5], null],
  // Ranges.
  ["Mon-Fri easy", [1, 2, 3, 4, 5], null],
  ["Monday to Friday", [1, 2, 3, 4, 5], null],
  // Per-week distances, said at the distance.
  ["20 miles a week", [], 32.2],
  ["I run 30 km a week", [], 30],
  ["20-30 km per week", [], 25],
  ["weekly mileage of about 25 km", [], 25],
  ["long run on Sun, a 40k week", [0], 40],
  ["sat/sun", [6, 0], null],
  ["not sure yet", [], null],
];

test("the answer table: days and weekly volume read exactly as said", () => {
  for (const [words, dows, weekly] of ANSWERS) {
    const read = parseRunFollowUpAnswer(words);
    assert.deepEqual(plain(read.days.map((d) => d.dow)), dows, `days of: ${words}`);
    assert.equal(read.weekly_km, weekly, `weekly of: ${words}`);
  }
  assert.ok(
    parseRunFollowUpAnswer("Mon-Fri easy").days.every((d) => d.kind === "easy"),
    "a range keeps the kind its clause gave"
  );
});

test("a weekly distance in miles lands in km and is said back in miles", () => {
  race();
  setSettings({ run_units: "mi" });
  const out = answerWelcomeFollowUp("Tuesdays and Saturdays, 20 miles a week");
  assert.equal(getEnduranceGoal().weekly_km, 32.2);
  assert.match(out.reply, /20 mi a week/);
});

test("the reply says what landed, and only that", () => {
  race();
  const daysOnly = answerWelcomeFollowUp("Tuesdays and Saturdays, training for a 10k");
  assert.deepEqual(plain(daysOnly.applied.run_days), [2, 6]);
  assert.equal(daysOnly.applied.weekly_km, null);
  assert.doesNotMatch(daysOnly.reply, /either/);
  assert.match(daysOnly.reply, /You can change the days/);
  assert.match(daysOnly.reply, /didn't catch a weekly distance/);
  assert.equal(violatesReadingGrammar(daysOnly.reply), null);

  const volumeOnly = answerWelcomeFollowUp("about 30 km a week");
  assert.equal(volumeOnly.applied.weekly_km, 30);
  assert.doesNotMatch(volumeOnly.reply, /either/);
  assert.match(volumeOnly.reply, /You can change that distance/);
  assert.equal(violatesReadingGrammar(volumeOnly.reply), null);
});

test("days already set: the reply says they stay, never that it could not pick them out", () => {
  setProfile({ endurance_schedule: { days: [{ dow: 2, kind: "any" }], source: "athlete" } });
  const out = answerWelcomeFollowUp("Fridays and Sundays");
  assert.deepEqual(plain(out.applied.run_days), []);
  assert.match(out.reply, /already set/);
  assert.doesNotMatch(out.reply, /couldn't pick out/);
  assert.equal(violatesReadingGrammar(out.reply), null);
});

test("every phrasing holds the reading grammar and asks one question", () => {
  for (const set of Object.values(WELCOME_FOLLOW_UP_QUESTIONS)) {
    assert.ok(set.length >= 3);
    for (const text of set) {
      assert.equal(violatesReadingGrammar(text), null, text);
      assert.equal((text.match(/\?/g) || []).length, 1, text);
    }
  }
});

test("the answer is read from their words: weekdays with the kind they gave, and a weekly distance", () => {
  const a = parseRunFollowUpAnswer("Tuesday and Thursday easy, long run Sunday, about 25 miles a week");
  assert.deepEqual(plain(a.days), [
    { dow: 2, kind: "easy" },
    { dow: 4, kind: "easy" },
    { dow: 0, kind: "long" },
  ]);
  assert.equal(a.weekly_km, 40.2);
  const b = parseRunFollowUpAnswer("weekends, 30k");
  assert.deepEqual(plain(b.days.map((d) => d.dow)), [6, 0]);
  assert.equal(b.weekly_km, null, "a bare distance is not said to be the week's");
  const c = parseRunFollowUpAnswer("Saturdays, my long run is 16 km");
  assert.equal(c.weekly_km, null, "the long run's distance is not the week's");
  const d = parseRunFollowUpAnswer("not sure yet");
  assert.deepEqual(plain(d), { days: [], weekly_km: null });
  assert.equal(parseRunFollowUpAnswer("20-30 km per week").weekly_km, 25);
});

test("answering lands the run days and the starting volume through the existing setters", () => {
  race();
  const out = answerWelcomeFollowUp("Wednesdays for intervals, long run Saturday, easy Monday. Around 32 km a week.");
  assert.equal(out.ok, true);
  assert.deepEqual(plain(out.applied.run_days), [1, 3, 6]);
  const byDow = Object.fromEntries(getEnduranceSchedule().days.map((d) => [d.dow, d.kind]));
  assert.deepEqual(byDow, { 1: "easy", 3: "quality", 6: "long" });
  assert.equal(getEnduranceGoal().weekly_km, 32);
  assert.equal(out.applied.weekly_km, 32);
  assert.match(out.reply, /Monday, Wednesday and Saturday/);
  assert.equal(violatesReadingGrammar(out.reply), null);
});

test("an answer never overwrites days already stated, and an unreadable one is said plainly", () => {
  setProfile({ endurance_schedule: { days: [{ dow: 2, kind: "any" }], source: "athlete" } });
  const out = answerWelcomeFollowUp("Fridays");
  assert.deepEqual(plain(out.applied.run_days), []);
  assert.deepEqual(plain(getEnduranceSchedule().days.map((d) => d.dow)), [2]);
  const blank = answerWelcomeFollowUp("no idea");
  assert.match(blank.reply, /couldn't pick out/);
});

test("POST /welcome/follow-up answers at once; a blank body is a 400", () => {
  const layer = personContextRouter.stack.find(
    (entry) => entry.route?.path === "/welcome/follow-up" && entry.route?.methods?.post
  );
  assert.ok(layer, "registered");
  const handle = layer.route.stack[0].handle;
  const res = () => ({
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  });
  const blank = res();
  handle({ body: { text: "  " } }, blank);
  assert.equal(blank.statusCode, 400);
  const ok = res();
  handle({ body: { text: "Tuesdays and Saturdays" } }, ok);
  assert.equal(ok.payload.ok, true);
  assert.deepEqual(plain(ok.payload.applied.run_days), [2, 6]);
});

// ---------- client: Meet asks once, and the composer answers it ----------

const PROVIDER = {
  name: "claude",
  label: "Claude",
  plan: "Claude Pro or Max",
  usable: true,
  present: true,
  installable: true,
  canLogin: true,
  configured: true,
  signedIn: true,
};
const QUESTION = "One quick thing so the runs land in the right places: which days do you usually run?";

function meet() {
  const timers = createFakeTimers();
  const rec = { enqueued: [], streams: [], posts: [] };
  const win = loadClientModule(
    [
      "html-utils",
      "ui-stone-model",
      "ui-stone",
      "welcome-model",
      "welcome-client",
      "welcome-meet-run",
      "welcome-meet-controller",
    ],
    {
      globals: {
        ...timers,
        reducedMotion: () => true,
        matchMedia: () => ({ matches: false }),
        api: async (path, opts) => {
          if (path === "/agent-jobs") return { ok: true, jobs: [] };
          if (path === "/welcome/follow-up") {
            rec.posts.push(JSON.parse(opts.body));
            return { ok: true, reply: "Got it: your runs go on Tuesday and Saturday.", week: null };
          }
          return null;
        },
        enqueueJob: async (path, body) => {
          rec.enqueued.push({ path, body });
          return { ok: true, job: { id: 42 } };
        },
        openJobStream: (id, handlers) => rec.streams.push({ id, handlers }),
        teardownJobs: () => {},
        thinkingCaption: () => () => {},
        CairnCoachLink: { invalidate: () => {} },
      },
    }
  );
  const host = createHost(win.document, { html: win.CairnWelcomeClient.meetHtml(PROVIDER) });
  win.CairnWelcomeMeet.mount(host, {
    provider: PROVIDER,
    onReconnect: () => {},
    onDone: () => {},
    onSkip: () => {},
  });
  return { win, host, rec, timers };
}

test("Meet: the question follows the reply, and the composer answers it rather than starting over", async () => {
  const { host, rec } = meet();
  const input = host.querySelector(".wel-text");
  const form = host.querySelector(".wel-compose");
  input.value = "Half in November, lifting upper/lower.";
  form.dispatchEvent(new host.ownerDocument.defaultView.Event("submit", { cancelable: true }));
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(rec.enqueued.length, 1);
  const stream = rec.streams[0];
  stream.handlers.onPhase({
    status: "running",
    meta: { step: "fuel", reply: "Thanks, a clear picture.", follow_up: { asks: ["days"], question: QUESTION } },
  });
  const asked = host.querySelector("[data-wel-followup]");
  assert.ok(asked, "the question is painted");
  assert.match(asked.textContent, /which days do you usually run/);
  assert.equal(input.disabled, false, "the composer is open for the answer");
  // The week starts composing: the answer box stays, with "look around" beneath it.
  stream.handlers.onPhase({
    status: "running",
    meta: { step: "week", reply: "Thanks, a clear picture.", follow_up: { asks: ["days"], question: QUESTION } },
  });
  assert.ok(host.querySelector(".wel-compose"), "still answerable while the week composes");
  assert.ok(host.querySelector("[data-wel-leave]"));
  assert.equal(host.querySelectorAll("[data-wel-followup]").length, 1, "asked once");
  input.value = "Tuesdays and Saturdays";
  form.dispatchEvent(new host.ownerDocument.defaultView.Event("submit", { cancelable: true }));
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(rec.enqueued.length, 1, "no second welcome");
  assert.deepEqual(rec.posts, [{ text: "Tuesdays and Saturdays" }]);
  assert.match(host.textContent, /your runs go on Tuesday and Saturday/);
  assert.equal(host.querySelector(".wel-compose"), null, "answered: the dock goes back to waiting");
});
