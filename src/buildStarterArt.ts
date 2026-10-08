// Maintainer tool — bake the committed STARTER picture pack (`seed-art/starter/`)
// so every install, keyless or not, shows real exercise figures with zero setup.
//
//   npm run starter:art:build -- --limit 5          # preview a handful first
//   npm run starter:art:build -- --only "Romanian Deadlift"
//   npm run starter:art:build -- --only pattern:squat
//   npm run starter:art:build                       # the full run (resumable)
//   npm run starter:art:build -- --dry-run          # what would be drawn, and the cost
//
// It reads the curated lists (`seed-art/starter/exercises.json`, `patterns.json`)
// and draws each figure through the SAME prompt the runtime producer sends for an
// exercise (src/art.ts stylePrompt with the entry's ArtContext, pose leading), so a
// pack figure and a later bespoke figure read as one set. Three ANCHOR figures
// (ANCHOR_NAMES) are drawn first; once built, they ride along as style references
// on every later figure (when the model takes references), so the pack shares one
// sculptural language. Each image is downscaled to a small JPEG with
// ffmpeg and written to `exercises/<slug>.jpg` / `patterns/<id>.jpg`, plus a
// manifest.
//
// Resumable: a figure already in the pack is skipped unless `--force`, so an
// interrupted run picks up where it stopped. Serial, one request at a time, and it
// stops early when the art circuit breaker opens (an upstream outage).
//
// Requirements: a Gemini key (`.env` GEMINI_API_KEY / GOOGLE_AI_KEY) and ffmpeg on
// PATH (without ffmpeg the pack is written full-size — larger, but it works). It
// runs against a THROWAWAY DATA_DIR (set by the npm script) and never touches your
// real data/.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// The throwaway DB has no Gemini key in Settings, so pick it up from .env (the
// usual place a maintainer keeps GEMINI_API_KEY). Node 24 ships loadEnvFile.
// Loaded BEFORE importing the art modules, whose model constants resolve at load.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* no .env — rely on an already-exported GEMINI_API_KEY / GOOGLE_AI_KEY */
}

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DOWNSCALE = process.env.STARTER_ART_PX || "512";
// The series anchors: drawn FIRST, then sent as style references with every later
// figure. Deliberately three different body positions (standing loaded, lying
// press, seated pull), so the references carry material and light, not a pose.
const ANCHOR_NAMES = ["Back Squat", "Barbell Bench Press", "Lat Pulldown"];
const ANCHOR_COUNT = 3;

interface Target {
  /** "exercise" | "pattern" — where the file lands and how the manifest files it. */
  type: "exercise" | "pattern";
  id: string; // exercise slug or pattern id
  name: string; // the prompt subject
  context: { muscle_group: string | null; equipment: string | null; pose: string | null };
  dst: string;
}

function parseArgs(argv: string[]): { limit: number; only: string[]; force: boolean; dryRun: boolean } {
  const out = { limit: Number.POSITIVE_INFINITY, only: [] as string[], force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") out.force = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--limit") out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--limit=")) out.limit = Math.max(0, Number(arg.slice(8)) || 0);
    else if (arg === "--only") out.only.push(String(argv[++i] ?? ""));
    else if (arg.startsWith("--only=")) out.only.push(arg.slice(7));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  out.only = out.only.map((s) => s.trim()).filter(Boolean);
  return out;
}

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readManifest(file: string): any {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  // Guard: never run against the real data dir — the builder writes its own art cache.
  if (!process.env.DATA_DIR || path.resolve(DATA_DIR) === path.resolve(ROOT, "data")) {
    console.error("Refusing to run without a throwaway DATA_DIR. Use `npm run starter:art:build`.");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const art = await import("./art.js");
  const starter = await import("./artStarter.js");
  const { getGeminiApiKey } = await import("./repo/settings.js");

  const PACK = starter.STARTER_ART_DIR;
  const pack = starter.readStarterPack(PACK);
  if (!pack.exercises.length && !pack.patterns.length) {
    console.error(`No starter lists found in ${PACK} (exercises.json / patterns.json).`);
    process.exit(1);
  }
  const model = art.GEMINI_IMAGE_MODEL;
  const perImage = art.imageCostForModel(model);
  const refsSupported = art.STYLE_REFERENCE_MODELS.has(model) && process.env.ART_EXERCISE_STYLE_REFS !== "0";

  const all: Target[] = [
    ...pack.exercises.map(
      (entry): Target => ({
        type: "exercise",
        id: starter.starterSlug(entry.name),
        name: entry.name,
        context: {
          muscle_group: entry.muscle_group || null,
          equipment: entry.equipment || null,
          pose: entry.pose || null,
        },
        dst: starter.starterExerciseFile(entry, PACK),
      })
    ),
    ...pack.patterns.map(
      (p): Target => ({
        type: "pattern",
        id: p.id,
        name: p.subject || p.id.replace(/_/g, " "),
        context: { muscle_group: null, equipment: null, pose: p.pose || null },
        dst: starter.starterPatternFile(p.id, PACK),
      })
    ),
  ];
  const named = ANCHOR_NAMES.map((n) => all.find((t) => t.type === "exercise" && t.name === n)).filter(
    (t): t is Target => !!t
  );
  const anchors = named.length ? named : all.filter((t) => t.type === "exercise").slice(0, ANCHOR_COUNT);
  // Anchors first, so a `--limit` preview draws the series' reference figures.
  all.sort((a, b) => Number(!anchors.includes(a)) - Number(!anchors.includes(b)));
  const onlyKeys = new Set(args.only.map((s) => s.toLowerCase()));
  const selected = onlyKeys.size
    ? all.filter(
        (t) =>
          onlyKeys.has(t.name.toLowerCase()) ||
          onlyKeys.has(t.id.toLowerCase()) ||
          (t.type === "pattern" && onlyKeys.has(`pattern:${t.id}`.toLowerCase()))
      )
    : all;
  if (onlyKeys.size && selected.length !== onlyKeys.size) {
    const found = new Set(selected.flatMap((t) => [t.name.toLowerCase(), t.id.toLowerCase(), `pattern:${t.id}`]));
    const missing = [...onlyKeys].filter((k) => !found.has(k));
    if (missing.length) console.warn(`No starter entry for: ${missing.join(", ")}`);
  }
  const todo = selected.filter((t) => args.force || !fs.existsSync(t.dst)).slice(0, args.limit);
  const already = selected.filter((t) => fs.existsSync(t.dst)).length;

  console.log(`Starter pack: ${pack.exercises.length} exercises + ${pack.patterns.length} patterns in ${PACK}`);
  console.log(
    `Model: ${model} · ~$${perImage.toFixed(4)} per image · style references: ${refsSupported ? "anchors" : "off"}`
  );
  console.log(
    `${already} already built${args.force ? " (rebuilding: --force)" : ""}; drawing ${todo.length} now · est. $${(todo.length * perImage).toFixed(2)}`
  );
  if (args.dryRun) {
    for (const t of todo) console.log(`  · ${t.type}: ${t.name}`);
    return;
  }
  if (!todo.length) return;
  if (!getGeminiApiKey()) {
    console.error("No Gemini key: set GEMINI_API_KEY (or GOOGLE_AI_KEY) in .env or the environment.");
    process.exit(1);
  }
  // The throwaway DB keeps the breaker a previous run tripped (a bad key, an outage);
  // a maintainer re-running the tool is the decision to try again, so start closed.
  (await import("./artCircuit.js")).resetArtCircuit();

  const haveFfmpeg = ffmpegAvailable();
  if (!haveFfmpeg) console.log("ffmpeg not found — the pack will be written full-size.");
  fs.mkdirSync(path.join(PACK, "exercises"), { recursive: true });
  fs.mkdirSync(path.join(PACK, "patterns"), { recursive: true });

  const manifestFile = path.join(PACK, "manifest.json");
  const manifest = readManifest(manifestFile);
  manifest.exercises = manifest.exercises && typeof manifest.exercises === "object" ? manifest.exercises : {};
  manifest.patterns = manifest.patterns && typeof manifest.patterns === "object" ? manifest.patterns : {};
  let spent = 0;
  let paid = 0;
  let ok = 0;
  let fail = 0;
  const writeManifest = () => {
    // Only figures actually on disk stay listed — the manifest is the pack's inventory.
    for (const [bucket, dir] of [
      ["exercises", "exercises"],
      ["patterns", "patterns"],
    ] as const) {
      for (const [id, row] of Object.entries(manifest[bucket] as Record<string, any>)) {
        if (!fs.existsSync(path.join(PACK, dir, String(row?.file ?? "")))) delete manifest[bucket][id];
      }
    }
    manifest.model = model;
    manifest.built_at = new Date().toISOString();
    manifest.downscale_px = haveFfmpeg ? Number(DOWNSCALE) : null;
    manifest.est_cost_usd = Number((Number(manifest.est_cost_usd || 0) + spent).toFixed(4));
    spent = 0;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  };

  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    process.stdout.write(`  [${i + 1}/${todo.length}] ${t.type}: ${t.name.slice(0, 52)} … `);
    // The anchors that already exist (never the figure being drawn) set the style.
    const refFiles = refsSupported
      ? anchors.filter((a) => a.dst !== t.dst && fs.existsSync(a.dst)).map((a) => a.dst)
      : [];
    try {
      // A figure already paid for in this work dir (a run that died between the
      // generation and the pack write) is reused, never bought twice — unless --force.
      const work = path.join(DATA_DIR, "art", `${art.exerciseAssetKey(t.name, t.context, 1)}.png`);
      let src = work;
      if (args.force || !fs.existsSync(work)) {
        src = await art.pregenerateExerciseFigure(t.name, t.context, { refFiles, model });
        spent += perImage;
        paid++;
      }
      const tmp = `${t.dst}.tmp-${process.pid}.jpg`;
      let downscaled = false;
      if (haveFfmpeg) {
        try {
          execFileSync(
            "ffmpeg",
            ["-y", "-i", src, "-vf", `scale=${DOWNSCALE}:${DOWNSCALE}:flags=lanczos`, "-q:v", "4", tmp],
            { stdio: "ignore" }
          );
          downscaled = true;
        } catch {
          console.log("(ffmpeg could not downscale this one — keeping it full-size) ");
        }
      }
      // Full-size bytes when not downscaled; the serve routes sniff the real type.
      if (!downscaled) fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, t.dst);
      const bucket = t.type === "exercise" ? "exercises" : "patterns";
      manifest[bucket][t.id] = {
        name: t.name,
        file: path.basename(t.dst),
        sha1: crypto.createHash("sha1").update(fs.readFileSync(t.dst)).digest("hex"),
        prompt_sha1: crypto
          .createHash("sha1")
          .update(art.stylePrompt("exercise", t.name, t.context))
          .digest("hex"),
        references: refFiles.length,
        model,
      };
      ok++;
      console.log(`ok · running $${(paid * perImage).toFixed(2)}`);
      writeManifest(); // after every figure, so an interrupted run keeps its inventory
    } catch (e: any) {
      fail++;
      const message = String(e?.message ?? e);
      console.log(`FAIL (${message})`);
      if (/circuit is open/.test(message)) {
        console.log(
          "The art circuit breaker opened (upstream failing) — stopping. Re-run later; built figures are kept."
        );
        break;
      }
    }
  }
  writeManifest();

  let size = "?";
  try {
    size = execFileSync("du", ["-sh", PACK]).toString().trim().split("\t")[0];
  } catch {
    /* du is optional */
  }
  console.log(
    `\nDone. ${ok} ok, ${fail} failed, ~$${(paid * perImage).toFixed(2)} spent this run. Pack: ${PACK} (${size}).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
