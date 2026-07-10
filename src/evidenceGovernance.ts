// Deterministic evidence-governance primitives shared by the offline guideline
// pack and the live evidence cache. No DB, network, or agent dependency belongs
// here: callers can test a source/claim/freshness decision with a fixed clock.

export const EVIDENCE_SOURCE_SCOPES = ["general", "athlete", "clinician"] as const;
export type EvidenceSourceScope = (typeof EVIDENCE_SOURCE_SCOPES)[number];
export type EvidenceFreshness = "current" | "review_due" | "expired" | "unknown";
export type EvidenceVerificationStatus = "claim_source" | "source_only" | "unverified";
export type EvidenceConfidence = "high" | "moderate" | "low";

export interface EvidenceGovernanceMetadata {
  source_scope?: EvidenceSourceScope | string | null;
  source_version?: string | null;
  published_at?: string | null;
  reviewed_at?: string | null;
  expires_at?: string | null;
  verification_status?: EvidenceVerificationStatus | string | null;
}

const DAY_MS = 86_400_000;
const STOP_WORDS = new Set([
  "about",
  "after",
  "along",
  "also",
  "among",
  "because",
  "before",
  "being",
  "between",
  "from",
  "have",
  "into",
  "more",
  "most",
  "other",
  "over",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "through",
  "under",
  "used",
  "using",
  "very",
  "when",
  "where",
  "which",
  "while",
  "with",
  "within",
  "without",
  "your",
]);

const TOKEN_ALIASES: Record<string, string> = {
  apolipoprotein: "apob",
  atherosclerosis: "cardiovascular",
  atherosclerotic: "cardiovascular",
  ascvd: "cardiovascular",
  cardiac: "cardiovascular",
  glycaemic: "glucose",
  glycemic: "glucose",
  hba1c: "a1c",
  renal: "kidney",
  filtration: "kidney",
  cholecalciferol: "vitamin",
};

function parsedTime(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T23:59:59Z`
    : raw.includes("T")
      ? raw
      : `${raw.replace(" ", "T")}Z`;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

export function normalizeEvidenceScope(value: unknown): EvidenceSourceScope {
  const scope = String(value ?? "")
    .trim()
    .toLowerCase();
  return EVIDENCE_SOURCE_SCOPES.includes(scope as EvidenceSourceScope) ? (scope as EvidenceSourceScope) : "general";
}

export function normalizeEvidenceDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match && parsedTime(match[1]) != null ? match[1] : null;
}

export function evidenceFreshness(
  metadata: EvidenceGovernanceMetadata,
  asOf: Date | string | number = new Date(),
  reviewWindowDays = 30
): EvidenceFreshness {
  const expiry = parsedTime(metadata.expires_at);
  if (expiry == null) return "unknown";
  const now = asOf instanceof Date ? asOf.getTime() : typeof asOf === "number" ? asOf : parsedTime(asOf);
  if (now == null || !Number.isFinite(now)) return "unknown";
  if (now > expiry) return "expired";
  const windowMs = Math.max(0, Math.min(365, Number(reviewWindowDays) || 0)) * DAY_MS;
  return expiry - now <= windowMs ? "review_due" : "current";
}

export function downgradedEvidenceConfidence(
  confidence: unknown,
  freshness: EvidenceFreshness,
  verification: EvidenceVerificationStatus
): EvidenceConfidence {
  const original: EvidenceConfidence = ["high", "moderate", "low"].includes(String(confidence))
    ? (String(confidence) as EvidenceConfidence)
    : "moderate";
  if (verification !== "claim_source" || freshness === "expired" || freshness === "unknown") return "low";
  if (freshness === "review_due" && original === "high") return "moderate";
  return original;
}

function evidenceTokens(value: unknown): Set<string> {
  const raw = String(value ?? "")
    .toLowerCase()
    .replace(/25[- ]?oh/g, "vitamin d")
    .replace(/non[- ]hdl/g, "nonhdl")
    .replace(/[^a-z0-9]+/g, " ");
  const out = new Set<string>();
  for (const word of raw.split(/\s+/)) {
    if (!word || word.length < 3 || STOP_WORDS.has(word)) continue;
    out.add(TOKEN_ALIASES[word] ?? word);
  }
  return out;
}

export interface ClaimSourceInput {
  claim?: unknown;
  body?: unknown;
  marker?: unknown;
  source_title?: unknown;
  source_url?: unknown;
}

export interface ClaimSourceVerdict {
  verified: boolean;
  status: EvidenceVerificationStatus;
  reason: "verified" | "missing_claim" | "missing_source" | "invalid_url" | "thin_support" | "topic_mismatch";
}

// A deterministic semantic floor, not a substitute for reading the publication:
// require a real URL, a specific title, and at least two shared material concepts
// between the claim and its supporting detail/topic. This prevents an unrelated
// claim from inheriting trust merely because its citation says "AHA" or "WHO".
export function verifyClaimToSource(input: ClaimSourceInput): ClaimSourceVerdict {
  const claim = String(input.claim ?? "").trim();
  if (!claim) return { verified: false, status: "unverified", reason: "missing_claim" };
  const title = String(input.source_title ?? "").trim();
  const url = String(input.source_url ?? "").trim();
  if (!title || title.length < 5 || !url) return { verified: false, status: "unverified", reason: "missing_source" };
  if (!isPlausibleSourceUrl(url)) return { verified: false, status: "unverified", reason: "invalid_url" };

  const supportText = `${String(input.body ?? "")} ${String(input.marker ?? "")}`.trim();
  const claimTokens = evidenceTokens(claim);
  const supportTokens = evidenceTokens(supportText);
  if (claimTokens.size < 2 || supportTokens.size < 2) {
    return { verified: false, status: "source_only", reason: "thin_support" };
  }
  let shared = 0;
  for (const token of claimTokens) if (supportTokens.has(token)) shared++;
  if (shared < 2) return { verified: false, status: "source_only", reason: "topic_mismatch" };
  return { verified: true, status: "claim_source", reason: "verified" };
}

// Validate a URL before it is stored or surfaced. Placeholder domains are not
// evidence, even though they are syntactically valid public URLs.
export function isPlausibleSourceUrl(url: unknown): boolean {
  const s = String(url ?? "").trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return false;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (!/\.[a-z]{2,}$/.test(host)) return false;
    if (/^(?:www\.)?example\.(?:com|org|net)$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}
