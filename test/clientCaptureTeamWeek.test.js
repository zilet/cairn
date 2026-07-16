import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.innerHTML = "";
    this.isConnected = true;
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
}

function loadCards() {
  const context = { Object, Array, String, Number, Date, Intl };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-cards-client.js"), "utf8"), context);
  return context.CairnCaptureReadCards;
}

const cardDeps = {
  api: async () => {},
  toast: () => {},
  collapseEl: () => {},
  escapeHtml,
  weekRangeLabel: () => "Jul 10 – 16",
};

const fullTeam = () => ({
  lead: "This week your team made 2 changes and is watching 1 response.",
  did: [
    {
      domain: "nutrition",
      label: "Nutrition",
      changes: [{ text: "Raised your target <2225>", specialist: "Nutrition lead: fuel <up>", when: "2026-07-14" }],
    },
  ],
  flagged: [{ kind: "directive", text: "Anchor meals around <fibre>", domain: "nutrition", when: "2026-07-13" }],
  watching: [{ text: "how your weight trend answers the nutrition change", through: "2026-07-22", source: "expectation" }],
  landed: [{ text: "Weight trend landed as expected", verdict: "aligned", when: "2026-07-12" }],
  insights: [{ id: 1, text: "Sleep <dipped> when mileage ramped", when: "2026-07-11", backlog: false }],
});

test("teamWeekSectionsHtml renders every populated section with escaping, domain labels, and the specialist voice", () => {
  const cards = loadCards();
  const html = cards.teamWeekSectionsHtml(fullTeam(), escapeHtml);

  assert.match(html, /Week in review/);
  assert.doesNotMatch(html, /What your team did/, "the old section name is gone");
  assert.match(html, /class="team-domain">Nutrition</);
  assert.match(html, /Raised your target &lt;2225&gt;/);
  assert.match(html, /class="team-voice">Nutrition lead: fuel &lt;up&gt;/);

  assert.match(html, /Waiting for you/);
  assert.match(html, /Anchor meals around &lt;fibre&gt;/);

  assert.match(html, /What we're watching/);
  assert.match(html, /how your weight trend answers the nutrition change/);
  assert.doesNotMatch(html, /Watching how your weight trend/, "the 'Watching' prefix is gone");
  assert.match(html, /· through Jul 22/);

  assert.match(html, /How it landed/);
  assert.match(html, /class="team-item team-good"/);
  assert.match(html, /Weight trend landed as expected/);

  assert.match(html, /Connections worth a look/);
  assert.match(html, /Sleep &lt;dipped&gt; when mileage ramped/);

  // No expander when nothing exceeds a display cap.
  assert.doesNotMatch(html, /team-fold/);

  assert.doesNotMatch(html, /<2225>|<up>|<fibre>|<dipped>/);
});

test("display caps fold the overflow into a quiet expander per section", () => {
  const cards = loadCards();
  const team = {
    lead: "",
    did: [
      {
        domain: "training",
        label: "Training",
        changes: [
          { text: "Change one", specialist: null, when: "2026-07-14" },
          { text: "Change two", specialist: null, when: "2026-07-13" },
          { text: "Change three", specialist: null, when: "2026-07-12" },
          { text: "Change four", specialist: null, when: "2026-07-11" },
        ],
      },
    ],
    flagged: [
      { kind: "directive", text: "Ask one", domain: "health", when: "2026-07-14" },
      { kind: "directive", text: "Ask two", domain: "health", when: "2026-07-13" },
      { kind: "directive", text: "Ask three", domain: "health", when: "2026-07-12" },
      { kind: "directive", text: "Ask four", domain: "health", when: "2026-07-11" },
    ],
    watching: [],
    landed: [],
    insights: [],
  };
  const html = cards.teamWeekSectionsHtml(team, escapeHtml);

  // Week in review: ≤2 per domain visible, the other two folded.
  assert.match(html, /Change one/);
  assert.match(html, /Change two/);
  assert.match(html, /<details class="team-fold"><summary class="team-fold-sum">Show 2 more/);
  // Waiting for you: ≤3 visible, one folded.
  assert.match(html, /Ask three/);
  assert.match(html, /Show 1 more/);
  // The folded items are still present in the DOM (behind the disclosure).
  assert.match(html, /Change four/);
  assert.match(html, /Ask four/);
});

test("teamWeekSectionsHtml and teamWeekHasContent stay quiet on an empty week", () => {
  const cards = loadCards();
  const empty = { lead: "", did: [], flagged: [], watching: [], landed: [], insights: [] };
  assert.equal(cards.teamWeekSectionsHtml(empty, escapeHtml), "");
  assert.equal(cards.teamWeekSectionsHtml(null, escapeHtml), "");
  assert.equal(cards.teamWeekHasContent(empty), false);
  assert.equal(cards.teamWeekHasContent(null), false);
  assert.equal(cards.teamWeekHasContent(fullTeam()), true);
});

test("the weekly card leads with the agentic sentence, then the deterministic team sections", () => {
  const cards = loadCards();
  const target = new FakeElement("weeklySlot");
  cards.renderWeeklyInSlot(
    target,
    { id: 1, kind: "weekly_read", text: "The week went well.", next_step: "Hold the target.", status: "seen" },
    cardDeps,
    fullTeam(),
  );
  assert.match(target.innerHTML, /weekly-text">The week went well\./);
  assert.match(target.innerHTML, /One change/);
  assert.match(target.innerHTML, /team-week/);
  assert.match(target.innerHTML, /Week in review/);
});

test("with no agentic weekly read, the deterministic team body stands alone under a calm lead", () => {
  const cards = loadCards();
  const target = new FakeElement("weeklySlot");
  cards.renderTeamWeekInSlot(target, fullTeam(), cardDeps);
  assert.match(target.innerHTML, /Your team this week/);
  assert.match(target.innerHTML, /This week your team made 2 changes/);
  assert.match(target.innerHTML, /Week in review/);
  // No feedback foot — there is no agentic insight to react to.
  assert.doesNotMatch(target.innerHTML, /data-ifb/);
});

test("the standalone team card renders nothing when the week is empty", () => {
  const cards = loadCards();
  const target = new FakeElement("weeklySlot");
  cards.renderTeamWeekInSlot(target, { lead: "", did: [], flagged: [], watching: [], landed: [], insights: [] }, cardDeps);
  assert.equal(target.innerHTML, "");
});

// ---- loadTodayReads wiring: the standalone-team-card degradation path ----
function loadCaptureReads(cards) {
  const context = { Object, Array, String, Promise };
  context.window = context;
  context.CairnCaptureReadDate = { weekRangeLabel: () => "" };
  context.CairnCaptureReadCards = cards;
  context.CairnCaptureReadJobs = {
    createController: () => ({
      maybeGenerateWeekly: () => {},
      maybeGenerateInsight: () => {},
      reconnectInsight: () => null,
    }),
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-reads-client.js"), "utf8"), context);
  return context.CairnCaptureReads;
}

test("loadTodayReads shows the standalone team card when there is no agentic weekly read but the team has content", async () => {
  const calls = [];
  const captureReads = loadCaptureReads({
    renderInsightInSlot: () => {},
    renderWeeklyInSlot: () => calls.push("weekly"),
    renderTeamWeekInSlot: (_target, team) => calls.push(["team", team]),
    teamWeekHasContent: (t) => !!(t && Array.isArray(t.did) && t.did.length),
    teamWeekSectionsHtml: () => "",
  });

  const wSlot = new FakeElement("weeklySlot");
  const rootEl = { querySelector: (sel) => (sel === "#weeklySlot" ? wSlot : null) };
  const team = fullTeam();
  const deps = {
    root: rootEl,
    state: { tab: "today" },
    api: async (path) => {
      if (path === "/insights") return []; // no weekly_read insight yet
      if (path === "/team-week") return team;
      return null;
    },
    runOp: () => {},
    toast: () => {},
    collapseEl: () => {},
    escapeHtml,
    storage: null,
  };

  const controller = captureReads.createController(deps);
  await controller.loadTodayReads();
  await flush();

  assert.equal(calls.some((c) => c === "weekly"), false, "no agentic weekly card was rendered");
  const teamCall = calls.find((c) => Array.isArray(c) && c[0] === "team");
  assert.ok(teamCall, "the standalone team card was rendered");
  assert.equal(teamCall[1], team);
});
