// A mistyped load used to sit in the log with no signal, and then poison
// progression. The set is still saved — the log is truth — and a same-sign load
// more than 60% off the recent median comes back as an advisory. Assist-sign
// normalization is unchanged.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { db, repo } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";

beforeEach(() => {
  for (const t of ["logged_sets", "sessions", "exercises"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist yet */
    }
  }
});

function log(exercise, weight, date, reps = 5) {
  return repo.logSetByName({ exercise, weight, reps, date });
}

function seed(exercise, weights, start = "2031-05-01") {
  return weights.map((weight, index) => {
    const day = String(index + 1).padStart(2, "0");
    return log(exercise, weight, `${start.slice(0, 8)}${day}`);
  });
}

test("exact 60% is quiet and one step past it is an advisory, and the set is always saved", () => {
  seed("Barbell Bench Press", [100, 100, 100, 100]);

  const highEdge = log("Barbell Bench Press", 160, "2031-05-10");
  assert.equal(highEdge.weight, 160);
  assert.equal(highEdge.weight_check, undefined);
  assert.equal(db.prepare(`SELECT weight FROM logged_sets WHERE id = ?`).get(highEdge.id).weight, 160);

  const lowEdge = log("Barbell Bench Press", 40, "2031-05-11");
  assert.equal(lowEdge.weight, 40);
  assert.equal(lowEdge.weight_check, undefined);

  const high = log("Barbell Bench Press", 161, "2031-05-12");
  assert.equal(high.weight, 161);
  assert.equal(high.weight_check.kind, "unusually_high");
  assert.equal(high.weight_check.recent_median, 100);

  const low = log("Barbell Bench Press", 39, "2031-05-13");
  assert.equal(low.weight, 39);
  assert.equal(low.weight_check.kind, "unusually_low");
  assert.equal(low.weight_check.recent_median, 100);
});

test("45 against a 115 median flags, and 135 against 230 does not", () => {
  seed("Barbell Bench Press", [100, 110, 115, 120, 130]);
  const bench = log("Barbell Bench Press", 45, "2031-05-10");
  assert.equal(bench.weight, 45);
  assert.equal(bench.weight_check.kind, "unusually_low");
  assert.equal(bench.weight_check.recent_median, 115);

  seed("Seated Leg Press", [220, 230, 230, 240], "2031-06-01");
  const press = log("Seated Leg Press", 135, "2031-06-10");
  assert.equal(press.weight, 135);
  assert.equal(press.weight_check, undefined);
  assert.equal(db.prepare(`SELECT weight FROM logged_sets WHERE id = ?`).get(press.id).weight, 135);
});

test("fewer than four prior sessions, a zero, and a bodyweight set carry no advisory", () => {
  seed("Overhead Press", [40, 40, 40]);
  const early = log("Overhead Press", 20, "2031-05-10");
  assert.equal(early.weight, 20);
  assert.equal(early.weight_check, undefined);

  const zero = log("Overhead Press", 0, "2031-05-11");
  assert.equal(zero.weight, 0);
  assert.equal(zero.weight_check, undefined);

  const body = log("Pull Up", null, "2031-05-12", 8);
  assert.equal(body.weight, null);
  assert.equal(body.weight_check, undefined);
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM logged_sets WHERE exercise_id = (SELECT id FROM exercises WHERE name = 'Pull Up')`
      )
      .get().n,
    1
  );
});

test("the reference is each prior session's top set: warm-ups neither inflate nor deflate it", () => {
  // Five sessions of 60/80 warm-ups then a 100 top set: a per-set median would sit
  // at 80 and call an ordinary 120 top "heavy"; the top-set median is 100.
  for (let day = 1; day <= 5; day++) {
    const date = `2031-05-0${day}`;
    log("Barbell Bench Press", 60, date);
    log("Barbell Bench Press", 80, date);
    log("Barbell Bench Press", 100, date);
  }
  const top = log("Barbell Bench Press", 120, "2031-05-10");
  assert.equal(top.weight_check, undefined);
  const warm = log("Barbell Bench Press", 45, "2031-05-10");
  assert.equal(warm.weight_check, undefined, "45 is 55% under a 100 reference, inside the band");
  const far = log("Barbell Bench Press", 161, "2031-05-11");
  assert.equal(far.weight_check.kind, "unusually_high");
  assert.equal(far.weight_check.recent_median, 100);
});

test("sets of one session never make four sessions, and a stale history is ignored", () => {
  for (const w of [100, 100, 100, 100, 100]) log("Barbell Bench Press", w, "2031-05-01");
  assert.equal(log("Barbell Bench Press", 20, "2031-05-10").weight_check, undefined);
  seed("Back Squat", [100, 100, 100, 100], "2030-01-01");
  assert.equal(log("Back Squat", 20, "2031-05-10").weight_check, undefined);
});

test("assist-sign normalization is unchanged and the advisory stays on the stored sign", () => {
  seed("Assisted Dip", [-30, -30, -30, -30]);

  const slipped = log("Assisted Dip", 28, "2031-05-10");
  assert.equal(slipped.weight, -28);
  assert.equal(slipped.normalized, "assist_sign");
  assert.equal(slipped.weight_check, undefined);
  assert.equal(slipped.est_1rm, null);
  const priors = db
    .prepare(
      `SELECT weight FROM logged_sets WHERE exercise_id = (SELECT id FROM exercises WHERE name = 'Assisted Dip') AND id != ? ORDER BY id`
    )
    .all(slipped.id);
  assert.deepEqual(
    priors.map((row) => row.weight),
    [-30, -30, -30, -30]
  );

  const weighted = log("Assisted Dip", 200, "2031-05-11");
  assert.equal(weighted.weight, 200);
  assert.equal(weighted.normalized, undefined);
  assert.equal(weighted.weight_check, undefined);
  assert.ok(weighted.est_1rm > 0);

  const exact = log("Assisted Dip", -48, "2031-05-12");
  assert.equal(exact.weight, -48);
  assert.equal(exact.normalized, undefined);
  assert.equal(exact.weight_check, undefined);

  const moreAssist = log("Assisted Dip", -49, "2031-05-13");
  assert.equal(moreAssist.weight, -49);
  assert.equal(moreAssist.weight_check.kind, "unusually_low");
  assert.equal(moreAssist.weight_check.recent_median, -30);
});

test("a chat log_set keeps the advisory on the saved set", () => {
  seed("Barbell Bench Press", [100, 110, 115, 120, 130]);
  const turn = applyChatActions(
    { actions: [{ type: "log_set", exercise: "Barbell Bench Press", weight: 45, reps: 5, date: "2031-05-20" }] },
    { agent: "stub", message: "bench was 45 for 5" }
  );
  assert.equal(turn.applied.length, 1);
  assert.equal(turn.applied[0].type, "log_set");
  assert.equal(turn.applied[0].result.weight, 45);
  assert.equal(turn.applied[0].result.weight_check.kind, "unusually_low");
  assert.equal(turn.applied[0].result.weight_check.recent_median, 115);
});

function loadSetModel() {
  class El {
    constructor(className = "") {
      this.className = className;
      this.children = [];
      this.dataset = {};
      this.parentElement = null;
      this.isConnected = false;
      this.listeners = {};
      this.textContent = "";
      this.type = "";
    }
    matches(sel) {
      if (sel === "[data-weight-check]") return this.dataset.weightCheck != null;
      if (sel === ".logrow") return this.className.split(/\s+/).includes("logrow");
      if (sel === ".ex") return this.className.split(/\s+/).includes("ex");
      return false;
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node && typeof node === "object") node.parentElement = this;
        this.children.push(node);
      }
    }
    appendChild(node) {
      this.append(node);
      return node;
    }
    insertBefore(node, anchor) {
      node.parentElement = this;
      const index = this.children.indexOf(anchor);
      if (index < 0) this.children.push(node);
      else this.children.splice(index, 0, node);
    }
    querySelector(sel) {
      const walk = (el) => {
        if (!el || typeof el.matches !== "function") return null;
        if (el.matches(sel)) return el;
        for (const child of el.children) {
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
  }
  const document = {
    createElement: (tag) => new El(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelector: () => null,
  };
  const context = { document, setTimeout, clearTimeout, console };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(
    readFileSync(join(import.meta.dirname, "..", "public/js/today-session-set-model.js"), "utf8"),
    context
  );
  return { model: context.CairnTodaySessionSetModel, El, document };
}

test("the quiet line names the direction without a number and dismisses", () => {
  const { model, El } = loadSetModel();
  const lines = [
    model.weightCheckLine("unusually_high", 185),
    model.weightCheckLine("unusually_low", 45),
    model.weightCheckLine("unusually_high", -20),
    model.weightCheckLine("unusually_low", -80),
  ];
  assert.deepEqual(lines, [
    "Heavier than your recent sets — fine if that's right",
    "Lighter than your recent sets — fine if that's right",
    "Less assistance than your recent sets — fine if that's right",
    "More assistance than your recent sets — fine if that's right",
  ]);
  for (const line of lines) assert.equal(/\d/.test(line), false);
  assert.equal(model.weightCheckLine("fine", 100), null);

  const card = new El("ex");
  card.isConnected = true;
  const logrow = new El("logrow");
  card.append(logrow);
  model.showWeightCheck(card, { weight: 45, weight_check: { kind: "unusually_low", recent_median: 115 } });
  model.showWeightCheck(card, { weight: 45, weight_check: { kind: "unusually_low", recent_median: 115 } });
  const notes = card.children.filter((child) => child.matches && child.matches("[data-weight-check]"));
  assert.equal(notes.length, 1);
  assert.equal(card.children[0], notes[0]);
  assert.equal(card.children[1], logrow);
  const span = notes[0].children.find((child) => String(child.textContent || "").startsWith("Lighter"));
  assert.equal(span.textContent, "Lighter than your recent sets — fine if that's right");
  const button = notes[0].children.find((child) => child.textContent === "Dismiss");
  assert.equal(button.className, "linkbtn linkbtn-quiet");
  const event = {
    defaultPrevented: false,
    propagation: true,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagation = false;
    },
  };
  for (const fn of button.listeners.click) fn(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.propagation, false);
  assert.equal(card.querySelector("[data-weight-check]"), null);
});
