// @ts-check
// The training drive on Today, the view (ClientDayRead.push, src/contracts/training-drive.ts):
//
//   - THE PUSH LINE, one quiet line under the Brief's why while push is in force:
//     "Push · until Oct 20 — room for one heavier top set today", or, when something
//     holds the day back, "Push · until Oct 20 — holding today:" with the holds as
//     two or three plain chips ("short night", "chest still recovering"). A chip opens
//     the Brief's own "tap to see why", where the holds are said in full. A stance that
//     just ran out is said once, never silently dropped.
//   - THE PUSH OFFER, the coach's open question ("You're carrying this well — want to
//     open the throttle for the next two weeks?"): a calm pull card with the log's
//     evidence and two answers, never a notification. Absent → nothing at all.
//
// Words are the server's own (line, evidence, labels, holds); the chips are the holds'
// SHORT form, their full words in the chip's label and the why panel. No score, no
// number about the athlete beyond dates. Pure string builders; every string escaped.
//
// LAZY (today-ahead bundle). Mounted by today-push-controller.ts.
{
  type DriveRead = import("../contracts/training-drive.js").ClientTrainingDriveRead;
  type DriveHold = import("../contracts/training-drive.js").ClientTrainingDriveHold;
  type PushOffer = import("../contracts/training-drive.js").ClientPushOffer;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const COUNT = ["no", "one", "two", "three", "four"];

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** "2026-10-20" → "Oct 20"; "" for anything else. */
  function monthDay(iso: unknown): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
    return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : "";
  }

  // The leading words a hold's sentence opens with that a chip does without.
  const LEAD = /^(?:a |an |the |this morning's |last night's |your |how )+/i;

  /** A plain clause, short: no leading article, nothing past its first comma. */
  function clause(words: string): string {
    const head = text(words).split(/[,;:—]/)[0] || "";
    return text(head.replace(LEAD, ""));
  }

  /**
   * A hold's chip: the few words a glance needs ("short night", "chest still
   * recovering", "Bench Press holding"). The full sentence rides the chip's label and
   * the why panel, so nothing is lost by the short form.
   */
  function chipLabels(hold: DriveHold, kind: string): string[] {
    const words = text(hold?.words);
    switch (hold?.code) {
      case "quiet_day":
        return [kind === "rest" ? "today reads rest" : "today reads easy"];
      case "signal":
        // "a short night and last night's HRV, outside your usual band" → two chips.
        return words
          .split(/ and /)
          .map(clause)
          .filter(Boolean);
      case "recovering_group": {
        const group = text(words.split(/ is still/)[0]);
        return [group ? `${group} still recovering` : "still recovering"];
      }
      case "lift_hold": {
        const lift = text(words.split(":")[0]);
        return [lift ? `${lift} holding` : "a lift holding"];
      }
      case "deload":
        return ["a lighter week"];
      case "underpowered":
        return ["last session under par"];
      case "recovery_low":
        return ["recovery reading low"];
      case "soreness":
        return ["soreness"];
      case "fueling":
        return ["fueling light"];
      case "injury":
        return ["working around an injury"];
      case "stance_harm":
        return ["a recent day cost something"];
      case "stack_ceiling": {
        const n = Number.parseInt(words, 10);
        return [Number.isFinite(n) && n > 0 ? `${n} days in a row` : "a long run of days"];
      }
      case "preference":
        return ["longevity first"];
      case "not_vouched":
        return ["nothing vouching yet"];
      default:
        return words ? [clause(words)] : [];
    }
  }

  type Chip = { label: string; words: string };

  /**
   * At most three chips, most decisive first. The day's own quiet read is the why
   * above (said once): it becomes a chip only when nothing else holds the day.
   */
  function chipsOf(push: DriveRead | null | undefined, kind: string): Chip[] {
    const holding = Array.isArray(push?.today?.holding) ? push!.today!.holding : [];
    const own = holding.filter((h) => h && h.code !== "quiet_day");
    const pick = own.length ? own : holding;
    const out: Chip[] = [];
    for (const hold of pick) {
      for (const label of chipLabels(hold, kind)) {
        const short = label.length > 32 ? `${label.slice(0, 31).trimEnd()}…` : label;
        if (short && !out.some((c) => c.label.toLowerCase() === short.toLowerCase()) && out.length < 3)
          out.push({ label: short, words: text(hold.words) });
      }
    }
    return out;
  }

  /** "two heavier top sets" from the day's licensed hosts. */
  function reachWords(hosts: unknown): string {
    const n = Math.max(1, Math.min(4, Math.round(Number(hosts) || 1)));
    return `${COUNT[n]} heavier top set${n === 1 ? "" : "s"}`;
  }

  /**
   * The push line and its chips; "" when the drive is steady and no stance just ended.
   * `kind` is the Brief's day kind (the quiet-day chip's word).
   */
  function stateHtml(push: DriveRead | null | undefined, kind = "train"): string {
    if (!push || typeof push !== "object") return "";
    if (push.drive !== "push") {
      const ended = text(push.ended?.line);
      return ended ? `<p class="tpush-line is-ended"><span class="lbl tpush-k">Push</span> <span class="tpush-t">${escHtml(ended)}</span></p>` : "";
    }
    const until = monthDay(push.stance?.until);
    const today = push.today || null;
    const chips = today && !today.reaching ? chipsOf(push, kind) : [];
    const tail = today?.reaching
      ? `room for ${reachWords(today.reach_hosts)} today`
      : chips.length
        ? "holding today:"
        : "";
    const said = [until ? `until ${until}` : "", tail].filter(Boolean).join(" — ");
    const line = `<p class="tpush-line"><span class="lbl tpush-k">Push</span>${said ? ` <span class="tpush-t">${escHtml(said)}</span>` : ""}</p>`;
    const chipRow = chips.length
      ? `<div class="tpush-chips" role="group" aria-label="What is holding today back">${chips
          .map(
            (c) =>
              `<button type="button" class="tpush-chip" data-tpush-why aria-expanded="false" aria-label="${escAttr(`${c.words || c.label} — tap to see why`)}"><span class="tpush-chip-t">${escHtml(c.label)}</span></button>`
          )
          .join("")}</div>`
      : "";
    return `<div class="tpush" data-wired>${line}${chipRow}</div>`;
  }

  /**
   * The why panel's push section: the server's honest "why not more" sentence and every
   * hold in full. "" when nothing holds the day.
   */
  function whyHtml(push: DriveRead | null | undefined): string {
    const today = push?.drive === "push" ? push.today : null;
    const all = Array.isArray(today?.holding) ? today!.holding.filter((h) => h && text(h.words)) : [];
    // The day's own quiet read IS the why above the panel: listed only when nothing else holds.
    const own = all.filter((h) => h.code !== "quiet_day");
    const holding = own.length ? own : all;
    if (!holding.length) return "";
    const line = text(today?.line);
    return `<div class="tpush-why" data-tpush-panel>
      <span class="lbl tpush-why-k">Why not more today</span>
      ${line ? `<p class="tpush-why-line">${escHtml(line)}</p>` : ""}
      <ul class="tpush-why-list">${holding.map((h) => `<li>${escHtml(text(h.words))}</li>`).join("")}</ul>
    </div>`;
  }

  /** The offer's id when it is a real one; null for an absent or malformed offer. */
  function offerId(offer: PushOffer | null | undefined): number | null {
    const id = Number(offer?.decision_id);
    return offer && text(offer.line) && Number.isFinite(id) && id > 0 ? id : null;
  }

  /**
   * The coach's push offer as a calm pull card: the question, the log's evidence, how
   * long it would run, and the two answers. "" when there is no offer (or it was waved
   * off on this device). Never a modal, never a badge.
   */
  function offerHtml(offer: PushOffer | null | undefined): string {
    const id = offerId(offer);
    if (id == null) return "";
    const evidence = (Array.isArray(offer!.evidence) ? offer!.evidence : []).map(text).filter(Boolean).slice(0, 4);
    const until = monthDay(offer!.until);
    const accept = text(offer!.accept_label) || "Push me for two weeks";
    const dismiss = text(offer!.dismiss_label) || "Not now";
    return `<section class="tpush-offer" data-wired data-tpush-offer="${escAttr(String(id))}" aria-labelledby="tpushOfferQ">
      <span class="lbl tpush-offer-k">An open question</span>
      <p class="tpush-offer-q" id="tpushOfferQ">${escHtml(text(offer!.line))}</p>
      ${evidence.length ? `<ul class="tpush-offer-ev">${evidence.map((e) => `<li>${escHtml(e)}</li>`).join("")}</ul>` : ""}
      ${until ? `<p class="tpush-offer-until">${escHtml(`It would run through ${until}, then go back to steady on its own. Rest-grade mornings, symptoms and health findings still come first.`)}</p>` : ""}
      <div class="tpush-offer-btns" data-tpush-offer-btns>
        <button class="btn btn-solid" type="button" data-tpush-accept>${escHtml(accept)}</button>
        <button class="btn" type="button" data-tpush-dismiss>${escHtml(dismiss)}</button>
      </div>
    </section>`;
  }

  /** The card's own calm state while an answer is in flight (optimistic, said plainly). */
  function answeringHtml(offer: PushOffer | null | undefined, accepted: boolean): string {
    const until = monthDay(offer?.until);
    const said = accepted
      ? `Opening the throttle${until ? ` through ${until}` : ""}…`
      : "Noted — not now.";
    return `<p class="tpush-offer-said" role="status">${escHtml(said)}</p>`;
  }

  const CAIRN_TODAY_PUSH = {
    stateHtml,
    offerHtml,
    answeringHtml,
    whyHtml,
    chipsOf,
    offerId,
    monthDay,
  };

  Object.assign(globalThis, { CairnTodayPush: CAIRN_TODAY_PUSH });
}
