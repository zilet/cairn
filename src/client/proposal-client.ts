// @ts-check
// Shared proposal/result render helpers used by Today, Plan, Chat, and Meals.

type ProposalRecord = Record<string, unknown>;

type ApplyResultMessage = {
  failed: boolean;
  message: string;
};

(() => {
  function proposalRecord(value: unknown): ProposalRecord {
    return value && typeof value === "object" ? value as ProposalRecord : {};
  }

  function statusBadge(status: unknown): string {
    const s = String(status || "draft");
    const cls = s === "accepted" || s === "applied" || s === "kept" ? "ok"
      : s === "discarded" ? "off"
      : s === "superseded" ? "muted" : "draft";
    return `<span class="mp-badge ${cls}">${escHtml(s)}</span>`;
  }

  function applyResultMessage(result: unknown): ApplyResultMessage {
    const r = proposalRecord(result);
    if (!result || r.ok === false || r.error) return { failed: true, message: String(r.error || "Couldn't apply — try again") };
    if (Array.isArray(r.clamped) && r.clamped.length) return { failed: false, message: "Applied · adjusted to a safe step" };
    const addedN = Array.isArray(r.added) ? r.added.length : 0;
    if (addedN) return { failed: false, message: addedN > 1 ? `Added ${addedN} movements to your plan` : "Added to your plan" };
    if (r.restructured) return { failed: false, message: "Plan restructured" };
    return { failed: false, message: "Applied" };
  }

  function clampNoteHtml(clamped: unknown): string {
    const rows = (Array.isArray(clamped) ? clamped : []).filter(Boolean).map(proposalRecord);
    if (!rows.length) return "";
    const lines = rows.slice(0, 6).map((c) => {
      const what = String(c.exercise || c.field || "a value").trim();
      const reason = String(c.reason || "kept to a safe step").trim();
      const from = c.requested != null && c.requested !== "" ? `${escHtml(String(c.requested))} → ` : "";
      const to = c.applied != null && c.applied !== "" ? `<b>${escHtml(String(c.applied))}</b>` : "";
      const move = from || to ? `<span class="clampnote-move">${from}${to}</span>` : "";
      return `<div class="clampnote-row"><span class="clampnote-what">${escHtml(what)}</span>${move}<span class="clampnote-why">${escHtml(reason)}</span></div>`;
    }).join("");
    return `<div class="clampnote settle-in" role="note">
        <div class="clampnote-lbl lbl"><span class="clampnote-glyph" aria-hidden="true">⚖</span> adjusted to a safe step</div>
        ${lines}
      </div>`;
  }

  function verifiedBadgeHtml(verified: unknown): string {
    const v = proposalRecord(verified);
    if (!v.checked) return "";
    const adj = (Array.isArray(v.adjustments) ? v.adjustments : []).filter((a) => a != null && String(a).trim());
    const detail = adj.length
      ? `<details class="verified-detail"><summary>what was adjusted</summary>
           <ul class="verified-list">${adj.slice(0, 8).map((a) => `<li>${escHtml(String(a))}</li>`).join("")}</ul>
         </details>`
      : "";
    return `<div class="verified-badge settle-in" role="note">
        <span class="verified-mark" aria-hidden="true">✓</span>
        <span class="verified-text">Checked against your floors</span>
        ${detail}
      </div>`;
  }

  function strengthChangeHtml(change: unknown): string {
    const c = proposalRecord(change);
    if (!change) return "";
    const dayTag = c.day_number != null
      ? `<span class="lbl" style="margin-right:7px;opacity:.7">Day ${escHtml(c.day_number)}</span>`
      : "";
    const tgt = c.target_seconds != null
      ? `${escHtml(c.target_seconds)}s`
      : (c.target_weight != null ? escHtml(fmtWeight(c.target_weight)) : "—");
    const reps = (c.rep_low != null)
      ? ` <span style="color:var(--muted)">× ${escHtml(c.rep_low)}${c.rep_high != null && c.rep_high !== c.rep_low ? "–" + escHtml(c.rep_high) : ""}</span>`
      : "";
    const reason = c.reason || c.note;
    const why = reason
      ? `<div class="sess-why" style="color:var(--muted);font-size:.82rem;margin:0 0 5px">${escHtml(reason)}</div>`
      : "";
    return `<div class="sess-line">${dayTag}<b>${escHtml(c.exercise || "")}</b> → <span class="numeral">${tgt}</span>${reps}</div>${why}`;
  }

  function runTargetText(run: unknown): string {
    const c = proposalRecord(run);
    const bits = [];
    if (c.target_distance_km != null) bits.push(`${c.target_distance_km} km`);
    if (c.target_duration_min != null) bits.push(`${Math.round(Number(c.target_duration_min))} min`);
    if (c.target_zone) bits.push(String(c.target_zone));
    return bits.join(" · ") || "run";
  }

  function isOpenProposal(proposal: unknown): boolean {
    const p = proposalRecord(proposal);
    const parsed = proposalRecord(p.parsed);
    return p.status === "draft" && (
      (Array.isArray(parsed.changes) && parsed.changes.length > 0) ||
      (Array.isArray(parsed.cardio) && parsed.cardio.length > 0) ||
      (Array.isArray(parsed.days) && parsed.days.length > 0)
    );
  }

  function appliedClampFor(proposal: ProposalRecord, lastApplyClamp?: unknown): unknown {
    if (!lastApplyClamp || typeof lastApplyClamp !== "object" || proposal.id == null) return null;
    const lookup = lastApplyClamp as Record<string, unknown>;
    return lookup[String(proposal.id)] ?? null;
  }

  function coachProposalCardHtml(proposal: unknown, index: number, lastApplyClamp?: unknown): string {
    const p = proposalRecord(proposal);
    const parsed = proposalRecord(p.parsed);
    const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
    const cardio = Array.isArray(parsed.cardio) ? parsed.cardio : [];
    const cardioHtml = cardio.map((run) => {
      const c = proposalRecord(run);
      return `<div class="sess-line run-line"><span class="run-pin" aria-hidden="true">▸</span><b>D${escHtml(c.day_number)} ${escHtml(c.label || c.exercise || "Run")}</b> <span class="numeral">${escHtml(runTargetText(c))}</span> <span style="color:var(--muted)">(${escHtml(c.reason || c.note || "")})</span></div>`;
    }).join("");
    const body = p.parsed
      ? `<div class="sess-line">${escHtml(parsed.summary || "")}</div>` +
        changes.map(strengthChangeHtml).join("") +
        cardioHtml +
        (parsed.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(parsed.notes)}</div>` : "")
      : `<div class="sess-line" style="color:var(--warn)">Unparseable output</div><div class="sess-line" style="color:var(--muted);font-size:.78rem">${escHtml(String(p.raw_output || "").slice(0, 200))}…</div>`;
    const actions = isOpenProposal(p)
      ? `<div class="logrow" style="margin-top:10px"><button class="logbtn" style="width:auto;padding:0 14px;font-size:.85rem" data-apply="${escAttr(p.id)}">APPLY</button>
         <button class="ghostbtn" style="width:auto;padding:0 14px" data-discard="${escAttr(p.id)}">DISCARD</button></div>`
      : "";
    const applied = p.status === "applied"
      ? `<div class="apply-done settle-in"><span class="apply-done-mark" aria-hidden="true">✓</span> Applied to your plan</div>`
        + clampNoteHtml(appliedClampFor(p, lastApplyClamp))
      : "";
    return `<div class="mp-card reveal${p.status === "superseded" ? " mp-card-faded" : ""}" style="${stagger(index)}">
      <div class="mp-hero">
        <span class="lbl">${escHtml(p.agent)} · #${escHtml(p.id)} · ${escHtml(p.created_at || "")}</span>
        ${statusBadge(p.status)}
      </div>
      ${body}${actions}${applied}</div>`;
  }

  function coachProposalListHtml(proposals: unknown, lastApplyClamp?: unknown): string {
    const rows = Array.isArray(proposals) ? proposals : [];
    if (!rows.length) return `<div class="empty">No drafts yet. Ask the coach above for next week's targets — every change waits here for you to apply.</div>`;

    const open = rows.filter(isOpenProposal);
    const settled = rows.filter((p) => !isOpenProposal(p));
    const shown = [...open, ...settled.slice(0, 1)];
    const earlier = settled.slice(1);
    return shown.map((p, i) => coachProposalCardHtml(p, i, lastApplyClamp)).join("") +
      (earlier.length
        ? `<details class="hist-fold"><summary>Show earlier proposals (${earlier.length})</summary>
           <div class="hist-fold-body">${earlier.map((p, i) => coachProposalCardHtml(p, i, lastApplyClamp)).join("")}</div></details>`
        : "");
  }

  const CAIRN_PROPOSAL = {
    statusBadge,
    applyResultMessage,
    clampNoteHtml,
    verifiedBadgeHtml,
    strengthChangeHtml,
    runTargetText,
    isOpenProposal,
    coachProposalCardHtml,
    coachProposalListHtml,
  };

  Object.assign(globalThis, {
    CairnProposal: CAIRN_PROPOSAL,
    statusBadge,
    applyResultMessage,
    clampNoteHtml,
    verifiedBadgeHtml,
    strengthChangeHtml,
    runTargetText,
    isOpenProposal,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnProposal: CAIRN_PROPOSAL,
      statusBadge,
      applyResultMessage,
      clampNoteHtml,
      verifiedBadgeHtml,
      strengthChangeHtml,
      runTargetText,
      isOpenProposal,
    });
  }
})();
