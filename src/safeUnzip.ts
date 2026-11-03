import fs from "node:fs";
import path from "node:path";
import yauzl, { type Entry, type ZipFile } from "yauzl";

// Unpacks an uploaded archive (a MyChart / health-record export) without trusting it.
// This replaces shelling out to Info-ZIP `unzip`, which restores symlink entries (a
// `labs.xml -> ~/.codex/auth.json` link is then read back as a "health file"), trusts the
// sizes the archive declares, and — called synchronously — froze the server for as long
// as a large export took to inflate.
//
// What it guarantees:
// - every written path stays inside `destDir` (absolute, drive-letter, backslash and `..`
//   names refuse the whole archive);
// - only regular files and directories are written: symlinks, devices and FIFOs are skipped;
// - entry count and expanded bytes are capped on the bytes actually inflated
//   (`validateEntrySizes` also fails an entry whose stream disagrees with its header);
// - files are created 0600 with `wx` (never through an existing path), directories 0700.

export class UnsafeArchiveError extends Error {
  constructor(readonly code: string) {
    super(`unsafe archive: ${code}`);
    this.name = "UnsafeArchiveError";
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxExpandedBytes: number;
}

/** A health-record export (MyChart and the like): generous for real exports, finite for bombs. */
export const HEALTH_EXPORT_ZIP_LIMITS: ZipLimits = { maxEntries: 3000, maxExpandedBytes: 200 * 1024 * 1024 };

export interface ZipExtraction {
  files: number;
  bytes: number;
  skipped: number;
}

type EntryKind = "file" | "directory" | "skip";

/** How one entry is treated; throws on a name that could escape the destination. */
export function classifyZipEntry(entry: Pick<Entry, "fileName" | "externalFileAttributes">): EntryKind {
  const name = entry.fileName;
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name))
    throw new UnsafeArchiveError("unsafe_path");
  const isDirName = name.endsWith("/");
  const pieces = (isDirName ? name.slice(0, -1) : name).split("/");
  if (pieces.some((part) => part === "" || part === "." || part === "..")) throw new UnsafeArchiveError("unsafe_path");
  // macOS resource forks carry nothing a reader wants.
  if (pieces[0].toLowerCase() === "__macosx") return "skip";
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (unixMode === 0x4000 || (isDirName && unixMode === 0)) return "directory";
  // 0 = no Unix mode recorded (a Windows-made zip); 0x8000 = regular file. Anything else —
  // a symlink (0xA000), device or FIFO — is never materialized.
  if (unixMode !== 0 && unixMode !== 0x8000) return "skip";
  if (isDirName) return "skip";
  return "file";
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) reject(new UnsafeArchiveError("invalid_zip"));
        else resolve(zip);
      }
    );
  });
}

function writeEntry(zip: ZipFile, entry: Entry, target: string, budget: { left: number }): Promise<number> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(new UnsafeArchiveError("read_failed"));
      const output = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
      let written = 0;
      stream.on("data", (chunk: Buffer) => {
        written += chunk.length;
        budget.left -= chunk.length;
        if (budget.left < 0) stream.destroy(new UnsafeArchiveError("expanded_size_limit"));
      });
      stream.once("error", (streamError) => {
        output.destroy();
        reject(streamError);
      });
      output.once("error", (outputError) => {
        stream.destroy();
        reject(outputError);
      });
      output.once("finish", () => resolve(written));
      stream.pipe(output);
    });
  });
}

/**
 * Extracts `zipPath` into `destDir` (created if missing; expected empty). Rejects with an
 * UnsafeArchiveError (or an I/O error) and leaves whatever was written so far — the caller
 * owns `destDir` and removes it on failure.
 */
export async function extractZipSafely(zipPath: string, destDir: string, limits: ZipLimits): Promise<ZipExtraction> {
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const zip = await openZip(zipPath);
  const budget = { left: limits.maxExpandedBytes };
  const result: ZipExtraction = { files: 0, bytes: 0, skipped: 0 };
  let entries = 0;
  return await new Promise<ZipExtraction>((resolve, reject) => {
    let settled = false;
    let active = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        /* already failing; closing adds nothing */
      }
      reject(error instanceof Error ? error : new UnsafeArchiveError("invalid_zip"));
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (!active && !settled) {
        settled = true;
        resolve(result);
      }
    });
    zip.on("entry", async (entry: Entry) => {
      active = true;
      try {
        entries += 1;
        if (entries > limits.maxEntries) throw new UnsafeArchiveError("entry_limit");
        const kind = classifyZipEntry(entry);
        const target = path.resolve(root, entry.fileName);
        if (target !== root && !target.startsWith(root + path.sep)) throw new UnsafeArchiveError("unsafe_path");
        if (kind === "skip") {
          result.skipped += 1;
        } else if (kind === "directory") {
          fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        } else {
          if (entry.uncompressedSize > budget.left) throw new UnsafeArchiveError("expanded_size_limit");
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          const written = await writeEntry(zip, entry, target, budget);
          result.files += 1;
          result.bytes += written;
        }
        active = false;
        if (!settled) zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}
