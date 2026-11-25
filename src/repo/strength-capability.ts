// The capability read: progress per movement unit and per muscle group, the single lift as
// evidence. Contract: src/contracts/strength-capability.ts.
import { localDateISO } from "./shared.js";
import type { StrengthCapabilityRead } from "../contracts/strength-capability.js";

export function capabilityRead(date: string = localDateISO()): StrengthCapabilityRead {
  return { available: false, date, overall: null, units: [], muscles: [] };
}
