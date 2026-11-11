#!/usr/bin/env node
// Chat coach-read eval — a measuring tool, NOT a test (it is never run by npm test).
//
// For a fixed list of real-shaped questions it builds the chat prompt both ways — the
// lean core (settings.chat_context "lean") and the full snapshot ("full") — and prints
// the bytes of each. With --run it sends each question through the REAL chat read path
// (src/chatTurns.ts runChatCompletion: routing, transport, native listener or prompt
// loop) on the named agent and prints the transport, every read the agent made, the
// wall time and the reply.
//
//   npm run build
//   node scripts/chat-read-eval.mjs --agent claude                 # bytes only, demo seed
//   node scripts/chat-read-eval.mjs --agent claude --db /path/to/cairn.db --run
//   node scripts/chat-read-eval.mjs --agent codex --run --question "What did I burn today?"
//
// Safety: it never touches the database it is pointed at. The DB file (and its WAL) is
// copied into a throwaway directory first and every module opens the copy. Without --db it seeds the fictional demo athlete into a throwaway DB;
// it refuses to read the repo's own data/ directory unless --db names it explicitly.
// --run spawns the real CLI (your subscription, your quota); without it nothing spawns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export const QUESTIONS = [
  "What did I burn today?",
  "How has my squat moved over the last two months?",
  "What was my last ApoB and when?",
  "How was my sleep this week compared to normal?",
  "What's my run plan this week and why?",
  "Did I hit protein yesterday?",
  "How did Sunday's long run go inside?",
  "What changed in my plan recently?",
];

function parseArgs(argv) {
  const out = { agent: null, db: null, run: false, questions: [], reply: 1200 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--agent") out.agent = next();
    else if (arg === "--db") out.db = next();
    else if (arg === "--run") out.run = true;
    else if (arg === "--question") out.questions.push(next());
    else if (arg === "--reply-chars") out.reply = Math.max(80, Number(next()) || 1200);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

const USAGE = `usage: node scripts/chat-read-eval.mjs --agent <name> [--db <path>] [--run] [--question "..."]... [--reply-chars N]
  --agent        the agent to evaluate (agents.json name: claude, codex, grok, antigravity)
  --db           a cairn.db to COPY and read (never written); omit to use the demo seed
  --run          actually run each question through the chat read path (spawns the CLI)
  --question     replace the built-in question list (repeatable)
  --reply-chars  how much of each reply to print (default 1200)`;

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Copy the database file and its WAL into a private directory, byte for byte, and open
// only the copy. The source is never opened by SQLite at all — even a read-only open of a
// WAL database creates -shm/-wal files beside it — so nothing is ever written next to the
// database being evaluated. SQLite replays the copied WAL (and ignores a torn tail frame,
// should a live server be mid-write) when the copy is first opened.
function copyDatabase(source, targetDir) {
  const target = path.join(targetDir, "cairn.db");
  fs.copyFileSync(source, target);
  if (fs.existsSync(`${source}-wal`)) fs.copyFileSync(`${source}-wal`, `${target}-wal`);
  return { target, method: "file copy" };
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function dataBytes(prompt) {
  const at = prompt.lastIndexOf("\nDATA:\n");
  return at < 0 ? 0 : Buffer.byteLength(prompt.slice(at + "\nDATA:\n".length), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.agent) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  if (!fs.existsSync(path.join(root, "dist", "chatTurns.js"))) {
    console.error("dist/ is missing — run `npm run build` first.");
    process.exit(2);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-chat-read-eval-"));
  let source = "demo seed (fictional athlete)";
  if (args.db) {
    const resolved = path.resolve(args.db);
    if (!fs.existsSync(resolved)) throw new Error(`no database at ${resolved}`);
    const copy = copyDatabase(resolved, work);
    source = `${resolved} (read through a ${copy.method}; the original is never opened)`;
  } else {
    // The default must never be the repo's real data/ — an inherited DATA_DIR/DB_PATH
    // pointing there is refused rather than silently read.
    for (const inherited of [process.env.DATA_DIR, process.env.DB_PATH]) {
      if (inherited && isInside(path.resolve(inherited), path.join(root, "data"))) {
        throw new Error("refusing to read the repo's data/ dir implicitly — pass --db <path> to evaluate it (a copy is used)");
      }
    }
  }
  // Every module below opens the copy (or the fresh demo DB): DATA_DIR/DB_PATH are read
  // once, at import, by src/db.ts and src/dataDir.ts.
  process.env.DATA_DIR = work;
  process.env.DB_PATH = path.join(work, "cairn.db");

  const dist = (file) => pathToFileURL(path.join(root, "dist", file)).href;
  const repo = await import(dist("repo.js"));
  if (!args.db) {
    const { seedDemo } = await import(dist("demoSeed.js"));
    seedDemo();
  }
  const { loadAgents } = await import(dist("agents.js"));
  if (!loadAgents()[args.agent]) throw new Error(`unknown agent "${args.agent}" (agents.json)`);
  const { buildChatPrompt } = await import(dist("prompt.js"));
  const { classifyChatRoute } = await import(dist("chatRouting.js"));
  const { resolveCoachReadTransport } = await import(dist("brain/read-transport.js"));
  const transport = resolveCoachReadTransport(args.agent).transport;

  console.log(`chat read eval — agent ${args.agent} (declared transport: ${transport})`);
  console.log(`database: ${source}`);
  console.log(`work dir: ${work}`);
  console.log("");

  const questions = args.questions.length ? args.questions : QUESTIONS;
  const rows = [];
  for (const question of questions) {
    const routing = classifyChatRoute({ message: question, has_image: false });
    const lane = routing.lane;
    const lean = buildChatPrompt([], question, undefined, { lane, context: "lean" });
    const full = buildChatPrompt([], question, undefined, { lane, context: "full" });
    rows.push({
      question,
      lane,
      lean: Buffer.byteLength(lean, "utf8"),
      leanData: dataBytes(lean),
      full: Buffer.byteLength(full, "utf8"),
      fullData: dataBytes(full),
    });
  }
  console.log("prompt bytes (whole prompt / its DATA block), before the read contract is appended:");
  for (const row of rows) {
    console.log(
      `- [${row.lane}] ${row.question}\n    lean ${kb(row.lean)} (DATA ${kb(row.leanData)})   full ${kb(row.full)} (DATA ${kb(row.fullData)})`
    );
  }

  if (!args.run) {
    console.log("\n(no --run: nothing was sent to an agent)");
    return;
  }

  const { runChatCompletion } = await import(dist("chatTurns.js"));
  repo.setSettings({ chat_context: "lean" });
  console.log(`\nrunning ${questions.length} question(s) on ${args.agent} through the chat read path…`);
  let id = 900_000;
  for (const question of questions) {
    const routing = classifyChatRoute({ message: question, has_image: false });
    const turn = { id: ++id, agent: args.agent, message: question, image_path: null, routing };
    const started = Date.now();
    console.log(`\n=== ${question}  [lane ${routing.lane}]`);
    try {
      const out = await runChatCompletion(turn.id, turn, [], new AbortController().signal);
      const wall = Date.now() - started;
      const reads = out.reads ?? { transport: "?", calls: [], rounds: 0, total_bytes: 0 };
      console.log(
        `transport ${reads.transport}${reads.native_fallback ? " (native attach failed → prompt loop)" : ""} · ${reads.calls.length} read(s) · ${reads.rounds} round(s) · ${kb(reads.total_bytes)} read · prompt ${kb(out.promptBytes ?? 0)} · ${wall} ms · agent ${out.agent}`
      );
      for (const call of reads.calls) console.log(`  - ${call.tool} ${call.ok ? "ok" : "REFUSED"} ${call.ms} ms ${kb(call.bytes)}`);
      const failed = out.attempts.filter((attempt) => !attempt.ok);
      for (const attempt of failed) console.log(`  ! attempt ${attempt.agent}: ${attempt.status} — ${attempt.error_message ?? ""}`);
      const { parseChatReply } = await import(dist("prompt.js"));
      const reply = parseChatReply(out.raw).reply;
      console.log(`reply:\n${reply.length > args.reply ? `${reply.slice(0, args.reply)}…` : reply}`);
    } catch (error) {
      console.log(`FAILED after ${Date.now() - started} ms: ${error?.message ?? error}`);
      for (const attempt of error?.attempts ?? []) console.log(`  ! attempt ${attempt.agent}: ${attempt.status} — ${attempt.error_message ?? ""}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
