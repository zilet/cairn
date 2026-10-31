// The same imaging report pasted twice and read twice in different words is one
// study. The strict rule (same day, procedure AND impression) cannot see that, so
// an agent judges the near-twins it leaves apart: a fold only on a remembered
// same_study verdict at high confidence with no measurement disagreeing; never
// on a medium verdict, never without a verdict, and never asked twice.
// Every value here is invented.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, repo, resetTables } from "./_seed.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { AgentBusyError, isAgentBusyError } from "../dist/agent-busy.js";
import { checkHealthDuplicates, judgeImagingTwins, settleImagingTwins } from "../dist/coachOps/health.js";
import { imagingJudgeCandidates } from "../dist/repo/imaging-dedupe.js";
import { dedupeHealthDocuments } from "../dist/repo/health-dedupe.js";

beforeEach(() => {
  resetTables("imaging_study_files", "health_documents", "health_directives");
  repo.setSettings({ enrich_enabled: false });
});

function storedPaste(text) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fp = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.txt`);
  fs.writeFileSync(fp, text);
  return fp;
}

function pastedStudy({ procedure, impression, agatston = 0, laterality = "not_applicable", region = "torso.chest" }) {
  const text = `EXAM: ${procedure}\nIMPRESSION: ${impression}`;
  const source = repo.addHealthDocument({
    kind: "imaging",
    original_name: "Pasted results",
    mime: "text/plain",
    file_path: storedPaste(text),
    parsed_json: {},
    summary: procedure,
    enrichment_status: "done",
  });
  const [study] = repo.replaceDerivedImagingStudies(source.id, [
    {
      imaging_study: {
        study: { modality: "CT", procedure, study_date: "2026-09-14" },
        anatomy: { clinical_system: "cardiovascular", body_region: region, laterality },
        report: { impression },
        findings: [
          {
            finding_text: "Coronary calcium",
            measurements: [{ name: "Agatston score", qualifier: "total", value: agatston, unit: "Agatston" }],
          },
        ],
      },
    },
  ]);
  return { source, study };
}

function twins(opts = {}) {
  const first = pastedStudy({
    procedure: "CT coronary calcium scoring",
    impression: "Calcium score 0. Very low risk.",
  });
  const second = pastedStudy({
    procedure: "Coronary calcium scoring CT",
    impression: "No coronary artery calcium (score 0).",
    ...opts,
  });
  return { first, second };
}

const studyIds = () =>
  db
    .prepare(
      "SELECT id FROM health_documents WHERE kind = 'imaging' AND parsed_json LIKE '%imaging_study%' ORDER BY id"
    )
    .all()
    .map((r) => r.id);

// A dispatch double: answers every pair with `verdict`, and counts the calls.
function answering(verdict) {
  const calls = [];
  const run = async (agent, prompt, opts) => {
    calls.push({ agent, prompt, opts });
    return { agent: "judge", result: { parsed: verdict }, tried: [] };
  };
  return { run, calls };
}

test("the strict rule leaves the reworded twin apart, so it is a candidate", () => {
  const { first, second } = twins();
  assert.equal(dedupeHealthDocuments({ dryRun: true }).merged, 0, "different words: the strict rule cannot fold");
  const candidates = imagingJudgeCandidates();
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].older.id, candidates[0].newer.id], [first.study.id, second.study.id]);
});

test("a high-confidence same-study verdict folds the twin, with its paste, on the next fold", async () => {
  const { first, second } = twins();
  const { run, calls } = answering({
    same_study: true,
    confidence: "high",
    reason: "Both describe one calcium-score CT.",
  });
  const judged = await judgeImagingTwins("judge", { run });
  assert.deepEqual([judged.asked, judged.judged], [1, 1]);
  assert.equal(calls[0].opts.op, "imaging_twin_judge");
  assert.ok(calls[0].opts.schema?.properties?.same_study, "the verdict is schema-enforced");
  assert.match(calls[0].prompt, /CT coronary calcium scoring/);
  assert.match(calls[0].prompt, /Coronary calcium scoring CT/);

  const plan = dedupeHealthDocuments({ dryRun: true });
  assert.equal(plan.merged, 1);
  assert.equal(plan.clusters[0].rule, "same_scan_judged");
  assert.match(plan.clusters[0].reason, /read twice in different words\. Both describe one calcium-score CT\./);
  assert.deepEqual(studyIds(), [first.study.id, second.study.id], "a dry run folds nothing");

  const applied = dedupeHealthDocuments({});
  assert.equal(applied.merged, 1);
  assert.deepEqual(studyIds(), [first.study.id]);
  assert.equal(repo.getHealthDocumentRaw(second.source.id), null, "the paste that only carried the twin goes with it");
});

test("a medium verdict, a contradicting measurement, or a different side keeps both", async () => {
  {
    twins();
    await judgeImagingTwins("judge", {
      run: answering({ same_study: true, confidence: "medium", reason: "Probably one scan." }).run,
    });
    assert.equal(dedupeHealthDocuments({}).merged, 0);
    assert.equal(studyIds().length, 2);
  }
  resetTables("imaging_study_files", "health_documents");
  {
    twins({ agatston: 12 });
    await judgeImagingTwins("judge", {
      run: answering({ same_study: true, confidence: "high", reason: "One scan." }).run,
    });
    assert.equal(dedupeHealthDocuments({}).merged, 0, "0 and 12 are two readings, whatever was judged");
    assert.equal(studyIds().length, 2);
  }
  resetTables("imaging_study_files", "health_documents");
  {
    pastedStudy({ procedure: "XR knee", impression: "Normal.", laterality: "left", region: "lower_limb.knee" });
    pastedStudy({
      procedure: "Knee radiograph",
      impression: "No acute finding.",
      laterality: "right",
      region: "lower_limb.knee",
    });
    assert.equal(imagingJudgeCandidates().length, 0, "left and right are never one scan, so never asked");
  }
});

test("a verdict is remembered: the next pass asks nothing", async () => {
  twins();
  const first = answering({ same_study: false, confidence: "high", reason: "Two different exams." });
  await judgeImagingTwins("judge", { run: first.run });
  assert.equal(first.calls.length, 1);
  const again = answering({ same_study: true, confidence: "high", reason: "unused" });
  const second = await judgeImagingTwins("judge", { run: again.run });
  assert.equal(again.calls.length, 0);
  assert.equal(second.skipped, "no_candidates");
  assert.equal(dedupeHealthDocuments({}).merged, 0);
});

test("congestion defers: AgentBusyError propagates and nothing is marked judged", async () => {
  twins();
  const run = async () => {
    throw new AgentBusyError("claude", 120_000);
  };
  await assert.rejects(judgeImagingTwins("judge", { run }), (e) => isAgentBusyError(e));
  assert.equal(imagingJudgeCandidates().length, 1, "still owed a verdict");
});

test("no usable agent, or only the offline stub, judges nothing and folds nothing", async () => {
  twins();
  const out = await judgeImagingTwins("stub");
  assert.equal(out.skipped, "no_agent");
  assert.equal(imagingJudgeCandidates().length, 1);
  const failing = async () => {
    throw new Error("every agent failed");
  };
  const failed = await judgeImagingTwins("judge", { run: failing });
  assert.equal(failed.judged, 0);
  assert.equal(dedupeHealthDocuments({}).merged, 0);
  assert.equal(studyIds().length, 2);
});

test("a real agent answer travels through runChosen's schema and parse", async () => {
  twins();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-imaging-judge-"));
  const file = path.join(dir, "agents.json");
  const body = '{"same_study":true,"confidence":"high","reason":"One scan, two readings of it."}';
  fs.writeFileSync(
    file,
    JSON.stringify({
      judge: {
        command: "sh",
        args: ["-c", `printf '%s' '${body}'`],
        input: "arg",
        description: "test double",
        env_required: [],
        capabilities: { model: false, reasoning: [], execution_profile_noop: true },
      },
    })
  );
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = file;
  try {
    const out = await judgeImagingTwins("judge");
    assert.equal(out.judged, 1);
  } finally {
    if (previous === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(dedupeHealthDocuments({}).merged, 1);
});

test("after an imaging ingest the settle folds a judged twin; the Records check only plans", async () => {
  const { second } = twins();
  const plan = await checkHealthDuplicates("judge", undefined, {
    run: answering({ same_study: true, confidence: "high", reason: "One scan." }).run,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.merged, 1);
  assert.equal(studyIds().length, 2, "the check plans; the person applies");

  resetTables("imaging_study_files", "health_documents");
  const pair = twins();
  const settled = await settleImagingTwins(pair.second.source.id, {
    run: answering({ same_study: true, confidence: "high", reason: "One scan." }).run,
  });
  assert.equal(settled.merged, 1);
  assert.deepEqual(studyIds(), [pair.first.study.id]);
  assert.ok(second, "fixture");
});
