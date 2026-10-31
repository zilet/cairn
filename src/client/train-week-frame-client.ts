// @ts-check
// ---------- Train: This week, the frame (train-week-client.ts paints into it) ----------
// The group bar, the landing and the deeper rows (Progress first). With nothing held, the
// landing is a skeleton shaped like it — the next session's card over the week's label
// and its seven rows — and the deeper rows wait HIDDEN under it, so when the reads land
// the skeleton gives way to the whole landing in one paint and nothing on screen moves
// (twkPaint swaps in `slotsHtml` and unhides the deeper rows together).
//
// LAZY ("train" bundle, ahead of train-week-client.js). No caller text is interpolated.
{
  /** The cold skeleton: the next session's card, then the week's label and its seven rows. */
  function skeletonHtml(): string {
    const rows = Array.from({ length: 7 }, () => `<div class="hshimmer pahead-skel-row"></div>`).join("");
    const lines = Array.from({ length: 3 }, () => `<div class="hshimmer twk-skel-l"></div>`).join("");
    const card = `<div class="card twk-next twk-skel-next"><div class="hshimmer twk-skel-k"></div><div class="hshimmer twk-skel-t"></div>${lines}</div>`;
    return `<div class="twk-skel" aria-busy="true" aria-label="This week">${card}<div class="pahead-skel"><div class="hshimmer pahead-skel-k"></div>${rows}</div></div>`;
  }

  /** The landing's three slots: the next session, the week's days, next week's fold. */
  function slotsHtml(): string {
    return `<div class="twk-next-slot" data-twk-next></div>
    <div data-twk-days></div>
    <details class="twk-fold" data-twk-ahead hidden></details>`;
  }

  /** The frame: the landing's slots when a read is held, else the skeleton with the deeper rows hidden. */
  function frameHtml(held: boolean): string {
    return `${segBar("week", PROGRESS_SEG)}<section class="twk" aria-label="This week" data-twk>${
      held ? slotsHtml() : skeletonHtml()
    }</section><div data-train-deeper-slot${held ? "" : " hidden"}></div>`;
  }

  Object.assign(globalThis, { CairnTrainWeekFrame: { frameHtml, slotsHtml } });
}
