export interface HealthSynthesisPriority {
  label: string | null;
  why_it_matters: string | null;
  the_move: string | null;
  recheck: string | null;
}

export interface HealthSynthesis {
  headline: string | null;
  story: string | null;
  priorities: HealthSynthesisPriority[];
  one_change: string | null;
  agent: string | null;
  generated_at: string;
}

export function normalizeHealthSynthesis(
  input: unknown,
  meta: { agent?: unknown; generated_at: string }
): HealthSynthesis | null {
  const p: any = input && typeof input === "object" && (input as any).synthesis && typeof (input as any).synthesis === "object"
    ? (input as any).synthesis
    : input;
  if (!p || typeof p !== "object" || p.found === false) return null;

  const headline = cleanHealthSynthesisField(p.headline, 300);
  const story = cleanHealthSynthesisField(p.story, 1400);
  if (!headline && !story) return null;

  const priorities = (Array.isArray(p.priorities) ? p.priorities : [])
    .slice(0, 5)
    .map((x: any) => ({
      label: cleanHealthSynthesisField(x?.label, 60),
      why_it_matters: cleanHealthSynthesisField(x?.why_it_matters, 220),
      the_move: cleanHealthSynthesisField(x?.the_move, 320),
      recheck: cleanHealthSynthesisField(x?.recheck, 160),
    }))
    .filter((x: HealthSynthesisPriority) => x.label || x.the_move);

  return {
    headline,
    story,
    priorities,
    one_change: cleanHealthSynthesisField(p.one_change, 200),
    agent: cleanHealthSynthesisField(meta.agent, 80),
    generated_at: meta.generated_at,
  };
}

function cleanHealthSynthesisField(v: unknown, n: number): string | null {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, n) : null;
}
