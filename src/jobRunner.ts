import { EventEmitter } from "node:events";

// Shared in-process scaffolding for Cairn's durable serial agent engines
// (src/chatTurns.ts, src/agentJobs.ts): a per-entity progress bus + a strictly
// serial drain loop whose failing item can never wedge the queue. Each engine
// keeps its OWN AbortController map, per-item processor, cancel and recovery — only
// the generic bus + queue mechanics live here, so a fix to either propagates to
// both instead of drifting between two near-identical copies.

// One EventEmitter, one event name per entity id ("<prefix>:<id>"). The SSE handler
// subscribes for the id it's streaming; the worker emits on every phase change and
// on the terminal transition. `on` returns an unsubscribe.
export function createProgressBus<E>(prefix: string) {
  const bus = new EventEmitter();
  // A finite, generous cap: each entity id is its own event name with typically
  // one SSE subscriber, so this comfortably allows normal concurrency (many turns/
  // jobs in flight) while still surfacing Node's warning if a genuine listener leak
  // ever accumulates — which `setMaxListeners(0)` would silence entirely.
  bus.setMaxListeners(50);
  return {
    on(id: number, listener: (e: E) => void): () => void {
      const ev = `${prefix}:${id}`;
      bus.on(ev, listener);
      return () => bus.off(ev, listener);
    },
    emit(id: number, payload: E): void {
      try { bus.emit(`${prefix}:${id}`, payload); } catch { /* a bad subscriber must never break the worker */ }
    },
  };
}

// A strictly-serial in-process queue: one id processed at a time. A throwing
// `process` can never wedge the loop — `backstop(id, err)` records the escaped
// failure (the engine's own processX `finally` has already released its
// AbortController), then the drain continues. `enqueue` kicks the drain if idle.
export function createSerialRunner(
  process: (id: number) => Promise<void>,
  backstop: (id: number, err: any) => void,
) {
  const queue: number[] = [];
  let draining = false;
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const id = queue.shift()!;
        try {
          await process(id);
        } catch (e: any) {
          try { backstop(id, e); } catch { /* a backstop must never break the loop */ }
        }
      }
    } finally {
      draining = false;
    }
  }
  return {
    enqueue(id: number): void {
      queue.push(id);
      if (!draining) void drain();
    },
  };
}
