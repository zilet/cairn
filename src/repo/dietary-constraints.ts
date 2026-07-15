// Canonical whole-diet parsing shared by prompts and deterministic persistence.
// A single parser prevents the model-facing rules and the write boundary from
// disagreeing about mixed/negated declarations.

export const HARD_DIET_KEYS = [
  "vegan",
  "vegetarian",
  "pescatarian",
  "dairy_free",
  "gluten_free",
  "halal",
  "kosher",
  "keto",
  "carnivore",
  "paleo",
] as const;

export type HardDietKey = (typeof HARD_DIET_KEYS)[number];
export type HardDietSourceMode = "authoritative" | "meal_prefs" | "instruction";

const ALIASES: Record<HardDietKey, RegExp> = {
  vegan: /\bvegans?\b/i,
  vegetarian: /\bvegetarians?\b/i,
  pescatarian: /\bpesca?tarians?\b/i,
  dairy_free: /\b(?:dairy[ -]?free|no dairy)\b/i,
  gluten_free: /\b(?:gluten[ -]?free|no gluten)\b/i,
  halal: /\bhalal\b/i,
  kosher: /\bkosher\b/i,
  keto: /\bketo(?:genic)?\b/i,
  carnivore: /\bcarnivore\b/i,
  paleo: /\bpaleo\b/i,
};

const SOFT_LANGUAGE =
  /\b(?:mostly|prefer|preferred|preference|sometimes|occasionally|option|if possible|nice to have|lunch(?:es)?|dinner(?:s)?)\b/i;
const GLOBAL_LANGUAGE =
  /\b(?:make|keep|build|plan|switch|change|follow|strictly|must|every meal|all meals|always|this week|whole week|i am|i['’]m|we are|we['’]re|my diet|our diet|diet is|following)\b/i;
const IDENTITY_LANGUAGE =
  /\b(?:i am|i['’]m|we are|we['’]re|my diet is|our diet is|i follow|we follow|following|must be|strictly|every meal|all meals|always)\b/i;
const SUBCLAUSE_BOUNDARY = /\b(?:but|however|although|though|yet)\b/i;

function regexFlags(re: RegExp): string {
  return re.flags.includes("g") ? re.flags : `${re.flags}g`;
}

function aliasMatches(clause: string, alias: RegExp): Array<{ index: number; text: string }> {
  return [...clause.matchAll(new RegExp(alias.source, regexFlags(alias)))].map((match) => ({
    index: match.index ?? 0,
    text: match[0],
  }));
}

function matchIsNegated(clause: string, match: { index: number; text: string }): boolean {
  const prefix = clause.slice(Math.max(0, match.index - 64), match.index);
  return (
    /\b(?:not|no longer|isn['’]?t|aren['’]?t)\s+(?:a\s+)?$/i.test(prefix) ||
    /\b(?:do\s+not|don['’]?t|does\s+not|doesn['’]?t)\b.{0,48}$/i.test(prefix)
  );
}

export function canonicalHardDietKeys(value: unknown, mode: HardDietSourceMode = "authoritative"): HardDietKey[] {
  const found = new Set<HardDietKey>();
  // Contrast words start a fresh qualification scope. Without this second split,
  // one soft phrase anywhere in a sentence ("prefer vegetarian lunches") erased
  // a separate explicit identity in the same sentence ("I am vegan"). Negation,
  // soft language and global/identity language must qualify the diet mention in
  // their own subclause, not every diet mentioned before or after it.
  const subclauses = String(value ?? "")
    .split(/[,;.\n]+/)
    .flatMap((clause) => clause.split(SUBCLAUSE_BOUNDARY))
    .map((clause) => clause.trim())
    .filter(Boolean);

  for (const clause of subclauses) {
    for (const key of HARD_DIET_KEYS) {
      const matches = aliasMatches(clause, ALIASES[key]);
      for (const match of matches) {
        if (matchIsNegated(clause, match)) continue;

        // Qualification belongs to THIS diet mention, not the whole sentence.
        // The local prefix starts after the latest coordinating conjunction and
        // the local suffix ends at the next one. This keeps
        // "I am vegan and prefer simple meals" hard-vegan while leaving
        // "prefer vegan meals" and "vegetarian lunches" soft. Identity/global
        // language may carry across a diet-only coordination ("I am vegan and
        // vegetarian"), but a local soft qualifier always wins for its mention.
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match.text.length);
        const localPrefix = before.split(/\b(?:and|or)\b|&/i).at(-1) ?? before;
        const localSuffix = (after.split(/\b(?:and|or)\b|&/i)[0] ?? after).trim();
        const locallySoft = SOFT_LANGUAGE.test(`${localPrefix} ${localSuffix}`);
        if (locallySoft) continue;

        const withoutAlias = `${localPrefix} ${localSuffix}`.replace(new RegExp(ALIASES[key].source, "gi"), " ").trim();
        if (mode === "instruction" && !GLOBAL_LANGUAGE.test(before) && withoutAlias.length > 12) continue;
        if (mode === "meal_prefs" && !IDENTITY_LANGUAGE.test(before)) continue;
        found.add(key);
        break;
      }
    }
  }
  return HARD_DIET_KEYS.filter((key) => found.has(key));
}

export function normalizeHardDietKeys(value: unknown): HardDietKey[] {
  const allowed = new Set<string>(HARD_DIET_KEYS);
  const found = new Set<HardDietKey>();
  for (const entry of Array.isArray(value) ? value : []) {
    const key = String(entry ?? "").trim() as HardDietKey;
    if (allowed.has(key)) found.add(key);
  }
  return HARD_DIET_KEYS.filter((key) => found.has(key));
}

// Remove recognized whole-diet declarations (affirmative or negated) while
// preserving unrelated free-text restrictions such as "no cilantro". This is
// presentation/warning support only; enforcement always uses canonical keys.
export function hardDietFreeRemainder(value: unknown): string {
  return String(value ?? "")
    .split(/[,;.\n]+/)
    .map((clause) => {
      let remainder = clause;
      for (const key of HARD_DIET_KEYS) remainder = remainder.replace(new RegExp(ALIASES[key].source, "gi"), " ");
      return remainder
        .replace(
          /\b(?:i am|i['’]m|we are|we['’]re|my diet is|our diet is|i follow|we follow|following|do not|don['’]?t|does not|doesn['’]?t|not|no longer|isn['’]?t|aren['’]?t|strictly|also|and|a diet|diet)\b/gi,
          " "
        )
        .replace(/\s+/g, " ")
        .trim();
    })
    .filter(Boolean)
    .join(", ");
}

export function mealPlanHardDietKeys(parsed: any): HardDietKey[] {
  return normalizeHardDietKeys(parsed?.hard_diet_constraints?.keys);
}

export function stampInstructionHardDiets(parsed: any, instruction: unknown): any {
  if (!parsed || typeof parsed !== "object") return parsed;
  const instructionKeys = canonicalHardDietKeys(instruction, "instruction");
  if (!instructionKeys.length) return parsed;
  const existing = mealPlanHardDietKeys(parsed);
  const keys = HARD_DIET_KEYS.filter((key) => existing.includes(key) || instructionKeys.includes(key));
  const priorProvenance = Array.isArray(parsed?.hard_diet_constraints?.provenance)
    ? parsed.hard_diet_constraints.provenance.filter((entry: any) => entry && typeof entry === "object")
    : [];
  return {
    ...parsed,
    hard_diet_constraints: {
      keys,
      provenance: [
        ...priorProvenance,
        ...instructionKeys
          .filter(
            (key) => !priorProvenance.some((entry: any) => entry.source === "current_instruction" && entry.key === key)
          )
          .map((key) => ({ key, source: "current_instruction" })),
      ],
    },
  };
}
