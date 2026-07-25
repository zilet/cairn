// Client consumption of the server's Today LEAD arbitration: the Brief yields
// its emphasis, the winning surface moves into the main column, and everything
// stays present and reachable. Absent decision → byte-identical to before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function escAttr(value) {
  return escHtml(value).replaceAll('"', "&quot;");
}

function loadTodayBrief() {
  const context = { Array, Math, Number, Object, String, escHtml, escAttr };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-brief-client.js"), "utf8"), context);
  return context.CairnTodayBrief;
}

function loadMainShell() {
  const context = { Object, String };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-main-shell-client.js"), "utf8"), context);
  return context.CairnTodayMainShell;
}

function loadRailController() {
  const context = { Array, Number, Object, Set, String };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-rail-controller.js"), "utf8"), context);
  return context.CairnTodayRailController;
}

// ---- the smallest DOM the promotion path actually touches -------------------
// No jsdom in this zero-dependency harness, so model exactly the surface used:
// querySelector / setAttribute / closest / appendChild / remove.
function makeElement(name, options = {}) {
  // `contains` maps a selector the code queries → the descendant it should find.
  const contains = options.contains || {};
  return {
    name,
    attrs: {},
    children: [],
    removed: false,
    inMore: !!options.inMore,
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    closest(selector) {
      return selector === "#todayMore" && this.inMore ? { name: "#todayMore" } : null;
    },
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
    },
    remove() {
      this.removed = true;
    },
    querySelector(selector) {
      const found = contains[selector];
      return found && !found.removed ? found : null;
    },
  };
}

function makeRoot(elements) {
  return {
    elements,
    querySelector(selector) {
      const el = elements[selector];
      return el && !el.removed ? el : null;
    },
  };
}

const ATTENTION = (primary) => ({
  primary,
  brief_state: "repeat_of_yesterday",
  items: [
    { surface: primary, tier: "lead" },
    { surface: "brief", tier: "supporting" },
  ],
});

// ---- the Brief -------------------------------------------------------------

test("the Brief yields its emphasis when another surface leads, keeping every control", () => {
  const brief = loadTodayBrief();
  const read = {
    kind: "rest",
    headline: "Rest today.",
    why: "Nothing's moved since yesterday.",
    focus: null,
    est_minutes: null,
    signals: {},
    attention: ATTENTION("insight"),
  };

  const html = brief.briefHtml(read, { isToday: true, showPlan: false });

  assert.match(html, /class="brief brief-rest reveal brief-quiet"/);
  assert.match(html, /data-attention="supporting"/);
  // Quieter, never gone: the headline, the why, and the ways in all remain.
  assert.match(html, /Rest today\./);
  assert.match(html, /Nothing&#039;s moved since yesterday\.|Nothing's moved since yesterday\./);
  assert.match(html, /data-redirect="reveal-plan"/);
  assert.match(html, /data-redirect="ask-session"/);
  assert.match(html, /class="brief-steer"/);
});

test("the Brief keeps the lead band when the decision names it primary", () => {
  const brief = loadTodayBrief();
  const html = brief.briefHtml(
    {
      kind: "train",
      headline: "Good to go",
      why: "Ready.",
      focus: "Lower",
      est_minutes: 45,
      signals: {},
      attention: { primary: "brief", brief_state: "new_read", items: [{ surface: "brief", tier: "lead" }] },
    },
    { isToday: true }
  );

  assert.doesNotMatch(html, /brief-quiet/);
  assert.match(html, /data-attention="lead"/);
});

test("a payload with no decision renders byte-identically to one before the field existed", () => {
  const brief = loadTodayBrief();
  const base = { kind: "train", headline: "Good to go", why: "Ready.", focus: "Lower", est_minutes: 45, signals: {} };

  const before = brief.briefHtml(base, { isToday: true, showPlan: false });
  const withUndefined = brief.briefHtml({ ...base, attention: undefined }, { isToday: true, showPlan: false });
  const withNull = brief.briefHtml({ ...base, attention: null }, { isToday: true, showPlan: false });

  assert.equal(withUndefined, before);
  assert.equal(withNull, before);
  assert.doesNotMatch(before, /brief-quiet|data-attention/);
});

test("gaining or losing the lead is a material repaint; the rest of the decision is not", () => {
  const brief = loadTodayBrief();
  const base = { kind: "rest", headline: "Rest today.", why: "Quiet.", focus: null, est_minutes: null, signals: {} };

  assert.equal(brief.materiallyDiffers(base, { ...base, attention: ATTENTION("brief") }), false);
  assert.equal(brief.materiallyDiffers(base, { ...base, attention: ATTENTION("insight") }), true);
  // Same lead, different ordering behind it → no repaint.
  const a = { ...base, attention: ATTENTION("insight") };
  const b = {
    ...base,
    attention: { primary: "insight", brief_state: "settled_quiet", items: [{ surface: "insight", tier: "lead" }] },
  };
  assert.equal(brief.materiallyDiffers(a, b), false);
});

test("attentionPrimary and yieldsLead are null-safe", () => {
  const brief = loadTodayBrief();
  assert.equal(brief.attentionPrimary(null), "");
  assert.equal(brief.attentionPrimary({}), "");
  assert.equal(brief.attentionPrimary({ attention: {} }), "");
  assert.equal(brief.yieldsLead(undefined), false);
  assert.equal(brief.yieldsLead({ attention: { primary: "brief" } }), false);
  assert.equal(brief.yieldsLead({ attention: { primary: "weekly" } }), true);
});

// ---- the main-column lead container ----------------------------------------

test("the Today lead reserves the promotion container without disturbing the shell", () => {
  const shell = loadMainShell();
  const html = shell.leadHtml(
    { isToday: true, briefHtml: `<section id="brief">Rest today.</section>`, conductorHtml: "", currentWeight: 172.4 },
    { escapeHtml: String }
  );

  assert.match(html, /id="attentionLead"/);
  // It sits under the coach's voice and above the capture row.
  assert.ok(html.indexOf(`id="cfocusSlot"`) < html.indexOf(`id="attentionLead"`));
  assert.ok(html.indexOf(`id="attentionLead"`) < html.indexOf(`id="wtChipMini"`));
  // Everything that was reachable before still is.
  assert.match(html, /id="ctxBanner"/);
  assert.match(html, /id="sugSlot"/);
  assert.match(html, /id="wtChipMini"/);
});

// ---- promotion -------------------------------------------------------------

test("the winning rail card moves into the main column — same element, marked as the lead", () => {
  const rail = loadRailController();
  const insight = makeElement("#insightSlot");
  const lead = makeElement("#attentionLead");
  const mast = makeElement(".rail-mast");
  const railEl = makeElement(".today-rail", {
    // Another card is still in the rail, so the masthead earns its keep.
    contains: { ".card-stack-item, .today-more, .agenda-card": makeElement("#qlRecent"), ".rail-mast": mast },
  });
  const dom = makeRoot({ "#insightSlot": insight, "#attentionLead": lead, ".today-rail": railEl });

  rail.promoteAttentionLead(dom, ATTENTION("insight"));

  assert.equal(lead.children.length, 1);
  assert.equal(lead.children[0], insight, "the SAME slot moved, never a copy");
  assert.equal(insight.attrs["data-attention"], "lead");
  assert.equal(railEl.removed, false);
  assert.equal(mast.removed, false);
});

test("the feedback capture is marked in place, never torn out of its session card", () => {
  const rail = loadRailController();
  const feedback = makeElement("#feedbackSlot");
  const lead = makeElement("#attentionLead");
  const dom = makeRoot({ "#feedbackSlot": feedback, "#attentionLead": lead });

  rail.promoteAttentionLead(dom, ATTENTION("feedback"));

  assert.equal(feedback.attrs["data-attention"], "lead");
  assert.equal(lead.children.length, 0, "it stays where the moment it belongs to lives");
});

test("a card the surprise budget deferred behind 'more' stays waiting — pull, never push", () => {
  const rail = loadRailController();
  const weekly = makeElement("#weeklySlot", { inMore: true });
  const lead = makeElement("#attentionLead");
  const dom = makeRoot({ "#weeklySlot": weekly, "#attentionLead": lead });

  rail.promoteAttentionLead(dom, ATTENTION("weekly"));

  assert.equal(lead.children.length, 0);
  assert.equal(weekly.attrs["data-attention"], undefined);
});

test("a masthead left standing over no cards retires — but never the rail itself", () => {
  const rail = loadRailController();
  const fuel = makeElement("#fuelSlot");
  const lead = makeElement("#attentionLead");
  const mast = makeElement(".rail-mast");
  // No card selector resolves → the promoted slot was the rail's last card.
  const railEl = makeElement(".today-rail", { contains: { ".rail-mast": mast } });
  const dom = makeRoot({ "#fuelSlot": fuel, "#attentionLead": lead, ".today-rail": railEl });

  rail.promoteAttentionLead(dom, ATTENTION("fuel"));

  assert.equal(mast.removed, true, "an 'Also worth a look' header over nothing is litter");
  assert.equal(railEl.removed, false, "removing the aside would take other slots with it");
  assert.equal(lead.children[0], fuel);
});

// The FALLBACK rail (no agenda: offline, or the route unavailable) has no mast and
// its slots carry no `card-stack-item` class — promotion must leave every one of
// its remaining cards mounted and reachable.
test("promoting out of the fallback rail leaves its other slots mounted", () => {
  const rail = loadRailController();
  const insight = makeElement("#insightSlot");
  const lead = makeElement("#attentionLead");
  const railEl = makeElement(".today-rail", { contains: {} }); // no mast, no card-stack-items
  const dom = makeRoot({ "#insightSlot": insight, "#attentionLead": lead, ".today-rail": railEl });

  rail.promoteAttentionLead(dom, ATTENTION("insight"));

  assert.equal(lead.children[0], insight);
  assert.equal(railEl.removed, false, "the fallback rail still holds weekly / reconcile / lately");
});

test("no decision, an unknown surface, a missing slot or a missing container all no-op", () => {
  const rail = loadRailController();
  const build = () => {
    const insight = makeElement("#insightSlot");
    const lead = makeElement("#attentionLead");
    return { insight, lead, dom: makeRoot({ "#insightSlot": insight, "#attentionLead": lead }) };
  };

  for (const attention of [null, undefined, {}, { primary: "" }, ATTENTION("brief"), ATTENTION("a-newer-surface")]) {
    const { insight, lead, dom } = build();
    rail.promoteAttentionLead(dom, attention);
    assert.equal(lead.children.length, 0, `should no-op for ${JSON.stringify(attention)}`);
    assert.equal(insight.attrs["data-attention"], undefined);
  }

  // Slot not rendered in this build → nothing to promote, nothing thrown.
  const lead = makeElement("#attentionLead");
  rail.promoteAttentionLead(makeRoot({ "#attentionLead": lead }), ATTENTION("insight"));
  assert.equal(lead.children.length, 0);

  // Container missing (an older shell) → the slot is still marked, and stays put.
  const insight = makeElement("#insightSlot");
  rail.promoteAttentionLead(makeRoot({ "#insightSlot": insight }), ATTENTION("insight"));
  assert.equal(insight.attrs["data-attention"], "lead");
});

test("promotion runs before the loaders so every slot is still reachable by id", () => {
  const source = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");
  const promote = source.indexOf("promoteAttentionLead");
  const runAgenda = source.indexOf("runAgendaRail(agenda");
  assert.ok(promote > -1 && runAgenda > -1);
  assert.ok(promote < runAgenda, "the move must happen before runAgendaRail hydrates the slots");
});
