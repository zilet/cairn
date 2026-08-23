export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// A bare .slice() cuts mid-word, and the fragment then runs into whatever follows it
// as if it were one sentence ("…rotates to a fresh Held the load"). Cut back to the
// last word boundary instead and mark the cut, so a truncated line still READS as
// truncated. The result never exceeds maxLength (the ellipsis is inside the budget).
export function truncateAtWord(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return "…";
  const budget = maxLength - 1; // the ellipsis lives inside the caller's limit
  const clipped = text.slice(0, budget);
  const lastSpace = clipped.lastIndexOf(" ");
  // The budget may already land on a word boundary — then nothing needs trimming.
  // Otherwise fall back to the last complete word; a single very long token has no
  // boundary worth honouring, so keep the hard cut rather than losing the budget.
  const boundary = text[budget] === " " || lastSpace <= 0 ? clipped : clipped.slice(0, lastSpace);
  // Trimming the cut can empty it (a leading run of punctuation, or a first "word"
  // that is punctuation alone), and a bare "…" says nothing at all. The hard clip is
  // the floor: less readable than a word boundary, still more than nothing.
  const cut = trimTrailingPunctuation(boundary) || trimTrailingPunctuation(clipped) || clipped;
  return `${cut}…`;
}

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[\s,;:.—–-]+$/, "");
}

// The identifier sibling of truncateAtWord. A version string or a row key is matched,
// not read: a word boundary means nothing in it, and an appended "…" would become
// part of the value and never compare equal to the same identifier clipped elsewhere.
export function cleanIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, maxLength) || null : null;
}

// The prose variant: anything a person reads. Machine identifiers take
// `cleanIdentifier` instead, so no ellipsis ever lands inside a compared value.
export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text ? truncateAtWord(text, maxLength) : null;
}

export function cleanOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, maxLength);
}

export function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T[number]) : null;
}

export function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function boundedInteger(value: unknown, min: number, max: number): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

export function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function isoDateTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function normalizeStringList(value: unknown, options: { maxItems?: number; maxLength?: number } = {}): string[] {
  if (!Array.isArray(value)) return [];
  const maxItems = options.maxItems ?? 20;
  const maxLength = options.maxLength ?? 160;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = cleanText(item, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function normalizeJsonValueInner(value: unknown, depth: number): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, 50)) {
      const normalized = normalizeJsonValueInner(item, depth + 1);
      if (normalized !== undefined) result.push(normalized);
    }
    return result;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const result: JsonObject = {};
  for (const [rawKey, item] of Object.entries(record).slice(0, 50)) {
    const key = cleanText(rawKey, 80);
    const normalized = normalizeJsonValueInner(item, depth + 1);
    if (key && !["__proto__", "constructor", "prototype"].includes(key) && normalized !== undefined) {
      result[key] = normalized;
    }
  }
  return result;
}

export function normalizeJsonObject(value: unknown): JsonObject | null {
  const record = asRecord(value);
  if (!record) return null;
  return normalizeJsonValueInner(record, 0) as JsonObject;
}

export function hasOwnProperties(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}
