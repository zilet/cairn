export function enduranceSportPatterns(sportInput: unknown = "running"): string[] {
  const sport = normalizeSportText(sportInput);
  if (hasAnyToken(sport, ["cycling", "cycle", "bike", "biking", "ride", "riding", "mtb", "gravel", "cyclocross"])) {
    return ["cycling", "cycle", "bike", "biking", "ride", "riding", "mtb", "gravel", "cyclocross"];
  }
  if (hasAnyToken(sport, ["swim", "swimming"])) return ["swim", "swimming"];
  if (hasAnyToken(sport, ["row", "rowing", "erg"])) return ["row", "rowing", "erg"];
  if (hasAnyToken(sport, ["walk", "walking", "hike", "hiking"])) return ["walk", "walking", "hike", "hiking"];
  if (hasAnyToken(sport, ["tri", "triathlon", "multisport"])) {
    return ["run", "running", "jog", "jogging", "cycling", "cycle", "bike", "biking", "ride", "riding", "mtb", "gravel", "cyclocross", "swim", "swimming", "triathlon", "multisport"];
  }
  return ["run", "running", "jog", "jogging"];
}

// Fold a raw activity type into a canonical endurance sport bucket, with whether
// PACE (min/km) is the metric that actually matters for it. Pace is a foot-sport
// idea: a cyclist's "3:53/km" is just speed inverted and reads as nonsense next to a
// runner's pace, so ride/swim/row are `paced:false` (distance/duration/speed instead).
// Shared + deterministic so the PR grouping and its test agree on the buckets.
export interface CanonicalSport {
  key: string;   // "run" | "walk" | "ride" | "swim" | "row" | "other"
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
  if (has("walk", "walking", "hike", "hiking", "hiked", "ruck", "rucking", "fell")) {
    return { key: "walk", label: "Walking & Hiking", paced: true };
  }
  // Unknown: a Title Case version of the raw type, treated as a distance sport.
  const pretty = m ? m.split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "Other";
  return { key: m || "other", label: pretty || "Other", paced: false };
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
