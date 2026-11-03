import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractZipSafely, HEALTH_EXPORT_ZIP_LIMITS } from "../dist/safeUnzip.js";
import { storedZip } from "./fixtures/dicom.js";

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-safe-unzip-"));
  return { dir, zip: path.join(dir, "export.zip"), dest: path.join(dir, "export.zip-x") };
}

test("a health export unpacks with its folders, files private to the service", async () => {
  const { dir, zip, dest } = scratch();
  try {
    fs.writeFileSync(
      zip,
      storedZip([
        { name: "IHE_XDM/", data: "", mode: 0o040755 },
        { name: "IHE_XDM/Patient/DOC0001.XML", data: "<ClinicalDocument/>" },
        { name: "INDEX.HTM", data: "<html></html>", mode: 0 },
      ])
    );
    const out = await extractZipSafely(zip, dest, HEALTH_EXPORT_ZIP_LIMITS);
    assert.deepEqual(out, { files: 2, bytes: 32, skipped: 0 });
    const doc = path.join(dest, "IHE_XDM/Patient/DOC0001.XML");
    assert.equal(fs.readFileSync(doc, "utf8"), "<ClinicalDocument/>");
    assert.equal(fs.statSync(doc).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink entry is never materialized (no reading a file outside the upload)", async () => {
  const { dir, zip, dest } = scratch();
  try {
    fs.writeFileSync(
      zip,
      storedZip([
        { name: "labs.xml", data: "/home/app/.codex/auth.json", mode: 0o120777 },
        { name: "DOC0001.XML", data: "<ClinicalDocument/>" },
      ])
    );
    const out = await extractZipSafely(zip, dest, HEALTH_EXPORT_ZIP_LIMITS);
    assert.equal(out.skipped, 1);
    assert.equal(fs.existsSync(path.join(dest, "labs.xml")), false);
    assert.equal(fs.existsSync(path.join(dest, "DOC0001.XML")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a name that climbs out of the folder refuses the whole archive", async () => {
  for (const name of ["../escape.xml", "/etc/cron.d/x", "a/../../b.xml", "C:/x.xml", "a\\..\\b.xml"]) {
    const { dir, zip, dest } = scratch();
    try {
      fs.writeFileSync(zip, storedZip([{ name, data: "x" }]));
      // yauzl's strictFileNames refuses some of these at open; ours refuses the rest.
      await assert.rejects(extractZipSafely(zip, dest, HEALTH_EXPORT_ZIP_LIMITS), undefined, name);
      assert.equal(fs.existsSync(path.join(dir, "escape.xml")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("entry count and inflated bytes are capped", async () => {
  const { dir, zip, dest } = scratch();
  try {
    fs.writeFileSync(
      zip,
      storedZip([
        { name: "a.xml", data: "x".repeat(600) },
        { name: "b.xml", data: "y".repeat(600) },
      ])
    );
    await assert.rejects(extractZipSafely(zip, dest, { maxEntries: 1, maxExpandedBytes: 1e6 }), {
      code: "entry_limit",
    });
    fs.rmSync(dest, { recursive: true, force: true });
    await assert.rejects(extractZipSafely(zip, dest, { maxEntries: 10, maxExpandedBytes: 1000 }), {
      code: "expanded_size_limit",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not a zip is refused, not thrown past the caller", async () => {
  const { dir, zip, dest } = scratch();
  try {
    fs.writeFileSync(zip, "not a zip at all");
    await assert.rejects(extractZipSafely(zip, dest, HEALTH_EXPORT_ZIP_LIMITS), { code: "invalid_zip" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
