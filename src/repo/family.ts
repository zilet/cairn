// Family members (Phase 2B) — a small, self-contained CRUD cluster split out of
// coach.ts. Re-exported through src/repo.ts, so callers are unchanged.
import { db } from "../db.js";

// ---------- family members (Phase 2B) ----------
export interface FamilyInput {
  name?: string | null;
  color?: string | null;
  relationship?: string | null;
  birthdate?: string | null;
  notes?: string | null;
  allergies?: string | null;
  dietary_restrictions?: string | null;
}

export function listFamily() {
  return db.prepare(`SELECT * FROM family_members ORDER BY id`).all();
}

export function getFamilyMember(id: number) {
  return db.prepare(`SELECT * FROM family_members WHERE id = ?`).get(id) ?? null;
}

export function addFamily(fields: FamilyInput = {}) {
  const info = db
    .prepare(
      `INSERT INTO family_members (name, color, relationship, birthdate, notes, allergies, dietary_restrictions) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.name == null ? null : String(fields.name).trim().slice(0, 120) || null,
      fields.color == null ? null : String(fields.color).trim().slice(0, 40) || null,
      fields.relationship == null ? null : String(fields.relationship).trim().slice(0, 60) || null,
      fields.birthdate == null ? null : String(fields.birthdate).trim().slice(0, 10) || null,
      fields.notes == null ? null : String(fields.notes).trim().slice(0, 1000) || null,
      fields.allergies == null ? null : String(fields.allergies).trim().slice(0, 500) || null,
      fields.dietary_restrictions == null ? null : String(fields.dietary_restrictions).trim().slice(0, 500) || null
    );
  return getFamilyMember(Number(info.lastInsertRowid));
}

export function updateFamily(id: number, fields: FamilyInput) {
  const cur = getFamilyMember(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  const put = (col: string, v: any, max: number) => {
    sets.push(`${col} = ?`);
    vals.push(v == null ? null : String(v).trim().slice(0, max) || null);
  };
  if (fields.name !== undefined) put("name", fields.name, 120);
  if (fields.color !== undefined) put("color", fields.color, 40);
  if (fields.relationship !== undefined) put("relationship", fields.relationship, 60);
  if (fields.birthdate !== undefined) put("birthdate", fields.birthdate, 10);
  if (fields.notes !== undefined) put("notes", fields.notes, 1000);
  if (fields.allergies !== undefined) put("allergies", fields.allergies, 500);
  if (fields.dietary_restrictions !== undefined) put("dietary_restrictions", fields.dietary_restrictions, 500);
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE family_members SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getFamilyMember(id);
}

export function deleteFamily(id: number) {
  return { deleted: db.prepare(`DELETE FROM family_members WHERE id = ?`).run(id).changes };
}
