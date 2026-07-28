const SPORT_PATTERNS: Record<string, string[]> = {
  run: ["run", "running", "jog", "jogging"],
  ride: ["cycling", "cycle", "bike", "biking", "ride", "riding", "mtb", "gravel", "cyclocross"],
  swim: ["swim", "swimming"],
  row: ["row", "rowing", "erg"],
  walk: ["walk", "walking", "hike", "hiking"],
  ski: ["ski", "skiing", "skate skiing", "nordic", "cross country skiing", "xc skiing", "backcountry skiing", "ski touring"],
};

export const RUN_SPORT_PATTERNS = [...SPORT_PATTERNS.run];

export function sportPatternsForKey(key: unknown): string[] {
  return [...(SPORT_PATTERNS[String(key ?? "").toLowerCase()] ?? [])];
}

export function configuredEnduranceSportKeys(sportInput: unknown, defaultToRun = true): string[] {
  const sport = normalizeSportText(sportInput);
  if (!sport) return defaultToRun ? ["run"] : [];
  if (hasAnyToken(sport, ["tri", "triathlon", "multisport"])) return ["run", "ride", "swim"];

  const positions = Object.entries(SPORT_PATTERNS)
    .map(([key, tokens]) => {
      const offsets = tokens
        .map((token) => ` ${sport} `.indexOf(` ${token} `))
        .filter((offset) => offset >= 0);
      return { key, offset: offsets.length ? Math.min(...offsets) : -1 };
    })
    .filter((row) => row.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
  return positions.length ? positions.map((row) => row.key) : (defaultToRun ? ["run"] : []);
}

export function enduranceSportPatterns(sportInput: unknown = "running"): string[] {
  const sport = normalizeSportText(sportInput);
  if (hasAnyToken(sport, ["tri", "triathlon", "multisport"])) {
    return [...SPORT_PATTERNS.run, ...SPORT_PATTERNS.ride, ...SPORT_PATTERNS.swim, "triathlon", "multisport"];
  }
  const out: string[] = [];
  const add = (xs: string[]) => {
    for (const x of xs) if (!out.includes(x)) out.push(x);
  };
  if (hasAnyToken(sport, SPORT_PATTERNS.run)) add(SPORT_PATTERNS.run);
  if (hasAnyToken(sport, ["cycling", "cycle", "bike", "biking", "ride", "riding", "mtb", "gravel", "cyclocross"])) {
    add(SPORT_PATTERNS.ride);
  }
  if (hasAnyToken(sport, SPORT_PATTERNS.swim)) add(SPORT_PATTERNS.swim);
  if (hasAnyToken(sport, SPORT_PATTERNS.row)) add(SPORT_PATTERNS.row);
  if (hasAnyToken(sport, SPORT_PATTERNS.walk)) add(SPORT_PATTERNS.walk);
  if (hasAnyToken(sport, SPORT_PATTERNS.ski)) add(SPORT_PATTERNS.ski);
  return out.length ? out : [...SPORT_PATTERNS.run];
}

// Fold a raw activity type into a canonical endurance sport bucket, with whether
// PACE (min/km) is the metric that actually matters for it. Pace is a foot-sport
// idea: a cyclist's "3:53/km" is just speed inverted and reads as nonsense next to a
// runner's pace, so ride/swim/row are `paced:false` (distance/duration/speed instead).
// Shared + deterministic so the PR grouping and its test agree on the buckets.
export interface CanonicalSport {
  key: string;   // legacy family key: "run" | "walk" | "ride" | "swim" | "row" | "ski" | "other"
  label: string; // display name
  paced: boolean; // pace (min/km) is the meaningful best metric
}
export function canonicalEnduranceSport(type: unknown): CanonicalSport {
  const m = normalizeSportText(type); // separators → spaces, lowercased
  const has = (...tokens: string[]) => tokens.some((t) => ` ${m} `.includes(` ${t} `));
  // Order matters: "trail running" must read run before "trail" reads anything else,
  // and "mountain biking" must read ride, not walk on "mountain".
  if (has("run", "running", "jog", "jogging", "treadmill", "tempo", "interval", "intervals", "parkrun", "5k", "10k")) {
    return { key: "run", label: "Running", paced: true };
  }
  if (has("cycl", "cycling", "cycle", "bike", "biking", "biked", "mtb", "gravel", "cyclocross", "ride", "riding", "rode")) {
    return { key: "ride", label: "Cycling", paced: false };
  }
  if (has("swim", "swimming", "swam")) return { key: "swim", label: "Swimming", paced: false };
  if (has("row", "rowing", "erg")) return { key: "row", label: "Rowing", paced: false };
  if (has("ski", "skiing", "skied", "nordic", "skimo")) return { key: "ski", label: "Skiing", paced: false };
  if (has("walk", "walking", "hike", "hiking", "hiked", "ruck", "rucking", "fell")) {
    return { key: "walk", label: "Walking & Hiking", paced: true };
  }
  // Unknown: a Title Case version of the raw type, treated as a distance sport.
  const pretty = m ? m.split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "Other";
  return { key: m || "other", label: pretty || "Other", paced: false };
}

export type EnduranceSportFamily = "run" | "ride" | "swim" | "row" | "walk" | "ski" | "other";
export type EnduranceSportMode =
  | "run"
  | "ride"
  | "ride-road"
  | "ride-gravel"
  | "ride-trail-mtb"
  | "ride-downhill-mtb"
  | "swim"
  | "row"
  | "walk"
  | "ski"
  | "ski-alpine"
  | "ski-nordic"
  | "ski-touring"
  | "other";

export interface EnduranceSportClassification {
  family: EnduranceSportFamily;
  mode: EnduranceSportMode;
  label: string;
  paced: boolean;
  specificity: "family" | "mode";
}

const modeHas = (text: string, patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(text));

function modeWithinFamily(family: EnduranceSportFamily, input: unknown): EnduranceSportClassification {
  const text = normalizeSportText(input);
  if (family === "ride") {
    // Explicit downhill/lift-served language wins over the broader MTB token.
    if (
      modeHas(text, [
        /\blift served\b/,
        /\blift assisted\b/,
        /\bbike park\b/,
        /\bgravity mtb\b/,
        /\bdh mtb\b/,
        /\bmtb dh\b/,
        /\bdownhill (?:mountain bik(?:e|ing)|mtb|trail bik(?:e|ing)|trail rid(?:e|ing))\b/,
        /\b(?:mountain bik(?:e|ing)|mtb|trail bik(?:e|ing)|trail rid(?:e|ing)) downhill\b/,
      ])
    ) {
      return {
        family,
        mode: "ride-downhill-mtb",
        label: "Downhill mountain biking",
        paced: false,
        specificity: "mode",
      };
    }
    if (
      modeHas(text, [
        /\bmountain bik(?:e|ing)\b/,
        /\bmountain rid(?:e|ing)\b/,
        /\bmtb\b/,
        /\btrail bik(?:e|ing)\b/,
        /\btrail rid(?:e|ing)\b/,
        /\bsingle ?track\b/,
        /\bcross country mtb\b/,
        /\bxc mtb\b/,
        /\bmtb xc\b/,
        /\bfells rid(?:e|ing)\b/,
        /\brid(?:e|ing) (?:in|at|through) (?:the )?fells\b/,
      ])
    ) {
      return {
        family,
        mode: "ride-trail-mtb",
        label: "Trail mountain biking",
        paced: false,
        specificity: "mode",
      };
    }
    if (modeHas(text, [/\bgravel\b/, /\bcyclocross\b/])) {
      return { family, mode: "ride-gravel", label: "Gravel cycling", paced: false, specificity: "mode" };
    }
    if (modeHas(text, [/\broad bik(?:e|ing)\b/, /\broad cycl(?:e|ing)\b/, /\broad rid(?:e|ing)\b/])) {
      return { family, mode: "ride-road", label: "Road cycling", paced: false, specificity: "mode" };
    }
    return { family, mode: "ride", label: "Cycling", paced: false, specificity: "family" };
  }

  if (family === "ski") {
    // Human-powered touring must win over "alpine" in "alpine touring".
    if (
      modeHas(text, [
        /\bbackcountry\b/,
        /\bski tour(?:ing)?\b/,
        /\balpine tour(?:ing)?\b/,
        /\buphill ski(?:ing)?\b/,
        /\bskin(?:ning| track)?\b/,
        /\bskimo\b/,
      ])
    ) {
      return { family, mode: "ski-touring", label: "Ski touring", paced: false, specificity: "mode" };
    }
    if (
      modeHas(text, [
        /\bnordic\b/,
        /\bcross country ski(?:ing)?\b/,
        /\bxc ski(?:ing)?\b/,
        /\bskate ski(?:ing)?\b/,
        /\bclassic ski(?:ing)?\b/,
      ])
    ) {
      return { family, mode: "ski-nordic", label: "Nordic skiing", paced: false, specificity: "mode" };
    }
    if (
      modeHas(text, [
        /\balpine\b/,
        /\bdownhill\b/,
        /\blift served\b/,
        /\blift assisted\b/,
        /\bresort ski(?:ing)?\b/,
      ])
    ) {
      return { family, mode: "ski-alpine", label: "Alpine skiing", paced: false, specificity: "mode" };
    }
    return { family, mode: "ski", label: "Skiing", paced: false, specificity: "family" };
  }

  const canonical = canonicalEnduranceSport(text);
  const knownFamily: EnduranceSportFamily =
    ["run", "ride", "swim", "row", "walk", "ski"].includes(canonical.key)
      ? (canonical.key as EnduranceSportFamily)
      : "other";
  return {
    family: knownFamily,
    mode: (knownFamily === "other" ? "other" : knownFamily) as EnduranceSportMode,
    label: canonical.label,
    paced: canonical.paced,
    specificity: "family",
  };
}

/**
 * Classify one sport description into a stable legacy family plus a terrain/modal
 * subtype. Generic "MTB" means trail/cross-country riding; explicit downhill or
 * lift-served language is required for the gravity-only mode.
 */
export function classifyEnduranceSport(input: unknown): EnduranceSportClassification {
  const canonical = canonicalEnduranceSport(input);
  const family: EnduranceSportFamily =
    ["run", "ride", "swim", "row", "walk", "ski"].includes(canonical.key)
      ? (canonical.key as EnduranceSportFamily)
      : "other";
  return modeWithinFamily(family, input);
}

/**
 * Classify an activity without allowing incidental prose to change its structured
 * family. A generic structured family may use the surrounding text to recover a
 * more specific mode inside that family (for example Garmin `ride` + "MTB").
 */
export function classifyEnduranceActivity(
  structuredType: unknown,
  supportingText: unknown = "",
): EnduranceSportClassification {
  const structured = classifyEnduranceSport(structuredType);
  if (structured.family !== "other") {
    const supported = modeWithinFamily(
      structured.family,
      `${String(structuredType ?? "")} ${String(supportingText ?? "")}`,
    );
    // "Mountain biking" is a broad provider type. Explicit lift-served/downhill
    // detail refines it to gravity riding, while other structured subtypes stay
    // authoritative over incidental notes.
    if (structured.mode === "ride-trail-mtb" && supported.mode === "ride-downhill-mtb") return supported;
    if (structured.specificity === "mode") return structured;
    return supported;
  }
  return classifyEnduranceSport(supportingText);
}

export function activitySportWhere(alias: string, patterns: string[]): { sql: string; params: string[] } {
  const params = patterns.map(sportTokenParam).filter((p): p is string => !!p);
  if (!params.length) return { sql: "0", params: [] };
  const typeWords = activityTypeWordsSql(alias);
  return {
    sql: params.map(() => `${typeWords} LIKE ?`).join(" OR "),
    params,
  };
}

function normalizeSportText(input: unknown): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAnyToken(text: string, tokens: string[]): boolean {
  const haystack = ` ${text} `;
  return tokens.some((token) => haystack.includes(` ${token} `));
}

function sportTokenParam(pattern: string): string | null {
  const token = normalizeSportText(String(pattern).replace(/%/g, " "));
  return token ? `% ${token} %` : null;
}

function activityTypeWordsSql(alias: string): string {
  let expr = `LOWER(COALESCE(${alias}.type,''))`;
  for (const ch of ["-", "_", "/", ".", ",", ":", ";", "(", ")", "[", "]", "+"]) {
    expr = `REPLACE(${expr}, '${ch}', ' ')`;
  }
  return `(' ' || ${expr} || ' ')`;
}
