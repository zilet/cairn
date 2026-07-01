(() => {
// @ts-check
// Quiet Today reads controller for Capture.
// "Jun 9-15" -- the Monday-Sunday week containing the read's date. Empty when
// the date is missing/unparseable (then the masthead shows just "The week").
function captureReadsWeekRangeLabel(iso) {
    const s = String(iso || "").slice(0, 10);
    const [y, m, d] = s.split("-").map(Number);
    if (!y || !m || !d)
        return "";
    const date = new Date(y, m - 1, d);
    if (Number.isNaN(date.getTime()))
        return "";
    const dow = (date.getDay() + 6) % 7; // 0 = Monday
    const mon = new Date(date);
    mon.setDate(date.getDate() - dow);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const long = (dt) => dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return mon.getMonth() === sun.getMonth()
        ? `${mon.toLocaleDateString(undefined, { month: "short" })} ${mon.getDate()}–${sun.getDate()}`
        : `${long(mon)} – ${long(sun)}`;
}
function createCaptureReadsController(deps) {
    const storage = deps.storage || null;
    const slot = (selector) => deps.root.querySelector(selector);
    const burnGate = (key) => {
        try {
            storage?.setItem(key, String(Date.now()));
        }
        catch { }
    };
    const lastGate = (key) => {
        try {
            return Number(storage?.getItem(key) || 0);
        }
        catch {
            return 0;
        }
    };
    // One fetch of GET /api/insights, split into two calm surfaces under the Brief:
    // the WEEKLY READ ("how the week went + the one change") and the one-at-a-time
    // CONNECTION insight. Empty means nothing renders; producers stay backgrounded.
    async function loadTodayReads() {
        const wSlot = slot("#weeklySlot");
        const iSlot = slot("#insightSlot");
        if (!wSlot && !iSlot)
            return;
        let list = [];
        try {
            list = await deps.api("/insights");
        }
        catch {
            list = [];
        }
        if (deps.state.tab !== "today")
            return;
        const arr = Array.isArray(list) ? list : [];
        if (wSlot && wSlot.isConnected) {
            const weekly = arr.find((i) => i && i.kind === "weekly_read");
            if (weekly)
                renderWeeklyInSlot(wSlot, weekly);
            else {
                wSlot.innerHTML = "";
                maybeGenerateWeekly();
            }
        }
        if (iSlot && iSlot.isConnected) {
            const conn = arr.find((i) => i && i.kind !== "weekly_read");
            if (conn)
                renderInsightInSlot(iSlot, conn);
            else {
                iSlot.innerHTML = "";
                maybeGenerateInsight();
            }
        }
    }
    function renderInsightInSlot(target, ins) {
        if (!target || !ins)
            return;
        renderInsightCard(target, ins);
        if (ins.status === "new") {
            deps.api(`/insights/${ins.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "seen" }),
            }).catch(() => { });
        }
    }
    function maybeGenerateInsight() {
        const target = slot("#insightSlot");
        if (!target)
            return;
        if (Date.now() - lastGate("cairn:lastInsightGen") < 20 * 3600 * 1000)
            return;
        deps.runOp("insight", {}, {
            path: "/insights/generate",
            anchor: "#insightSlot",
            guard: () => !slot("#insightSlot")?.isConnected,
            isFail: (r) => {
                const result = r;
                return !result || result.ok === false || !result.insight;
            },
            render: (r) => {
                const result = r;
                burnGate("cairn:lastInsightGen");
                if (deps.state.tab !== "today")
                    return;
                const s = slot("#insightSlot");
                if (s && result.insight)
                    renderInsightInSlot(s, result.insight);
            },
            onFail: (err) => {
                if (err)
                    burnGate("cairn:lastInsightGen");
            },
        });
    }
    function reconnectInsight() {
        if (deps.state.tab !== "today")
            return null;
        const target = slot("#insightSlot");
        if (!target)
            return null;
        const isFail = (r) => !r || r.ok === false || !r.insight;
        return {
            guard: () => !slot("#insightSlot")?.isConnected,
            onDone: (r) => {
                const result = r;
                if (isFail(result)) {
                    burnGate("cairn:lastInsightGen");
                    return;
                }
                burnGate("cairn:lastInsightGen");
                if (deps.state.tab !== "today")
                    return;
                const s = slot("#insightSlot");
                if (s && result?.insight)
                    renderInsightInSlot(s, result.insight);
            },
            onError: () => { },
            onCanceled: () => { },
        };
    }
    function renderInsightCard(target, ins) {
        const text = deps.escapeHtml(String(ins.text || ""));
        const step = String(ins.next_step || "").trim();
        const why = String(ins.rationale || "").trim();
        const kicker = ins.kind === "weekly_read" ? "This week" : "A connection worth noting";
        const soft = ins.uncertain === true || ins.confidence === "low";
        const lead = soft ? `<span class="insight-soft">Worth looking into · </span>` : "";
        target.innerHTML = `<section class="insight-card settle-in${soft ? " insight-card-soft" : ""}">
      <div class="insight-kicker lbl"><span class="insight-glyph" aria-hidden="true">✦</span> ${kicker}</div>
      <p class="insight-text">${lead}${text}</p>
      ${step ? `<p class="insight-step"><span class="insight-step-lbl">Worth trying</span>${deps.escapeHtml(step)}</p>` : ""}
      ${why ? `<p class="insight-why" hidden>${deps.escapeHtml(why)}</p>` : ""}
      <div class="insight-foot">
        <div class="insight-acts">
          <button class="insight-act insight-act-go" data-ifb="up">Got it</button>
          <button class="insight-act" data-ifb="down">Not useful</button>
        </div>
        ${why ? `<button class="insight-why-more" data-iwhy aria-expanded="false">why this</button>` : ""}
      </div>
    </section>`;
        target.querySelectorAll("[data-ifb]").forEach((button) => button.addEventListener("click", () => insightFeedback(target, ins, button.dataset.ifb)));
        wireWhyToggle(target, ".insight-why");
    }
    async function insightFeedback(target, ins, dir, cardSel = ".insight-card") {
        const card = target.querySelector(cardSel);
        const body = dir === "up"
            ? { feedback: "up", status: "dismissed" }
            : { status: "dismissed" };
        deps.api(`/insights/${ins.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }).catch(() => { });
        if (dir === "up")
            deps.toast("Noted — I'll remember");
        if (card)
            deps.collapseEl(card, () => {
                target.innerHTML = "";
            });
        else
            target.innerHTML = "";
    }
    function renderWeeklyInSlot(target, ins) {
        if (!target || !ins)
            return;
        renderWeeklyCard(target, ins);
        if (ins.status === "new") {
            deps.api(`/insights/${ins.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "seen" }),
            }).catch(() => { });
        }
    }
    function renderWeeklyCard(target, ins) {
        const text = deps.escapeHtml(String(ins.text || ""));
        const change = String(ins.next_step || "").trim();
        const why = String(ins.rationale || "").trim();
        const range = captureReadsWeekRangeLabel(ins.created_at);
        target.innerHTML = `<section class="weekly-card settle-in">
      <div class="weekly-head">
        <span class="weekly-kicker lbl">The week</span>
        ${range ? `<span class="weekly-range">${deps.escapeHtml(range)}</span>` : ""}
      </div>
      <p class="weekly-text">${text}</p>
      ${change ? `<div class="weekly-change">
          <span class="weekly-change-lbl lbl">One change</span>
          <p class="weekly-change-text">${deps.escapeHtml(change)}</p>
        </div>` : ""}
      ${why ? `<p class="weekly-why" hidden>${deps.escapeHtml(why)}</p>` : ""}
      <div class="weekly-foot">
        <div class="insight-acts">
          <button class="insight-act insight-act-go" data-ifb="up">Got it</button>
          <button class="insight-act" data-ifb="down">Not useful</button>
        </div>
        ${why ? `<button class="insight-why-more" data-iwhy aria-expanded="false">why this</button>` : ""}
      </div>
    </section>`;
        target.querySelectorAll("[data-ifb]").forEach((button) => button.addEventListener("click", () => insightFeedback(target, ins, button.dataset.ifb, ".weekly-card")));
        wireWhyToggle(target, ".weekly-why");
    }
    function maybeGenerateWeekly() {
        const target = slot("#weeklySlot");
        if (!target)
            return;
        const dow = new Date().getDay(); // 0 Sun ... 6 Sat
        if (!(dow === 0 || dow === 5 || dow === 6))
            return;
        if (Date.now() - lastGate("cairn:lastWeeklyGen") < 6 * 24 * 3600 * 1000)
            return;
        deps.runOp("weekly_read", { kind: "weekly_read" }, {
            path: "/insights/generate",
            anchor: "#weeklySlot",
            guard: () => !slot("#weeklySlot")?.isConnected,
            isFail: (r) => {
                const result = r;
                return !result || result.ok === false || !result.insight;
            },
            render: (r) => {
                const result = r;
                burnGate("cairn:lastWeeklyGen");
                if (deps.state.tab !== "today")
                    return;
                const s = slot("#weeklySlot");
                if (s && result.insight)
                    renderWeeklyInSlot(s, result.insight);
            },
            onFail: (err) => {
                if (err)
                    burnGate("cairn:lastWeeklyGen");
            },
        });
    }
    function wireWhyToggle(target, bodySelector) {
        const whyBtn = target.querySelector("[data-iwhy]");
        const whyEl = target.querySelector(bodySelector);
        if (!whyBtn || !whyEl)
            return;
        whyBtn.addEventListener("click", () => {
            const opening = whyEl.hidden;
            whyEl.hidden = !opening;
            if (opening) {
                whyEl.classList.remove("chip-in");
                void whyEl.offsetWidth;
                whyEl.classList.add("chip-in");
            }
            whyBtn.setAttribute("aria-expanded", String(opening));
            whyBtn.textContent = opening ? "hide" : "why this";
        });
    }
    return {
        weekRangeLabel: captureReadsWeekRangeLabel,
        loadTodayReads,
        reconnectInsight,
    };
}
const CAIRN_CAPTURE_READS = {
    createController: createCaptureReadsController,
    weekRangeLabel: captureReadsWeekRangeLabel,
};
Object.assign(globalThis, {
    CairnCaptureReads: CAIRN_CAPTURE_READS,
    weekRangeLabel: captureReadsWeekRangeLabel,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnCaptureReads: CAIRN_CAPTURE_READS,
        weekRangeLabel: captureReadsWeekRangeLabel,
    });
}
})();
