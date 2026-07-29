// @ts-check
// Shared browser date/label helpers. Kept as a plain script so existing vanilla
// PWA modules can keep using global functions while this pure slice is typechecked.

function localISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateLabel(iso: string): string {
  if (iso === localISO()) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (iso === localISO(y)) return "Yesterday";
  const [yr, mo, da] = iso.split("-").map(Number);
  return new Date(yr, mo - 1, da).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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

function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) return String(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (days < 0) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 45) return `${Math.round(days / 7)} weeks ago`;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function relAge(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) return String(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (days < 0) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 45) return `${Math.round(days / 7)} weeks ago`;
  if (days < 320) return `${Math.max(1, Math.round(days / 30))} months ago`;
  if (days < 550) return "a year ago";
  return `${Math.round(days / 365)} years ago`;
}

function absDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function humanizeReviewText(text: string, latestISO: string | null | undefined): string {
  if (!text) return text || "";
  let s = String(text);
  if (latestISO && /^\d{4}-\d{2}-\d{2}$/.test(latestISO)) {
    const esc = latestISO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`\\s*[([]?\\b(?:on|as of|dated|measured on|recorded on|taken on)\\s+${esc}\\b[)\\]]?`, "gi"), "");
    s = s.replace(new RegExp(`\\s*[([]\\s*${esc}\\s*[)\\]]`, "g"), "");
  }
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m0) => humanDate(m0));
  return s.replace(/\(\s*\)/g, "").replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").replace(/^\s*[,.;:]\s*/, "").trim();
}

function latestReviewDate(p: unknown): string | null {
  const hits = JSON.stringify(p || {}).match(/\d{4}-\d{2}-\d{2}/g);
  return hits && hits.length ? hits.sort()[hits.length - 1] : null;
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
  dateLabel,
  relTime,
  humanDate,
  relAge,
  absDate,
  humanizeReviewText,
  latestReviewDate,
  pickDayVariant,
});
