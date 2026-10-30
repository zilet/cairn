// `node test/run.mjs --changed` (npm run test:changed) picks the test files a change can
// reach — test/_select.mjs. A fixture repo pins each kind of edge; the real repo pins
// that the graph stays fast and that a change selects the tests that import it and not
// the ones that cannot load it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, selectTests } from "./_select.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-select-"));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  const testFiles = fs
    .readdirSync(path.join(root, "test"))
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => path.join(root, "test", f));
  const pick = (...changed) => {
    const result = selectTests({ root, changed, testFiles });
    return { ...result, names: result.selected.map((f) => path.basename(f, ".test.js")) };
  };
  return { root, pick, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const FILES = {
  "src/a.ts": "export function a() { return 1; }\n",
  "src/b.ts": 'import { c } from "./c.js";\nexport function b() { return c(); }\n',
  "src/c.ts": "export function c() { return 3; }\nexport type Shape = { n: number };\n",
  "src/d.ts": 'import type { Shape } from "./c.js";\nexport const d = (s: Shape) => s.n;\n',
  // A barrel: followed only through the names an importer uses.
  "src/barrel.ts": 'export * from "./a.js";\nexport * from "./b.js";\n',
  "src/db.ts": "export const db = {};\n",
  "src/client/widget.ts": "function widget() {}\n",
  "scripts/build-client.mjs":
    'export const CLIENT_OUTPUTS = [\n  { source: "src/client/widget.ts", output: "public/js/widget.js" },\n];\n',
  "docs/notes.md": "# notes\n",
  // A helper that hands a namespace on, like test/_seed.js's `repo`.
  "test/_seed.js":
    'import * as repo from "../dist/barrel.js";\nexport { repo };\nexport function seedA() { return repo.a(); }\n',
  "test/a.test.js": 'import { a } from "../dist/barrel.js";\na();\n',
  "test/b.test.js": 'import { repo } from "./_seed.js";\nrepo.b();\n',
  "test/c.test.js": 'import { c } from "../dist/c.js";\nc();\n',
  "test/d.test.js": 'import { d } from "../dist/d.js";\nd({ n: 1 });\n',
  "test/client.test.js": 'import { loadClientModule } from "./_dom.mjs";\nloadClientModule(["widget.js"]);\n',
  "test/_dom.mjs": "export function loadClientModule() {}\n",
  "test/reads.test.js":
    'import fs from "node:fs";\nimport path from "node:path";\nfs.readFileSync(path.join(root, "src", "c.ts"), "utf8");\n',
  // A child process that imports the built module: the walk goes on through it.
  "test/spawn.test.js":
    'import { spawnSync } from "node:child_process";\nimport path from "node:path";\n' +
    'const target = path.join(root, "dist", "b.js");\n' +
    'spawnSync(process.execPath, ["-e", "import(" + JSON.stringify(target) + ")"]);\n',
  // A `/*` inside a // comment must not swallow the import after it.
  "test/comment.test.js": '// reads `public/css/*.css` too\nimport { d } from "../dist/d.js";\nd({ n: 2 });\n',
  // A dot-directory file a test reads by path, and one nothing names.
  ".github/workflows/ci.yml": "on: push\n",
  ".dockerignore": "node_modules\n",
  "test/ci.test.js":
    'import fs from "node:fs";\nimport path from "node:path";\nfs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");\n',
};
const TEST_COUNT = Object.keys(FILES).filter((f) => f.endsWith(".test.js")).length;

test("each kind of edge selects the tests behind it, and nothing else", (t) => {
  const repo = fixture(FILES);
  t.after(repo.done);
  // Through a concrete import, a barrel's used name, a namespace handed on, a path read,
  // and a child process that imports dist/b.js (b imports c).
  assert.deepEqual(repo.pick("src/c.ts").names, ["b", "c", "reads", "spawn"]);
  // An import after a comment holding "/*" is still an import.
  assert.deepEqual(repo.pick("src/d.ts").names, ["comment", "d"]);
  // A dot-directory file a test reads selects that test.
  assert.deepEqual(repo.pick(".github/workflows/ci.yml").names, ["ci"]);
  // A type-only import carries no edge: d.ts does not load c.ts.
  assert.ok(!repo.pick("src/c.ts").names.includes("d"));
  // test/_seed.js's own use of repo.a reaches every file that imports the helper.
  assert.deepEqual(repo.pick("src/a.ts").names, ["a", "b"]);
  // The barrel itself: everyone who imports it.
  assert.deepEqual(repo.pick("src/barrel.ts").names, ["a", "b"]);
  // Client code: the test that loads the built bundle by its bare name.
  assert.deepEqual(repo.pick("src/client/widget.ts").names, ["client"]);
  // A changed test is selected; a helper selects its importers.
  assert.deepEqual(repo.pick("test/d.test.js").names, ["d"]);
  assert.deepEqual(repo.pick("test/_dom.mjs").names, ["client"]);
  // Nothing loads the docs; generated output is never a change of its own.
  assert.deepEqual(repo.pick("docs/notes.md").names, []);
  assert.deepEqual(repo.pick("dist/c.js", "public/js/widget.js").names, []);
  assert.equal(repo.pick().reason, "nothing changed");
});

test("infrastructure, the schema, or a graph it cannot build means the whole suite", (t) => {
  const repo = fixture(FILES);
  t.after(repo.done);
  for (const [changed, why] of [
    ["test/run.mjs", /test infrastructure changed \(test\/run\.mjs\)/],
    ["test/_isolate.mjs", /test infrastructure/],
    ["package.json", /test infrastructure/],
    ["tsconfig.json", /test infrastructure/],
    ["scripts/build-client.mjs", /test infrastructure/],
    ["src/db.ts", /every test process loads src\/db\.ts/],
    ["src/migrations/v101-150.ts", /every test process loads/],
  ]) {
    const result = repo.pick(changed, "src/a.ts");
    assert.equal(result.full, true, changed);
    assert.equal(result.names.length, TEST_COUNT, changed);
    assert.match(result.reason, why);
  }
  // A changed file no test's graph or path references reach: run everything, and say which.
  const unseen = repo.pick(".dockerignore", "src/a.ts");
  assert.equal(unseen.full, true);
  assert.match(unseen.reason, /reach \.dockerignore/);
  fs.rmSync(path.join(repo.root, "src"), { recursive: true, force: true });
  const noSrc = repo.pick("src/a.ts");
  assert.equal(noSrc.full, true);
  assert.match(noSrc.reason, /no src\//);
});

test("on the real repo the graph builds fast and a change selects its importers, not the world", () => {
  const started = performance.now();
  const graph = buildGraph(repoRoot);
  const buildMs = performance.now() - started;
  assert.ok(graph.modules.size > 1000, `parsed ${graph.modules.size} modules`);
  // A runaway guard, not a benchmark (it builds in ~0.35 s alone; this runs beside 8 others).
  assert.ok(buildMs < 15_000, `graph built in ${Math.round(buildMs)} ms`);

  const testDir = path.join(repoRoot, "test");
  const testFiles = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => path.join(testDir, f));
  const pick = (changed) => selectTests({ root: repoRoot, changed: [changed], testFiles, graph });

  // A route module: every test that imports it directly is selected, a pure client test is not.
  const route = pick("src/routes/operator.ts");
  const names = new Set(route.selected.map((f) => path.basename(f)));
  const direct = testFiles.filter((f) => fs.readFileSync(f, "utf8").includes("dist/routes/operator.js"));
  assert.ok(direct.length > 0);
  for (const f of direct) assert.ok(names.has(path.basename(f)), `${path.basename(f)} imports the route`);
  assert.ok(!names.has("savebarUi.test.js"), "a client-only test cannot load a route");
  assert.ok(route.selected.length < testFiles.length / 4, `${route.selected.length} of ${testFiles.length}`);

  // A coach op that tests load only in a child process (spawned against dist/coachOps.js).
  const nutrition = new Set(pick("src/coachOps/nutrition.ts").selected.map((f) => path.basename(f)));
  for (const name of ["nutritionCheckinVetoCooldown.test.js", "nutritionCheckinProtectiveGuard.test.js"]) {
    assert.ok(nutrition.has(name), `${name} spawns a child importing dist/coachOps.js`);
  }
  assert.ok(new Set(pick("src/routes/health-metrics.ts").selected.map((f) => path.basename(f))).has("auth.test.js"));

  // A stylesheet partial selects the tests that read the built CSS (and the ones that scan
  // all of src/), not the rest.
  const styles = new Set(pick("src/styles/foundation/tokens.css").selected);
  const code = (f) => fs.readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const readers = testFiles.filter((f) => /public\/styles\.css|"public",\s*"styles\.css"/.test(code(f)));
  assert.ok(readers.length > 0);
  for (const f of readers) assert.ok(styles.has(f), `${path.basename(f)} reads public/styles.css`);
  assert.ok(styles.size < testFiles.length / 4, `${styles.size} of ${testFiles.length}`);
});
