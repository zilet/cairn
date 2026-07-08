import { AsyncLocalStorage } from "node:async_hooks";

type SignalKey = string;

interface BrainSnapshotScope {
  values: Map<SignalKey, unknown>;
  computes: Map<SignalKey, number>;
}

const als = new AsyncLocalStorage<BrainSnapshotScope>();

function createScope(): BrainSnapshotScope {
  return { values: new Map(), computes: new Map() };
}

export function runWithBrainSnapshot<T>(fn: () => T): T {
  const existing = als.getStore();
  if (existing) return fn();
  return als.run(createScope(), fn);
}

export function brainSignal<T>(key: SignalKey, compute: () => T): T {
  const scope = als.getStore();
  if (!scope) return compute();
  if (scope.values.has(key)) return scope.values.get(key) as T;
  scope.computes.set(key, (scope.computes.get(key) ?? 0) + 1);
  const value = compute();
  scope.values.set(key, value);
  return value;
}

export function invalidateBrainSnapshot(key?: SignalKey): void {
  const scope = als.getStore();
  if (!scope) return;
  if (!key) {
    scope.values.clear();
    return;
  }
  for (const existing of [...scope.values.keys()]) {
    if (existing === key || existing.startsWith(`${key}:`)) scope.values.delete(existing);
  }
}

export function activeBrainSnapshotStats(): { active: boolean; computes: Record<string, number>; keys: string[] } {
  const scope = als.getStore();
  if (!scope) return { active: false, computes: {}, keys: [] };
  return {
    active: true,
    computes: Object.fromEntries(scope.computes.entries()),
    keys: [...scope.values.keys()].sort(),
  };
}
