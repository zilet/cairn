import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadMarkdown() {
  const context = { Object, RegExp, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/markdown-client.js"), "utf8"), context);
  return context.CairnMarkdown;
}

test("markdown renderer escapes text and allowlists link schemes", () => {
  const markdown = loadMarkdown();

  assert.equal(markdown.mdSafeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(markdown.mdSafeUrl("/api/export"), "/api/export");
  assert.equal(markdown.mdSafeUrl("mailto:coach@example.com"), "mailto:coach@example.com");
  assert.equal(markdown.mdSafeUrl("javascript:alert(1)"), null);

  const html = markdown.mdToHtml('Hello **you** <script>alert(1)</script> [safe](https://example.com) [bad](javascript:alert(1))');

  assert.match(html, /<strong>you<\/strong>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">safe<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<script>/);
});

test("markdown renderer preserves structured chat formatting", () => {
  const markdown = loadMarkdown();
  const html = markdown.mdToHtml([
    "### Focus",
    "",
    "- easy run",
    "- protein",
    "",
    "> quiet note",
    "",
    "| Marker | Read |",
    "| --- | --- |",
    "| ApoB | high |",
    "",
    "```",
    "<raw>",
    "```",
  ].join("\n"));

  assert.match(html, /<h5>Focus<\/h5>/);
  assert.match(html, /<ul><li>easy run<\/li><li>protein<\/li><\/ul>/);
  assert.match(html, /<blockquote>quiet note<\/blockquote>/);
  assert.match(html, /<div class="md-tablewrap"><table>/);
  assert.match(html, /<th>Marker<\/th>/);
  assert.match(html, /<td>ApoB<\/td>/);
  assert.match(html, /<pre><code>&lt;raw&gt;<\/code><\/pre>/);
});
