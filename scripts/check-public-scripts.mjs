#!/usr/bin/env node
// Guard the classic browser app-shell graph from global-scope script hazards.
// Cairn intentionally ships a dependency-free vanilla PWA: each <script> tag in
// public/index.html is a classic script, so top-level let/const/class bindings
// share one global lexical scope across files. A duplicate can parse-fail the
// whole feature file in production even when TypeScript checkJs passes.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { BUNDLES } from "./build-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepo(file) {
  return readFileSync(path.join(root, file), "utf8");
}

// index.html's own <script src> list, PLUS every bundle it does not load
// eagerly. A `lazy` bundle is injected at navigation time into the SAME global
// scope as the rest of the shell, so it is exactly as exposed to a duplicate
// top-level binding as an eager one — checking only index.html would leave the
// biggest bundle unguarded. Lazy bundles go last, matching their real execution
// order (nothing runs them before boot has finished).
function scriptSources() {
  const index = readRepo("public/index.html");
  const eager = [...index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const lazy = BUNDLES.filter((bundle) => bundle.lazy)
    .map((bundle) => bundle.output.replace(/^public/, ""))
    .filter((src) => !eager.includes(src));
  return [...eager, ...lazy];
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => {
      if (ts.isOmittedExpression(element)) return [];
      const child = ts.isBindingElement(element) ? element.name : element;
      return bindingNames(child);
    });
  }
  return [];
}

function lineCol(sourceFile, node) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${pos.line + 1}:${pos.character + 1}`;
}

function topLevelBindings(sourceFile, src) {
  const bindings = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      bindings.push({ name: "import/export", kind: "module syntax", lexical: true, src, at: lineCol(sourceFile, statement) });
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      const kind = (flags & ts.NodeFlags.Const) ? "const" : (flags & ts.NodeFlags.Let) ? "let" : "var";
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          bindings.push({ name, kind, lexical: kind !== "var", src, at: lineCol(sourceFile, declaration.name) });
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.push({ name: statement.name.text, kind: "function", lexical: false, src, at: lineCol(sourceFile, statement.name) });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      bindings.push({ name: statement.name.text, kind: "class", lexical: true, src, at: lineCol(sourceFile, statement.name) });
    }
  }
  return bindings;
}

const scripts = scriptSources();
const errors = [];
const seen = new Map();

for (const src of scripts) {
  if (!src.startsWith("/")) continue;
  const file = `public${src}`;
  const abs = path.join(root, file);
  if (!existsSync(abs)) {
    errors.push(`script missing on disk: ${src} -> ${file}`);
    continue;
  }
  const sourceFile = ts.createSourceFile(file, readRepo(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const binding of topLevelBindings(sourceFile, src)) {
    if (binding.kind === "module syntax") {
      errors.push(`${src}:${binding.at} uses ${binding.name}; app-shell scripts must stay classic or use type="module" deliberately`);
      continue;
    }
    const prior = seen.get(binding.name);
    if (prior && (prior.lexical || binding.lexical)) {
      errors.push(
        `${binding.name} redeclared in classic app-shell scripts: ` +
        `${prior.src}:${prior.at} ${prior.kind} -> ${binding.src}:${binding.at} ${binding.kind}`
      );
    }
    if (!prior) seen.set(binding.name, binding);
  }
}

if (errors.length) {
  console.error("✗ public app-shell script globals are unsafe:");
  for (const error of errors) console.error(`    ${error}`);
  process.exit(1);
}

console.log(`✓ public app-shell script globals are safe (${scripts.length} script(s))`);
