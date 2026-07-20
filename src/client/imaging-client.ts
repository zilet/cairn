// First-class imaging study rendering. All server-originated fields are escaped here.

type ImagingDoc = import("../contracts/client-api.js").ClientHealthDocument;
type ImagingStudy = import("../contracts/client-api.js").ClientImagingStudy;
type ImagingFindingSource = NonNullable<import("../contracts/client-api.js").ClientImagingFinding["source"]>;
type ImagingRecommendationStatus = import("../contracts/client-api.js").ClientImagingRecommendationStatus;

function imagingStudy(doc: ImagingDoc): ImagingStudy | null {
  const parsed =
    doc.parsed ||
    (typeof doc.parsed_json === "string"
      ? (() => {
          try {
            return JSON.parse(doc.parsed_json);
          } catch {
            return null;
          }
        })()
      : doc.parsed_json);
  const candidate =
    parsed && typeof parsed === "object" ? (parsed as { imaging_study?: ImagingStudy }).imaging_study : null;
  return candidate && typeof candidate === "object" ? candidate : null;
}

function imagingHasDicomSeries(study: ImagingStudy | null): boolean {
  if (!study?.dicom || typeof study.dicom !== "object") return false;
  return (
    Array.isArray((study.dicom as { series?: unknown }).series) &&
    (study.dicom as { series: unknown[] }).series.length > 0
  );
}

function imagingLabel(value: unknown): string {
  return String(value || "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function imagingGroups(study: ImagingStudy): Array<
  [
    string,
    Array<{
      body: string;
      lateralities: Array<{ laterality: string; items: NonNullable<ImagingStudy["findings"]> }>;
    }>,
  ]
> {
  const systems = new Map<string, Map<string, Map<string, NonNullable<ImagingStudy["findings"]>>>>();
  const findings = study.findings?.length
    ? study.findings
    : [
        {
          clinical_system: study.anatomy?.clinical_system,
          body_region: study.anatomy?.body_region || study.anatomy?.verbatim_site,
          laterality: study.anatomy?.laterality,
          finding_text: study.report?.impression || study.report?.findings || "Study details",
        },
      ];
  for (const finding of findings) {
    const system = String(finding.clinical_system || "Unsorted imaging");
    const body = String(finding.body_region || finding.verbatim_site || "Unsorted imaging");
    const laterality = String(finding.laterality || "not stated");
    if (!systems.has(system)) systems.set(system, new Map());
    const regions = systems.get(system)!;
    if (!regions.has(body)) regions.set(body, new Map());
    const sides = regions.get(body)!;
    if (!sides.has(laterality)) sides.set(laterality, []);
    sides.get(laterality)!.push(finding);
  }
  return [...systems]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([system, regions]) => [
      system,
      [...regions]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([body, sides]) => ({
          body,
          lateralities: [...sides]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([laterality, items]) => ({ laterality, items })),
        })),
    ]);
}

function meaningfulImagingValue(value: unknown): string | null {
  const out = String(value || "").trim();
  return out && !/^(unknown|other|not[_ ]stated|not[_ ]applicable)$/i.test(out) ? out : null;
}

function imagingStudyGrouping(study: ImagingStudy | null): {
  system: string;
  region: string;
  laterality: string | null;
} {
  const anatomy = study?.anatomy || {};
  const explicitSystem = meaningfulImagingValue(anatomy.clinical_system);
  const explicitRegion = meaningfulImagingValue(anatomy.body_region || anatomy.verbatim_site);
  const explicitLaterality = meaningfulImagingValue(anatomy.laterality);
  if (explicitSystem || explicitRegion) {
    return {
      system: explicitSystem || "Unsorted imaging",
      region: explicitRegion || "Unsorted imaging",
      laterality: explicitLaterality,
    };
  }
  const findings = study?.findings || [];
  const systems = new Set(findings.map((finding) => meaningfulImagingValue(finding.clinical_system)).filter(Boolean));
  const regions = new Set(
    findings.map((finding) => meaningfulImagingValue(finding.body_region || finding.verbatim_site)).filter(Boolean)
  );
  const lateralities = new Set(findings.map((finding) => meaningfulImagingValue(finding.laterality)).filter(Boolean));
  return {
    system: systems.size === 1 ? String([...systems][0]) : systems.size > 1 ? "Multiple systems" : "Unsorted imaging",
    region: regions.size === 1 ? String([...regions][0]) : regions.size > 1 ? "Multiple regions" : "Unsorted imaging",
    laterality:
      lateralities.size === 1 ? String([...lateralities][0]) : lateralities.size > 1 ? "Multiple lateralities" : null,
  };
}

function boundedEditorText(value: unknown, max: number, field: string): string {
  const out = String(value || "").trim();
  if (out.length > max) throw new Error(`${field} is too long`);
  return out;
}

function parseEditorJson(value: unknown, field: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value || "[]"));
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array`);
  return parsed;
}

function imagingCorrectionPayload(study: ImagingStudy, values: Record<string, unknown>): ImagingStudy {
  const reportStatus = boundedEditorText(values.report_status, 20, "Report status").toLowerCase() || "unknown";
  if (!["draft", "preliminary", "final", "amended", "corrected", "unknown"].includes(reportStatus)) {
    throw new Error("Report status is invalid");
  }
  const studyDate = boundedEditorText(values.study_date, 10, "Study date");
  if (studyDate && !/^\d{4}-\d{2}-\d{2}$/.test(studyDate)) throw new Error("Study date must be YYYY-MM-DD");
  const existingFindings = study.findings || [];
  const findings = parseEditorJson(values.findings_json, "Atomic findings");
  if (findings.length > 200) throw new Error("Atomic findings are limited to 200");
  const cleanFindings = findings.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Finding ${index + 1} must be an object`);
    const finding = raw as Record<string, unknown>;
    const findingText = boundedEditorText(finding.finding_text, 2000, `Finding ${index + 1}`);
    if (!findingText) throw new Error(`Finding ${index + 1} needs finding_text`);
    const source = (boundedEditorText(finding.source, 20, `Finding ${index + 1} source`) ||
      "image_ai") as ImagingFindingSource;
    if (!["report", "image_ai", "mychart", "patient"].includes(source))
      throw new Error(`Finding ${index + 1} source is invalid`);
    const measurements = Array.isArray(finding.measurements) ? finding.measurements : [];
    if (measurements.length > 30) throw new Error(`Finding ${index + 1} measurements are limited to 30`);
    const existing = existingFindings.find((item) => item.id && item.id === finding.id) || existingFindings[index];
    return {
      id: boundedEditorText(finding.id, 80, `Finding ${index + 1} id`) || existing?.id,
      source,
      clinical_system: boundedEditorText(finding.clinical_system, 80, `Finding ${index + 1} system`),
      body_region: boundedEditorText(finding.body_region, 120, `Finding ${index + 1} region`),
      verbatim_site: boundedEditorText(finding.verbatim_site, 240, `Finding ${index + 1} site`),
      laterality: boundedEditorText(finding.laterality, 24, `Finding ${index + 1} laterality`),
      finding_text: findingText,
      severity: boundedEditorText(finding.severity, 24, `Finding ${index + 1} severity`),
      certainty: boundedEditorText(finding.certainty, 24, `Finding ${index + 1} certainty`),
      measurements: measurements.map((measurement, measurementIndex) => {
        if (!measurement || typeof measurement !== "object" || Array.isArray(measurement)) {
          throw new Error(`Finding ${index + 1} measurement ${measurementIndex + 1} must be an object`);
        }
        const item = measurement as Record<string, unknown>;
        const name = boundedEditorText(item.name || item.label, 120, "Measurement name");
        if (!name) throw new Error(`Finding ${index + 1} measurement ${measurementIndex + 1} needs a name`);
        const numeric = item.value === "" || item.value == null ? null : Number(item.value);
        if (numeric != null && !Number.isFinite(numeric))
          throw new Error(`Finding ${index + 1} measurement value is invalid`);
        return {
          name,
          value: numeric ?? undefined,
          value_text:
            numeric == null
              ? boundedEditorText(item.value_text, 120, "Measurement value text") || undefined
              : undefined,
          unit: boundedEditorText(item.unit, 40, "Measurement unit"),
          qualifier: boundedEditorText(item.qualifier, 120, "Measurement qualifier"),
          method: boundedEditorText(item.method, 120, "Measurement method"),
        };
      }),
      source_spans: existing?.source_spans || [],
    };
  });
  const existingRecommendations = study.recommendations || [];
  const recommendations = parseEditorJson(values.recommendations_json, "Recommendations");
  if (recommendations.length > 80) throw new Error("Recommendations are limited to 80");
  const cleanRecommendations = recommendations.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`Recommendation ${index + 1} must be an object`);
    const recommendation = raw as Record<string, unknown>;
    const recommendationText = boundedEditorText(
      recommendation.recommendation_text,
      1500,
      `Recommendation ${index + 1}`
    );
    if (!recommendationText) throw new Error(`Recommendation ${index + 1} needs recommendation_text`);
    const existing =
      existingRecommendations.find((item) => item.id && item.id === recommendation.id) ||
      existingRecommendations[index];
    const source = boundedEditorText(recommendation.source, 20, `Recommendation ${index + 1} source`) || "report";
    if (!["report", "mychart"].includes(source)) throw new Error(`Recommendation ${index + 1} source is invalid`);
    const status = (boundedEditorText(recommendation.status, 24, "Recommendation status") ||
      existing?.status ||
      "unknown") as ImagingRecommendationStatus;
    if (!["recommended", "scheduled", "completed", "declined", "not_needed", "unknown"].includes(status)) {
      throw new Error(`Recommendation ${index + 1} status is invalid`);
    }
    return {
      id: boundedEditorText(recommendation.id, 80, `Recommendation ${index + 1} id`) || existing?.id,
      source,
      recommendation_text: recommendationText,
      timeframe: boundedEditorText(recommendation.timeframe, 240, "Recommendation timeframe"),
      action: boundedEditorText(recommendation.action, 500, "Recommendation action"),
      status,
      source_spans: existing?.source_spans || [],
    };
  });
  return {
    ...study,
    report_status: reportStatus,
    study: {
      ...study.study,
      modality: boundedEditorText(values.modality, 120, "Modality"),
      procedure: boundedEditorText(values.procedure, 240, "Procedure"),
      study_date: studyDate || undefined,
      facility: boundedEditorText(values.facility, 240, "Facility"),
    },
    anatomy: {
      ...study.anatomy,
      clinical_system: boundedEditorText(values.clinical_system, 80, "Clinical system"),
      body_region: boundedEditorText(values.body_region, 120, "Body region"),
      verbatim_site: boundedEditorText(values.verbatim_site, 240, "Source anatomy wording"),
      laterality: boundedEditorText(values.laterality, 24, "Laterality"),
    },
    report: {
      ...study.report,
      history: boundedEditorText(values.history, 4000, "History"),
      technique: boundedEditorText(values.technique, 4000, "Technique"),
      comparison: boundedEditorText(values.comparison, 4000, "Comparison"),
      findings: boundedEditorText(values.report_findings, 12000, "Written findings"),
      impression: boundedEditorText(values.impression, 6000, "Impression"),
      addendum: boundedEditorText(values.addendum, 4000, "Addendum"),
    },
    findings: cleanFindings,
    recommendations: cleanRecommendations,
    // Provenance and verification are deliberately carried through unchanged;
    // there are no editor controls for server-owned clinician verification.
    provenance: study.provenance,
    verification: study.verification,
  };
}

function imagingFindingHtml(finding: NonNullable<ImagingStudy["findings"]>[number]): string {
  const imageOnly = finding.source === "image_ai";
  const measurements = (finding.measurements || [])
    .map(
      (m) =>
        `<li>${escHtml([m.name || m.label, m.qualifier, m.value_text || m.value, m.unit, m.method].filter(Boolean).join(" "))}</li>`
    )
    .join("");
  return `<li class="imaging-finding"><span class="imaging-source">${imageOnly ? "AI image observation · unconfirmed" : escHtml(imagingLabel(finding.source || "report"))}</span><div>${escHtml(finding.finding_text || "Finding not stated")}</div>${finding.laterality ? `<small>${escHtml(imagingLabel(finding.laterality))}</small>` : ""}${measurements ? `<ul class="imaging-measurements">${measurements}</ul>` : ""}</li>`;
}

function imagingInner(doc: ImagingDoc): string {
  const study = imagingStudy(doc);
  if (!study) return `<div class="sess-line" style="color:var(--muted)">Preparing this imaging study…</div>`;
  const metadata = study.study || {};
  const anatomy = study.anatomy || {};
  const report = study.report || {};
  const verification = study.verification || {};
  const groups = imagingGroups(study)
    .map(
      ([system, regions]) =>
        `<section class="imaging-group"><h4>${escHtml(imagingLabel(system))}</h4>${regions.map(({ body, lateralities }) => `<div><h5>${escHtml(imagingLabel(body))}</h5>${lateralities.map(({ laterality, items }) => `<div class="imaging-laterality"><h6>${escHtml(imagingLabel(laterality))}</h6><ul>${items.map(imagingFindingHtml).join("")}</ul></div>`).join("")}</div>`).join("")}</section>`
    )
    .join("");
  const files = (doc.study_files || [])
    .map(
      (file) =>
        `<li><a href="${escAttr(withToken(`/api/health-docs/${doc.id}/imaging-files/${file.id}`))}" target="_blank" rel="noopener">${escHtml(file.original_name)}</a> · ${escHtml(imagingLabel(file.source_kind))}</li>`
    )
    .join("");
  const confirmation = verification.user_confirmed
    ? "You checked these details against the source report."
    : "Extraction has not been checked against the source report.";
  return `<div class="imaging-detail" id="imaging-detail-${escAttr(doc.id)}">
    <dl class="imaging-meta"><div><dt>Study</dt><dd>${escHtml([metadata.modality || metadata.raw_modality, metadata.procedure, anatomy.verbatim_site || anatomy.body_region, anatomy.laterality].filter(Boolean).join(" · ") || "Not stated")}</dd></div>${metadata.study_date ? `<div><dt>Date</dt><dd>${escHtml(metadata.study_date)}</dd></div>` : ""}${metadata.facility ? `<div><dt>Facility</dt><dd>${escHtml(metadata.facility)}</dd></div>` : ""}</dl>
    ${report.impression ? `<section><h4>Impression</h4><p>${escHtml(report.impression)}</p></section>` : ""}${report.findings ? `<section><h4>Written findings</h4><p>${escHtml(report.findings)}</p></section>` : ""}
    ${groups ? `<section><h4>Extracted findings</h4>${groups}</section>` : ""}
    ${study.recommendations?.length ? `<section><h4>Source-stated follow-up</h4><ul>${study.recommendations.map((rec) => `<li>${escHtml(rec.recommendation_text || "Follow-up not stated")}${rec.timeframe ? ` · ${escHtml(rec.timeframe)}` : ""}${rec.id ? ` <label class="imaging-status-label">Your tracking <select data-imaging-recommendation="${escAttr(rec.id)}" aria-label="Tracking status for source-stated follow-up">${["recommended", "scheduled", "completed", "declined", "not_needed", "unknown"].map((status) => `<option value="${status}"${rec.status === status ? " selected" : ""}>${escHtml(imagingLabel(status))}</option>`).join("")}</select></label>` : ""}</li>`).join("")}</ul></section>` : ""}
    <p class="imaging-verification">${escHtml(confirmation)}</p>${files ? `<section><h4>Source files</h4><ul>${files}</ul></section>` : ""}
    <div class="imaging-actions">${imagingHasDicomSeries(study) ? `<button class="hdoc-link" data-dicom-open="${escAttr(doc.id)}">Open image viewer</button>` : ""}<button class="hdoc-link" data-imaging-ask="${escAttr(doc.id)}">Ask Cairn</button><button class="hdoc-link" data-imaging-confirm="${escAttr(doc.id)}"${verification.user_confirmed ? " disabled" : ""}>Confirm extracted details</button><button class="hdoc-link" data-imaging-edit="${escAttr(doc.id)}">Correct details</button></div>
    <form class="imaging-edit" data-imaging-form="${escAttr(doc.id)}" hidden><p class="imaging-note">Source check editor. Keep atomic findings and recommendations as JSON arrays; attachment citations and server-owned verification are preserved.</p><div class="imaging-edit-grid"><label>Study date<input name="study_date" value="${escAttr(metadata.study_date || doc.doc_date || "")}" placeholder="YYYY-MM-DD"></label><label>Facility<input name="facility" value="${escAttr(metadata.facility || "")}"></label><label>Report status<input name="report_status" value="${escAttr(study.report_status || "unknown")}"></label><label>Modality<input name="modality" value="${escAttr(metadata.modality || "")}"></label><label>Procedure<input name="procedure" value="${escAttr(metadata.procedure || "")}"></label><label>System<input name="clinical_system" value="${escAttr(anatomy.clinical_system || "")}"></label><label>Body region<input name="body_region" value="${escAttr(anatomy.body_region || "")}"></label><label>Source anatomy wording<input name="verbatim_site" value="${escAttr(anatomy.verbatim_site || "")}"></label><label>Laterality<input name="laterality" value="${escAttr(anatomy.laterality || "")}"></label></div><label>History<textarea name="history">${escHtml(report.history || "")}</textarea></label><label>Technique<textarea name="technique">${escHtml(report.technique || "")}</textarea></label><label>Comparison<textarea name="comparison">${escHtml(report.comparison || "")}</textarea></label><label>Written findings<textarea name="report_findings">${escHtml(report.findings || "")}</textarea></label><label>Impression<textarea name="impression">${escHtml(report.impression || "")}</textarea></label><label>Addendum<textarea name="addendum">${escHtml(report.addendum || "")}</textarea></label><label>Atomic findings JSON<textarea class="imaging-json-editor" name="findings_json" spellcheck="false">${escHtml(JSON.stringify(study.findings || [], null, 2))}</textarea></label><label>Source-stated recommendations JSON<textarea class="imaging-json-editor" name="recommendations_json" spellcheck="false">${escHtml(JSON.stringify(study.recommendations || [], null, 2))}</textarea></label><button class="hdoc-link" type="submit">Save correction</button></form>
  </div>`;
}

function imagingCard(doc: ImagingDoc, index?: number): string {
  const study = imagingStudy(doc);
  const meta = study?.study || {};
  const anatomy = study?.anatomy || {};
  const title = [meta.modality || meta.raw_modality || "Imaging", anatomy.body_region || anatomy.verbatim_site]
    .filter(Boolean)
    .join(" · ");
  const controls = `imaging-detail-${escAttr(doc.id)}`;
  const expanded = index === 0;
  const retry =
    doc.enrichment_status === "retry_needed"
      ? `<div class="imaging-retry" role="status"><span>Your correction was kept. Re-analyze when you’re ready to review the source files again.</span><button class="hdoc-link" data-hrescan="${escAttr(doc.id)}">Re-analyze</button></div>`
      : "";
  return `<div class="sess hdoc imaging-card${expanded ? "" : " hdoc-collapsed"}" data-hdoc="${escAttr(doc.id)}"><div class="sess-head"><span class="sess-date">${escHtml(title)}${doc.doc_date ? ` · ${escHtml(doc.doc_date)}` : ""}</span><button class="hdoc-link" data-imaging-toggle="${escAttr(doc.id)}" aria-expanded="${String(expanded)}" aria-controls="${controls}">Details</button></div>${retry}${imagingInner(doc)}<div class="hdoc-foot"><div class="hdoc-actions"><button class="iconbtn hdoc-del" data-hdel="${escAttr(doc.id)}" title="Delete imaging study" aria-label="Delete imaging study">×</button></div></div></div>`;
}

function wireImaging(
  doc: ImagingDoc,
  el: HTMLElement,
  deps: {
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    toast(message: string): void;
    refresh(): void;
  }
): void {
  el.querySelector<HTMLButtonElement>("[data-imaging-toggle]")?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    el.classList.toggle("hdoc-collapsed");
    button.setAttribute("aria-expanded", String(!el.classList.contains("hdoc-collapsed")));
  });
  el.querySelector<HTMLButtonElement>("[data-dicom-open]")?.addEventListener("click", (event) => {
    CairnDicomViewer.openDicomViewer(Number(doc.id), event.currentTarget as Element, deps.api, deps.toast);
  });
  el.querySelector<HTMLButtonElement>("[data-imaging-ask]")?.addEventListener("click", () => {
    const study = imagingStudy(doc);
    const s = study?.study || {};
    const a = study?.anatomy || {};
    const unconfirmed = study?.verification?.user_confirmed
      ? ""
      : " This extraction is unconfirmed; please treat it as a starting point.";
    CairnHealthClient.askCoach(
      `Help me understand imaging study #${doc.id}: ${[s.study_date || doc.doc_date, s.modality, a.body_region || a.verbatim_site, study?.report?.impression].filter(Boolean).join(" · ")}.${unconfirmed}`
    );
  });
  el.querySelector<HTMLButtonElement>("[data-imaging-confirm]")?.addEventListener("click", async () => {
    try {
      await deps.api(`/health-docs/${doc.id}/imaging-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      deps.toast("Marked as checked against the source");
      deps.refresh();
    } catch {
      deps.toast("Couldn't confirm those details");
    }
  });
  el.querySelectorAll<HTMLSelectElement>("[data-imaging-recommendation]").forEach((select) =>
    select.addEventListener("change", async () => {
      try {
        await deps.api(
          `/health-docs/${doc.id}/imaging-recommendations/${select.dataset.imagingRecommendation}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: select.value }),
          }
        );
        deps.toast("Tracking status updated");
      } catch {
        deps.toast("Couldn't update that status");
      }
    })
  );
  const form = el.querySelector<HTMLFormElement>("[data-imaging-form]");
  el.querySelector<HTMLButtonElement>("[data-imaging-edit]")?.addEventListener("click", () => {
    if (form) form.hidden = !form.hidden;
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const study = imagingStudy(doc);
    if (!study) return;
    const formData = new FormData(form);
    const values = Object.fromEntries(formData.entries());
    let updated: ImagingStudy;
    try {
      updated = imagingCorrectionPayload(study, values);
    } catch (error) {
      deps.toast(error instanceof Error ? error.message : "Please check the correction fields");
      return;
    }
    try {
      await deps.api(`/health-docs/${doc.id}/imaging-details`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imaging_study: updated }),
      });
      deps.toast("Correction saved; please review it against the source");
      deps.refresh();
    } catch {
      deps.toast("Couldn't save that correction");
    }
  });
}

const CAIRN_IMAGING = {
  imagingStudy,
  imagingHasDicomSeries,
  imagingLabel,
  imagingGroups,
  imagingStudyGrouping,
  imagingCorrectionPayload,
  imagingInner,
  imagingCard,
  wireImaging,
};
Object.assign(globalThis, { CairnImaging: CAIRN_IMAGING });
if (typeof window !== "undefined") window.CairnImaging = CAIRN_IMAGING;
