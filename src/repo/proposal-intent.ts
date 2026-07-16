export type ProposalSemanticKind =
  | "nutrition_target"
  | "training_structure"
  | "training_target"
  | "exercise_rotation";

export interface AutomaticOrphanIntent {
  kind: ProposalSemanticKind;
  key: string;
}

export interface ChatOrphanIntent {
  kind: ProposalSemanticKind;
  key: string;
  provenance: "chat" | "background_chat";
  burst_window_ms?: number;
}

export const LEGACY_BACKGROUND_CHAT_INSTRUCTION = "background: chat signal";
export const LEGACY_BACKGROUND_CHAT_BURST_MS = 30 * 60 * 1000;

function parsedProposal(proposal: any): any {
  if (proposal?.parsed && typeof proposal.parsed === "object") return proposal.parsed;
  try {
    return proposal?.parsed_json ? JSON.parse(String(proposal.parsed_json)) : null;
  } catch {
    return null;
  }
}

export function proposalSemanticKind(proposal: any): ProposalSemanticKind {
  const parsed = parsedProposal(proposal);
  if (parsed?.kind === "nutrition_target") return "nutrition_target";
  if (Array.isArray(parsed?.days)) return "training_structure";
  if (Array.isArray(parsed?.changes) && parsed.changes.some((change: any) => change?.swap)) {
    return "exercise_rotation";
  }
  return "training_target";
}

function normalized(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isExplicitAutomaticSource(proposal: any): boolean {
  const instruction = normalized(proposal?.instruction);
  const agent = normalized(proposal?.agent);
  return (
    instruction.startsWith("auto:") ||
    instruction === "weekly auto-evolution" ||
    agent === "auto-progression" ||
    agent === "auto-run-plan"
  );
}

function targetScope(parsed: any): string {
  const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
  const cardio = Array.isArray(parsed?.cardio) ? parsed.cardio : [];
  const keys = [
    ...changes.map((change: any) => {
      const day = Number.isFinite(Number(change?.day_number)) ? Math.trunc(Number(change.day_number)) : 0;
      const exercise = normalized(change?.exercise || change?.swap?.from || "movement");
      const fields = [
        "sets",
        "rep_low",
        "rep_high",
        "target_weight",
        "target_seconds",
        "target_distance_km",
        "target_duration_min",
        "target_zone",
      ].filter((field) => Object.hasOwn(change ?? {}, field));
      return `${day}:${exercise}:${change?.swap ? "swap" : fields.sort().join("+") || "change"}`;
    }),
    ...cardio.map((run: any) => {
      const day = Number.isFinite(Number(run?.day_number)) ? Math.trunc(Number(run.day_number)) : 0;
      return `${day}:cardio`;
    }),
  ];
  return [...new Set(keys.filter(Boolean))].sort().join("|") || "unspecified";
}

function structureScope(parsed: any): string {
  const days = Array.isArray(parsed?.days) ? parsed.days : [];
  const keys = days.map((day: any) => {
    const dayNumber = Number.isFinite(Number(day?.day_number)) ? Math.trunc(Number(day.day_number)) : 0;
    const name = normalized(day?.name || day?.focus || "day");
    const movements = (Array.isArray(day?.items) ? day.items : [])
      .map((item: any) => normalized(item?.exercise || item?.label || item?.kind))
      .filter(Boolean)
      .sort()
      .join("+");
    return `${dayNumber}:${name}:${movements}`;
  });
  return keys.sort().join("|") || "whole-program";
}

function affectedPlanDayScope(parsed: any): string {
  const dayNumbers = [
    ...(Array.isArray(parsed?.days) ? parsed.days : []),
    ...(Array.isArray(parsed?.changes) ? parsed.changes : []),
    ...(Array.isArray(parsed?.cardio) ? parsed.cardio : []),
  ]
    .map((entry: any) => Number(entry?.day_number))
    .filter((day: number) => Number.isFinite(day) && day > 0)
    .map((day: number) => Math.trunc(day));
  return [...new Set(dayNumbers)].sort((a, b) => a - b).join("+") || "unspecified";
}

// Only explicit scheduler/automatic provenance qualifies for orphan adoption and
// convergence. Chat, manual, user-authored, and ordinary agent drafts deliberately
// return null even if their payload resembles an automatic proposal.
export function automaticOrphanIntent(proposal: any): AutomaticOrphanIntent | null {
  if (!isExplicitAutomaticSource(proposal)) return null;
  const parsed = parsedProposal(proposal);
  const kind = proposalSemanticKind(proposal);
  const scope =
    kind === "nutrition_target"
      ? "nutrition-target"
      : kind === "training_structure"
        ? /\b(recovery|deload)\b/.test(normalized(proposal?.instruction))
          ? "recovery-week"
          : "whole-program"
        : targetScope(parsed);
  return { kind, key: `${kind}:${scope}` };
}

// Legacy chat actions are eligible for self-healing ONLY when the immutable
// instruction carries explicit `chat:` provenance or the exact historical
// `background: chat signal` marker. The latter used one generic instruction for
// iterative retries, so its intent is deliberately coarser (kind + affected plan
// day set) and the caller must additionally constrain convergence to one short burst.
// Agent name or payload shape alone is never enough: manual/user-authored drafts
// remain outside this path.
export function chatOrphanIntent(proposal: any): ChatOrphanIntent | null {
  const instruction = normalized(proposal?.instruction);
  const isBackgroundChat = instruction === LEGACY_BACKGROUND_CHAT_INSTRUCTION;
  if (!isBackgroundChat && !instruction.startsWith("chat:")) return null;
  const parsed = parsedProposal(proposal);
  const kind = proposalSemanticKind(proposal);
  if (isBackgroundChat) {
    return {
      kind,
      key: `background-chat:${kind}:days:${affectedPlanDayScope(parsed)}`,
      provenance: "background_chat",
      burst_window_ms: LEGACY_BACKGROUND_CHAT_BURST_MS,
    };
  }
  const scope =
    kind === "nutrition_target"
      ? "nutrition-target"
      : kind === "training_structure"
        ? structureScope(parsed)
        : targetScope(parsed);
  return { kind, key: `chat:${kind}:${scope}`, provenance: "chat" };
}
