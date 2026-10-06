// @ts-check
// Week/date labels for quiet Capture reads.

// "Jun 9-15" -- the Monday-Sunday week containing the read's date. Empty when
// the date is missing/unparseable (then the masthead shows just "The week").
function captureReadWeekRangeLabel(iso: unknown): string {
  const s = String(iso || "").slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return "";
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // 0 = Monday
  const at = (n: number): string => new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  const mon = at(-dow);
  const sun = at(6 - dow);
  return mon.slice(5, 7) === sun.slice(5, 7)
    ? `${CairnFmt.date(mon, { fmt: { month: "short" } })} ${Number(mon.slice(8))}–${Number(sun.slice(8))}`
    : `${CairnFmt.date(mon, { year: false })} – ${CairnFmt.date(sun, { year: false })}`;
}

const CAIRN_CAPTURE_READ_DATE: CaptureReadDateApi = {
  weekRangeLabel: captureReadWeekRangeLabel,
};

Object.assign(globalThis, { CairnCaptureReadDate: CAIRN_CAPTURE_READ_DATE });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnCaptureReadDate: CAIRN_CAPTURE_READ_DATE });
}
