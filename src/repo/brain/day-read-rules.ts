import type { DayRead } from "../intelligence.js";

export interface DayReadRule {
  name: string;
  resolve: () => DayRead | null;
}

export function resolveDayReadRule(rules: DayReadRule[]): DayRead | null {
  for (const rule of rules) {
    const read = rule.resolve();
    if (read) return read;
  }
  return null;
}
