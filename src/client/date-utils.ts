// @ts-check
// Shared browser date/label helpers. Kept as a plain script so existing vanilla
// PWA modules can keep using global functions while this pure slice is typechecked.

function localISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// The browser mirror of pickDayVariant in src/repo/brain/day-read-rules.ts, for the
// athlete-facing lines the CLIENT composes. A stable input renders the same rule
// every morning, so one literal prints verbatim for weeks and reads as a broken app.
// Same day + same key ⇒ the same text; consecutive days always differ (the index
// advances by exactly one per day). Deterministic — never Math.random(), never "now".
function variantKeyOffset(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash % 9973);
}

function pickDayVariant<T>(variants: readonly T[], date?: string, key = ""): T {
  if (variants.length <= 1) return variants[0];
  const ms = Date.parse(`${String(date || localISO()).slice(0, 10)}T00:00:00Z`);
  const dayIndex = Number.isFinite(ms) ? Math.floor(ms / 864e5) : 0;
  const span = variants.length;
  return variants[(((dayIndex + variantKeyOffset(key)) % span) + span) % span];
}

Object.assign(globalThis, {
  localISO,
  relTime,
  pickDayVariant,
});
