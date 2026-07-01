import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function compileClientSource(file) {
  const source = readFileSync(join(root, file), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      alwaysStrict: false,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.None,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  }).outputText;
}

class FakeSource {
  constructor(id) {
    this.id = id;
    this.closeCount = 0;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closeCount += 1;
  }

  emit(type, data) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }

  emitRaw(type, event) {
    this.listeners.get(type)?.(event);
  }
}

function record(value) {
  return value && typeof value === "object" ? value : {};
}

function loadMonitor() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    String,
    globalThis: null,
    window: null,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(compileClientSource("src/client/chat-turn-monitor-client.ts"), context, {
    filename: "chat-turn-monitor-client.js",
  });
  return context.CairnChatTurnMonitor;
}

function createHarness(options = {}) {
  const api = loadMonitor();
  let active = options.active ?? true;
  let hasLog = options.hasLog ?? true;
  const pending = new Set(options.pending ?? [7]);
  const sources = [];
  const calls = [];
  const monitor = api.create({
    isActive: () => active,
    hasLog: () => hasLog,
    pendingIds: () => [...pending],
    createStream: (id) => {
      const source = new FakeSource(id);
      sources.push(source);
      return source;
    },
    parse: (event) => record(JSON.parse(event.data)),
    record,
    phase: (id, turn) => calls.push({ kind: "phase", id, turn: record(turn) }),
    progress: (id, text) => calls.push({ kind: "progress", id, text }),
    delta: (id, text) => calls.push({ kind: "delta", id, text }),
    reset: (id) => calls.push({ kind: "reset", id }),
    finish: (turn, message) => {
      const row = record(turn);
      pending.delete(Number(row.id));
      calls.push({ kind: "finish", turn: row, message: record(message) });
    },
    cancel: (turn) => {
      const row = record(turn);
      pending.delete(Number(row.id));
      calls.push({ kind: "cancel", turn: row });
    },
  });
  return {
    calls,
    monitor,
    pending,
    setActive: (value) => { active = value; },
    setHasLog: (value) => { hasLog = value; },
    sources,
  };
}

test("chat turn monitor opens the oldest pending turn and advances after terminal events", () => {
  const h = createHarness({ pending: [9, 4] });

  h.monitor.ensure();
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].id, 4);
  assert.equal(h.monitor.currentId(), 4);

  h.sources[0].emit("snapshot", { turn: { id: 4, status: "running", phase: "applying" } });
  h.sources[0].emit("progress", { text: "Saving" });
  h.sources[0].emit("delta", { text: "hello" });
  h.sources[0].emit("reset", {});
  assert.deepEqual(h.calls.slice(0, 4), [
    { kind: "phase", id: 4, turn: { id: 4, status: "running", phase: "applying" } },
    { kind: "progress", id: 4, text: "Saving" },
    { kind: "delta", id: 4, text: "hello" },
    { kind: "reset", id: 4 },
  ]);

  h.sources[0].emit("done", { turn: { id: 4, status: "done" }, message: { id: "m4" } });
  assert.equal(h.sources[0].closeCount, 1);
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[1].id, 9);
  assert.equal(h.monitor.currentId(), 9);
  assert.deepEqual(h.calls.at(-1), {
    kind: "finish",
    turn: { id: 4, status: "done" },
    message: { id: "m4" },
  });
});

test("chat turn monitor closes stale streams without dispatching stale DOM writes", () => {
  const h = createHarness({ pending: [3] });

  h.monitor.ensure();
  h.setActive(false);
  h.sources[0].emit("delta", { text: "late" });

  assert.equal(h.sources[0].closeCount, 1);
  assert.equal(h.monitor.currentId(), null);
  assert.deepEqual(h.calls, []);
});

test("chat turn monitor leaves native connection errors to EventSource reconnect", () => {
  const h = createHarness({ pending: [2] });

  h.monitor.ensure();
  h.sources[0].emitRaw("error", { data: "" });

  assert.equal(h.sources[0].closeCount, 0);
  assert.equal(h.monitor.currentId(), 2);

  h.sources[0].emit("error", { turn: { id: 2, status: "error" }, message: { id: "m2" } });
  assert.equal(h.sources[0].closeCount, 1);
  assert.deepEqual(h.calls, [
    { kind: "finish", turn: { id: 2, status: "error" }, message: { id: "m2" } },
  ]);
});
