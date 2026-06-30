// @ts-check
// Progress test-week banner presentation helpers.

type TestWeekRead = {
  due?: unknown;
  why?: unknown;
  key_lifts?: unknown[];
};

async function loadTestWeek(): Promise<void> {
  const slot = view.querySelector("#progTestSlot");
  if (!slot) return;
  let testWeek: TestWeekRead | null = null;
  try {
    testWeek = (await api("/test-week")) as TestWeekRead;
  } catch {
    testWeek = null;
  }
  if (state.tab !== "progress" || state.progressSeg !== "program" || !slot.isConnected) return;
  if (!testWeek || !testWeek.due) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = testWeekBannerHtml(testWeek);
}

function testWeekBannerHtml(testWeek: TestWeekRead | null | undefined): string {
  if (!testWeek) return "";
  const lifts = Array.isArray(testWeek.key_lifts) ? testWeek.key_lifts.filter(Boolean) : [];
  return `<div class="ptest-banner">
      <div class="ptest-head"><span class="ptest-glyph" aria-hidden="true">✦</span><span class="ptest-title">A test week is about due</span></div>
      ${testWeek.why ? `<div class="ptest-why">${escHtml(testWeek.why)}</div>` : ""}
      ${lifts.length ? `<div class="ptest-lifts">${lifts.map((lift) => `<span class="ptest-lift">${escHtml(lift)}</span>`).join("")}</div>` : ""}
    </div>`;
}

const CAIRN_PROGRESS_TEST_WEEK = {
  loadTestWeek,
  testWeekBannerHtml,
};

Object.assign(globalThis, {
  CairnProgressTestWeek: CAIRN_PROGRESS_TEST_WEEK,
  loadTestWeek,
  testWeekBannerHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressTestWeek: CAIRN_PROGRESS_TEST_WEEK,
    loadTestWeek,
    testWeekBannerHtml,
  });
}
