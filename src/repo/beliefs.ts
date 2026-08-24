// INSPECTABLE BELIEFS (W3.6) — one calm, grouped list of what the coach currently
// believes about this athlete, each row in athlete voice with its evidence
// provenance in WORDS (never a number/score) and a correction affordance.
//
// Sources aggregated here (each already the deterministic, agent-free,
// null-safe pattern the rest of the brain reads from):
//   1) learned models          — learned-models.ts (cross-domain coincidences)
//   2) felt-signal correlations — felt-signals.ts (subjective-signal patterns)
//   3) personal-response modifiers — reaction-model.ts's whatWorksForYou()
// Active directives already render in Connections (health_directives) — this
// surface links to them rather than duplicating the rows. There is no coach
// "memory table" / profile-understanding repo read to fold in yet (see
// src/repo/memory.ts: addMemory() writes free-text notes, not a queryable
// belief structure) — omitted rather than faked.
//
// CONSTITUTION (binding): no numeric scores or confidences-as-numbers anywhere
// in the public shape; evidence counts in words ("seen three times"). A
// correction marks the belief 'disputed' — never a one-tap inversion, which
// would let a tap silently rewrite a model instead of just setting it aside.

import {
  feltSignalBeliefId,
  learnedModelBeliefId,
  listBeliefDispositions,
  personalModifierBeliefId,
  setBeliefActive,
  setBeliefDisputed,
  type BeliefSource,
} from "./belief-dispositions.js";
import { feltSignalsForBeliefs } from "./felt-signals.js";
import { learnedModelsForBeliefs } from "./learned-models.js";
import { whatWorksForYouForBeliefs } from "./reaction-model.js";
import { listDirectives } from "./coach.js";

export type BeliefGroupKind = "learned_model" | "felt_signal" | "personal_modifier";

export interface BeliefRow {
  id: string; // namespaced belief id, e.g. "learned_model:sleep_fuel_correlation"
  group: BeliefGroupKind;
  statement: string; // athlete-voice belief text
  why: string; // evidence provenance in plain words, never a number
  confidence: string; // confidence WORD only (tentative/observed/strong)
  disputed: boolean;
}

export interface BeliefGroupView {
  kind: BeliefGroupKind;
  label: string;
  rows: BeliefRow[]; // active rows only (disputed rows move to set_aside)
}

export interface BeliefsView {
  groups: BeliefGroupView[];
  set_aside: BeliefRow[]; // every disputed belief, across groups — visible, not deleted
  directives: { active_count: number; note: string };
}

// ---- evidence-count -> words (NEVER a bare digit; the constitution bans scores) --

const SMALL_NUMBER_WORDS = [
  "zero",
  "once",
  "twice",
  "three times",
  "four times",
  "five times",
  "six times",
  "seven times",
  "eight times",
  "nine times",
  "ten times",
];

function evidenceWords(n: number | undefined | null): string {
  if (!Number.isFinite(n as number) || (n as number) <= 0) return "a little evidence so far";
  const v = Math.round(n as number);
  if (v <= 10) return `seen ${SMALL_NUMBER_WORDS[v]}`;
  return "seen many times";
}

function isDisputedId(dispositions: Map<string, string>, id: string): boolean {
  return dispositions.get(id) === "disputed";
}

export function listBeliefs(): BeliefsView {
  const dispositions = new Map(listBeliefDispositions().map((d) => [d.id, d.status] as const));
  const setAside: BeliefRow[] = [];

  const learnedRows: BeliefRow[] = learnedModelsForBeliefs().map((p) => {
    const id = learnedModelBeliefId(p.id);
    return {
      id,
      group: "learned_model" as const,
      statement: p.statement,
      why: `${evidenceWords(p.evidence_n)}, so far read as ${p.confidence}`,
      confidence: p.confidence,
      disputed: p.disputed || isDisputedId(dispositions, id),
    };
  });

  const feltRows: BeliefRow[] = feltSignalsForBeliefs().map((p) => {
    const id = feltSignalBeliefId(p.id);
    return {
      id,
      group: "felt_signal" as const,
      statement: p.statement,
      why: `${evidenceWords(p.evidence_n)}, so far read as ${p.confidence}`,
      confidence: p.confidence,
      disputed: p.disputed || isDisputedId(dispositions, id),
    };
  });

  const modifierSource = whatWorksForYouForBeliefs();
  const modifierRows: BeliefRow[] = (modifierSource?.modifiers ?? []).map((m) => {
    const id = personalModifierBeliefId(m.key);
    return {
      id,
      group: "personal_modifier" as const,
      // These modifiers don't carry their own athlete-voice sentence — their
      // rationale IS the plain-words explanation (written by the case
      // conference / evaluation layer already), so it doubles as the statement.
      statement: m.rationale,
      why: `${evidenceWords(m.evidence_n)}, so far read as ${m.confidence}`,
      confidence: m.confidence,
      disputed: m.disputed || isDisputedId(dispositions, id),
    };
  });

  const groups: BeliefGroupView[] = [
    { kind: "learned_model", label: "Learned models", rows: learnedRows.filter((r) => !r.disputed) },
    { kind: "felt_signal", label: "Felt-signal correlations", rows: feltRows.filter((r) => !r.disputed) },
    { kind: "personal_modifier", label: "How you tend to respond", rows: modifierRows.filter((r) => !r.disputed) },
  ];
  for (const row of [...learnedRows, ...feltRows, ...modifierRows]) {
    if (row.disputed) setAside.push(row);
  }

  const activeDirectives = listDirectives({ all: false });
  return {
    groups,
    set_aside: setAside,
    directives: {
      active_count: Array.isArray(activeDirectives) ? activeDirectives.length : 0,
      note: "Active directives already show in Connections — nothing duplicated here.",
    },
  };
}

function sourceForBeliefId(id: string): BeliefSource {
  if (id.startsWith("felt_signal:")) return "felt_signal";
  if (id.startsWith("personal_modifier:")) return "personal_modifier";
  return "learned_model";
}

// "That's not right" — never a one-tap inversion (a tap should never rewrite a
// model, only set it aside). Records the dispute as evidence for the induction
// that produced it (a disputed learned/felt pattern is a negative outcome the
// next rebuild's consumers will never see resurrected, since the belief's own
// forCoach() read filters by this same disposition regardless of what the
// rebuild recomputes) and keeps the belief visible under "set aside".
export function disputeBelief(id: string): BeliefRow | null {
  const trimmed = String(id ?? "").trim();
  if (!trimmed) return null;
  setBeliefDisputed(trimmed, sourceForBeliefId(trimmed));
  return findBeliefRow(trimmed);
}

// Un-dispute — transparency cuts both ways; a set-aside belief can be restored.
export function undisputeBelief(id: string): BeliefRow | null {
  const trimmed = String(id ?? "").trim();
  if (!trimmed) return null;
  setBeliefActive(trimmed, sourceForBeliefId(trimmed));
  return findBeliefRow(trimmed);
}

function findBeliefRow(id: string): BeliefRow | null {
  const view = listBeliefs();
  for (const g of view.groups) {
    const hit = g.rows.find((r) => r.id === id);
    if (hit) return hit;
  }
  return view.set_aside.find((r) => r.id === id) ?? null;
}
