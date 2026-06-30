// @ts-check
// Bottom rest timer shown after logging a set.
const rest = { id: null, remaining: 0, total: 0 };
function ensureRestBar() {
    let bar = document.querySelector(".rest");
    if (!bar) {
        bar = document.createElement("div");
        bar.className = "rest";
        bar.innerHTML = `<div class="rest-fill"></div>
      <div class="rest-row">
        <button class="rest-btn" data-r="-15">−15</button>
        <span class="rest-time"></span>
        <button class="rest-btn" data-r="15">+15</button>
        <button class="rest-btn rest-skip" data-r="0">Skip</button>
      </div>`;
        document.body.appendChild(bar);
        bar.querySelectorAll("[data-r]").forEach((button) => {
            button.addEventListener("click", () => {
                const value = Number(button.dataset.r);
                if (value === 0) {
                    stopRest();
                    return;
                }
                rest.remaining = Math.max(1, rest.remaining + value);
                rest.total = Math.max(rest.total, rest.remaining);
                paintRest();
            });
        });
    }
    return bar;
}
function paintRest() {
    const bar = document.querySelector(".rest");
    if (!bar)
        return;
    const minutes = Math.floor(rest.remaining / 60);
    const seconds = String(rest.remaining % 60).padStart(2, "0");
    const time = bar.querySelector(".rest-time");
    if (time)
        time.textContent = `Rest ${minutes}:${seconds}`;
    const fill = bar.querySelector(".rest-fill");
    if (fill)
        fill.style.width = `${Math.max(0, (rest.remaining / rest.total) * 100)}%`;
}
function startRest(seconds) {
    rest.total = seconds || Number(localStorage.getItem("restSec") || 120);
    rest.remaining = rest.total;
    ensureRestBar().classList.add("show");
    document.body.classList.add("resting");
    paintRest();
    if (rest.id)
        clearInterval(rest.id);
    rest.id = setInterval(() => {
        rest.remaining -= 1;
        if (rest.remaining <= 0) {
            stopRest();
            toast("Rest done");
            if (navigator.vibrate)
                navigator.vibrate(150);
            return;
        }
        paintRest();
    }, 1000);
}
function stopRest() {
    if (rest.id)
        clearInterval(rest.id);
    rest.id = null;
    const bar = document.querySelector(".rest");
    if (bar)
        bar.classList.remove("show");
    document.body.classList.remove("resting");
}
const CAIRN_REST_TIMER = {
    ensureRestBar,
    paintRest,
    startRest,
    stopRest,
};
Object.assign(globalThis, {
    CairnRestTimer: CAIRN_REST_TIMER,
    ensureRestBar,
    paintRest,
    startRest,
    stopRest,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnRestTimer: CAIRN_REST_TIMER,
        ensureRestBar,
        paintRest,
        startRest,
        stopRest,
    });
}
