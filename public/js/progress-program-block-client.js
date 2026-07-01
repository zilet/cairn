(() => {
// @ts-check
// Progress program-block card and controls.
function blockFocusWord(focus) {
    if (focus === "strength")
        return "Strength";
    if (focus === "hypertrophy")
        return "Hypertrophy";
    if (focus === "endurance-base")
        return "Endurance base";
    if (focus === "peak")
        return "Peak";
    return focus ? String(focus) : "";
}
function activeBlockHtml(block) {
    if (!block)
        return "";
    const b = block;
    const meta = [blockFocusWord(b.focus), phaseWord(b.phase)].filter(Boolean).join(" · ");
    return `<div class="pblock pblock-active">
    <div class="pblock-head">
      <span class="pblock-kicker lbl">Current block</span>
      <span class="pblock-week lbl">week ${Number(b.week_index)} of ${Number(b.total_weeks)}</span>
    </div>
    <div class="pblock-goal">${escHtml(b.goal || "Training block")}</div>
    ${meta ? `<div class="pblock-meta lbl">${escHtml(meta)}</div>` : ""}
    <div class="pblock-actions">
      <button class="pillbtn" type="button" data-blockadvance="${escAttr(b.id)}">Advance week</button>
      <button class="pillbtn" type="button" data-blockcomplete="${escAttr(b.id)}">Complete</button>
    </div>
  </div>`;
}
function startBlockHtml() {
    return `<div class="pblock">
    <button class="linkbtn" type="button" data-blockstart>+ Start a training block</button>
    <div class="pblock-composer" hidden>
      <input class="pblock-goal-in" type="text" autocomplete="off" placeholder="goal — e.g. Build squat + 10k base" aria-label="Block goal">
      <div class="pblock-composer-row">
        <select class="pblock-focus-in" aria-label="Focus">
          <option value="strength">Strength</option>
          <option value="hypertrophy">Hypertrophy</option>
          <option value="endurance-base">Endurance base</option>
          <option value="peak">Peak</option>
        </select>
        <input class="pblock-weeks-in" type="number" inputmode="numeric" min="2" max="12" value="5" aria-label="Weeks">
        <span class="lbl">weeks</span>
        <button class="pillbtn pill-accent" type="button" data-blockcreate>Start</button>
      </div>
    </div>
  </div>`;
}
async function loadProgramBlock() {
    const slot = view.querySelector("#progBlockSlot");
    if (!slot)
        return;
    let block = null;
    try {
        block = await api("/program/blocks/active");
    }
    catch {
        return;
    }
    if (state.tab !== "progress" || !slot.isConnected)
        return;
    slot.innerHTML = block ? activeBlockHtml(block) : startBlockHtml();
    wireProgramBlock(slot);
}
function wireProgramBlock(slot) {
    const refresh = () => {
        swrInvalidate("plan:coach");
        loadProgramBlock();
    };
    const post = async (path, okMsg) => {
        try {
            const result = (await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
            if (result?.error) {
                toast("Couldn't update the block");
                return;
            }
            if (okMsg)
                toast(okMsg);
            refresh();
        }
        catch {
            toast("Couldn't update the block");
        }
    };
    slot.querySelector("[data-blockstart]")?.addEventListener("click", () => {
        const composer = slot.querySelector(".pblock-composer");
        if (composer) {
            composer.hidden = false;
            slot.querySelector(".pblock-goal-in")?.focus();
        }
    });
    slot.querySelector("[data-blockcreate]")?.addEventListener("click", async () => {
        const goal = (slot.querySelector(".pblock-goal-in")?.value || "").trim();
        const focus = slot.querySelector(".pblock-focus-in")?.value || "strength";
        const total_weeks = Number(slot.querySelector(".pblock-weeks-in")?.value) || 5;
        try {
            const result = (await api("/program/blocks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ goal: goal || "Training block", focus, total_weeks }),
            }));
            if (result?.id) {
                toast("Block started — the coach will periodize toward it");
                refresh();
            }
            else {
                toast("Couldn't start the block");
            }
        }
        catch {
            toast("Couldn't start the block");
        }
    });
    const advanceButton = slot.querySelector("[data-blockadvance]");
    if (advanceButton) {
        advanceButton.addEventListener("click", () => post(`/program/blocks/${advanceButton.dataset.blockadvance}/advance`, "Moved to the next week"));
    }
    const completeButton = slot.querySelector("[data-blockcomplete]");
    if (completeButton) {
        completeButton.addEventListener("click", () => armDelete(completeButton, () => post(`/program/blocks/${completeButton.dataset.blockcomplete}/complete`, "Block completed")));
    }
}
const CAIRN_PROGRESS_PROGRAM_BLOCK = {
    blockFocusWord,
    activeBlockHtml,
    startBlockHtml,
    loadProgramBlock,
    wireProgramBlock,
};
Object.assign(globalThis, {
    CairnProgressProgramBlock: CAIRN_PROGRESS_PROGRAM_BLOCK,
    blockFocusWord,
    activeBlockHtml,
    startBlockHtml,
    loadProgramBlock,
    wireProgramBlock,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressProgramBlock: CAIRN_PROGRESS_PROGRAM_BLOCK,
        blockFocusWord,
        activeBlockHtml,
        startBlockHtml,
        loadProgramBlock,
        wireProgramBlock,
    });
}
})();
