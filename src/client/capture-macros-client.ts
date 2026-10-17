// @ts-check
// Signature macro tags for a chat food-capture row ("P47 F20"). Split out of
// chat-client.ts, which renders the review and calls captureFoodMacrosHtml per row.

type CaptureMacroRow = { kcal?: unknown; protein_g?: unknown; carbs_g?: unknown; fat_g?: unknown; fiber_g?: unknown };

// A food's SIGNATURE macros: what it meaningfully brings, never its full split. The
// macro carrying the largest share of its energy leads, fiber rides along when the
// row is a real source of it, and a second macro fills the slot otherwise — two
// tags at most, so six rows never become a metric wall. A trivial row (a handful of
// greens, a shot of spirits) earns no tag. Tags print in one fixed order (P C F fib)
// so the eye learns where each lives.
type CaptureMacroTag = { key: "P" | "C" | "F" | "fib"; grams: number; label: string };

const CAPTURE_MACRO_ORDER = ["P", "C", "F", "fib"] as const;
const CAPTURE_TRIVIAL_KCAL = 20;
const CAPTURE_FIBER_SOURCE_G = 3;
// [tag, field, kcal per gram, minimum grams, minimum share of the row's energy, label]
const CAPTURE_MACRO_RULES = [
  ["P", "protein_g", 4, 4, 0.2, "protein"],
  ["C", "carbs_g", 4, 6, 0.4, "carbs"],
  ["F", "fat_g", 9, 4, 0.4, "fat"],
] as const;

function captureMacroGrams(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function captureFoodSignatureMacros(row: CaptureMacroRow): CaptureMacroTag[] {
  const grams = {
    protein_g: captureMacroGrams(row.protein_g),
    carbs_g: captureMacroGrams(row.carbs_g),
    fat_g: captureMacroGrams(row.fat_g),
  };
  const fiber = captureMacroGrams(row.fiber_g);
  const fromMacros = 4 * (grams.protein_g ?? 0) + 4 * (grams.carbs_g ?? 0) + 9 * (grams.fat_g ?? 0);
  const kcal = captureMacroGrams(row.kcal) ?? fromMacros;
  const fiberTag: CaptureMacroTag | null =
    fiber != null && fiber >= CAPTURE_FIBER_SOURCE_G ? { key: "fib", grams: Math.round(fiber), label: "fiber" } : null;
  if (kcal < CAPTURE_TRIVIAL_KCAL) return fiberTag ? [fiberTag] : [];
  const macros: Array<CaptureMacroTag & { share: number }> = [];
  for (const [key, field, perGram, minGrams, minShare, label] of CAPTURE_MACRO_RULES) {
    const g = grams[field];
    if (g == null || g < minGrams) continue;
    const share = (g * perGram) / kcal;
    if (share >= minShare) macros.push({ key, grams: Math.round(g), label, share });
  }
  macros.sort((a, b) => b.share - a.share);
  const picked: CaptureMacroTag[] = [];
  if (macros[0]) picked.push(macros[0]);
  if (fiberTag) picked.push(fiberTag);
  if (picked.length < 2 && macros[1]) picked.push(macros[1]);
  return picked
    .sort((a, b) => CAPTURE_MACRO_ORDER.indexOf(a.key) - CAPTURE_MACRO_ORDER.indexOf(b.key))
    .map(({ key, grams: g, label }) => ({ key, grams: g, label }));
}

function captureFoodMacrosHtml(row: CaptureMacroRow): string {
  const tags = captureFoodSignatureMacros(row);
  if (!tags.length) return "";
  const body = tags
    .map((t) => {
      const said = `${t.grams} g ${t.label}`;
      return `<span class="capture-macro" title="${escAttr(said)}"><span class="sr-only">${escHtml(said)}</span><span aria-hidden="true"><span class="capture-macro-k">${escHtml(t.key)}</span>${t.grams}</span></span>`;
    })
    .join("");
  return `<span class="capture-item-macros">${body}</span>`;
}

Object.assign(globalThis, { captureFoodSignatureMacros, captureFoodMacrosHtml });
