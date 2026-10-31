// The words an imaging card speaks: stored keys read as plain words, measurement
// lines that keep their 0, the procedure title and the one line a study leads
// with. String helpers shared (one global scope, called at render time) by
// imaging-client.ts; every caller escapes what it renders.

type ImagingWordsStudy = import("../contracts/client-api.js").ClientImagingStudy;

// Values that carry no information for a person: printing "Not applicable" or
// "Unsorted imaging" on a card is the machine talking. They are omitted.
const IMAGING_SILENT_VALUE = /^(unknown|unsorted( imaging)?|other|not stated|not applicable|n\/?a|none|null)$/i;

function imagingSilent(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  return !raw || IMAGING_SILENT_VALUE.test(raw.replace(/[._-]+/g, " ").replace(/\s+/g, " "));
}

// A stored key ("torso.chest", "head_and_neck", "not_applicable") read as plain
// words: a dotted region names its most specific place ("Chest"; "spine.lumbar"
// is "Lumbar spine", since that leaf alone is an adjective). Text a person or a
// report wrote keeps its own wording. A silent value is "", never printed.
function imagingLabel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (imagingSilent(raw)) return "";
  if (!/^[a-z0-9_.-]+$/.test(raw)) return raw;
  if (raw === "mychart") return "MyChart";
  const parts = raw
    .split(".")
    .map((part) => part.replace(/[_-]+/g, " ").trim())
    .filter((part) => part !== "");
  const leaf = parts[parts.length - 1] || "";
  const parent = parts.length > 1 ? parts[parts.length - 2] : "";
  const words = parent === "spine" ? `${leaf} spine` : leaf;
  if (imagingSilent(words)) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The athlete's own follow-up tracking choices: "unknown" is a real choice there.
function imagingStatusLabel(status: string): string {
  return status === "unknown" ? "Not sure" : imagingLabel(status);
}

// One printed part of a measurement line. 0 is a value ("Agatston score 0");
// only null / undefined / blank text are absent.
function imagingPart(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value).trim();
}

type ImagingMeasurement = NonNullable<NonNullable<ImagingWordsStudy["findings"]>[number]["measurements"]>[number];

function imagingMeasurementText(m: ImagingMeasurement): string {
  const valueText = imagingPart(m.value_text);
  const value = valueText !== "" ? valueText : imagingPart(m.value);
  const name = imagingPart(m.name) || imagingPart(m.label);
  return [name, imagingPart(m.qualifier), value, imagingPart(m.unit), imagingPart(m.method)]
    .filter((part) => part !== "")
    .join(" ");
}

const IMAGING_ABBREVIATIONS = new Set([
  "CT",
  "CTA",
  "MR",
  "MRI",
  "MRA",
  "PET",
  "XR",
  "DX",
  "NM",
  "US",
  "DEXA",
  "DXA",
  "CAC",
]);

// A procedure printed in capitals ("CT CARDIAC CALCIUM SCORING") reads as a
// sentence, keeping the modality abbreviations it names.
function imagingProcedureText(value: unknown): string {
  const raw = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw || /[a-z]/.test(raw)) return raw;
  const words = raw.split(" ").map((word) => (IMAGING_ABBREVIATIONS.has(word) ? word : word.toLowerCase()));
  const first = words[0] || "";
  if (!IMAGING_ABBREVIATIONS.has(first)) words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

function imagingModality(study: ImagingWordsStudy | null): string {
  const meta = study?.study || {};
  const modality = imagingPart(meta.modality);
  if (modality && modality.toUpperCase() !== "UNKNOWN") return modality;
  const raw = imagingPart(meta.raw_modality);
  return imagingSilent(raw) ? "" : raw;
}

// What the card is called: the study's own procedure name ("CT coronary calcium
// score"), led by its modality when the name does not already say it; else the
// modality and the place it imaged. Never a stored key.
function imagingStudyTitle(study: ImagingWordsStudy | null): string {
  const modality = imagingModality(study);
  const procedure = imagingProcedureText(study?.study?.procedure);
  if (procedure && !imagingSilent(procedure)) {
    const token = modality.replace(/[^A-Za-z0-9]/g, "");
    const named = !token || new RegExp(`\\b${token}\\b`, "i").test(procedure);
    if (named) return procedure;
    // "Cardiac calcium scoring" after "CT" reads on as one phrase; an acronym keeps its case.
    const rest = /^[A-Z][a-z]/.test(procedure) ? procedure.charAt(0).toLowerCase() + procedure.slice(1) : procedure;
    return `${modality} ${rest}`;
  }
  const anatomy = study?.anatomy || {};
  const place = imagingLabel(anatomy.body_region) || imagingLabel(anatomy.verbatim_site);
  return [modality, place].filter((part) => part !== "").join(" · ") || "Imaging study";
}

// The Study line inside Details: what was done, where, which side — each part
// only when it says something.
function imagingStudyLine(study: ImagingWordsStudy): string {
  const anatomy = study.anatomy || {};
  const procedure = imagingSilent(study.study?.procedure) ? "" : imagingStudyTitle(study);
  return (
    [
      procedure || imagingModality(study),
      imagingLabel(anatomy.verbatim_site) || imagingLabel(anatomy.body_region),
      imagingLabel(anatomy.laterality),
    ]
      .filter((part) => part !== "")
      .join(" · ") || "Not stated"
  );
}

// A grouping heading only when its label says something ("Not applicable",
// "Unknown" and "Unsorted imaging" print nothing).
function imagingHeading(tag: "h4" | "h5" | "h6", value: unknown): string {
  const label = imagingLabel(value);
  return label ? `<${tag}>${escHtml(label)}</${tag}>` : "";
}

function imagingClip(value: string, max: number): string {
  const out = value.replace(/\s+/g, " ").trim();
  if (out.length <= max) return out;
  const cut = out.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  const kept = space > max * 0.5 ? cut.slice(0, space) : out.slice(0, max);
  return `${kept.replace(/[\s,;:·-]+$/, "")}…`;
}

// The one line a card leads with: what the study FOUND. The report's own
// impression speaks first (its first sentence, clipped on a word boundary);
// without one, a total measurement the study states; then its first finding.
function imagingHeadline(study: ImagingWordsStudy | null): string {
  if (!study) return "";
  const impression = String(study.report?.impression || "")
    .replace(/^\s*(impression|conclusion)s?\s*:\s*/i, "")
    .replace(/^\s*(\d+[.)]|[-•*])\s+/, "")
    .trim();
  if (impression) {
    // First sentence: up to a stop followed by space or the end ("0.5 mm" is not
    // one). No lookbehind — older Safari cannot parse it.
    const line = impression.split(/\n+/)[0] || impression;
    const first = line.match(/^.*?[.!?](?=\s|$)/)?.[0] || line;
    return imagingClip(first.replace(/[.\s]+$/, ""), 110);
  }
  const findings = study.findings || [];
  for (const finding of findings) {
    for (const m of finding.measurements || []) {
      if (!/\btotal\b/i.test(`${imagingPart(m.name) || imagingPart(m.label)} ${imagingPart(m.qualifier)}`)) continue;
      const line = imagingMeasurementText(m);
      if (line) return imagingClip(line, 110);
    }
  }
  const text = findings.map((finding) => imagingPart(finding.finding_text)).find((value) => value !== "");
  return text ? imagingClip(text.replace(/[.\s]+$/, ""), 110) : "";
}

const CAIRN_IMAGING_WORDS = {
  imagingSilent,
  imagingLabel,
  imagingStatusLabel,
  imagingPart,
  imagingMeasurementText,
  imagingStudyTitle,
  imagingStudyLine,
  imagingHeading,
  imagingHeadline,
};
Object.assign(globalThis, { CairnImagingWords: CAIRN_IMAGING_WORDS });
if (typeof window !== "undefined") window.CairnImagingWords = CAIRN_IMAGING_WORDS;
