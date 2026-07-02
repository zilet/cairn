(() => {
// @ts-check
// ==== chat-message-client.js ====
// Static chat message rendering: day dividers, bubbles, copy affordances, and
// draft/apply controls shared by the live chat log and read-only history overlay.
function chatMessageRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function chatMessageRows(value) {
    return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
}
function chatMessageMeta(value) {
    return chatMessageRecord(value);
}
function chatMessageApplied(value) {
    return chatMessageRows(value);
}
function chatMessageDrafts(value) {
    return chatMessageRows(value);
}
function chatMessageString(value) {
    return value == null ? "" : String(value);
}
// Convert a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") to a local YYYY-MM-DD
// for day grouping; falls back to today on anything unparseable.
function chatMessageDayISO(ts) {
    return CairnChatClient.dayISO(ts, localISO);
}
function chatDivider(iso) {
    const template = document.createElement("template");
    template.innerHTML = CairnChatClient.dividerHtml(iso, dateLabel(iso)).trim();
    const el = template.content.firstElementChild;
    if (el)
        return el;
    const fallback = document.createElement("div");
    fallback.className = "chat-divider";
    fallback.dataset.day = iso;
    fallback.textContent = dateLabel(iso);
    return fallback;
}
// Local clock time for a chat turn ("2:14 PM"); now when no timestamp (the
// optimistic user bubble). Empty string if unparseable.
function chatClock(ts) {
    const d = ts ? new Date(`${String(ts).replace(" ", "T")}Z`) : new Date();
    if (Number.isNaN(d.getTime()))
        return "";
    try {
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    catch {
        return "";
    }
}
// Copy text to the clipboard with a graceful fallback + a confirming toast.
function copyText(text) {
    const t = String(text || "");
    if (!t)
        return;
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(t).then(() => toast("Copied"), () => toast("Couldn't copy"));
        return;
    }
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand("copy");
        toast("Copied");
    }
    catch {
        toast("Couldn't copy");
    }
    ta.remove();
}
// Touch long-press -> copy (the hover copy button is desktop-only).
function attachLongPressCopy(el, text) {
    let timer = 0;
    const cancel = () => clearTimeout(timer);
    el.addEventListener("touchstart", () => {
        cancel();
        timer = window.setTimeout(() => copyText(text), 500);
    }, { passive: true });
    el.addEventListener("touchmove", cancel, { passive: true });
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchcancel", cancel);
}
const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>`;
// Render one chat turn. `opts.readonly` (history overlay) renders drafts as a
// static note instead of an Apply button. Consecutive same-role turns group:
// the previous one drops its tail + time, this one becomes the run's last.
function appendMsg(m, noScroll = false, parent = null, opts = {}) {
    const log = $("#chatlog");
    const host = parent || log;
    if (!host)
        return null; // log torn down (tab switch mid-stream) -- bail safely
    // Follow to the bottom only when the reader is already near it (measured BEFORE
    // any DOM mutation below grows the log). A turn finalizing while someone scrolled
    // up to re-read must not yank them down (D6 · 200px proximity rule).
    const stickBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 200;
    const readonly = !!opts.readonly;
    // Optional position-preserving insert: a streaming turn finalizes in place even
    // when a queued follow-up's pending bubble already sits below it.
    const before = opts.before && opts.before.isConnected && opts.before.parentElement === host ? opts.before : null;
    if (!noScroll && !parent && log) {
        // a live turn: clear the loading/empty state + starter chips, and make sure
        // it lands under a "Today" divider
        log.querySelector(".loadstate")?.remove();
        log.querySelector(".empty")?.remove();
        log.querySelector(".chat-chips")?.remove();
        const divs = log.querySelectorAll(".chat-divider[data-day]");
        const last = divs[divs.length - 1];
        if (!last || last.dataset.day !== localISO())
            log.appendChild(chatDivider(localISO()));
        const fresh = document.getElementById("hdrFresh");
        if (fresh && state.tab === "chat")
            fresh.hidden = false;
    }
    const role = chatMessageString(m.role);
    // Grouping: continue a same-role run (skip for the pending typing bubble).
    const prev = m.pending ? null : (before ? before.previousElementSibling : host.lastElementChild);
    const cont = !!prev && prev.classList?.contains("bubble") && prev.classList.contains(role) && !prev.classList.contains("pending");
    if (cont) {
        prev.classList.add("grouped");
        prev.querySelector(".bubble-time")?.remove();
    }
    const el = document.createElement("div");
    el.className = `bubble ${role}${m.pending ? " pending" : ""}${cont ? " cont" : ""}${noScroll ? "" : " bubble-in"}`;
    if (m.id != null)
        el.dataset.mid = String(m.id); // anchor for re-attaching a turn's pending bubble after reload
    // Pending = the house typing indicator (breathing dots); an optional caption
    // ("Reading your plate…") leads, the dots follow. Early-return so a pending
    // bubble never picks up a timestamp or copy affordance.
    if (m.pending) {
        // role=status + aria-busy couples the visible "thinking" dots to a screen-
        // reader signal; the caption is the live phase ("Thinking…" -> "Drafting…").
        el.setAttribute("role", "status");
        el.setAttribute("aria-busy", "true");
        const content = chatMessageString(m.content);
        const lead = content && content !== "…" ? `${escHtml(content)} ` : "";
        el.innerHTML = `<div class="bubble-text"><span class="typing-cap">${lead}</span><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
        host.appendChild(el);
        if (!noScroll && log && stickBottom)
            log.scrollTop = log.scrollHeight;
        return el;
    }
    const meta = chatMessageMeta(m.meta);
    let extra = "";
    const applied = chatMessageApplied(meta.applied);
    if (applied.length) {
        extra += `<div class="bubble-meta">${applied.map((a) => `<span class="bubble-tag">✓ ${escHtml(String(a.type).replace(/_/g, " "))}${a.error ? " ⚠" : ""}</span>`).join("")}</div>`;
    }
    const drafts = chatMessageDrafts(meta.drafts);
    if (drafts.length) {
        // Each draft reflects its CURRENT proposal status (stamped server-side). An
        // applied one is a calm "done" note -- no more Apply button to re-trigger it.
        extra += drafts.map((d) => {
            const label = escHtml(d.summary || (d.kind === "restructure" ? "plan restructure" : "plan update"));
            if (d.status === "applied")
                return `<div class="draftbtn applied" aria-disabled="true">✓ Applied · ${label}</div>`;
            if (readonly)
                return `<div class="bubble-meta"><span class="bubble-tag">plan draft</span></div>`;
            return `<button class="draftbtn" data-apply="${escAttr(d.id)}">Apply: ${label}</button>`;
        }).join("");
    }
    // A substantial pasted lab awaits one-tap confirmation before it writes to Health
    // records (propose→apply for a big write). Each reflects its doc's current status.
    const labConfirms = chatMessageRows(meta.lab_confirms);
    if (labConfirms.length) {
        extra += labConfirms.map((l) => {
            const status = chatMessageString(l.status);
            if (status === "missing")
                return ""; // dismissed / deleted — nothing to offer
            // Anything past pending_confirm (pending/in_progress/done) means committed.
            if (status && status !== "pending_confirm")
                return `<div class="draftbtn applied" aria-disabled="true">✓ Saved to Health</div>`;
            const est = Number(l.marker_estimate) || 0;
            const label = est ? `Save ~${est} lab results to Health` : "Save lab results to Health";
            if (readonly)
                return `<div class="bubble-meta"><span class="bubble-tag">lab draft</span></div>`;
            return `<button class="draftbtn" data-confirm-lab="${escAttr(l.id)}">${escHtml(label)}</button>`;
        }).join("");
    }
    const hideText = !!meta.image && (!m.content || m.content === "(photo)");
    const body = hideText ? "" : role === "assistant"
        ? `<div class="bubble-text md">${mdToHtml(m.content)}</div>`
        : `<div class="bubble-text">${escHtml(m.content)}</div>`;
    const rawPhoto = meta.image;
    const photoSrc = rawPhoto && String(rawPhoto).startsWith("/api/chat-images/")
        ? withToken(String(rawPhoto))
        : rawPhoto;
    const photo = photoSrc ? `<img class="bubble-img" alt="attached photo" loading="lazy" src="${escAttr(photoSrc)}" data-remove-on-error="1">` : "";
    const time = `<span class="bubble-time">${escHtml(chatClock(m.created_at))}</span>`;
    const canCopy = role === "assistant" && !hideText && !!m.content;
    const copyBtn = canCopy ? `<button class="bubble-copy" aria-label="Copy reply" title="Copy">${COPY_ICON}</button>` : "";
    el.innerHTML = `${copyBtn}${photo}${body}${extra}${time}`;
    if (before)
        host.insertBefore(el, before);
    else
        host.appendChild(el);
    el.querySelectorAll("[data-apply]").forEach((b) => {
        const btn = b instanceof HTMLButtonElement ? b : null;
        if (!btn)
            return;
        btn.addEventListener("click", async () => {
            btn.disabled = true;
            let r = null;
            try {
                r = await api(`/proposals/${btn.dataset.apply || ""}/apply`, { method: "POST" });
            }
            catch {
                r = null;
            }
            // Honest failure (shared with the Coach list via applyResultMessage): a transport
            // drop, a 400 {error}, or ok:false must NOT read as "Applied". Re-enable the button
            // so the draft stays actionable instead of settling into a false "done" note.
            const result = applyResultMessage(r);
            if (result.failed) {
                btn.disabled = false;
                toast(result.message);
                return;
            }
            const clamped = chatMessageRecord(r).clamped;
            const hasClamped = Array.isArray(clamped) && clamped.length > 0;
            toast(result.message);
            state.plan = [];
            swrInvalidate("plan"); // a chat-applied plan change makes the cache stale
            // Settle into the same calm "done" note the message renders on reload, so a
            // just-applied draft and a long-applied one look identical.
            const label = btn.textContent?.replace(/^Apply:\s*/, "") || "";
            const done = document.createElement("div");
            done.className = "draftbtn applied";
            done.setAttribute("aria-disabled", "true");
            done.textContent = `✓ Applied · ${label}`;
            btn.replaceWith(done);
            // A code guardrail nudged a load to a safe step -- show the honest hairline note
            // inline under the bubble's actions (it persists exactly here on this turn).
            if (hasClamped)
                done.insertAdjacentHTML("afterend", clampNoteHtml(clamped));
        });
    });
    // One-tap confirm for a pasted lab draft: commit it to Health records (nothing wrote
    // before this). Mirrors the plan-draft apply flow — honest failure re-enables the button.
    el.querySelectorAll("[data-confirm-lab]").forEach((b) => {
        const btn = b instanceof HTMLButtonElement ? b : null;
        if (!btn)
            return;
        btn.addEventListener("click", async () => {
            btn.disabled = true;
            let r = null;
            try {
                r = await api(`/health-docs/${btn.dataset.confirmLab || ""}/confirm`, { method: "POST" });
            }
            catch {
                r = null;
            }
            const rec = chatMessageRecord(r);
            if (!r || rec.error || rec.ok === false) {
                btn.disabled = false;
                toast("Couldn't save — try again");
                return;
            }
            toast("Saved to Health");
            const done = document.createElement("div");
            done.className = "draftbtn applied";
            done.setAttribute("aria-disabled", "true");
            done.textContent = "✓ Saved to Health";
            btn.replaceWith(done);
        });
    });
    if (canCopy) {
        el.querySelector(".bubble-copy")?.addEventListener("click", () => copyText(m.content));
        attachLongPressCopy(el, m.content);
    }
    if (!noScroll && log && stickBottom && (!before || before === host.lastElementChild))
        log.scrollTop = log.scrollHeight;
    return el;
}
Object.assign(globalThis, {
    appendMsg,
    chatDayISO: chatMessageDayISO,
    chatDivider,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        appendMsg,
        chatDayISO: chatMessageDayISO,
        chatDivider,
    });
}
})();
