// THE LAZY-BUNDLE LAW, checked statically over the built client.
//
// index.html loads only the eager bundles; Train, Horizon, Ask, Settings and
// Me/Health are injected later by ensureBundle (src/client/app/lazy-bundles.ts).
// Every client module shares ONE global scope, so a reference from an eager
// module to a global a lazy bundle defines is a ReferenceError waiting for the
// first cold tap. This test resolves every cross-module global reference in the
// built public/js modules and holds each one to the law:
//
//   1. nothing references a lazy global while a script is loading (top level);
//   2. an eager reference runs inside withBundle(<its bundle>, ...) / the
//      dispatcher's lazy(<its bundle>, ...), behind a `typeof`/optional-chain
//      guard, or is one of the few reviewed call sites below;
//   3. a lazy bundle reaches another lazy bundle's globals only when it DEPENDS
//      on it (LAZY_BUNDLE_DEPS), behind a guard, or inside withBundle(<that bundle>, ...)
//      (a tap that opens a heavier surface: Today's strip peeks a day through "calendar").
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { BUNDLES } from "../scripts/build-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GLOBAL_ROOT = /^(globalThis|window|self)$/;

// Eager call sites that reach a lazy global outside withBundle, each reviewed:
// the surrounding code only runs once that bundle's own surface is on screen.
const REVIEWED = {
  // reconnectProposal reaches these only while horizon's #endDraftStatus is in #view.
  "coach-proposal-controller.js": ["enduranceComposerLock", "enduranceProposalOpOpts"],
  // compressImage awaits ensureBundle("ask") first when CairnChatClient is absent (it rides
  // the lazy fuel bundle, which Ask depends on, so this is the one reach the other way).
  "chat-attachment-client.js": ["CairnChatClient"],
  // The Fuel surface's mounts: mountFuelSurface / paintFoodJournal / loadFood… run only
  // under renderFoodJournal, which the dispatcher and the segment deps reach through
  // lazy("fuel") / withLatestRender("fuel"); nothing else calls them.
  "06-coach-meals.js": ["CairnFuelDeps", "CairnFuelTodayController", "CairnFuelMealsController", "CairnFuelLogController", "CairnIdeaCardController", "CairnFuelToday"],
  // Read through Array.isArray((globalThis).ME_SEG) — absent reads as "no bar yet".
  "app-tabs.js": ["ME_SEG"],
};

function loadModules() {
  const inputs = BUNDLES.flatMap((b) => b.inputs.map((input) => ({ input, lazy: b.lazy || null })));
  const lazyOf = new Map(inputs.map((x) => [x.input, x.lazy]));
  const files = inputs.map((x) => path.join(root, x.input));
  for (const f of files) assert.ok(existsSync(f), `${f} is built (run npm run build)`);
  const program = ts.createProgram(files, { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022 });
  return { inputs, lazyOf, program, checker: program.getTypeChecker() };
}

function lazyLoaderTables() {
  const source = readFileSync(path.join(root, "public/js/app-lazy-bundles.js"), "utf8");
  const context = { window: {}, globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { deps: context.LAZY_BUNDLE_DEPS, src: context.LAZY_BUNDLE_SRC };
}

function exportsByModule(program, inputs) {
  const exportsOf = new Map();
  for (const { input } of inputs) {
    const sf = program.getSourceFile(path.join(root, input));
    const add = (name) => {
      if (!exportsOf.has(name)) exportsOf.set(name, new Set());
      exportsOf.get(name).add(input);
    };
    const objectFor = (node) => {
      if (node && ts.isIdentifier(node)) {
        let found = null;
        const find = (n) => {
          if (!found && ts.isVariableDeclaration(n) && n.name.getText() === node.text && n.initializer) found = n.initializer;
          ts.forEachChild(n, find);
        };
        find(sf);
        return found;
      }
      return node;
    };
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        n.expression.getText() === "Object.assign" &&
        n.arguments[0] &&
        GLOBAL_ROOT.test(n.arguments[0].getText())
      ) {
        const obj = objectFor(n.arguments[1]);
        if (obj && ts.isObjectLiteralExpression(obj)) for (const p of obj.properties) if (p.name) add(p.name.getText());
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        GLOBAL_ROOT.test(n.left.expression.getText())
      ) {
        add(n.left.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return exportsOf;
}

const isFnLike = (n) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
  ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);

function immediatelyInvoked(fn) {
  let p = fn.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  return !!p && ts.isCallExpression(p);
}

function runsAtLoad(node) {
  for (let p = node.parent; p; p = p.parent) if (isFnLike(p) && !immediatelyInvoked(p)) return false;
  return true;
}

/** The bundle a withBundle(...)/withLatestRender(...)/lazy(...)/ensureBundle(...).then(...) around `node` waits for, if any. */
function routedBundle(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (!ts.isCallExpression(p)) continue;
    const callee = p.expression.getText();
    const arg = p.arguments[0];
    if ((callee === "withBundle" || callee === "withLatestRender" || callee === "lazy") && arg && ts.isStringLiteral(arg) && p.arguments[1] && node.pos >= p.arguments[1].pos) {
      return arg.text;
    }
  }
  return null;
}

function guarded(node, name) {
  // typeof X / X?.y / (globalThis).X?.y
  const parent = node.parent;
  if (parent && ts.isTypeOfExpression(parent)) return true;
  const access = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : null;
  if (access?.questionDotToken) return true;
  if (ts.isPropertyAccessExpression(node) && node.questionDotToken) return true;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.parent && ts.isCallExpression(parent.parent) && parent.parent.questionDotToken) return true;
  for (let p = node.parent; p && !isFnLike(p); p = p.parent) {
    const cond = ts.isIfStatement(p) || ts.isConditionalExpression(p) ? p.expression ?? p.condition : ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? p.left : null;
    if (cond && new RegExp(`typeof\\s+${name}\\b|\\b${name}\\?\\.`).test(cond.getText())) return true;
  }
  return false;
}

function crossRefs() {
  const { inputs, lazyOf, program, checker } = loadModules();
  const exportsOf = exportsByModule(program, inputs);
  const aliasOfGlobal = (e) => {
    if (!ts.isIdentifier(e)) return false;
    const d = checker.getSymbolAtLocation(e)?.declarations?.[0];
    return !!d && ts.isVariableDeclaration(d) && !!d.initializer && /\b(globalThis|window|self)\b/.test(d.initializer.getText()) && d.initializer.getText().length < 200;
  };
  const refs = [];
  for (const { input } of inputs) {
    const sf = program.getSourceFile(path.join(root, input));
    const visit = (n) => {
      let name = null;
      if (ts.isIdentifier(n) && exportsOf.has(n.text)) {
        const p = n.parent;
        const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n);
        const decl = checker.getSymbolAtLocation(n)?.declarations?.[0];
        if (!isName && !(decl && decl.getSourceFile() === sf)) name = n.text;
      } else if (ts.isPropertyAccessExpression(n) && exportsOf.has(n.name.text) && (GLOBAL_ROOT.test(n.expression.getText()) || aliasOfGlobal(n.expression))) {
        const p = n.parent;
        if (!(ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken)) name = n.name.text;
      }
      if (name) {
        for (const def of exportsOf.get(name)) {
          if (def === input) continue;
          refs.push({
            from: input,
            fromLazy: lazyOf.get(input),
            def,
            defLazy: lazyOf.get(def),
            name,
            atLoad: runsAtLoad(n),
            routed: routedBundle(n),
            guarded: guarded(n, name),
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return refs.filter((r) => r.defLazy && r.defLazy !== r.fromLazy);
}

const refs = crossRefs();
const { deps } = lazyLoaderTables();
const closure = (name, seen = new Set()) => {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const d of deps[name] || []) closure(d, seen);
  return seen;
};
const where = (r) => `${path.basename(r.from)}:${r.line} → ${r.name} (${r.defLazy})`;

test("the loader's tables name every lazy bundle in the manifest", () => {
  const { src } = lazyLoaderTables();
  const lazy = BUNDLES.filter((b) => b.lazy);
  assert.deepEqual(Object.keys(src).sort(), lazy.map((b) => b.lazy).sort());
  for (const b of lazy) assert.equal(src[b.lazy], `/${b.output.replace(/^public\//, "")}`);
  for (const [name, list] of Object.entries(deps)) for (const d of list) assert.ok(src[d], `${name} depends on a known bundle (${d})`);
});

test("no module touches another bundle's lazy global while it is loading", () => {
  const offenders = refs.filter((r) => r.atLoad && !r.guarded).map(where);
  assert.deepEqual(offenders, []);
});

test("every eager reach into a lazy bundle waits for that bundle", () => {
  const offenders = refs
    .filter((r) => !r.fromLazy)
    .filter((r) => {
      if (r.guarded) return false;
      if (r.routed) return !closure(r.routed).has(r.defLazy);
      return !(REVIEWED[path.basename(r.from)] || []).includes(r.name);
    })
    .map((r) => (r.routed ? `${where(r)} is routed through "${r.routed}", which does not load ${r.defLazy}` : where(r)));
  assert.deepEqual(offenders, [], "route the call through withBundle(<bundle>, ...) — or guard it and add it to REVIEWED with the reason");
});

test("a lazy bundle reaches another lazy bundle only through a declared dependency", () => {
  const offenders = refs
    .filter((r) => r.fromLazy && !r.guarded && !closure(r.fromLazy).has(r.defLazy))
    .filter((r) => !(r.routed && closure(r.routed).has(r.defLazy)))
    .filter((r) => !(REVIEWED[path.basename(r.from)] || []).includes(r.name))
    .map(where);
  assert.deepEqual(offenders, [], "add the dependency to LAZY_BUNDLE_DEPS in src/client/app/lazy-bundles.ts");
});

test("the dispatcher and the segment deps route every lazy destination", () => {
  const routedNames = new Set(refs.filter((r) => r.routed).map((r) => r.name));
  for (const name of ["renderTrainOverview", "renderProgress", "renderPlanEditor", "renderPlanEndurance", "renderHorizon", "renderChat", "renderSettings", "renderMe"]) {
    assert.ok(routedNames.has(name), `${name} is reached through withBundle`);
  }
});
