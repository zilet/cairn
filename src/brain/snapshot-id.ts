import crypto from "node:crypto";
import { normalizeJsonObject, type JsonObject } from "./contract-utils.js";

export interface ImmutableBrainSnapshot {
  id: string;
  created_at: string;
  context: JsonObject;
}

export function createImmutableBrainSnapshot(context: unknown, now = new Date()): ImmutableBrainSnapshot {
  const bounded = normalizeJsonObject(context) ?? {};
  const serialized = JSON.stringify(bounded);
  const id = crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 32);
  return Object.freeze({ id, created_at: now.toISOString(), context: structuredClone(bounded) });
}
