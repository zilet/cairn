import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { runWithTimeZone } from "../dist/tz.js";
import { marker, repo, resetTables, seedHealthDoc } from "./_seed.js";

beforeEach(() => {
  resetTables("blood_pressure_readings", "health_documents", "health_directives");
});

test("bpRead interprets the latest reading and surfaces an improving trend", () => {
  repo.addBloodPressureReading({ measured_at: "2026-02-24T08:00", systolic: 125, diastolic: 78 });
  repo.addBloodPressureReading({ measured_at: "2026-03-10T08:00", systolic: 144, diastolic: 87 });
  repo.addBloodPressureReading({ measured_at: "2026-03-11T08:00", systolic: 113, diastolic: 75 });
  const read = repo.bpRead(repo.listBloodPressureReadings(12));
  assert.equal(read.category, "optimal");
  assert.equal(read.tone, "strong");
  assert.equal(read.trajectory.dir, "improving");
  assert.equal(read.trajectory.from.systolic, 144);
  assert.equal(read.trajectory.to.systolic, 113);
  assert.match(read.read, /down from 144\/87/);
});

test("bpRead flags an elevated reading without alarm", () => {
  repo.addBloodPressureReading({ measured_at: "2026-06-24T08:00", systolic: 134, diastolic: 86 });
  const read = repo.bpRead(repo.listBloodPressureReadings(12));
  assert.equal(read.category, "high");
  assert.equal(read.tone, "watch");
  assert.equal(read.trajectory, null);
});

test("manual BP readings are stored as point-in-time vitals and projected into markers", () => {
  const row = repo.addBloodPressureReading({
    measured_at: "2026-06-24T07:15",
    systolic: 128,
    diastolic: 78,
    pulse: 62,
    position: "seated",
  });
  assert.equal(row.measured_at, "2026-06-24 07:15:00");

  const rows = repo.listBloodPressureReadings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].systolic, 128);
  assert.equal(rows[0].pulse, 62);

  const { markers } = repo.getMarkerHistory();
  const sys = markers.find((m) => m.name === "Systolic BP");
  const dia = markers.find((m) => m.name === "Diastolic BP");
  const pulse = markers.find((m) => m.name === "Pulse");
  assert.ok(sys, "systolic BP appears as a marker");
  assert.ok(dia, "diastolic BP appears as a marker");
  assert.ok(pulse, "pulse appears as a marker when present");
  assert.equal(sys.latest.value, 128);
  assert.equal(dia.latest.value, 78);
  assert.equal(pulse.latest.value, 62);
  assert.equal(sys.group, "vitals");
  assert.equal(dia.group, "vitals");
  assert.equal(sys.latest.kind, "vitals");
});

test("imported MyChart-style BP strings split into systolic and diastolic markers", () => {
  seedHealthDoc("2026-06-20", [marker("Blood Pressure", "134/82", { unit: "mmHg" })], "other");
  const { markers } = repo.getMarkerHistory();
  const sys = markers.find((m) => m.name === "Systolic BP");
  const dia = markers.find((m) => m.name === "Diastolic BP");

  assert.ok(sys, "systolic marker created from 134/82");
  assert.ok(dia, "diastolic marker created from 134/82");
  assert.equal(sys.latest.value, 134);
  assert.equal(dia.latest.value, 82);
  assert.equal(sys.unit, "mmHg");
  assert.equal(dia.unit, "mmHg");
});

test("fallback BP timestamp uses the active device timezone for date and time", () => {
  const instant = new Date("2026-06-24T03:15:00Z");
  const measuredAt = runWithTimeZone("America/Los_Angeles", () => repo.normalizeBpMeasuredAt(null, instant));
  assert.equal(measuredAt, "2026-06-23 20:15:00");
});

test("BP readings participate in connected-brain directive derivation", () => {
  repo.addBloodPressureReading({
    measured_at: "2026-06-24T07:15",
    systolic: 138,
    diastolic: 84,
  });

  const out = repo.deriveDirectives();
  const markers = out.directives.map((d) => d.marker);
  assert.ok(markers.includes("Systolic BP") || markers.includes("Diastolic BP"));
});

test("BP validation rejects implausible or inverted readings", () => {
  assert.throws(
    () => repo.addBloodPressureReading({ systolic: 78, diastolic: 90 }),
    /diastolic must be below systolic/
  );
  assert.throws(
    () => repo.addBloodPressureReading({ systolic: 310, diastolic: 90 }),
    /systolic and diastolic BP required/
  );
});
