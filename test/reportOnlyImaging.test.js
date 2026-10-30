// A report-only imaging ingest (a pasted CT calcium score, an MRI, an echo …) lands as ONE
// thing: the derived study carries the report's date, the source folds into it, the coach
// view keeps the totals, and the cardiovascular read + visit questions connect it — as
// dated facts that never soften a lipid finding. Plus the cardiovascular card's context:
// one source per number, ages side by side, what is working, and honest staleness.
// Every fixture is synthetic: invented names, dates and values.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, localDaysAgo, marker, repo, resetTables, seedHealthDoc } from "./_seed.js";
import { applyHealthIngest } from "../dist/enrich.js";
import { UPLOADS_DIR } from "../dist/uploadPaths.js";
import { deleteImagingStudy, imagingForCoach, isImagingOnlySource } from "../dist/repo/imaging.js";
import { updateHealthDocFields } from "../dist/repo/health.js";
import { CAC_ZERO_NOTE, cardiovascularImagingOnFile, unremarkableScanDatesOnFile } from "../dist/repo/scans-on-file.js";
import { visitQuestionsRead } from "../dist/domain/health/visit-questions.js";
import { answeredScanTopics, clinicianAskVoice } from "../dist/repo/brain/clinician-ask.js";
import { weightChangeStaleness } from "../dist/repo/propagation.js";
import { recheckNote, riskReadingContext, workingForYou } from "../dist/repo/risk-context.js";
import { awaitingBrainDecisions } from "../dist/repo/brain-decisions.js";
import { localDateISO } from "../dist/repo/shared.js";
import { coachingFocus } from "../dist/repo/coaching-focus.js";

beforeEach(() =>
  resetTables(
    "imaging_study_files",
    "health_documents",
    "health_directives",
    "brain_decisions",
    "profile",
    "bodyweight_log",
    "garmin_daily_metrics",
    "garmin_sources",
    "blood_pressure_readings",
    "body_measurements",
    "attention_schedule",
    "health_reviews"
  )
);

const ARTERIES = ["Left main", "LAD", "LCx", "RCA", "PDA", "Diagonal"];

function cacStudy({ studyDate = null, issuedAt = "2026-10-30T13:05:00Z", total = 0 } = {}) {
  const perArtery = ARTERIES.flatMap((a) => [
    { name: `${a} Agatston`, value: 0 },
    { name: `${a} volume`, value: 0, unit: "mm3" },
  ]);
  return {
    imaging_study: {
      report_status: "final",
      study: {
        modality: "CT",
        raw_modality: "CT",
        procedure: "CT cardiac calcium scoring",
        study_date: studyDate,
        issued_at: issuedAt,
        interpreting_clinician: "Synthetic Reader",
      },
      anatomy: { clinical_system: "cardiovascular", body_region: "heart", laterality: "not_applicable" },
      report: { impression: `Calcium score ${total} (CAC-DRS A0); 3 mm left upper lobe nodule.` },
      findings: [
        {
          source: "mychart",
          finding_text: "Coronary artery calcium",
          clinical_system: "cardiovascular",
          body_region: "heart",
          laterality: "not_applicable",
          measurements: [
            ...perArtery,
            { name: "Agatston score Total", value: total },
            { name: "MESA percentile", value_text: "0 to 25th" },
          ],
        },
        {
          source: "mychart",
          finding_text: "3 mm nodule, left upper lobe",
          clinical_system: "pulmonary",
          body_region: "left upper lobe",
          laterality: "left",
          measurements: [{ name: "nodule size", value: 3, unit: "mm" }],
        },
      ],
      recommendations: [
        { source: "mychart", recommendation_text: "No routine follow-up if low risk (Fleischner)." },
      ],
    },
  };
}

function pastedSource() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const filePath = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.txt`);
  fs.writeFileSync(filePath, "CT CARDIAC CALCIUM SCORING (synthetic)");
  const row = repo.addHealthDocument({
    kind: "other",
    original_name: "Pasted results",
    mime: "text/plain",
    file_path: filePath,
    enrichment_status: "pending",
  });
  return { id: Number(row.id), filePath };
}

function ingestReport(sourceId, study = cacStudy(), extra = {}) {
  assert.equal(
    applyHealthIngest(sourceId, { imaging_studies_complete: true, imaging_studies: [study], ...extra }),
    true
  );
  return db.prepare("SELECT * FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging'").all(sourceId);
}

const raw = (id) => db.prepare("SELECT * FROM health_documents WHERE id = ?").get(id);

test("A1/A2: a report-only source gets a summary + the study date, and the study files under its signed date", () => {
  const { id } = pastedSource();
  const [study] = ingestReport(id);
  assert.equal(study.doc_date, "2026-10-30", "no study_date → the signed issued_at day, never 'Set date'");
  const source = raw(id);
  assert.equal(source.doc_date, "2026-10-30");
  assert.match(source.summary, /CT cardiac calcium scoring/);
  assert.match(source.summary, /Calcium score 0/);
  const parsed = JSON.parse(source.parsed_json);
  assert.equal(parsed.imaging_only, true);
  assert.deepEqual(parsed.markers, []);
  assert.equal(isImagingOnlySource(source), true);
});

test("A2: a date the person set on the study survives a re-analysis; a stated study date still wins", () => {
  const { id } = pastedSource();
  const [study] = ingestReport(id);
  updateHealthDocFields(Number(study.id), { doc_date: "2026-10-28" });
  ingestReport(id);
  assert.equal(raw(study.id).doc_date, "2026-10-28", "the hand-set date outranks the signed-date fallback");
  // A date-only issued stamp is that day, never shifted back by the zone.
  const other = pastedSource();
  const [dateOnly] = ingestReport(other.id, cacStudy({ issuedAt: "2026-09-02" }));
  assert.equal(dateOnly.doc_date, "2026-09-02");
});

test("A1: deleting the study card removes an otherwise-empty source and its file", () => {
  const { id, filePath } = pastedSource();
  const [study] = ingestReport(id);
  const result = deleteImagingStudy(Number(study.id));
  assert.equal(result.deleted, 1);
  assert.equal(result.source_deleted, 1);
  assert.equal(raw(id), undefined, "the source went with its only study");
  assert.equal(fs.existsSync(filePath), false, "the pasted file is gone too");
});

test("A1: a source that also produced markers keeps its own card and survives the study's delete", () => {
  const { id, filePath } = pastedSource();
  const [study] = ingestReport(id, cacStudy(), {
    panels: [
      {
        doc_date: "2026-10-30",
        kind: "bloodwork",
        summary: "Lipid panel",
        markers: [{ name: "ApoB", value: 95, unit: "mg/dL", flag: "high" }],
      },
    ],
  });
  const source = raw(id);
  assert.equal(isImagingOnlySource(source), false);
  assert.notEqual(JSON.parse(source.parsed_json).imaging_only, true);
  const result = deleteImagingStudy(Number(study.id));
  assert.equal(result.deleted, 1);
  assert.equal(result.source_deleted, undefined);
  assert.ok(raw(id), "the mixed source stays");
  fs.rmSync(filePath, { force: true });
});

test("A4: the coach view keeps a per-site table's total and percentile", () => {
  const { id, filePath } = pastedSource();
  ingestReport(id);
  const detail = imagingForCoach().details[0];
  const names = detail.measurements.map((m) => m.name);
  assert.ok(names.includes("Agatston score Total"), "the study-level cap keeps the total");
  assert.ok(names.includes("MESA percentile"));
  const finding = detail.findings.find((f) => /calcium/i.test(f.finding_text));
  assert.equal(finding.measurements[0].name, "Agatston score Total", "summary rows lead the finding's list");
  assert.ok(finding.measurements.length <= 5, "still bounded");
  fs.rmSync(filePath, { force: true });
});

test("B1: the cardiovascular read lists the CAC study as a dated fact and never touches a lipid finding", () => {
  repo.setProfile({ sex: "male", age: 44, height_in: 69, weight_lb: 180 });
  seedHealthDoc("2026-06-15", [
    marker("Total Cholesterol", 262, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 51, { unit: "mg/dL" }),
    marker("ApoB", 125, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 120, { unit: "nmol/L", flag: "high" }),
    marker("eGFR", 98, { unit: "mL/min" }),
    marker("Systolic BP", 112, { unit: "mmHg" }),
  ]);
  repo.deriveDirectives();
  const directives = () =>
    db.prepare("SELECT directive_key, directive, status, uncertain FROM health_directives ORDER BY id").all();
  const directivesBefore = directives();
  assert.ok(directivesBefore.length, "the lipid picture has directives to protect");
  const before = repo.cardiovascularRiskRead();
  const { id, filePath } = pastedSource();
  ingestReport(id);
  repo.deriveDirectives();
  assert.deepEqual(directives(), directivesBefore, "a CAC 0 never softens, clears or rewrites a lipid directive");
  const risk = repo.cardiovascularRiskRead();
  assert.equal(risk.imaging.length, 1);
  const cac = risk.imaging[0];
  assert.equal(cac.date, "2026-10-30");
  assert.equal(cac.procedure, "CT cardiac calcium scoring");
  assert.equal(cac.coronary_calcium.agatston_total, 0);
  assert.equal(cac.coronary_calcium.percentile, "0 to 25th");
  assert.equal(cac.note, CAC_ZERO_NOTE);
  assert.ok(risk.working_for_you.some((f) => f.key === "cac" && f.date === "2026-10-30"));
  // Never a PREVENT input, never a softened enhancer: keys AND findings are unchanged.
  assert.deepEqual(risk.enhancers, before.enhancers);
  assert.deepEqual(risk.prevent?.estimates ?? null, before.prevent?.estimates ?? null);
  fs.rmSync(filePath, { force: true });
});

test("B1: a positive calcium score states the score and percentile without a verdict", () => {
  const { id, filePath } = pastedSource();
  ingestReport(id, cacStudy({ total: 112 }));
  const [fact] = cardiovascularImagingOnFile();
  assert.equal(fact.coronary_calcium.agatston_total, 112);
  assert.equal(fact.note, "Agatston score 112 (0 to 25th percentile) on that date.");
  fs.rmSync(filePath, { force: true });
});

function seedClinicalAsk(text, daysAgo = 1) {
  return repo.recordDecision({
    effective_date: localDaysAgo(daysAgo),
    kind: "lifestyle_adjustment",
    domain: "health",
    summary: "Synthetic clinical hold",
    rationale: "Synthetic rationale.",
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "review",
    autonomy_tier: "clinician",
    risk_class: "clinical",
    reversible: true,
    context: { clinical: true },
    action: { user_explanation: text },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
}

const askTexts = () => visitQuestionsRead().questions.filter((q) => q.source === "clinical_ask").map((q) => q.text);

test("B2: a CAC topic drops out once a calcium scan is on file dated on or after the ask", () => {
  seedClinicalAsk("Consider a coronary calcium scan.");
  seedClinicalAsk("Talk about a statin and a coronary calcium scan.");
  assert.equal(askTexts().length, 2);
  const { id, filePath } = pastedSource();
  ingestReport(id, cacStudy({ studyDate: localDaysAgo(0) }));
  assert.ok(unremarkableScanDatesOnFile().has("cac"));
  assert.deepEqual(askTexts(), ["Should we talk about a statin?"], "only the unanswered topic remains");
  fs.rmSync(filePath, { force: true });
});

test("B2: a calcium scan that predates the ask leaves the question standing", () => {
  seedClinicalAsk("Consider a coronary calcium scan.");
  const { id, filePath } = pastedSource();
  ingestReport(id, cacStudy({ studyDate: localDaysAgo(30) }));
  assert.deepEqual(askTexts(), ["Should we talk about a coronary calcium (CAC) scan?"]);
  fs.rmSync(filePath, { force: true });
});

test("B2: the answered-topic table is generic and never revives a covered generic topic", () => {
  const scans = new Map([["carotid", "2026-10-20"], ["dexa", "2026-01-01"]]);
  const answered = answeredScanTopics("2026-10-10", scans);
  assert.deepEqual([...answered], ["carotid"]);
  const voice = clinicianAskVoice({ action: { user_explanation: "Get carotid ultrasound imaging." } }, answered);
  assert.equal(voice.question, null, "every topic answered → no question, and 'imaging' does not resurface");
  const dexa = clinicianAskVoice({ action: { user_explanation: "Repeat the DEXA scan." } }, answered);
  assert.equal(dexa.question, "Should we talk about a DEXA scan?");
});

test("C1/C2/C3: VO2max falls back to the watch, one body-fat source, a reached target is not a lever, ages side by side", () => {
  repo.setProfile({ sex: "male", age: 44, height_in: 69, weight_lb: 165, smoking: 0, bp_treated: 0, statin: 0 });
  // A DEXA anchor: 23% body fat. Tape measurements would read much leaner — the
  // DEXA is the one source both the standing and the risk read use.
  db.prepare(
    `INSERT INTO body_measurements (date, waist_in, neck_in, hip_in, source) VALUES (?, 31, 16, 36, 'manual')`
  ).run(localDaysAgo(2));
  seedHealthDoc(localDaysAgo(10), [
    marker("Body Fat %", 23, { unit: "%" }),
    marker("Visceral fat", 1.5, { unit: "lb" }),
  ], "dexa");
  seedHealthDoc(localDaysAgo(10), [
    marker("Total Cholesterol", 262, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 51, { unit: "mg/dL" }),
    marker("eGFR", 98, { unit: "mL/min" }),
    marker("Systolic BP", 99, { unit: "mmHg" }),
    marker("HbA1c", 5.2, { unit: "%" }),
  ]);
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','risk-test')`).run();
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, vo2max, fitness_age) VALUES (?, ?, 48.4, 38)`
  ).run(src.lastInsertRowid, localDaysAgo(1));

  const risk = repo.cardiovascularRiskRead();
  const standing = repo.healthStanding();
  assert.equal(risk.inputs.markers.vo2max.value, 48.4, "the watch's VO2max reaches the risk read");
  assert.ok(risk.inputs.markers.vo2max.source);
  const standingVo2 = standing.comparisons.find((c) => c.key === "vo2max");
  assert.equal(standingVo2.value, 48.4);
  const standingBf = standing.comparisons.find((c) => c.key === "body_fat_pct");
  assert.equal(risk.inputs.body_fat_pct, standingBf.value, "one body-fat source for both reads");
  assert.ok(risk.inputs.body_fat_date);
  // VO2max 48.4 is past the 42 target: never a lever pointing backwards.
  assert.ok(!risk.projections.some((p) => p.key === "vo2max"));
  for (const p of risk.projections) {
    if (p.current == null) continue;
    assert.ok(p.expected_direction === "lower" ? p.current > p.target : p.current < p.target, p.key);
  }
  assert.ok(!risk.enhancers.some((e) => e.key === "vo2max"));

  const vascular = risk.ages.find((a) => a.key === "vascular");
  assert.equal(vascular.value, Math.round(risk.prevent.vascular_age), "PREVENT's age, unadjusted");
  assert.match(vascular.reads, /does not see fitness/);
  assert.equal(vascular.date, localDaysAgo(10));
  const fitness = risk.ages.find((a) => a.key === "fitness");
  assert.ok(fitness && fitness.value === standingVo2.equivalent_age, "the FRIEND equivalent age, reused");
  assert.match(fitness.source, /FRIEND/);

  // C4: what is working, each dated.
  const working = Object.fromEntries(risk.working_for_you.map((f) => [f.key, f]));
  assert.ok(working.vo2max, "VO2max strong for age");
  assert.match(working.vo2max.finding, /fitter than \d+% of men your age/);
  assert.ok(working.visceral_fat, "low visceral fat on the DEXA");
  for (const f of risk.working_for_you) assert.doesNotMatch(f.finding, /\/\s*100|\bgrade\b|\bscore\b(?! 0)/i);
});

test("C5: a lab drawn before a material weight change says a fresh panel would show where you are now", () => {
  const drawn = localDaysAgo(140);
  const weights = [
    { date: localDaysAgo(141), weight_lb: 196 },
    { date: localDaysAgo(60), weight_lb: 182 },
    { date: localDaysAgo(1), weight_lb: 168 },
  ];
  const lipid = weightChangeStaleness("Total cholesterol", drawn, weights);
  assert.equal(lipid.stale, true);
  assert.equal(lipid.delta_lb, -28);
  assert.match(lipid.reason, /down ~28 lb/);
  assert.match(lipid.reason, /fresh panel would show where you are now/);
  for (const name of ["ApoB", "HbA1c", "hs-CRP", "ALT", "bloodwork age"]) {
    assert.equal(weightChangeStaleness(name, drawn, weights).stale, true, name);
  }
  // Lp(a) is genetic: weight never moves it.
  assert.equal(weightChangeStaleness("Lp(a)", drawn, weights).stale, false);
  // A small drift is not material.
  const steady = [{ date: localDaysAgo(141), weight_lb: 180 }, { date: localDaysAgo(1), weight_lb: 178 }];
  assert.equal(weightChangeStaleness("Total cholesterol", drawn, steady).stale, false);
  // The body-comp row keeps its own wording (bodyCompStaleness is unchanged).
  assert.match(weightChangeStaleness("Body fat", drawn, weights).reason, /fresh scan would confirm/);
  // Past the validity window, the class's own aging clause speaks first.
  const old = recheckNote("hs-CRP", localDaysAgo(400), steady);
  assert.match(old, /snapshot|re-test/);
  assert.equal(recheckNote("Total cholesterol", localDaysAgo(20), weights), null, "a recent draw stands");
});


// ---- review fixes ------------------------------------------------------------

function directStudy(date, { procedure = "CT cardiac calcium scoring", system = "cardiovascular", region = "heart", impression = "", rows = [], findings = null, recommendations = [] } = {}) {
  return repo.addHealthDocument({
    kind: "imaging",
    doc_date: date,
    summary: impression || procedure,
    enrichment_status: "done",
    parsed_json: {
      imaging_study: {
        schema_version: 1,
        report_status: "final",
        study: { modality: "CT", procedure, study_date: date },
        anatomy: { clinical_system: system, body_region: region },
        report: { impression },
        findings: findings ?? (rows.length
          ? [{ source: "mychart", finding_text: "Coronary artery calcium", clinical_system: system, body_region: region, measurements: rows }]
          : []),
        recommendations,
        provenance: { record_status: "current" },
      },
    },
  });
}

test("only the newest calcium result is working for you, and a volume row is never the score", () => {
  directStudy("2020-01-10", { rows: [{ name: "Agatston score Total", value: 0 }], impression: "Calcium score 0" });
  directStudy("2026-09-01", {
    rows: [
      { name: "Total calcium volume", value: 45, unit: "mm3" },
      { name: "Calcium mass", value: 9, unit: "mg" },
      { name: "Total Agatston score", value: 38 },
    ],
    impression: "Calcium score 38",
  });
  const facts = cardiovascularImagingOnFile();
  assert.equal(facts[0].date, "2026-09-01");
  assert.equal(facts[0].coronary_calcium.agatston_total, 38, "the volume and mass rows are skipped");
  assert.equal(facts[1].coronary_calcium.agatston_total, 0);
  const working = workingForYou(riskReadingContext({ sex: "male", age: 50 }, 50), { sex: "male" });
  assert.ok(!working.some((f) => f.key === "cac"), "an old zero never stands in for a newer positive score");
});

test("a newest calcium zero is working for you, with a slow-class recheck line once it is old", () => {
  directStudy(localDaysAgo(800), { rows: [{ name: "Agatston score Total", value: 0 }] });
  const cac = workingForYou(riskReadingContext({ sex: "male", age: 50 }, 50), { sex: "male" }).find((f) => f.key === "cac");
  assert.ok(cac);
  assert.match(cac.recheck ?? "", /months old/, "past the slow class's window, the aging clause speaks");
});

test("scan matching reads what a study IS, never its impression prose", () => {
  directStudy("2026-10-20", {
    procedure: "Transthoracic echocardiogram",
    impression: "Normal LV function. Consider coronary artery calcium scoring for risk stratification.",
  });
  directStudy("2026-10-21", {
    procedure: "Abdominal ultrasound",
    system: "gastrointestinal",
    region: "abdomen",
    impression: "Cholelithiasis. The abdominal aorta is normal in caliber.",
  });
  directStudy("2026-10-22", { procedure: "CT chest", system: "pulmonary", region: "chest", impression: "Cardiac size normal." });
  const scans = unremarkableScanDatesOnFile();
  assert.equal(scans.has("cac"), false, "an echo suggesting a calcium scan is not one");
  assert.equal(scans.get("echo"), "2026-10-20");
  const listed = cardiovascularImagingOnFile().map((f) => f.procedure);
  assert.deepEqual(listed, ["Transthoracic echocardiogram"], "prose about the aorta or heart size lists nothing");
  const voice = clinicianAskVoice(
    { action: { user_explanation: "Consider a coronary calcium scan." } },
    answeredScanTopics("2026-10-10", scans)
  );
  assert.equal(voice.question, "Should we talk about a coronary calcium (CAC) scan?");
});

test("a positive or abnormal result keeps the scan question; a person-set date wins", () => {
  directStudy("2026-10-20", { rows: [{ name: "Agatston score Total", value: 112 }] });
  directStudy("2026-10-21", {
    procedure: "Carotid duplex ultrasound",
    region: "neck",
    findings: [{ source: "mychart", finding_text: "Mild plaque, left bulb", severity: "mild", clinical_system: "cardiovascular", body_region: "neck", measurements: [] }],
  });
  directStudy("2026-10-22", {
    procedure: "Transthoracic echocardiogram",
    recommendations: [{ source: "mychart", recommendation_text: "Repeat echo in 12 months", status: "recommended" }],
  });
  const scans = unremarkableScanDatesOnFile();
  assert.deepEqual([...scans.keys()], [], "a score of 112, a mild plaque, an open follow-up each answer nothing");
  // The person's own date on the record outranks the report's study date.
  const row = directStudy("2026-10-01", { procedure: "Carotid duplex ultrasound", region: "neck", impression: "No plaque." });
  updateHealthDocFields(Number(row.id), { doc_date: "2026-10-25" });
  assert.equal(unremarkableScanDatesOnFile().get("carotid"), "2026-10-25");
});

test("an answered scan leaves its phrase, so another scan named beside it still asks", () => {
  const answered = new Set(["cac"]);
  assert.equal(
    clinicianAskVoice({ action: { user_explanation: "Get a coronary calcium scan and a knee MRI." } }, answered).question,
    "Should we talk about imaging?",
    "the MRI is not lost with the answered CAC"
  );
  assert.equal(
    clinicianAskVoice({ action: { user_explanation: "Get a coronary calcium scan." } }, answered).question,
    null
  );
});

test("visit questions are a pure read", () => {
  seedClinicalAsk("Consider a coronary calcium scan.");
  const { id, filePath } = pastedSource();
  ingestReport(id, cacStudy({ studyDate: localDaysAgo(0) }));
  const changes = () => db.prepare("SELECT total_changes() AS n").get().n;
  const before = changes();
  awaitingBrainDecisions(20);
  assert.equal(changes(), before, "the scan read writes nothing");
  fs.rmSync(filePath, { force: true });
});

test("a person-set source date and summary survive the ingest; a re-ingest keeps them", () => {
  const { id, filePath } = pastedSource();
  updateHealthDocFields(id, { doc_date: "2026-10-29" });
  ingestReport(id);
  assert.equal(raw(id).doc_date, "2026-10-29", "the person's date on the upload stays");
  db.prepare("UPDATE health_documents SET summary = ? WHERE id = ?").run("My own note", id);
  ingestReport(id);
  assert.equal(raw(id).summary, "My own note", "a summary this pass did not write is never overwritten");
  fs.rmSync(filePath, { force: true });
});

test("a real midnight-UTC timestamp is read in the local zone; a bare date is that day", () => {
  const a = pastedSource();
  const [stamp] = ingestReport(a.id, cacStudy({ issuedAt: "2026-09-02T00:00:00Z" }));
  assert.equal(stamp.doc_date, localDateISO(new Date("2026-09-02T00:00:00Z")));
  const b = pastedSource();
  const [bare] = ingestReport(b.id, cacStudy({ issuedAt: "2026-09-02" }));
  assert.equal(bare.doc_date, "2026-09-02");
  fs.rmSync(a.filePath, { force: true });
  fs.rmSync(b.filePath, { force: true });
});

test("a sibling study (current or superseded) keeps the source alive on delete", () => {
  const { id, filePath } = pastedSource();
  const second = cacStudy({ studyDate: "2026-08-01" });
  second.imaging_study.study.procedure = "MRI knee";
  second.imaging_study.anatomy = { clinical_system: "musculoskeletal", body_region: "knee", laterality: "left" };
  const rows = ingestReport(id, cacStudy({ studyDate: "2026-10-30" }), {});
  applyHealthIngest(id, { imaging_studies_complete: true, imaging_studies: [cacStudy({ studyDate: "2026-10-30" }), second] });
  const both = db.prepare("SELECT id FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging' ORDER BY id").all(id);
  assert.equal(both.length, 2);
  assert.equal(deleteImagingStudy(Number(both[1].id)).source_deleted, undefined, "a current sibling keeps it");
  assert.ok(raw(id));
  // Supersede the remaining one with a complete list that omits it, then delete the new current study.
  applyHealthIngest(id, { imaging_studies_complete: true, imaging_studies: [second] });
  const current = db
    .prepare("SELECT id FROM health_documents WHERE source_doc_id = ? AND kind = 'imaging' ORDER BY id DESC LIMIT 1")
    .get(id);
  assert.notEqual(Number(current.id), Number(rows[0].id));
  assert.equal(deleteImagingStudy(Number(current.id)).source_deleted, undefined, "a superseded sibling is audit history");
  assert.ok(raw(id));
  fs.rmSync(filePath, { force: true });
});

test("a source deleted mid-ingest never gets a derived study", () => {
  const { id, filePath } = pastedSource();
  db.prepare("DELETE FROM health_documents WHERE id = ?").run(id);
  assert.equal(applyHealthIngest(id, { imaging_studies_complete: true, imaging_studies: [cacStudy()] }), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_documents WHERE source_doc_id = ?").get(id).n, 0);
  fs.rmSync(filePath, { force: true });
});

function seedWatchVo2(value) {
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','vo2-test')`).run();
  db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, vo2max) VALUES (?, ?, ?)`).run(
    src.lastInsertRowid,
    localDaysAgo(1),
    value
  );
}

test("VO2max 'below target' is age- and sex-aware, and a lone watch VO2max never flips the conductor", () => {
  // 38 is under the old fixed 42, but strong for a man in his 50s.
  repo.setProfile({ sex: "male", age: 55, height_in: 69, weight_lb: 170 });
  seedWatchVo2(38);
  const strong = repo.cardiovascularRiskRead();
  assert.ok(!strong.enhancers.some((e) => e.key === "vo2max"));
  assert.ok(!strong.projections.some((p) => p.key === "vo2max"), "already past the age-band target");
  const plateau = {
    goalMode: "maintain",
    groupsTrajectory: {
      groups: [{ verdict: "stalling", label: "Shoulders", lead_lift: "Overhead Press", stalled_signal: "flat 4 wks", vary_options: [{ name: "Push Press" }] }],
    },
  };
  const without = coachingFocus({ ...plateau, cardioRisk: null });
  const withRead = coachingFocus({ ...plateau, cardioRisk: strong });
  assert.equal(withRead.lead.title, without.lead.title, "the lead does not move");
  assert.ok(![withRead.lead, ...withRead.parallel].some((x) => /cardiovascular/i.test(x.title)), "nothing to say");

  // A genuinely low watch VO2max for the age band names the lever, but only as a parallel note.
  resetTables("garmin_daily_metrics", "garmin_sources");
  seedWatchVo2(24);
  const low = repo.cardiovascularRiskRead();
  assert.ok(low.enhancers.some((e) => e.key === "vo2max"));
  const out = coachingFocus({ ...plateau, cardioRisk: low });
  assert.equal(out.lead.title, without.lead.title, "a lone enhancer never takes the lead");
});
