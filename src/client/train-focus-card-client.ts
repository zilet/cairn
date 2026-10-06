// @ts-check
// The Train overview "Where to focus" card markup. Lazy: ships in the train bundle and
// is reached by the eager coachingFocusHtml through a typeof guard (older/eager-only
// surfaces fall back to the flat lead). Uses the eager cfocus* helpers at call time.

// ---------------------------------------------------------------------------
// The Train overview "Where to focus" card: scannable in a glance. Hero = this
// week's lead lever with ONE move; a quiet "also" row; what moved; the block line
// with its deload decision; today's state as a small chip, never the lead. The why,
// evidence and the rest sit behind ONE aria-expanded tap. Every new field is
// optional — an older payload just renders fewer parts. Never a score.
// ---------------------------------------------------------------------------

function cfocusDomainKey(domain: unknown): string {
  return typeof domain === "string" && /^(training|running|nutrition|health|recovery|body)$/.test(domain) ? domain : "training";
}

function cfocusDomainDot(domain: unknown): string {
  return `<span class="tfc-dot tfc-dot-${cfocusDomainKey(domain)}" aria-hidden="true"></span>`;
}

function cfocusDirectionMark(direction: unknown): string {
  if (direction === "up") return `<span class="tfc-dir tfc-dir-up" role="img" aria-label="up">↑</span>`;
  if (direction === "down") return `<span class="tfc-dir tfc-dir-down" role="img" aria-label="down">↓</span>`;
  if (direction === "steady") return `<span class="tfc-dir tfc-dir-steady" role="img" aria-label="steady">→</span>`;
  return `<span class="tfc-dir" aria-hidden="true">·</span>`;
}

function cfocusMovedHtml(focus: ClientCoachingFocus): string {
  const changes = (Array.isArray(focus.changed_since) ? focus.changed_since : [])
    .filter((c) => c && cfocusText(c.text))
    .slice(0, 3);
  if (!changes.length) return "";
  const evidence = (Array.isArray(focus.evidence) ? focus.evidence : []).filter((e) => e && cfocusText(e.label));
  const rows = changes
    .map((c) => {
      const text = cfocusText(c.text);
      const hit = evidence.find((e) => e.domain === c.domain && text.toLowerCase().includes(cfocusText(e.label).toLowerCase()));
      const since = cfocusText(c.since);
      return `<li class="tfc-moved-item">${cfocusDirectionMark(hit ? hit.direction : null)}<span class="tfc-moved-text">${escHtml(text)}</span>${since ? `<span class="tfc-moved-since">${escHtml(since)}</span>` : ""}</li>`;
    })
    .join("");
  return `<div class="tfc-moved"><span class="tfc-lbl lbl">What moved</span><ul class="tfc-moved-list">${rows}</ul></div>`;
}

function cfocusBlockHtml(focus: ClientCoachingFocus, leadDomain: unknown): string {
  const block = focus.block || null;
  const decision = cfocusText(block?.decision);
  const line = cfocusText(focus.block_line);
  const shown = leadDomain === "training" || leadDomain === "running" || leadDomain === "recovery" || !!decision;
  if (!shown || (!line && !decision)) return "";
  const parts = [line, decision && !line.includes(decision) ? decision : ""].filter(Boolean);
  return `<p class="tfc-block">${parts.map((p) => escHtml(p)).join(" ")}</p>`;
}

function cfocusExpandHtml(focus: ClientCoachingFocus, lead: ClientCoachingFocusItem, spec: CfocusVariantSpec): string {
  let body = "";
  if (cfocusText(lead.why)) body += `<p class="tfc-why">${escHtml(lead.why)}</p>`;
  const basedOn = (Array.isArray(lead.based_on) ? lead.based_on : []).map((b) => cfocusText(b)).filter(Boolean);
  if (basedOn.length) body += `<p class="tfc-based"><span class="tfc-lbl lbl">Based on</span>${escHtml(basedOn.join(" · "))}</p>`;
  const evidence = (Array.isArray(focus.evidence) ? focus.evidence : []).filter((e) => e && cfocusText(e.label) && cfocusText(e.value));
  if (evidence.length) {
    body += `<ul class="tfc-evidence">${evidence
      .map(
        (e) =>
          `<li class="tfc-ev">${cfocusDirectionMark(e.direction)}<span class="tfc-ev-label">${escHtml(e.label)}</span><span class="tfc-ev-value">${escHtml(e.value)}</span>${cfocusText(e.note) ? `<span class="tfc-ev-note">${escHtml(e.note)}</span>` : ""}</li>`
      )
      .join("")}</ul>`;
  }
  const later = (Array.isArray(focus.later) ? focus.later : []).filter((item) => item && cfocusText(item.title));
  if (later.length) {
    body += `<div class="tfc-later"><span class="tfc-lbl lbl">Later</span>${later
      .map((item) => `<p class="tfc-later-row"><b>${escHtml(item.title)}</b>${cfocusText(item.why) ? ` ${escHtml(item.why)}` : ""}</p>`)
      .join("")}</div>`;
  }
  for (const c of (Array.isArray(focus.connections) ? focus.connections : []).filter(Boolean))
    body += `<p class="tfc-conn">${escHtml(c)}</p>`;
  body += cfocusRetestHtml(focus, spec);
  if (!body) return "";
  return `<button class="tfc-expand" type="button" data-cfocus-toggle="tfcPanel" aria-expanded="false" aria-controls="tfcPanel"><span>Why, and the move</span><span class="tfc-chev" aria-hidden="true">›</span></button><div class="tfc-panel" id="tfcPanel" hidden>${body}</div>`;
}

function cfocusTrainCardHtml(
  focus: ClientCoachingFocus,
  lead: ClientCoachingFocusItem,
  spec: CfocusVariantSpec,
  headline: string,
  style: string
): string {
  const state = focus.day_state || null;
  const stateTitle = cfocusText(state?.title);
  const chip = stateTitle
    ? `<span class="tfc-state tfc-state-${escAttr(cfocusText(state?.posture) || "easy")}" title="${escAttr(cfocusText(state?.line))}">${escHtml(stateTitle)}</span>`
    : "";
  let html = `<div class="${spec.wrap} tfc"${style}><div class="tfc-top"><div class="lbl">Where to focus</div>${chip}</div>`;
  if (headline) html += `<p class="tfc-headline">${escHtml(headline)}</p>`;
  const move = cfocusText(lead.move);
  html += `<div class="tfc-hero">${cfocusDomainDot(lead.domain)}<div class="tfc-hero-body">${cfocusDomainTag(lead.domain)}<div class="${spec.leadTitleClass}">${escHtml(lead.title || "")}</div>`;
  html += move ? `<div class="${spec.moveClass}">${escHtml(move)}</div>` : lead.why ? `<div class="${spec.leadWhyClass}">${escHtml(lead.why)}</div>` : "";
  html += `</div></div>`;
  const also = (Array.isArray(focus.parallel) ? focus.parallel : []).filter((i) => i && cfocusText(i.title)).slice(0, 2);
  if (also.length)
    html += `<div class="tfc-also"><span class="tfc-lbl lbl">Also this week</span><div class="tfc-chips">${also
      .map((i) => `<span class="tfc-chip">${cfocusDomainDot(i.domain)}${escHtml(i.title)}</span>`)
      .join("")}</div></div>`;
  html += cfocusMovedHtml(focus);
  html += cfocusBlockHtml(focus, lead.domain);
  html += cfocusExpandHtml(focus, lead, spec);
  return `${html}${spec.footer}</div>`;
}

Object.assign(globalThis, { cfocusTrainCardHtml });
