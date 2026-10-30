// Changed-test selection for `node test/run.mjs --changed[=<ref>]` (npm run test:changed).
//
// Static and conservative: a test file is selected when anything it can load or read
// changed. The graph is built from SOURCE, not from dist, so it is right before a build
// and never sees a stale dist file:
//   - import edges: `import … from`, `import "…"`, `export … from` and `import("…")` with a
//     literal (or a template literal's static head), relative specifiers only. A test's
//     `../dist/x.js` is src/x.ts; a src `./y.js` is src/y.ts. `import type` / `export type`
//     are erased at build time and carry no edge.
//   - barrels: a module made only of re-exports (src/repo.ts, src/prompt.ts, …) is
//     followed only through the names an importer actually uses — a named import's
//     bindings, or the `ns.name` reads of a namespace import (and of a namespace another
//     module hands on, like test/_seed.js's `repo`). Any other use of a namespace (passed
//     around, destructured, indexed) follows the whole barrel. This pruning assumes a
//     re-exported module's load-time side effects are covered by its own tests.
//   - path references in tests and scripts: a literal that names an EXECUTABLE module —
//     built output (`"./dist/coachOps.js"`, `path.join(root, "dist", "x.js")`, mapped to its
//     source) or a .js/.mjs script or test module — is an import edge, so the walk goes on
//     through what a spawned child loads. A literal naming any other repo path (a source
//     read as text, `"src/repo/x.ts"`; a fixture; a directory, meaning everything under it)
//     is a leaf — the contract tests that read sources.
//   - client code: a test that loads `public/js/<name>.js` (by path or by the bare name
//     test/_dom.mjs takes) depends on the src/client module(s) built into it
//     (scripts/build-client.mjs CLIENT_OUTPUTS and BUNDLES); public/styles.css and
//     public/css/* depend on src/styles/.
// Everything a test process loads regardless of the file (test/run.mjs, test/_isolate.mjs
// and the offline floor, package.json, tsconfig, the build scripts, agents.json, the
// selector itself) is "infrastructure": a change there selects the whole suite, as does
// a missing src/, a git that cannot answer, or a changed file the graph cannot see at all
// (no module, no reference, no directory read over it — a CI workflow, an ignore file);
// only a doc nothing names may select nothing. test/_isolate.mjs also imports dist/db.js
// for every file, so db.ts and its graph are a root of every test. (It imports a few
// stateful modules too, only to reset them between tests; a test that never imports
// one cannot observe its behaviour, and test/moduleLoadOrder.test.js holds load order.)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Changes that make every test file suspect.
const INFRA = [
  /^test\/run\.mjs$/,
  /^test\/_select\.mjs$/,
  /^test\/_isolate\.mjs$/,
  /^test\/_env\.mjs$/,
  /^test\/_offline\.mjs$/,
  /^test\/_offlineProbe\.mjs$/,
  /^package(-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^agents\.json$/,
  /^scripts\/build-[^/]+\.mjs$/,
  /^\.node-version$|^\.nvmrc$/,
];
// Generated or ignored output: never a source of change in itself.
const IGNORED = [/^dist\//, /^node_modules\//, /^public\/js\/(?!10-boot\.js$)[^/]+\.js$/, /\.(?:gz|br)$/];

const toPosix = (p) => p.split(path.sep).join("/");

// ---------------------------------------------------------------------------- git

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Files changed since `ref` (default: the merge-base with main), plus uncommitted and untracked ones. */
export function changedFiles(root, ref) {
  let base = ref;
  let baseLabel = ref;
  if (!base) {
    for (const main of ["main", "origin/main"]) {
      try {
        base = git(root, ["merge-base", "HEAD", main]);
        baseLabel = `merge-base with ${main} (${base.slice(0, 8)})`;
        break;
      } catch {}
    }
    if (!base) throw new Error("no merge-base with main or origin/main");
  }
  const diff = git(root, ["diff", "--name-only", "--no-renames", base]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  const files = [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort();
  return { files, base: baseLabel };
}

// ---------------------------------------------------------------------------- parsing

const IMPORT_CLAUSE = String.raw`((?:[\w$]+\s*,\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\})|[\w$]+)`;
const IMPORT_RE = new RegExp(String.raw`\bimport\s+(type\s+)?${IMPORT_CLAUSE}\s*from\s*["']([^"']+)["']`, "g");
const SIDE_IMPORT_RE = /\bimport\s*["']([^"']+)["']/g;
const EXPORT_FROM_RE = /\bexport\s+(type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(["'`])([^"'`$]*)/g;
const LITERAL_RE = /(["'`])((?:(?!\1)[^\\\n]|\\.){1,240})\1/g;
const JOIN_RE = /\b(?:join|resolve)\(([^()]*)\)/g;
const EXPORT_DECL_RE =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function\*?|const|let|var|class|enum|type|interface|namespace)\s+([\w$]+)/g;
const EXPORT_LIST_RE = /\bexport\s+(type\s+)?\{([^}]*)\}(?!\s*from)/g;

// Comments out, strings and regex literals kept: a scanner, so a `/*` inside a // comment
// (scripts/check-bundle-budget.mjs: "`public/css/*.css`") or a `//` inside a string never
// swallows the code after it.
function stripComments(source) {
  const parts = [];
  let segment = 0; // start of the code not yet copied
  let i = 0;
  const n = source.length;
  let prev = ""; // the last significant character class: "" (start), "a" (operand), or the char
  while (i < n) {
    const ch = source.charCodeAt(i);
    if (ch === 47 /* / */) {
      const next = source.charCodeAt(i + 1);
      if (next === 47 || next === 42) {
        parts.push(source.slice(segment, i), " ");
        if (next === 47) {
          const end = source.indexOf("\n", i);
          i = end === -1 ? n : end;
        } else {
          const end = source.indexOf("*/", i + 2);
          i = end === -1 ? n : end + 2;
        }
        segment = i;
        continue;
      }
      // A regex literal can only start where an expression can.
      if (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev)) {
        let inClass = false;
        for (i++; i < n; i++) {
          const c = source[i];
          if (c === "\\") i++;
          else if (c === "\n") break;
          else if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
        }
        i++;
        prev = "a";
        continue;
      }
      prev = "/";
      i++;
      continue;
    }
    if (ch === 34 || ch === 39 || ch === 96) {
      const quote = source[i];
      for (i++; i < n; i++) {
        const c = source[i];
        if (c === "\\") i++;
        else if (c === quote) break;
        else if (c === "\n" && quote !== "`") break;
      }
      i++;
      prev = "a";
      continue;
    }
    if (ch > 32) {
      const word = (ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
      prev = word || ch === 95 || ch === 36 || ch === 41 || ch === 93 ? "a" : source[i];
    }
    i++;
  }
  parts.push(source.slice(segment));
  return parts.join("");
}

// `{ a, b as c, type T }` → [{ imported: "a", local: "a" }, { imported: "b", local: "c" }]
function bindings(list) {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("type "))
    .map((part) => {
      const [imported, local = imported] = part.split(/\s+as\s+/).map((s) => s.trim());
      return { imported, local };
    });
}

// What a namespace binding `ns` is used for in `body`: the `ns.name` reads, or "all".
function namespaceUse(body, ns) {
  const names = new Set();
  const re = new RegExp(String.raw`(^|[^\w$.])${ns.replace(/\$/g, "\\$")}\b(\s*\.\s*([\w$]+))?`, "g");
  for (const m of body.matchAll(re)) {
    if (!m[3]) return "all";
    names.add(m[3]);
  }
  return names;
}

function parseModule(file, source) {
  const code = stripComments(source);
  const imports = []; // { spec, names: Set|"all", nsLocal?: string }
  const reexports = []; // { spec, star: bool, map: Map<exported, imported>, nsName?: string }
  const declared = new Set(); // runtime names this module defines and exports
  const typeNames = new Set();
  const listed = []; // `export { a as b }` without from: { local, exported }
  let statements = code;

  for (const m of code.matchAll(IMPORT_RE)) {
    statements = statements.replace(m[0], " ");
    if (m[1]) continue; // import type
    const clause = m[2].trim();
    const spec = m[3];
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause)?.[1];
    const named = /\{([^}]*)\}/.exec(clause)?.[1];
    const def = /^([\w$]+)/.exec(clause)?.[1];
    const entry = { spec, names: new Set(), locals: [] };
    if (def && def !== "type") entry.names.add("default");
    if (named !== undefined) {
      const list = bindings(named);
      if (!list.length && def === undefined && !ns) continue; // `import { type A }` only
      for (const b of list) {
        entry.names.add(b.imported);
        entry.locals.push(b);
      }
    }
    if (ns) entry.nsLocal = ns;
    imports.push(entry);
  }
  for (const m of code.matchAll(SIDE_IMPORT_RE)) imports.push({ spec: m[1], names: "all", locals: [] });
  for (const m of code.matchAll(EXPORT_FROM_RE)) {
    statements = statements.replace(m[0], " ");
    if (m[1]) continue; // export type … from
    const clause = m[2].trim();
    const spec = m[3];
    if (clause.startsWith("*")) {
      const nsName = /\*\s*as\s+([\w$]+)/.exec(clause)?.[1];
      reexports.push({ spec, star: !nsName, map: new Map(), nsName });
    } else {
      const map = new Map(bindings(clause.slice(1, -1)).map((b) => [b.local, b.imported]));
      if (map.size) reexports.push({ spec, star: false, map });
    }
  }
  for (const m of code.matchAll(DYNAMIC_RE)) {
    let spec = m[2];
    if (m[1] === "`" || spec.includes("?")) spec = spec.split("?")[0];
    if (/\.(?:m?js|ts|json)$/.test(spec)) imports.push({ spec, names: "all", locals: [] });
  }
  for (const m of code.matchAll(EXPORT_DECL_RE)) {
    if (m[1] === "type" || m[1] === "interface") typeNames.add(m[2]);
    else declared.add(m[2]);
  }
  if (/\bexport\s+default\b/.test(code)) declared.add("default");
  for (const m of code.matchAll(EXPORT_LIST_RE)) {
    statements = statements.replace(m[0], " ");
    if (m[1]) continue;
    for (const b of bindings(m[2])) listed.push({ local: b.imported, exported: b.local });
  }
  for (const { exported } of listed) declared.add(exported);

  // A namespace import's use, read from the rest of the module.
  for (const entry of imports) {
    if (!entry.nsLocal) continue;
    const use = namespaceUse(statements, entry.nsLocal);
    if (use === "all" || entry.names === "all") entry.names = "all";
    else for (const name of use) entry.names.add(name);
  }
  // Namespaces this module hands on: `import * as repo from …; export { repo }`.
  const nsExports = new Map();
  for (const { local, exported } of listed) {
    const from = imports.find((entry) => entry.nsLocal === local);
    if (from) nsExports.set(exported, from.spec);
  }
  const barrel =
    reexports.length > 0 &&
    imports.length === 0 &&
    declared.size === 0 &&
    statements
      .replace(/\bexport\s*\{\s*\}\s*;?/g, "")
      .trim()
      .replace(/;/g, "")
      .trim() === "";
  return {
    file,
    imports,
    reexports,
    declared,
    typeNames,
    nsExports,
    barrel,
    body: statements,
    // From the code minus its static import/export statements: an import specifier is an
    // edge with its own names, never a path reference that would load the whole module.
    refs: file.startsWith("src/") ? new Set() : fileRefs(statements),
  };
}

// String literals (and path.join/resolve literal runs) that may name a repo path.
// A ref built by a path.join/resolve run carries this prefix, so a single segment from one
// (`path.join(root, "src")`) can name a directory while a bare word cannot.
const JOINED = "\0join:";
function fileRefs(source) {
  const refs = new Set();
  for (const m of source.matchAll(LITERAL_RE)) {
    const value = m[2];
    if (/^[\w@.$/-][\w@.$/ -]*$/.test(value) && value.length > 2) refs.add(value);
  }
  for (const m of source.matchAll(JOIN_RE)) {
    const parts = [...m[1].matchAll(/["'`]([^"'`$]+)["'`]/g)].map((p) => p[1]);
    if (parts.length) refs.add(`${JOINED}${parts.join("/").replace(/\/+/g, "/")}`);
  }
  return refs;
}

// ---------------------------------------------------------------------------- the graph

function walk(dir, out, filter) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, filter);
    else if (filter(full)) out.push(full);
  }
  return out;
}

// scripts/build-client.mjs: which src/client sources each public/js output (or bundle) holds.
function clientOutputs(root) {
  const map = new Map(); // "public/js/x.js" → Set<"src/client/…ts">
  let source = "";
  try {
    source = readFileSync(path.join(root, "scripts", "build-client.mjs"), "utf8");
  } catch {
    return map;
  }
  for (const m of source.matchAll(/source:\s*"([^"]+)",\s*output:\s*"([^"]+)"/g)) {
    if (!map.has(m[2])) map.set(m[2], new Set());
    map.get(m[2]).add(m[1]);
  }
  const bundles = source.slice(Math.max(0, source.indexOf("export const BUNDLES")));
  for (const m of bundles.matchAll(/output:\s*"([^"]+)",[\s\S]*?inputs:\s*\[([\s\S]*?)\]/g)) {
    const sources = new Set();
    for (const input of m[2].matchAll(/"([^"]+)"/g)) for (const s of map.get(input[1]) ?? []) sources.add(s);
    map.set(m[1], sources);
  }
  return map;
}

export function buildGraph(root) {
  const started = performance.now();
  const rel = (abs) => toPosix(path.relative(root, abs));
  const srcFiles = walk(path.join(root, "src"), [], (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  if (!srcFiles.length) throw new Error("src/ has no TypeScript sources");
  const testDir = path.join(root, "test");
  const testSide = walk(testDir, [], (f) => /\.(?:m?js)$/.test(f));
  const scriptFiles = walk(path.join(root, "scripts"), [], (f) => /\.m?js$/.test(f));
  const modules = new Map();
  for (const abs of [...srcFiles, ...testSide, ...scriptFiles]) {
    let source = "";
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    modules.set(rel(abs), parseModule(rel(abs), source));
  }
  // Every repo path a reference may resolve to, files and directories alike.
  const known = new Set(modules.keys());
  const dirs = new Set();
  for (const name of known) for (let d = path.posix.dirname(name); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
  for (const top of ["public", "docs", "deploy", "media", "seed-art"]) {
    for (const abs of walk(path.join(root, top), [], () => true)) {
      const name = rel(abs);
      known.add(name);
      for (let d = path.posix.dirname(name); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
    }
  }
  // Root files, dotfiles included (.gitignore, .dockerignore, .env.example: tests read them),
  // and the dot-directories a test may read (.github/workflows). Names only — never contents.
  const PRIVATE = new Set(["node_modules", ".git", ".tsbuildcache", ".claude", ".local", ".cursor"]);
  for (const name of readdirSync(root)) {
    if (PRIVATE.has(name)) continue;
    try {
      const stat = statSync(path.join(root, name));
      if (stat.isFile()) known.add(name);
      else if (stat.isDirectory() && name.startsWith(".")) {
        dirs.add(name);
        for (const abs of walk(path.join(root, name), [], () => true)) {
          const file = rel(abs);
          known.add(file);
          for (let d = path.posix.dirname(file); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
        }
      }
    } catch {}
  }
  for (const top of ["src", "test", "scripts", "public", "dist", "docs", "deploy"]) dirs.add(top);

  // A specifier or path as the repo-relative source it stands for (dist → src, .js → .ts).
  const toSource = (name) => {
    let n = name.replace(/^\.\//, "");
    if (n === "dist" || n.startsWith("dist/")) n = `src${n.slice(4)}`;
    if (n.startsWith("src/") && n.endsWith(".js")) {
      const ts = `${n.slice(0, -3)}.ts`;
      if (modules.has(ts) || !known.has(n)) n = ts;
    }
    return n;
  };
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith(".")) return null;
    return toSource(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)));
  };
  const client = clientOutputs(root);
  const graph = { root, modules, known, dirs, toSource, resolveSpec, client };

  // Resolve every module's edges once: imports (with the names they use), the namespace a
  // target hands on (test/_seed.js's `repo`, followed by its use here), and — for a module
  // that is not a barrel — its own re-exports. A barrel keeps its re-exports for name
  // resolution. Then the reverse index: target → who reaches it, with which names.
  const importers = new Map(); // target → [{ from, names }]
  const reexporters = new Map(); // target → [barrel]
  const addEdge = (from, target, names) => {
    if (!target) return;
    if (!importers.has(target)) importers.set(target, []);
    importers.get(target).push({ from, names });
  };
  for (const mod of modules.values()) {
    const name = mod.file;
    if (mod.barrel) {
      for (const re of mod.reexports) {
        re.target = resolveSpec(name, re.spec);
        if (!re.target) continue;
        if (!reexporters.has(re.target)) reexporters.set(re.target, []);
        reexporters.get(re.target).push(name);
      }
    } else {
      for (const re of mod.reexports) {
        addEdge(name, resolveSpec(name, re.spec), re.star || re.nsName ? "all" : new Set(re.map.values()));
      }
    }
    for (const entry of mod.imports) {
      const target = resolveSpec(name, entry.spec);
      if (!target) continue;
      addEdge(name, target, entry.names);
      const targetMod = modules.get(target);
      if (!targetMod?.nsExports.size) continue;
      for (const { imported, local } of entry.locals) {
        const nsSpec = targetMod.nsExports.get(imported);
        if (nsSpec) addEdge(name, resolveSpec(target, nsSpec), namespaceUse(mod.body, local));
      }
    }
    resolveRefs(graph, mod);
    // A path this module runs (a child process importing dist/x.js, a script it spawns) is
    // an import in all but syntax: the walk continues through it.
    for (const target of mod.refExec) addEdge(name, target, "all");
  }
  graph.importers = importers;
  graph.reexporters = reexporters;
  graph.buildMs = performance.now() - started;
  return graph;
}

// A module's string references, as repo files and directory prefixes. A test or script
// naming a path reads it (a directory: everything under it). A src module's literals are
// mostly runtime paths into data/ or public/, so only an exact module counts there.
function resolveRefs(graph, mod) {
  const { modules, known, dirs, toSource, client } = graph;
  const files = new Set();
  const prefixes = new Set();
  const exec = new Set();
  const fromSrc = mod.file.startsWith("src/");
  for (const raw of mod.refs) {
    const joined = raw.startsWith(JOINED);
    const ref = joined ? raw.slice(JOINED.length) : raw;
    const candidates = [ref];
    if (ref.startsWith(".")) candidates.push(path.posix.normalize(path.posix.join(path.posix.dirname(mod.file), ref)));
    for (let c of candidates) {
      c = c.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!c || c === mod.file) continue;
      const source = toSource(c);
      if (modules.has(source)) {
        // Executable — built output (dist/…, mapped to its source) or a script/test module
        // by its .js/.mjs path — continues the walk; a source file read as text
        // (`src/x.ts`) is a leaf.
        const plain = c.replace(/^\.\//, "");
        const executable = plain.startsWith("dist/") || /\.m?js$/.test(plain);
        if (executable && !fromSrc) exec.add(source);
        else files.add(source);
      }
      if (fromSrc) continue;
      if (known.has(c)) files.add(c);
      // A directory counts when named as a path (`"src/repo"`) or by a join/resolve run;
      // a bare word that happens to match one (`"test"`, `"docs"`) is not a path.
      if (dirs.has(c) && (joined || c.includes("/"))) prefixes.add(toSource(c));
      for (const out of [c, `public/js/${path.posix.basename(c)}`]) {
        if (!client.has(out)) continue;
        files.add(out);
        for (const s of client.get(out)) files.add(s);
      }
      if (c === "public/styles.css" || c === "public/css" || c.startsWith("public/css/")) prefixes.add("src/styles");
      if (c === "public/js" || c === "public") prefixes.add("src/client");
    }
  }
  mod.refFiles = files;
  mod.refPrefixes = [...prefixes];
  mod.refExec = exec;
}

// Every name `name` exports at runtime (its own declarations and its re-exports).
function exportNames(graph, name, memo = new Map(), stack = new Set()) {
  if (memo.has(name)) return memo.get(name);
  const out = new Set();
  const mod = graph.modules.get(name);
  if (!mod || stack.has(name)) return out;
  stack.add(name);
  for (const n of mod.declared) out.add(n);
  for (const re of mod.reexports) {
    if (re.nsName) out.add(re.nsName);
    for (const n of re.map.keys()) out.add(n);
    if (re.star) for (const n of exportNames(graph, graph.resolveSpec(name, re.spec), memo, stack)) out.add(n);
  }
  stack.delete(name);
  memo.set(name, out);
  return out;
}

function typeOnly(graph, name, wanted, seen = new Set()) {
  if (!name || seen.has(name)) return false;
  seen.add(name);
  const mod = graph.modules.get(name);
  if (!mod) return false;
  if (mod.typeNames.has(wanted)) return true;
  return mod.reexports.some((re) => re.star && typeOnly(graph, graph.resolveSpec(name, re.spec), wanted, seen));
}

// Does an import of `barrel` with `names` load something behind `leading` (the barrel's
// names that lead to the change)? A name the barrel provides through no re-export and
// that is not a type is one this parser missed: count it as the whole barrel.
function edgeHits(graph, barrel, names, leading) {
  if (names === "all" || leading === "all") return true;
  for (const n of names) if (leading.has(n)) return true;
  graph.exportMemo ??= new Map();
  const provided = exportNames(graph, barrel, graph.exportMemo);
  for (const n of names) if (!provided.has(n) && !typeOnly(graph, barrel, n)) return true;
  return false;
}

/**
 * Every module that can load or read `changed` (a repo-relative path), walking the
 * reverse graph. A barrel is passed only by the names of it that lead to the change.
 */
export function reachers(graph, changed, trace = null) {
  const { modules, importers, reexporters } = graph;
  const concrete = new Set(); // modules that load the change outright
  const barrelNames = new Map(); // barrel → its names that lead to the change ("all" or Set)
  const queue = [];
  const reachConcrete = (name, via) => {
    if (concrete.has(name)) return;
    concrete.add(name);
    trace?.set(name, via);
    queue.push({ name, names: "all" });
  };
  const reachBarrel = (barrel, names, via) => {
    const had = barrelNames.get(barrel);
    if (had === "all") return;
    let grown = names;
    if (had && names !== "all") {
      grown = new Set([...had, ...names]);
      if (grown.size === had.size) return;
    }
    if (names !== "all" && !names.size) return;
    barrelNames.set(barrel, grown);
    trace?.set(barrel, `${via} [${grown === "all" ? "all" : [...grown].slice(0, 4).join(",")}]`);
    queue.push({ name: barrel, names: grown });
  };
  // Who names the changed path directly (a reference, or a directory above it).
  for (const mod of modules.values()) {
    if (mod.refFiles.has(changed) || mod.refPrefixes.some((p) => changed === p || changed.startsWith(`${p}/`))) {
      reachConcrete(mod.file, `names ${changed}`);
    }
  }
  const start = modules.get(changed);
  if (start?.barrel) reachBarrel(changed, "all");
  else reachConcrete(changed);

  while (queue.length) {
    const { name, names } = queue.pop();
    // Importers: a concrete target loads on any import; a barrel only by its leading names.
    for (const { from, names: used } of importers.get(name) ?? []) {
      const fromMod = modules.get(from);
      const hit = modules.get(name)?.barrel ? edgeHits(graph, name, used, names) : true;
      if (!hit) continue;
      if (fromMod?.barrel) continue; // barrels reach through reexporters below
      reachConcrete(from, name);
    }
    // Barrels that re-export this module: which of their names lead here.
    for (const barrel of reexporters.get(name) ?? []) {
      const bmod = modules.get(barrel);
      const leading = new Set();
      let all = false;
      for (const re of bmod.reexports) {
        if (re.target !== name) continue;
        if (re.nsName) leading.add(re.nsName);
        for (const [exported, imported] of re.map) if (names === "all" || names.has(imported)) leading.add(exported);
        if (re.star) {
          if (names === "all") {
            graph.exportMemo ??= new Map();
            for (const n of exportNames(graph, name, graph.exportMemo)) leading.add(n);
            if (!modules.has(name)) all = true;
          } else for (const n of names) leading.add(n);
        }
      }
      reachBarrel(barrel, all ? "all" : leading, name);
    }
  }
  return concrete;
}

// ---------------------------------------------------------------------------- selection

// Loaded by every test process (test/_isolate.mjs imports dist/db.js): the schema and its
// migrations. Their imports into the repo are NOT treated as every test's: a repair
// migration that calls a repo function runs on an empty test DB, and the tests that
// exercise that function reach it through their own imports.
const EVERY_TEST = [/^src\/db\.ts$/, /^src\/migrate\.ts$/, /^src\/migrations\//, /^src\/dataDir\.ts$/];

/**
 * Pick the test files a change can affect.
 * @returns {{ selected: string[], full: boolean, reason: string, graphMs: number }}
 */
export function selectTests({ root, changed, testFiles, graph: prebuilt = null }) {
  const started = performance.now();
  const rel = (abs) => toPosix(path.relative(root, abs));
  const relevant = changed.filter((f) => !IGNORED.some((re) => re.test(f)));
  const full = (reason) => ({ selected: testFiles, full: true, reason, graphMs: performance.now() - started });
  if (!relevant.length) return { selected: [], full: false, reason: "nothing changed", graphMs: 0 };
  const infra = relevant.filter((f) => INFRA.some((re) => re.test(f)));
  const list = (files) => `${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`;
  if (infra.length) return full(`full suite: test infrastructure changed (${list(infra)})`);
  const everyTest = relevant.filter((f) => EVERY_TEST.some((re) => re.test(f)));
  if (everyTest.length) return full(`full suite: every test process loads ${list(everyTest)}`);
  if (!existsSync(path.join(root, "src"))) return full("full suite: no src/ to build an import graph from");

  let graph;
  try {
    graph = prebuilt ?? buildGraph(root);
  } catch (error) {
    return full(`full suite: the import graph could not be built (${error.message})`);
  }
  // A changed file the graph knows nothing about — not a module, named by no test or
  // script, under no directory one reads — is a file whose readers the walk cannot see
  // (a workflow, an ignore file read through a variable): run everything and say which.
  // Docs are the exception: a doc no test names is one nothing reads.
  const refFiles = new Set();
  const refPrefixes = new Set();
  for (const mod of graph.modules.values()) {
    for (const f of mod.refFiles) refFiles.add(f);
    for (const p of mod.refPrefixes) refPrefixes.add(p);
  }
  const seen = (f) =>
    graph.modules.has(f) ||
    graph.importers.has(f) ||
    graph.reexporters.has(f) ||
    refFiles.has(f) ||
    [...refPrefixes].some((p) => f === p || f.startsWith(`${p}/`));
  const deletedTest = (f) => /^test\/[^/]+\.test\.js$/.test(f) && !existsSync(path.join(root, f));
  const unseen = relevant.filter((f) => !seen(f) && !deletedTest(f) && !(f.startsWith("docs/") || f.endsWith(".md")));
  if (unseen.length) return full(`full suite: no test's import graph or path references reach ${list(unseen)}`);

  const reached = new Set();
  for (const file of relevant) for (const name of reachers(graph, file)) reached.add(name);
  const selected = testFiles.filter((abs) => reached.has(rel(abs)));
  const kinds = new Map();
  for (const f of relevant) {
    const kind = f.startsWith("src/client/") ? "client" : f.startsWith("src/styles/") ? "styles" : f.split("/")[0];
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return {
    selected,
    full: false,
    reason: `${relevant.length} changed file(s): ${[...kinds].map(([k, n]) => `${n} ${k}`).join(", ")}`,
    graphMs: performance.now() - started,
  };
}
