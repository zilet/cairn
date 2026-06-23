// Maintainer tool — pre-bake the committed `seed-art/` image pack so a fresh seed
// and the demo render real studio photos with NO Gemini key at runtime.
//
//   npm run seed:art:build
//
// It seeds the fictional DEMO into a THROWAWAY DB (set via the npm-script env),
// generates every image the demo PWA will request under its DIRECT cache key
// (bypassing the live semantic-dedup so the pack is deterministic and alias-free),
// downscales each to a small JPEG with ffmpeg, and writes them — plus a manifest —
// into `seed-art/`. installSeedArt() (src/art.ts) then copies the matching files
// into data/art/ on every seed/first-boot.
//
// Requirements: a Gemini key (`.env` GEMINI_API_KEY / GOOGLE_AI_KEY, or Settings)
// and ffmpeg on PATH (without ffmpeg the pack is written full-size — larger, but
// it still works). Run rarely: after changing the demo content or the art style.
//
// Cost/time: ~$0.039 per image, generated serially — expect a few dollars and
// several minutes for the full demo set. Nothing here touches your real data/.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemo } from "./demoSeed.js";
import { enumeratePwaArt, cacheKey, pregenerate } from "./art.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// The throwaway DB has no Gemini key in Settings, so pick it up from .env (the
// usual place a maintainer keeps GEMINI_API_KEY). Node 24 ships loadEnvFile.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* no .env — rely on an already-exported GEMINI_API_KEY / GOOGLE_AI_KEY */
}

const PACK = path.join(ROOT, "seed-art");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const WORK_ART = path.join(DATA_DIR, "art");
const DOWNSCALE = process.env.SEED_ART_PX || "512";

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Guard: never run against the real data dir — this seeds (wipes) the DB.
  if (!process.env.DATA_DIR || DATA_DIR === path.join(ROOT, "data")) {
    console.error("Refusing to run without a throwaway DATA_DIR. Use `npm run seed:art:build`.");
    process.exit(1);
  }
  const haveFfmpeg = ffmpegAvailable();
  // Start from a clean work art dir so pregenerate always generates fresh.
  fs.rmSync(WORK_ART, { recursive: true, force: true });
  fs.mkdirSync(PACK, { recursive: true });

  console.log(`Seeding demo into throwaway DB at ${DATA_DIR} …`);
  seedDemo();

  const targets = enumeratePwaArt();
  console.log(`Generating ${targets.length} images (serial, ~$0.039 each)${haveFfmpeg ? "" : " — ffmpeg not found, pack will be full-size"} …\n`);

  const manifest: { key: string; kind: string; q: string }[] = [];
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const { kind, q } = targets[i];
    const key = cacheKey(kind, q);
    process.stdout.write(`  [${i + 1}/${targets.length}] ${kind}: ${q.slice(0, 52)} … `);
    try {
      const src = await pregenerate(kind, q, { force: true });
      const dst = path.join(PACK, `${key}.png`);
      if (haveFfmpeg) {
        const tmp = path.join(PACK, `${key}.tmp.jpg`);
        execFileSync(
          "ffmpeg",
          ["-y", "-i", src, "-vf", `scale=${DOWNSCALE}:${DOWNSCALE}:flags=lanczos`, "-q:v", "4", tmp],
          { stdio: "ignore" },
        );
        fs.renameSync(tmp, dst); // JPEG bytes in a .png name — the serve route sniffs the real type
      } else {
        fs.copyFileSync(src, dst);
      }
      manifest.push({ key, kind, q });
      ok++;
      console.log("ok");
    } catch (e: any) {
      fail++;
      console.log(`FAIL (${e?.message ?? e})`);
    }
  }

  // Manifest (human-readable inventory) + prune any orphan files no longer baked.
  fs.writeFileSync(
    path.join(PACK, "manifest.json"),
    `${JSON.stringify({ count: manifest.length, downscale_px: haveFfmpeg ? Number(DOWNSCALE) : null, items: manifest }, null, 2)}\n`,
  );
  const keep = new Set(manifest.map((m) => `${m.key}.png`));
  keep.add("manifest.json");
  for (const f of fs.readdirSync(PACK)) {
    if (!keep.has(f)) {
      try {
        fs.rmSync(path.join(PACK, f));
      } catch {
        /* ignore */
      }
    }
  }

  let size = "?";
  try {
    size = execFileSync("du", ["-sh", PACK]).toString().trim().split("\t")[0];
  } catch {
    /* du is optional */
  }
  console.log(`\nDone. ${ok} ok, ${fail} failed. Pack: ${PACK} (${size}).`);
  if (!haveFfmpeg) console.log("Install ffmpeg and re-run to ship a smaller pack.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
