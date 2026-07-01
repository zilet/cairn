(() => {
// @ts-check
// Week/date labels for quiet Capture reads.
// "Jun 9-15" -- the Monday-Sunday week containing the read's date. Empty when
// the date is missing/unparseable (then the masthead shows just "The week").
function captureReadWeekRangeLabel(iso) {
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
const CAIRN_CAPTURE_READ_DATE = {
    weekRangeLabel: captureReadWeekRangeLabel,
};
Object.assign(globalThis, { CairnCaptureReadDate: CAIRN_CAPTURE_READ_DATE });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnCaptureReadDate: CAIRN_CAPTURE_READ_DATE });
}
})();
