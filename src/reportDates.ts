import { localDateISO } from "./repo/shared.js";

const REPORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ReportDateOptions {
  notAfter?: string | null;
}

function parseDateLike(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDateISO(value);
  const raw = String(value).trim();
  if (!raw) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;

  const dated = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(raw);
  if (!dated) return null;

  // Timestamp strings represent instants, so frame them in Cairn's active local
  // zone. SQLite timestamps are UTC but usually lack a zone marker.
  if (/[T\s]/.test(raw)) {
    const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
    const normalized = raw.replace(" ", "T") + (hasZone ? "" : "Z");
    const d = new Date(normalized);
    if (!Number.isNaN(d.getTime())) return localDateISO(d);
  }

  return `${dated[1]}-${dated[2]}-${dated[3]}`;
}

export function reportDateISO(value?: unknown, opts: ReportDateOptions = {}): string | null {
  const iso = parseDateLike(value);
  if (!iso) return null;
  const ceiling = opts.notAfter ? parseDateLike(opts.notAfter) : null;
  return ceiling && iso > ceiling ? ceiling : iso;
}

export function reportTodayISO(): string {
  return localDateISO();
}

export function reportDaysBetween(from?: unknown, to?: unknown): number | null {
  const a = reportDateISO(from);
  const b = reportDateISO(to);
  if (!a || !b) return null;
  const at = Date.parse(`${a}T00:00:00Z`);
  const bt = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return null;
  return Math.max(0, Math.floor((bt - at) / 864e5));
}

export function formatReportDate(value?: unknown, opts: ReportDateOptions = {}): string {
  const iso = reportDateISO(value, opts);
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return String(value ?? "");
  return `${REPORT_MONTHS[m - 1]} ${d}, ${y}`;
}

export function formatReportDateShort(value?: unknown, opts: ReportDateOptions = {}): string {
  const iso = reportDateISO(value, opts);
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return String(value ?? "");
  return `${REPORT_MONTHS[m - 1]} ${d} '${String(y).slice(2)}`;
}
