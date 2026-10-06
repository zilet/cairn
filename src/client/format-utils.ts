// @ts-check
// Shared display-format helpers for the vanilla PWA.

function foodNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatFoodNum(value: unknown): string {
  const n = foodNum(value);
  if (n === null) return "";
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

function fmtWeight(weight: unknown): string {
  if (weight === null || weight === undefined) return "BW";
  const n = Number(weight);
  return Number.isFinite(n) && n < 0 ? `${-n} assist` : `${weight}`;
}

// ---------- duration helpers (timed exercises) ----------
// "90" -> 90, "1:30" -> 90, "2m" -> 120, "45s" -> 45. null on garbage.
function parseDur(text: unknown): number | null {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/);
  if (m) return Math.round(Number(m[1]) * 60);
  m = s.match(/^(\d+)\s*s(?:ec)?$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

// 90 -> "1:30", 45 -> "0:45"
function fmtDur(sec: unknown): string {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

// Join a list into natural, Oxford-comma prose: "a" / "a and b" / "a, b, and c".
// Client-side mirror of src/repo/shared.ts's joinList (the client shares one
// global scope, not modules, with the server — see CLAUDE.md).
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

Object.assign(globalThis, {
  foodNum,
  formatFoodNum,
  fmtWeight,
  parseDur,
  fmtDur,
  joinList,
});
