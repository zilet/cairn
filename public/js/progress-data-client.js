(() => {
// @ts-check
// Shared Progress data normalization helpers.
function progressDataIsRecord(value) {
    return !!value && typeof value === "object";
}
function progressDataRecord(value) {
    return progressDataIsRecord(value) ? value : {};
}
function progressDataRows(value) {
    return Array.isArray(value) ? value.filter(progressDataIsRecord) : [];
}
function progressDataString(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
}
function progressDataNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
const CAIRN_PROGRESS_DATA = {
    isRecord: progressDataIsRecord,
    record: progressDataRecord,
    rows: progressDataRows,
    string: progressDataString,
    number: progressDataNumber,
};
Object.assign(globalThis, {
    CairnProgressData: CAIRN_PROGRESS_DATA,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressData: CAIRN_PROGRESS_DATA,
    });
}
})();
