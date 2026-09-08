// ============================================================================
// equipment.ts — the athlete's persisted equipment profile (profile.equipment
// free text) and its parsed Equipment view. Split out of progression.ts, which
// only ever consumed availableEquipment() to rank variation candidates. A leaf:
// settings CRUD over one profile column, no progression logic. (The per-session
// equipment CONSTRAINT parser is a different concern — see equipment-capability.ts.)
// ============================================================================
import { db } from "../db.js";
import { type Equipment, parseEquipment } from "./exercise-variations.js";
import { getProfile } from "./profile.js";

// The athlete's available equipment, parsed from the persisted profile.equipment
// free-text field. Empty → no constraint (rank neutrally).
export function availableEquipment(): Equipment[] {
  try {
    return parseEquipment((getProfile() as any)?.equipment ?? null);
  } catch {
    return [];
  }
}

// Read/write the persisted equipment/preference profile (profile.equipment free
// text). Kept here (a direct column write) rather than in setProfile so the big
// profile upsert stays untouched — setProfile never lists equipment, so it never
// clobbers it. Returns the stored text + the parsed Equipment types.
export function getEquipmentProfile(): { equipment: string | null; parsed: Equipment[] } {
  const eq = (() => {
    try {
      return (getProfile() as any)?.equipment ?? null;
    } catch {
      return null;
    }
  })();
  return { equipment: eq, parsed: parseEquipment(eq) };
}

export function setEquipmentProfile(equipment: string | null): { equipment: string | null; parsed: Equipment[] } {
  const val = equipment == null ? null : String(equipment).trim().slice(0, 1000) || null;
  const existing = db.prepare(`SELECT id FROM profile WHERE id = 1`).get();
  if (existing) db.prepare(`UPDATE profile SET equipment = ? WHERE id = 1`).run(val);
  else db.prepare(`INSERT INTO profile (id, equipment) VALUES (1, ?)`).run(val);
  return { equipment: val, parsed: parseEquipment(val) };
}
