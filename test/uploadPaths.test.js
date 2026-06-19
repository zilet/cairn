import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { safeUploadPath } from "../dist/uploadPaths.js";

test("safeUploadPath allows files inside the uploads directory", () => {
  const root = path.resolve("/tmp/cairn-data/uploads");
  const file = path.join(root, "doc.pdf");
  assert.equal(safeUploadPath(file, root), file);
});

test("safeUploadPath rejects traversal, siblings, and the upload root itself", () => {
  const root = path.resolve("/tmp/cairn-data/uploads");
  assert.equal(safeUploadPath(path.join(root, "..", "cairn.db"), root), null);
  assert.equal(safeUploadPath(path.resolve("/tmp/cairn-data/uploads-old/doc.pdf"), root), null);
  assert.equal(safeUploadPath(root, root), null);
  assert.equal(safeUploadPath("", root), null);
});
