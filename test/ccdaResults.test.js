import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { inOwnerTimeZone } from "../dist/enrich.js";

// A synthetic MyChart-shaped CCDA export. Two documents (two encounter
// summaries) repeat the SAME lipid battery — the dedupe case — while the second
// adds a metabolic panel, an imaging narrative and a near-midnight draw.
const LIPID_BATTERY = `
      <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
        <code code="24331-1" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"><originalText>LIPID PANEL</originalText></code>
        <statusCode code="completed"/>
        <effectiveTime><low value="20260824120400+0000"/><high value="20260824120400+0000"/></effectiveTime>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2093-3" codeSystem="2.16.840.1.113883.6.1" displayName="Cholesterol"><originalText>CHOLESTEROL</originalText></code>
          <effectiveTime value="20260824120400+0000"/>
          <value xsi:type="PQ" value="262" unit="mg/dL"/>
          <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/>
          <referenceRange><observationRange><text>0 - 239</text><value xsi:type="IVL_PQ"><low value="0" unit="mg/dL"/><high value="239" unit="mg/dL"/></value></observationRange></referenceRange>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2085-9" codeSystem="2.16.840.1.113883.6.1"><originalText>HIGH DENSITY LIPOPROTEIN</originalText></code>
          <effectiveTime value="20260824120400+0000"/>
          <value xsi:type="PQ" value="41" unit="mg/dL"/>
          <interpretationCode code="N" codeSystem="2.16.840.1.113883.5.83"/>
          <referenceRange><observationRange><text>40-</text><value xsi:type="IVL_PQ"><low value="40" unit="mg/dL"/></value></observationRange></referenceRange>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="18262-6" codeSystem="2.16.840.1.113883.6.1"><originalText>LOW DENSITY LIPOPROTEIN DIRECT</originalText></code>
          <effectiveTime value="20260824120400+0000"/>
          <value xsi:type="PQ" value="188" unit="mg/dL"/>
          <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="9830-1" codeSystem="2.16.840.1.113883.6.1"><originalText>CHOL/HDL RATIO</originalText></code>
          <effectiveTime value="20260824120400+0000"/>
          <value xsi:type="CD" nullFlavor="UNK"/>
        </observation></component>
      </organizer></entry>`;

function resultsSection(body) {
  return `<component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="RESULTS"/>
      <title>Results</title>
      <text>Rendered narrative the agent may read.</text>
      ${body}
    </section></component>`;
}

function doc(body) {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <component><structuredBody>
    ${body}
  </structuredBody></component>
</ClinicalDocument>`;
}

// 23:30 on 2026-02-23 in a -05:00 zone. The naive "first ten characters of the
// UTC instant" reading would file this on the 24th.
const NEAR_MIDNIGHT_STAMP = "20260223233000-0500";
const NEAR_MIDNIGHT_DATE = localDateISO(new Date(Date.parse("2026-02-23T23:30:00-05:00")));

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ccda-results-"));
  fs.mkdirSync(path.join(dir, "IHE_XDM", "SUBSET01"), { recursive: true });
  const base = path.join(dir, "IHE_XDM", "SUBSET01");
  fs.writeFileSync(path.join(base, "DOC0001.XML"), doc(resultsSection(LIPID_BATTERY)));
  fs.writeFileSync(
    path.join(base, "DOC0002.XML"),
    doc(
      resultsSection(`${LIPID_BATTERY}
      <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
        <code code="24323-8" codeSystem="2.16.840.1.113883.6.1"><originalText>COMPREHENSIVE METABOLIC PANEL</originalText></code>
        <statusCode code="completed"/>
        <effectiveTime><low value="${NEAR_MIDNIGHT_STAMP}"/></effectiveTime>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2951-2" codeSystem="2.16.840.1.113883.6.1"><originalText>SODIUM</originalText></code>
          <effectiveTime value="${NEAR_MIDNIGHT_STAMP}"/>
          <value xsi:type="PQ" value="140" unit="mmol/L"/>
          <interpretationCode code="N" codeSystem="2.16.840.1.113883.5.83"/>
          <referenceRange><observationRange><text>136 - 145</text><value xsi:type="IVL_PQ"><low value="136" unit="mmol/L"/><high value="145" unit="mmol/L"/></value></observationRange></referenceRange>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2823-3" codeSystem="2.16.840.1.113883.6.1"><originalText>POTASSIUM</originalText></code>
          <effectiveTime value="${NEAR_MIDNIGHT_STAMP}"/>
          <value xsi:type="PQ" value="3.1" unit="mmol/L"/>
          <interpretationCode code="L" codeSystem="2.16.840.1.113883.5.83"/>
          <referenceRange><observationRange><text>3.5 - 5.1</text><value xsi:type="IVL_PQ"><low value="3.5" unit="mmol/L"/><high value="5.1" unit="mmol/L"/></value></observationRange></referenceRange>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2345-7" codeSystem="2.16.840.1.113883.6.1"><originalText>GLUCOSE</originalText></code>
          <effectiveTime value="${NEAR_MIDNIGHT_STAMP}"/>
          <value xsi:type="PQ" value="171" unit="mg/dL"/>
          <interpretationCode code="A" codeSystem="2.16.840.1.113883.5.83"/>
          <referenceRange><observationRange><text>70 - 99</text><value xsi:type="IVL_PQ"><low value="70" unit="mg/dL"/><high value="99" unit="mg/dL"/></value></observationRange></referenceRange>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="5778-6" codeSystem="2.16.840.1.113883.6.1"><originalText>APPEARANCE</originalText></code>
          <effectiveTime value="${NEAR_MIDNIGHT_STAMP}"/>
          <value xsi:type="ST">Clear</value>
        </observation></component>
      </organizer></entry>
      <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
        <code code="36643-5" codeSystem="2.16.840.1.113883.6.1"><originalText>XR Chest 2 views</originalText></code>
        <effectiveTime><low value="20260824120400+0000"/></effectiveTime>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="18748-4" codeSystem="2.16.840.1.113883.6.1"><originalText>Radiology Report</originalText></code>
          <effectiveTime value="20260824120400+0000"/>
          <value xsi:type="ED">IMPRESSION: No acute cardiopulmonary process.</value>
        </observation></component>
      </organizer></entry>`)
    )
  );
  // Bundle noise the reader must ignore.
  fs.writeFileSync(path.join(base, "STYLE.XSL"), "<xsl:stylesheet/>");
  return dir;
}

test("CCDA results extraction reads batteries, flags, ranges and dates deterministically", () => {
  const dir = writeFixture();
  try {
    const extracted = repo.extractCcdaHealthData(dir);
    const panels = extracted.results_panels;
    assert.equal(panels.length, 2, "one panel per collection date");

    const lipid = panels.find((p) => p.doc_date === "2026-08-24");
    assert.ok(lipid, "lipid panel filed on its collection date");
    // The SAME battery appears in both documents — deduped to one set of markers.
    assert.equal(lipid.markers.length, 3);
    assert.equal(lipid.summary, "Lipid Panel");

    const chol = lipid.markers.find((m) => m.loinc === "2093-3");
    assert.equal(chol.name, "Total Cholesterol");
    assert.equal(chol.source_name, "CHOLESTEROL");
    assert.equal(chol.value, 262);
    assert.equal(chol.unit, "mg/dL");
    assert.equal(chol.flag, "high");
    assert.equal(chol.ref_low, 0);
    assert.equal(chol.ref_high, 239);

    // Verbatim MyChart order names resolve through their LOINC code, so they land
    // on the same series the rest of the app already keys on.
    const hdl = lipid.markers.find((m) => m.loinc === "2085-9");
    assert.equal(hdl.name, "HDL Cholesterol");
    assert.equal(hdl.flag, "normal");
    assert.equal(hdl.ref_low, 40);
    assert.equal(hdl.ref_high, null, "a one-sided range keeps the other bound null");
    const ldl = lipid.markers.find((m) => m.loinc === "18262-6");
    assert.equal(ldl.name, "LDL-C (Direct)");
    assert.equal(ldl.ref_low, null);
    assert.equal(ldl.ref_high, null);
    // A nullFlavor value is not a result.
    assert.equal(lipid.markers.some((m) => m.loinc === "9830-1"), false);

    // The offset-carrying near-midnight draw is filed on the app's local day.
    const cmp = panels.find((p) => p.doc_date === NEAR_MIDNIGHT_DATE);
    assert.ok(cmp, `CMP filed on ${NEAR_MIDNIGHT_DATE}`);
    assert.equal(cmp.summary, "Comprehensive Metabolic Panel");
    assert.equal(cmp.markers.find((m) => m.loinc === "2823-3").flag, "low");
    // "A" is not in the marker vocabulary; the printed range settles the direction.
    assert.equal(cmp.markers.find((m) => m.loinc === "2345-7").flag, "high");
    const appearance = cmp.markers.find((m) => m.source_name === "APPEARANCE");
    assert.equal(appearance.value, "Clear");
    assert.equal(appearance.unit, null);

    // The imaging narrative stays the agent's job.
    assert.equal(
      panels.some((p) => p.markers.some((m) => /radiology/i.test(m.source_name))),
      false
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings");
  }
});

test("CCDA results backfill writes typed panels and is idempotent on re-run", () => {
  const dir = writeFixture();
  try {
    const source = repo.addHealthDocument({
      kind: "clinical_summary",
      original_name: "health_summary_mychart.zip",
      mime: "application/zip",
      enrichment_status: "done",
    });
    const extracted = repo.extractCcdaHealthData(dir);
    const first = repo.applyCcdaHealthBackfill(source.id, extracted);
    assert.equal(first.resultPanels, 2);
    assert.equal(first.resultMarkers, 7);
    assert.equal(first.wrote, true);

    const second = repo.applyCcdaHealthBackfill(source.id, extracted);
    assert.equal(second.resultPanels, 2);

    const rows = db
      .prepare(`SELECT * FROM health_documents WHERE source_doc_id = ?`)
      .all(source.id)
      .map((r) => ({ ...r, parsed: JSON.parse(r.parsed_json) }));
    const resultRows = rows.filter((r) => r.parsed.type === repo.CCDA_RESULTS_TYPE);
    assert.equal(resultRows.length, 2, "a re-run replaces its own stream rather than duplicating it");
    assert.equal(resultRows.every((r) => r.kind === "bloodwork"), true);
    // The lab's printed range survives into storage, where getMarkerHistory reads it.
    const stored = resultRows
      .flatMap((r) => r.parsed.markers)
      .find((m) => m.name === "Total Cholesterol");
    assert.equal(stored.ref_high, 239);

    const history = repo.getMarkerHistory();
    const series = history.markers.find((h) => /total cholesterol/i.test(h.name));
    assert.ok(series, "deterministic results reach the marker history");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings");
  }
});

test("an agent panel for the same date keeps only what the deterministic read missed", () => {
  const dir = writeFixture();
  try {
    const source = repo.addHealthDocument({
      kind: "clinical_summary",
      original_name: "health_summary_mychart.zip",
      mime: "application/zip",
      enrichment_status: "done",
    });
    // What the agent produced for the same collection date: one analyte the CCDA
    // already carries (under a different printed name) and one it does not.
    repo.replaceHealthPanels(
      source.id,
      [
        {
          doc_date: "2026-08-24",
          kind: "bloodwork",
          summary: "Lipids read from the PDF.",
          markers: [
            { name: "HDL-C", value: 41, unit: "mg/dL", flag: "normal" },
            { name: "Lipoprotein (a)", value: 180, unit: "nmol/L", flag: "high" },
          ],
        },
      ],
      "health_summary_mychart.zip"
    );

    const extracted = repo.extractCcdaHealthData(dir);
    repo.applyCcdaHealthBackfill(source.id, extracted);

    const rows = db
      .prepare(`SELECT * FROM health_documents WHERE source_doc_id = ?`)
      .all(source.id)
      .map((r) => JSON.parse(r.parsed_json));
    const agentPanel = rows.find((p) => p.type !== repo.CCDA_RESULTS_TYPE && p.type !== repo.CCDA_VITALS_TYPE);
    const names = agentPanel.markers.map((m) => m.name);
    assert.deepEqual(names, ["Lipoprotein (a)"], "the duplicated analyte steps aside; the rest stays");

    const determined = rows.filter((p) => p.type === repo.CCDA_RESULTS_TYPE).flatMap((p) => p.markers);
    assert.equal(determined.filter((m) => m.name === "HDL Cholesterol").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings");
  }
});

test("a CCDA timestamp is converted through its offset, not sliced", () => {
  // Same instant, three ways of printing it — one local calendar day.
  const expected = localDateISO(new Date(Date.parse("2026-02-24T04:30:00Z")));
  assert.equal(repo.ccdaLocalDate("20260223233000-0500"), expected);
  assert.equal(repo.ccdaLocalDate("20260224043000+0000"), expected);
  assert.equal(repo.ccdaLocalDate("20260224043000Z"), expected);
  // A date with no clock (or no zone to anchor one) is taken as printed.
  assert.equal(repo.ccdaLocalDate("20260224"), "2026-02-24");
  assert.equal(repo.ccdaLocalDate("20260224043000"), "2026-02-24");
  assert.equal(repo.ccdaLocalDate("not a stamp"), null);
  assert.equal(repo.ccdaLocalDate(null), null);
});

// ---------- one analyte, amended ----------

function lipidBattery(cholValue, stamp) {
  return `
      <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
        <code code="24331-1" codeSystem="2.16.840.1.113883.6.1"><originalText>LIPID PANEL</originalText></code>
        <effectiveTime><low value="${stamp}"/></effectiveTime>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2093-3" codeSystem="2.16.840.1.113883.6.1"><originalText>CHOLESTEROL</originalText></code>
          <effectiveTime value="${stamp}"/>
          <value xsi:type="PQ" value="${cholValue}" unit="mg/dL"/>
          <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2085-9" codeSystem="2.16.840.1.113883.6.1"><originalText>HIGH DENSITY LIPOPROTEIN</originalText></code>
          <effectiveTime value="${stamp}"/>
          <value xsi:type="PQ" value="41" unit="mg/dL"/>
        </observation></component>
      </organizer></entry>`;
}

test("an AMENDED repeat of one analyte on one date is one marker, and it is the later value", () => {
  // The same battery arrives in two exported documents and the lab has since
  // corrected (or merely re-rounded) a value. Keying the dedupe on the VALUE made
  // the two readings two different markers, so the panel showed the athlete both
  // 262 and 258 for one draw.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ccda-amended-"));
  const base = path.join(dir, "IHE_XDM", "SUBSET01");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "DOC0001.XML"), doc(resultsSection(lipidBattery(262, "20260824120400+0000"))));
  // Same collection DAY, later observation instant — the amendment.
  fs.writeFileSync(path.join(base, "DOC0002.XML"), doc(resultsSection(lipidBattery(258, "20260824154500+0000"))));
  try {
    const panels = repo.extractCcdaHealthData(dir).results_panels;
    assert.equal(panels.length, 1, "one collection date, one panel");
    const lipid = panels[0];
    const chol = lipid.markers.filter((m) => m.loinc === "2093-3");
    assert.equal(chol.length, 1, "one analyte, one row — not one row per printed value");
    assert.equal(chol[0].value, 258, "the later observation is the amendment, and it wins");
    assert.equal(lipid.markers.filter((m) => m.loinc === "2085-9").length, 1, "the unchanged analyte is still deduped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings");
  }
});

test("an EARLIER duplicate never overwrites the amendment, whatever order the files arrive in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ccda-amended-order-"));
  const base = path.join(dir, "IHE_XDM", "SUBSET01");
  fs.mkdirSync(base, { recursive: true });
  // The amended reading FIRST this time; the stale one must not win by being last.
  fs.writeFileSync(path.join(base, "DOC0001.XML"), doc(resultsSection(lipidBattery(258, "20260824154500+0000"))));
  fs.writeFileSync(path.join(base, "DOC0002.XML"), doc(resultsSection(lipidBattery(262, "20260824120400+0000"))));
  try {
    const lipid = repo.extractCcdaHealthData(dir).results_panels[0];
    const chol = lipid.markers.filter((m) => m.loinc === "2093-3");
    assert.equal(chol.length, 1);
    assert.equal(chol[0].value, 258);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetTables("health_documents", "blood_pressure_readings");
  }
});

test("background enrichment reads a CCDA date in the OWNER's zone, not the container's", () => {
  // ccdaLocalDate ends in localDateISO(), which reads the AsyncLocalStorage device
  // zone — and the enrichment queue drains outside any request, so on a UTC
  // container a 23:30-05:00 draw used to file on the next day. The drain now opens
  // the same owner-zone scope the scheduler opens around its ticks.
  const previous = repo.recordedClientTimeZone();
  repo.recordClientTimeZone("America/New_York");
  try {
    assert.equal(repo.recordedClientTimeZone(), "America/New_York");
    // A 23:30 draw in the owner's own zone — winter (EST, -0500) and summer
    // (EDT, -0400), so the reading is DST-correct rather than offset-literal.
    assert.equal(
      inOwnerTimeZone(() => repo.ccdaLocalDate("20260223233000-0500")),
      "2026-02-23",
      "a late-evening winter draw stays on its own evening"
    );
    assert.equal(
      inOwnerTimeZone(() => repo.ccdaLocalDate("20260824233000-0400")),
      "2026-08-24",
      "and a late-evening summer draw does too"
    );
    // The same instant printed as UTC lands on the same local day.
    assert.equal(inOwnerTimeZone(() => repo.ccdaLocalDate("20260825033000Z")), "2026-08-24");

    // The proof that the zone is doing the work: an owner in Tokyo files the very
    // same instant on the NEXT day, and neither answer is the container's.
    repo.recordClientTimeZone("Asia/Tokyo");
    assert.equal(inOwnerTimeZone(() => repo.ccdaLocalDate("20260824233000-0400")), "2026-08-25");
  } finally {
    if (previous) repo.recordClientTimeZone(previous);
  }
});
