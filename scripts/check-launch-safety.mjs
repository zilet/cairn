#!/usr/bin/env node
// Guard the public quickstarts from regressing to an internet-footgun. Cairn is a
// health-data app with an in-app CLI login bridge, so copy-paste docker run blocks
// must bind loopback unless the user deliberately widens the port.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "docs/QUICKSTART.md", "docs/SHARING.md"];

const fenced = [];
for (const file of DOCS) {
  const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
  let inFence = false;
  let lang = "";
  let buf = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        lang = fence[1] || "";
        buf = [];
        start = i + 1;
      } else {
        fenced.push({ file, lang, text: buf.join("\n"), start });
        inFence = false;
      }
      continue;
    }
    if (inFence) buf.push(line);
  }
}

const unsafe = fenced.filter((b) =>
  /\bdocker\s+run\b/.test(b.text) &&
  /(^|\s)-p\s+8787:8787(\s|\\|$)/.test(b.text) &&
  !/(^|\s)-p\s+127\.0\.0\.1:8787:8787(\s|\\|$)/.test(b.text)
);

if (unsafe.length) {
  console.error("✗ Public docker run quickstart binds Cairn to all interfaces:");
  for (const b of unsafe) console.error(`    ${b.file}:${b.start}`);
  console.error("\n  Use `-p 127.0.0.1:8787:8787` in copy-paste quickstarts.");
  console.error("  Mention widening to `-p 8787:8787` only as an explicit, authenticated/private-network step.");
  process.exit(1);
}

console.log(`✓ ${DOCS.join(", ")} docker run quickstarts bind loopback by default`);
