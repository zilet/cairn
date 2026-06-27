#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remote = process.argv.includes("--remote");
const workflows = [".github/workflows/ci.yml", ".github/workflows/release-image.yml"];
const failures = [];

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  failures.push(message);
}

function versionCommentFor(lines, index, action) {
  const re = new RegExp(`^\\s*#\\s*${escRe(action)}\\s+(v\\S+)\\s*$`);
  for (let i = index - 1; i >= 0 && i >= index - 4; i--) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    const m = line.match(re);
    if (m) return m[1];
    if (!line.trim().startsWith("#") && !/^\s*(id|name):\s/.test(line)) return null;
  }
  return null;
}

function tagSha(action, tag) {
  const refs = [`refs/tags/${tag}`, `refs/tags/${tag}^{}`];
  const out = execFileSync("git", ["ls-remote", `https://github.com/${action}.git`, ...refs], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rows = out.trim().split(/\n/).filter(Boolean).map((line) => line.split(/\s+/));
  const deref = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  const direct = rows.find(([, ref]) => ref === `refs/tags/${tag}`);
  return (deref || direct || [null])[0];
}

for (const file of workflows) {
  const text = readFileSync(path.join(root, file), "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const m = line.match(/^\s*uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-fA-F]{40}|[^\s#]+)/);
    if (!m) return;
    const [, action, ref] = m;
    if (!/^[0-9a-f]{40}$/i.test(ref)) {
      fail(`${file}:${index + 1} ${action} must be pinned to a full commit SHA, got ${ref}`);
      return;
    }
    const tag = versionCommentFor(lines, index, action);
    if (!tag) {
      fail(`${file}:${index + 1} ${action} needs an adjacent '# ${action} vX.Y.Z' comment`);
      return;
    }
    if (!remote) return;
    let got = "";
    try {
      got = tagSha(action, tag);
    } catch (err) {
      fail(`${file}:${index + 1} could not resolve ${action} ${tag}: ${err?.message || err}`);
      return;
    }
    if (!got) {
      fail(`${file}:${index + 1} ${action} ${tag} did not resolve on GitHub`);
    } else if (got.toLowerCase() !== ref.toLowerCase()) {
      fail(`${file}:${index + 1} ${action} ${tag} resolves to ${got}, workflow pins ${ref}`);
    }
  });
}

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join("\n"));
  process.exit(1);
}

console.log(remote ? "✓ action pins match their documented GitHub tags" : "✓ action pins are full SHAs with version comments");
