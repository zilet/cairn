// LOAD ORDER IS NOT A CONTRACT: every module that sits in an import cycle must load
// cleanly as the FIRST module a process imports.
//
// dist/ has import cycles (the repo layer is one large strongly-connected component).
// A cycle is harmless while every member only reaches its cycle-mates' bindings from
// inside functions, but a TOP-LEVEL read of a cycle-mate's binding (a constant built
// from another module's constant, a registration call at load) works only in the
// evaluation order the usual entry point happens to produce. Load another member first
// and the read lands before the binding is initialized: `ReferenceError: Cannot access
// 'X' before initialization` — at boot, from a reordered import. The server and
// test/_isolate.mjs have always entered the graph the same way, which hid exactly that
// (signal-state.js first used to throw on SIGNAL_VOICE).
//
// Within one strongly-connected component the evaluation order depends only on which
// member is entered first: the modules the component depends on are finished either
// way, and nothing in it is reached any other way. So importing EACH member of each
// cycle first, in a fresh process, covers every order any entry point can produce —
// the scan below finds the cycles from the built graph itself, so a new cycle is
// covered the moment it exists, and a new top-level read that one load order breaks
// fails here instead of at boot.
//
// The fix for a failure is structural, never a reordered import: move what is read at
// load time into a module outside the cycle (signal-voice.ts, push-stance-limits.ts,
// hybrid-forward-projection.ts are the precedents), or read it lazily.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// The static import graph: every top-level `import … from` / `export … from` / bare
// `import "…"` to a relative module. Dynamic import() is not an evaluation-order edge.
function importGraph() {
  const graph = new Map();
  for (const file of jsFiles(distDir)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
    const deps = new Set();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (statement.importClause?.isTypeOnly || statement.isTypeOnly) continue;
      const spec = statement.moduleSpecifier;
      if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith(".")) continue;
      deps.add(path.resolve(path.dirname(file), spec.text));
    }
    graph.set(file, deps);
  }
  return graph;
}

// Tarjan's strongly-connected components, iterative (the graph is deep enough that a
// recursive walk is one refactor away from the stack limit). Only real cycles (size > 1;
// tsc never emits a self-import) are returned.
function cycles(graph) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const found = [];
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work = [[start, [...graph.get(start)].filter((d) => graph.has(d)), 0]];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, deps] = frame;
      if (frame[2] < deps.length) {
        const dep = deps[frame[2]++];
        if (!index.has(dep)) {
          index.set(dep, counter);
          low.set(dep, counter++);
          stack.push(dep);
          onStack.add(dep);
          work.push([dep, [...graph.get(dep)].filter((d) => graph.has(d)), 0]);
        } else if (onStack.has(dep)) {
          low.set(node, Math.min(low.get(node), index.get(dep)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        if (component.length > 1) found.push(component.sort());
      }
    }
  }
  return found;
}

const rel = (file) => path.relative(root, file).split(path.sep).join("/");

// The child's environment mirrors test/run.mjs's envFor: its own throwaway DB (two
// processes opening one SQLite file race on the WAL pragma), every agent CLI pointed at
// a command that does not exist, no feedback service, no guide import. Loading a module
// should touch none of that, which is the point of making sure it cannot.
function childEnv(tempRoot, dir) {
  return {
    ...process.env,
    DATA_DIR: dir,
    DB_PATH: path.join(dir, "cairn-test.db"),
    AGENTS_CONFIG: path.join(tempRoot, "agents.offline.json"),
    GEMINI_API_KEY: "",
    GOOGLE_AI_KEY: "",
    GARMIN_USERNAME: "",
    GARMIN_PASSWORD: "",
    CAIRN_STARTER_ART_DIR: path.join(dir, "starter-art-none"),
    CAIRN_GUIDE_AUTO_IMPORT: "0",
    CAIRN_FEEDBACK_URL: "",
    CAIRN_LOG_LEVEL: "error",
    // Every child compiles the same few hundred modules; share V8's code cache so each
    // one after the first mostly evaluates.
    NODE_COMPILE_CACHE: path.join(tempRoot, "compile-cache"),
  };
}

// Import one module first and exit: process.exit, so a module that arms a timer at load
// cannot hold the child open.
const LOAD_FIRST = `
try {
  await import(process.argv[1]);
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
}`;

function loadFirst(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", LOAD_FIRST, pathToFileURL(file).href], {
      cwd: root,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ file, ok: status === 0, detail: signal ? `killed (${signal})` : stderr });
    });
  });
}

test("the import-graph scan sees dist's real imports", () => {
  const graph = importGraph();
  assert.ok(graph.size > 100, "dist/ is built (npm run build) and scanned");
  const signalState = graph.get(path.join(distDir, "repo", "signal-state.js"));
  assert.ok(signalState?.has(path.join(distDir, "repo", "signal-voice.js")), "a named re-export is an edge");
  assert.ok(signalState?.has(path.join(distDir, "repo", "sensor-freshness.js")), "a named import is an edge");
});

test("every module in an import cycle loads cleanly when it is imported first", async () => {
  const members = cycles(importGraph()).flat();
  if (!members.length) return; // no cycles, nothing whose order can matter

  const tempRoot = mkdtempSync(path.join(tmpdir(), "cairn-load-order-"));
  try {
    const agents = JSON.parse(readFileSync(path.join(root, "agents.json"), "utf8"));
    for (const [name, def] of Object.entries(agents)) {
      if (name !== "stub" && def && typeof def === "object") def.command = `cairn-test-offline-${name}`;
    }
    writeFileSync(path.join(tempRoot, "agents.offline.json"), JSON.stringify(agents));

    // Half the cores: the suite runs this beside other test files.
    const slots = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));
    const failures = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: slots }, async () => {
        while (next < members.length) {
          const file = members[next++];
          const dir = mkdtempSync(path.join(tempRoot, "db-"));
          const result = await loadFirst(file, childEnv(tempRoot, dir));
          if (!result.ok) failures.push(result);
        }
      })
    );

    const report = failures
      .sort((a, b) => a.file.localeCompare(b.file))
      .map(({ file, detail }) => `${rel(file)}\n    ${detail.trim().split("\n").slice(0, 4).join("\n    ")}`)
      .join("\n");
    assert.equal(
      failures.length,
      0,
      `${failures.length} of ${members.length} cycle members throw when imported first — a top-level read ` +
        `reaches a cycle-mate before it is initialized (see this file's header for the fix):\n${report}`
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
