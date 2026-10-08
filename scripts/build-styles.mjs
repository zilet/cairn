#!/usr/bin/env node
// Concatenate the stylesheet partials under src/styles/ into public/styles.css.
//
// The app ships ONE stylesheet (index.html links it, the service worker precaches
// it, the build precompresses it), but it is authored as per-surface partials so a
// screen stream edits only the files it owns (docs/DESIGN.md "Stylesheet ownership").
// The ORDER below is the cascade: a later partial wins a same-specificity tie, so a
// partial never moves without reading what it would now override. Every .css file
// under src/styles/ must appear here exactly once; an unlisted or missing partial
// fails the build rather than silently dropping rules.
//
// public/styles.css stays committed (the Docker runtime stage and the test suite
// read it straight from the checkout), so `--check` (run by `npm run verify`) fails
// when the committed file drifts from its partials.
//
// Usage: node scripts/build-styles.mjs [--check | --watch]
//   --watch rebuilds on every partial save (`npm run styles:watch`, next to `npm run dev`).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFile), "..");

export const STYLES_DIR = "src/styles";
export const STYLES_OUTPUT = "public/styles.css";
export const LAZY_STYLES_DIR = "public/css";

/** The cascade order. Foundation first, then the surfaces in their historical order. */
export const STYLE_PARTIALS = [
  "foundation/tokens",
  "foundation/fonts",
  "foundation/base",
  "foundation/motion",
  "foundation/primitives",
  "foundation/stones",
  "foundation/cards",
  "foundation/components",
  "today/header",
  "session/exercise",
  "foundation/segments",
  "train/plan-editor",
  "train/progress",
  "fuel/meal-plans",
  "ask/chat",
  "you/records",
  "shell/overlays",
  "shell/tabbar",
  "shell/responsive-nav",
  "shell/detail",
  "fuel/planner",
  "today/date",
  "fuel/meal-sheet",
  "train/progress-editorial",
  "today/garmin",
  "today/brief",
  "foundation/loading",
  "ask/capture",
  "session/head",
  "foundation/reduced-motion",
  "health/health",
  "health/stand",
  "you/profile",
  "shell/responsive",
  "train/endurance",
  "foundation/a11y",
  "train/program",
  "train/strength",
  "session/destination",
  "train/overview",
  "ask/changes",
  "fuel/meal-card",
  "fuel/today",
  "health/records",
  "health/packet",
  "horizon/race",
  "today/pebbles",
  "today/path",
  "today/ahead",
  "today/day",
  "today/strip",
  "you/cairn",
  "shell/identity",
  "shell/nav",
  // The coach link's quiet cards on Today and Ask (eager: Today paints one), and the AI
  // sign-in panel's rules (Settings → Agents and the welcome's Connect step share them;
  // ~0.5 KB, which a sheet of its own would only cost a request to avoid).
  "welcome/coach-link",
  "welcome/connect",
];

/**
 * LAZY SHEETS: the last partials of the cascade, each owned by ONE lazy bundle, shipped
 * as their own file (public/css/<name>.css) instead of inside styles.css. The lazy
 * loader (src/client/app/lazy-bundles.ts, LAZY_BUNDLE_CSS) adds the <link> next to the
 * bundle's <script> and resolves only once both landed, so a surface never paints
 * unstyled. A sheet loads AFTER styles.css, which is exactly where its partials already
 * sat (last), so the cascade is unchanged; only a partial that no eager partial follows
 * may move here (the overlap check in test/lazyStyleSheets.test.js holds that).
 * `bundle` is the lazy bundle name (scripts/build-client.mjs BUNDLES); list order here is
 * the order inside the sheet and must keep the partials' relative cascade order.
 */
export const LAZY_STYLE_SHEETS = {
  // Settings (every section): the agents, devices, data and system cards. Nothing outside
  // the Settings bundle names these classes (the shared hit-area / dot rings in
  // foundation/a11y only add position and box-shadow, which Settings never sets).
  settings: { partials: ["settings/settings", "settings/groups"] },
  // The day view (a day's body, its movement rows and run structure, a peek's foot):
  // Train's Program rows and the day's page and peek. Today's strip chips are eager
  // (today/strip) and Horizon draws only the glance, so neither pays for this.
  "day-view": { partials: ["today/day-detail"] },
  // Ask's quiet ripple / pill cards.
  ask: { partials: ["ask/ask"] },
  // Horizon (Week, Season, To the race): only its bundle renders these classes.
  horizon: { partials: ["horizon/horizon", "horizon/week", "horizon/journey"] },
  // The first-run welcome stage.
  welcome: { partials: ["welcome/welcome"] },
};

/** Every partial, eager and lazy, in cascade order. */
export const ALL_PARTIALS = [...STYLE_PARTIALS, ...Object.values(LAZY_STYLE_SHEETS).flatMap((sheet) => sheet.partials)];

export const lazySheetPath = (name) => `${LAZY_STYLES_DIR}/${name}.css`;

const BANNER =
  "/* GENERATED by scripts/build-styles.mjs from src/styles/** (minified). Edit the partials, never this file.\n" +
  "   Cascade order and ownership: docs/DESIGN.md \"Stylesheet ownership\". */\n";
const LAZY_BANNER = (name) =>
  `/* GENERATED by scripts/build-styles.mjs from src/styles/** (minified). LAZY sheet "${name}": loaded with its bundle, after styles.css. */\n`;

function listPartials(dir = STYLES_DIR) {
  const out = [];
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listPartials(rel));
    else if (entry.name.endsWith(".css")) out.push(rel.slice(STYLES_DIR.length + 1, -".css".length));
  }
  return out;
}

/**
 * Conservative CSS minification: comments dropped (an empty one kept where it glues
 * two tokens), whitespace runs collapsed to one
 * space, and the space next to `{`, `}`, `;` and `,` (where CSS never needs it)
 * removed, plus the redundant `;` before a `}`. Strings and unquoted url(...)
 * bodies are copied verbatim, and a custom property's value keeps its spacing
 * (it is a raw token stream that script may read back with getPropertyValue). Nothing is reordered, merged or rewritten, and the
 * space that CAN matter (descendant combinators, `calc(a + b)`, `and (`, a colon
 * in a selector) is kept as one space. One rule per line keeps the committed file
 * reviewable and merge-friendly; the partials under src/styles/ keep every comment.
 */
export function minifyCss(css) {
  let out = "";
  let pendingSpace = false;
  // Custom-property state: where the current declaration started in `out`, the
  // paren depth, and whether we are inside a `--name:` value.
  let declStart = 0;
  let depth = 0;
  let inCustom = false;
  const n = css.length;
  const tight = (ch) => ch === "{" || ch === "}" || ch === ";" || (ch === "," && !inCustom) || ch === "\n";
  const emit = (text) => {
    if (pendingSpace && out.length && !tight(out[out.length - 1]) && !tight(text[0])) out += " ";
    pendingSpace = false;
    out += text;
  };
  let i = 0;
  while (i < n) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      // A comment is NOT whitespace: `.a/**/.b` is the compound `.a.b`, and
      // `1px/**/solid` is two tokens. Glued between two token characters it
      // stays as an empty `/**/`; next to whitespace or punctuation it just goes.
      const prev = pendingSpace ? " " : out[out.length - 1] || " ";
      const next = css[i] || " ";
      const glue = (c) => !/[\s{};,]/.test(c);
      if (glue(prev) && glue(next)) out += "/**/";
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && css[j] !== ch) j += css[j] === "\\" ? 2 : 1;
      emit(css.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if ((ch === "u" || ch === "U") && /^url\(\s*[^\s"')]/i.test(css.slice(i, i + 6)) && !/[\w-]/.test(css[i - 1] || "")) {
      const end = css.indexOf(")", i);
      emit(css.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      i += 1;
      continue;
    }
    if (ch === "," && inCustom) {
      emit(ch);
      i += 1;
      continue;
    }
    if (ch === "{" || ch === ";" || ch === ",") {
      pendingSpace = false;
      out += ch;
      i += 1;
      if (ch !== "," && depth === 0) {
        inCustom = false;
        declStart = out.length;
      }
      continue;
    }
    if (ch === "}") {
      pendingSpace = false;
      if (out.endsWith(";")) out = out.slice(0, -1);
      out += "}\n";
      i += 1;
      depth = 0;
      inCustom = false;
      declStart = out.length;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0 && !inCustom && out.slice(declStart).trimStart().startsWith("--")) inCustom = true;
    emit(ch);
    i += 1;
  }
  return out;
}

function concatPartials(names) {
  let css = "";
  for (const name of names) {
    const chunk = readFileSync(path.join(root, STYLES_DIR, `${name}.css`), "utf8");
    css += chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  }
  return minifyCss(css);
}

/** Throws naming the partials out of step (unlisted, missing, or listed twice). */
function assertPartialsInStep() {
  const onDisk = new Set(listPartials());
  const listed = new Set(ALL_PARTIALS);
  const problems = [];
  if (listed.size !== ALL_PARTIALS.length) problems.push("a partial is listed twice in STYLE_PARTIALS / LAZY_STYLE_SHEETS");
  for (const name of ALL_PARTIALS) if (!onDisk.has(name)) problems.push(`listed but missing: ${STYLES_DIR}/${name}.css`);
  for (const name of onDisk) if (!listed.has(name)) problems.push(`not in STYLE_PARTIALS or LAZY_STYLE_SHEETS: ${STYLES_DIR}/${name}.css`);
  if (problems.length) throw new Error(`stylesheet partials out of step:\n  ${problems.join("\n  ")}`);
}

/** The stylesheet the eager partials produce, or throws naming the partials out of step. */
export function renderStyles() {
  assertPartialsInStep();
  return BANNER + concatPartials(STYLE_PARTIALS);
}

/** Every lazy sheet: [{ name, output, css }]. */
export function renderLazySheets() {
  assertPartialsInStep();
  return Object.entries(LAZY_STYLE_SHEETS).map(([name, sheet]) => ({
    name,
    output: lazySheetPath(name),
    css: LAZY_BANNER(name) + concatPartials(sheet.partials),
  }));
}

export function buildStyles() {
  const css = renderStyles();
  const target = path.join(root, STYLES_OUTPUT);
  const before = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (before !== css) writeFileSync(target, css);
  const sheets = renderLazySheets();
  mkdirSync(path.join(root, LAZY_STYLES_DIR), { recursive: true });
  for (const sheet of sheets) {
    const file = path.join(root, sheet.output);
    if (!existsSync(file) || readFileSync(file, "utf8") !== sheet.css) writeFileSync(file, sheet.css);
  }
  // A sheet that left LAZY_STYLE_SHEETS leaves no orphan behind (the server would still serve it).
  const dir = path.join(root, LAZY_STYLES_DIR);
  const keep = new Set(sheets.map((sheet) => path.basename(sheet.output)));
  for (const entry of readdirSync(dir)) {
    const base = entry.replace(/\.(br|gz)$/, "");
    if (/\.css(\.(br|gz))?$/.test(entry) && !keep.has(base)) rmSync(path.join(dir, entry));
  }
  console.log(
    `✓ built ${STYLES_OUTPUT} from ${STYLE_PARTIALS.length} partials (${(css.length / 1024).toFixed(0)} KB)` +
      (sheets.length ? ` + ${sheets.length} lazy sheet${sheets.length === 1 ? "" : "s"} (${sheets.map((sheet) => `${sheet.name} ${(sheet.css.length / 1024).toFixed(1)} KB`).join(", ")})` : "")
  );
}

export function checkStyles() {
  const css = renderStyles();
  const target = path.join(root, STYLES_OUTPUT);
  const committed = existsSync(target) ? readFileSync(target, "utf8") : "";
  let stale = committed !== css ? [STYLES_OUTPUT] : [];
  for (const sheet of renderLazySheets()) {
    const file = path.join(root, sheet.output);
    if (!existsSync(file) || readFileSync(file, "utf8") !== sheet.css) stale.push(sheet.output);
  }
  if (stale.length) {
    console.error(`✗ ${stale.join(", ")} out of date with ${STYLES_DIR}/. Run: node scripts/build-styles.mjs`);
    process.exit(1);
  }
  console.log(`✓ ${STYLES_OUTPUT} matches its ${STYLE_PARTIALS.length} partials, and ${Object.keys(LAZY_STYLE_SHEETS).length} lazy sheets match theirs`);
}

/** Rebuild on every partial save; a bad state is reported and waited out, never fatal. */
export function watchStyles() {
  const rebuild = () => {
    try {
      buildStyles();
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  rebuild();
  let timer = null;
  watch(path.join(root, STYLES_DIR), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 60);
  });
  console.log(`… watching ${STYLES_DIR}/ for changes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    if (process.argv.includes("--check")) checkStyles();
    else if (process.argv.includes("--watch")) watchStyles();
    else buildStyles();
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
