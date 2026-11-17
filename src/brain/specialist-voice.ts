// The calm, attributed voice of a case-conference specialist. The conference
// durably stores each specialist's structured opinion on the decision's
// `specialist_json` ({ opinions: SpecialistOpinion[], ... }); this projects ONE
// of those opinions into a single plain attribution line the athlete-facing
// surfaces (the team's-week digest, announced-change cards, the Learned timeline)
// can show — "Heart: ApoB is the one to move".
//
// The voice is the specialist's SEAT, a role word — one of the six stones
// (src/repo/team-seats.ts: Strength, Run, Recovery, Fuel, Body, Heart). Roles, never
// personas: no names, faces or personalities.
//
// It NEVER calls an agent and NEVER invents content: it surfaces only what a
// specialist already said, and only when that sentence holds the reading grammar
// (violatesReadingGrammar) — a recommendation written in the machine register is not
// a line for a person. Null-safe throughout — no opinions, an unparseable blob, or an
// empty/unreadable recommendation all yield null, and the caller renders nothing.
import { SPECIALIST_DOMAINS, type SpecialistDomain } from "./specialist-contract.js";
import { clipText } from "../repo/shared.js";
import { SPECIALIST_SEAT, type TeamSeatKey, teamSeatRole } from "../repo/team-seats.js";
import { violatesReadingGrammar } from "../repo/day-read-grammar.js";

export interface SpecialistVoiceLine {
  domain: SpecialistDomain;
  seat: TeamSeatKey;
  voice: string; // "Heart" — the seat's role word
  recommendation: string; // the specialist's plain recommendation, clipped
  line: string; // "Heart: ApoB is the one to move"
}

function clip(value: unknown, max = 180): string {
  return clipText(value, max, { collapseWhitespace: true, ellipsis: "" });
}

function isSpecialistDomain(value: unknown): value is SpecialistDomain {
  return typeof value === "string" && (SPECIALIST_DOMAINS as readonly string[]).includes(value);
}

// Pull the opinions[] array off a stored (already-parsed) specialist blob. The
// conference writes { snapshot_id, opinions, trajectory, ... }; tolerate either
// that shape or a bare array so historical rows still surface.
function opinionsOf(specialist: unknown): Record<string, unknown>[] {
  if (Array.isArray(specialist))
    return specialist.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
  if (specialist && typeof specialist === "object") {
    const raw = (specialist as Record<string, unknown>).opinions;
    if (Array.isArray(raw)) return raw.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
  }
  return [];
}

// The single attributed line for a decision's specialist_json. Prefers the
// opinion whose domain matches `preferDomain` (usually the decision's own
// domain — the voice that owned the call), else the first opinion present.
// Returns null when nothing usable is stored.
export function specialistVoiceLine(specialist: unknown, preferDomain?: string): SpecialistVoiceLine | null {
  const opinions = opinionsOf(specialist);
  if (!opinions.length) return null;
  // "Usable" means a known specialist domain AND a non-empty recommendation.
  // The preferred-domain opinion only wins if it is itself usable — an empty
  // recommendation there must fall through to another domain's usable opinion,
  // not short-circuit the whole read to null.
  const usable = (o: Record<string, unknown>) =>
    isSpecialistDomain(o.domain) && !!clip(o.recommendation) && !violatesReadingGrammar(clip(o.recommendation));
  const preferred =
    (preferDomain ? opinions.find((o) => o.domain === preferDomain && usable(o)) : undefined) || opinions.find(usable);
  if (!preferred || !isSpecialistDomain(preferred.domain)) return null;
  const domain = preferred.domain;
  const recommendation = clip(preferred.recommendation);
  const seat = SPECIALIST_SEAT[domain];
  const voice = teamSeatRole(seat);
  return { domain, seat, voice, recommendation, line: `${voice}: ${recommendation}` };
}
