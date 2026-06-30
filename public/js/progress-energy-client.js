// @ts-check
// Progress Energy Balance read helpers.
const ENERGY_CONF_WORD = { high: "well-established", medium: "settling in", low: "still early" };
function kcalFmt(value) {
    return Math.round(Number(value) || 0).toLocaleString();
}
function energyRead(exp) {
    if (!exp || exp.tdee == null || exp.confidence === "none") {
        return {
            lead: "Not enough logged yet to estimate.",
            body: "Keep logging meals and the odd weigh-in when you can — once there's a few weeks of data, I'll read your real energy balance here.",
            tone: "quiet",
        };
    }
    const trend = exp.trend_lb_wk == null ? null : Number(exp.trend_lb_wk);
    const dir = trend == null ? null : trend < -0.05 ? "down" : trend > 0.05 ? "up" : "flat";
    const rate = trend == null ? "" : `about ${Math.abs(Math.round(trend * 10) / 10)} lb/week`;
    const intake = exp.intake_avg_kcal != null ? `eating ~${kcalFmt(exp.intake_avg_kcal)} kcal/day` : "";
    let movement = "";
    if (dir === "down")
        movement = `trending down ${rate}`;
    else if (dir === "up")
        movement = `trending up ${rate}`;
    else if (dir === "flat")
        movement = "holding steady";
    const lead = [intake, movement].filter(Boolean).join(", ") || "Reading your energy balance.";
    return { lead: lead.charAt(0).toUpperCase() + lead.slice(1) + ".", body: "", tone: "read", dir };
}
const CAIRN_PROGRESS_ENERGY = {
    CONF_WORD: ENERGY_CONF_WORD,
    kcalFmt,
    energyRead,
};
Object.assign(globalThis, {
    CairnProgressEnergy: CAIRN_PROGRESS_ENERGY,
    CONF_WORD: ENERGY_CONF_WORD,
    kcalFmt,
    energyRead,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressEnergy: CAIRN_PROGRESS_ENERGY,
        CONF_WORD: ENERGY_CONF_WORD,
        kcalFmt,
        energyRead,
    });
}
