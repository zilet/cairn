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
