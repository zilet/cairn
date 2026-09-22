// STATED MOVEMENT CONSIDERATIONS — a lasting, painless fact about how this body moves
// ("mild scoliosis", "hypermobile", "one leg a bit longer"), in the athlete's own words.
//
// The only structured home such a sentence used to have was an `injury` context event,
// and an injury is protective by design: it hard-excludes the lifts that load its area,
// turns the day's posture to "modify", and refuses new movements — every day, forever,
// because a structural fact has no healing window. That is right for PAIN and wrong for
// a condition someone simply wants the program to take into account.
//
// So this is deliberately NOT an input to any gate. Nothing in the daily decision, the
// signal state or the injury machinery reads it. It reaches the prompts that shape a
// plan (context-projection's PERSON bundle + renderMovementConsiderations) and nothing
// else: it shapes selection and balance, and never excludes a lift on its own.
//
// Stated only — by the athlete, in chat, or in their onboarding intro. Never inferred
// from logs, labs or an agent's reading of about_me.
import { db } from "../db.js";
import { isoDate } from "../lib/dates.js";
import { localDateISO } from "./shared.js";

export const MOVEMENT_CONSIDERATIONS_MAX_ITEMS = 6;
export const MOVEMENT_CONSIDERATION_LABEL_MAX = 80;
export const MOVEMENT_CONSIDERATION_DETAIL_MAX = 400;

export type MovementConsiderationSource = "athlete" | "chat" | "onboard";
const SOURCES = new Set<MovementConsiderationSource>(["athlete", "chat", "onboard"]);

export interface MovementConsideration {
  label: string;
  detail?: string;
  /** They asked for the program to help with it — the only thing that adds a prep/supportive block. */
  wants_addressed: boolean;
  source: MovementConsiderationSource;
  stated_on: string;
}

export interface MovementConsiderations {
  items: MovementConsideration[];
}

// One line of the athlete's words: whitespace (newlines included) folds to single
// spaces, because each item is rendered as ONE prompt line and a raw newline there
// would let a sentence pose as a heading.
function oneLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
}

/**
 * Normalize any accepted shape — the stored JSON string, `{items:[…]}`, or a bare list —
 * into validated, trimmed, capped items. Returns `{items:[]}` for an explicit empty list
 * (a clear) and null when nothing usable was understood (a malformed write, which the
 * setter treats as "leave what is stored alone", like its schedule siblings).
 */
export function parseMovementConsiderations(
  input: unknown,
  opts?: { source?: MovementConsiderationSource; previous?: MovementConsiderations | null; today?: string }
): MovementConsiderations | null {
  let raw: any = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(raw.items) ? raw.items : null;
  if (!list) return null;
  if (!list.length) return { items: [] };
  const today = opts?.today ?? localDateISO();
  // A restated item keeps the day it was FIRST said — a chat turn that re-sends the full
  // list to add one condition must not re-date the others.
  const previousOn = new Map((opts?.previous?.items ?? []).map((item) => [item.label.toLowerCase(), item.stated_on]));
  const items: MovementConsideration[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (items.length >= MOVEMENT_CONSIDERATIONS_MAX_ITEMS) break;
    const label = oneLine(entry && typeof entry === "object" ? entry.label : entry, MOVEMENT_CONSIDERATION_LABEL_MAX);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const detail = entry && typeof entry === "object" ? oneLine(entry.detail, MOVEMENT_CONSIDERATION_DETAIL_MAX) : "";
    const wants = entry && typeof entry === "object" ? entry.wants_addressed : false;
    const sourceRaw = String((entry && typeof entry === "object" && entry.source) || opts?.source || "athlete")
      .trim()
      .toLowerCase() as MovementConsiderationSource;
    items.push({
      label,
      ...(detail ? { detail } : {}),
      wants_addressed: wants === true || wants === "true",
      source: SOURCES.has(sourceRaw) ? sourceRaw : "athlete",
      stated_on:
        previousOn.get(label.toLowerCase()) ??
        (entry && typeof entry === "object" ? isoDate(entry.stated_on) : null) ??
        today,
    });
  }
  return items.length ? { items } : null; // named entries, none usable -> reject, not a clear
}

/**
 * The stored column value for a write: a JSON string, null for a clear (explicit null or
 * an empty list), or undefined for input nothing could be read from — the setter keeps
 * the current value then, so a bad client cannot erase what the athlete said.
 */
export function serializeMovementConsiderations(
  input: unknown,
  opts?: { source?: MovementConsiderationSource; previous?: MovementConsiderations | null }
): string | null | undefined {
  if (input == null) return null;
  const parsed = parseMovementConsiderations(input, opts);
  if (!parsed) return undefined;
  return parsed.items.length ? JSON.stringify(parsed) : null;
}

/** What Cairn currently holds, or null when nothing has been stated. */
export function movementConsiderationsRead(): MovementConsiderations | null {
  let stored: unknown = null;
  try {
    stored = (db.prepare(`SELECT movement_considerations_json AS v FROM profile WHERE id = 1`).get() as any)?.v ?? null;
  } catch {
    return null; // a DB predating v107
  }
  const parsed = parseMovementConsiderations(stored);
  return parsed?.items.length ? parsed : null;
}
