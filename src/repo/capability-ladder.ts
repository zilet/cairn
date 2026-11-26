// The capability read with the plateau ladder's next lever on each in-plan unit — the
// shape the REST route (`GET /api/strength-capability`) and the MCP tool
// (`get_strength_capability`) carry.
//
// Composed HERE, at the surface, never inside `capabilityRead`: the ladder
// (unit-plateau.ts) reads the capability read itself, so the read calling the ladder back
// would be a cycle. The read is taken once and handed to the ladder. A ladder that cannot
// be read leaves every unit exactly as the bare read has it (no `next`), so the surface
// fails toward the read it always was.
import type { StrengthCapabilityRead } from "../contracts/strength-capability.js";
import { localDateISO } from "./shared.js";
import { capabilityRead } from "./strength-capability.js";
import { rungAsNext, unitPlateauLadder } from "./unit-plateau.js";

/** The capability read for `date`, each in-plan unit the ladder covers carrying its `next` lever. */
export function capabilityWithLadder(date: string = localDateISO()): StrengthCapabilityRead {
  const read = capabilityRead(date);
  if (!read.available) return read;
  let byKey: Map<string, ReturnType<typeof rungAsNext>>;
  try {
    const ladder = unitPlateauLadder(read.date, { capability: read });
    if (!ladder.available) return read;
    byKey = new Map(ladder.units.map((rung) => [rung.unit_key, rungAsNext(rung)]));
  } catch {
    return read;
  }
  return {
    ...read,
    units: read.units.map((unit) => {
      const next = unit.in_plan ? byKey.get(unit.key) : undefined;
      return next ? { ...unit, next } : unit;
    }),
  };
}
