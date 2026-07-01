import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function transpileClientSource(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      alwaysStrict: false,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.None,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      removeComments: false,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  return `(() => {\n${result.outputText.trimEnd()}\n})();\n`;
}

function loadAgentJobRecords() {
  const context = { Array, JSON, Object, String };
  context.window = context;
  vm.runInNewContext(transpileClientSource(join(root, "src/client/agent-job-records-client.ts")), context);
  return { context, records: context.CairnAgentJobRecords };
}

test("agent job record helpers normalize unknown records and rows", () => {
  const { context, records } = loadAgentJobRecords();

  assert.equal(context.window.CairnAgentJobRecords, records);
  assert.equal(typeof records.record, "function");
  assert.equal(Object.keys(records.record(null)).length, 0);
  assert.equal(Object.keys(records.record("bad")).length, 0);

  const row = { id: 42, kind: "meal_plan", status: "running" };
  assert.equal(records.record(row), row);
  assert.equal(records.job(row), row);
  assert.equal(records.job({ kind: "meal_plan" }), null);
  assert.equal(records.rows([row, null, "bad", { id: 43 }]).length, 2);
  assert.equal(records.key(null), "");
  assert.equal(records.key(42), "42");
});

test("agent job record helpers parse SSE events and terminal status", () => {
  const { records } = loadAgentJobRecords();
  const event = {
    data: JSON.stringify({
      job: { id: 7, status: "done", error: "fallback" },
      result: { ok: true },
    }),
  };

  const row = records.event(event);
  assert.equal(row.job.id, 7);
  assert.equal(row.result.ok, true);
  assert.equal(records.event({ data: "" }), null);
  assert.equal(records.event({ data: "{" }), null);
  assert.equal(records.event({ data: { nope: true } }), null);

  assert.equal(records.status(row.job), "done");
  assert.equal(records.status({ status: 200 }), "");
  assert.equal(records.isTerminal(row.job), true);
  assert.equal(records.isTerminal({ id: 8, status: "running" }), false);
  assert.equal(records.error({ message: "explicit" }, row.job), "explicit");
  assert.equal(records.error({}, row.job), "fallback");
  assert.equal(records.error({}, null), null);
});
