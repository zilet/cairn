// @ts-check
// ==== chat-speaker-client.js ====
// The speaker line on a team reply in Ask (Atelier v2): a stone dot + a mono name.
{
  // Who is speaking on a team reply: the stone the turn acted on, by what it logged or
  // changed (a meal is Fuel, a set or a plan change is Strength), else the Team as one
  // voice. A dot in that stone's own hue and a small mono name lead the bubble; it is a
  // label for where the reply landed, never a separate persona.
  const CHAT_SPEAKER_STONES: Record<string, string> = {
    log_food: "fuel",
    update_food_note: "fuel",
    log_set: "strength",
    plan_update: "strength",
    plan_restructure: "strength",
    flag_training_structure: "strength",
    set_strength_objective: "strength",
    set_strength_schedule: "strength",
    set_training_intent: "strength",
    log_activity: "endurance",
    set_run: "endurance",
    set_endurance_goal: "endurance",
    set_endurance_schedule: "endurance",
    set_activity_effort: "endurance",
    log_checkin: "recovery",
    set_training_drive: "strength",
    report_training_symptom: "recovery",
    resolve_training_symptom: "recovery",
    set_movement_considerations: "recovery",
    log_weight: "body",
    log_measurement: "body",
    log_health: "heart",
    log_blood_pressure: "heart",
    log_supplement: "heart",
  };
  const CHAT_SPEAKER_NAMES: Record<string, string> = {
    fuel: "Fuel",
    strength: "Strength",
    endurance: "Endurance",
    recovery: "Recovery",
    body: "Body",
    heart: "Heart",
  };

  function chatSpeaker(actions: ChatScreenAppliedAction[], drafts: ChatScreenDraft[]): { stone: string; name: string } {
    for (const action of actions) {
      const stone = CHAT_SPEAKER_STONES[String((action as Record<string, unknown>)?.type ?? "")];
      if (stone) return { stone, name: CHAT_SPEAKER_NAMES[stone] };
    }
    if (drafts.length) return { stone: "strength", name: CHAT_SPEAKER_NAMES.strength };
    return { stone: "", name: "Team" };
  }

  function chatSpeakerHtml(speaker: { stone: string; name: string }): string {
    const tone = speaker.stone ? ` stone-${speaker.stone}` : " is-team";
    return `<div class="bubble-who lbl"><span class="dot${tone}" aria-hidden="true"></span>${escHtml(speaker.name)}</div>`;
  }

  /** The speaker line for one team reply, from what the turn applied or drafted. */
  function chatSpeakerForTurn(actions: ChatScreenAppliedAction[], drafts: ChatScreenDraft[]): string {
    return chatSpeakerHtml(chatSpeaker(actions, drafts));
  }

  const CAIRN_CHAT_SPEAKER = { speaker: chatSpeaker, html: chatSpeakerHtml, forTurn: chatSpeakerForTurn };

  Object.assign(globalThis, { CairnChatSpeaker: CAIRN_CHAT_SPEAKER });
}
