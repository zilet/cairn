const FATIGUE_PATTERNS = [
  /\b(?:did(?:n't| not)|do(?:n't| not)) feel (?:very |super )?strong\b/i,
  /\b(?:felt|feeling) (?:flat|weak|drained|under[- ]?fueled|under[- ]?fuelled)\b/i,
  /\bfatigue (?:kicks|sets) in\b/i,
  /\breps? (?:quickly )?(?:fade|faded|drop|dropped|slow|slowed|start to get hard)\b/i,
  /\b(?:strength|muscular) endurance\b/i,
  /\b(?:could|can) (?:barely|hardly|almost not) (?:finish|lift|complete)\b/i,
  /\b(?:almost )?could not (?:finish|lift|complete)\b/i,
  /\bhuge calorie deficit\b/i,
];

export function sessionNoteSuggestsFatigue(note: unknown): boolean {
  const text = String(note ?? "").trim();
  return !!text && FATIGUE_PATTERNS.some((pattern) => pattern.test(text));
}

export function sessionNoteSuggestsRapidFade(note: unknown): boolean {
  const text = String(note ?? "").trim();
  return /\b(?:by|around) (?:the )?(?:fifth|5th|last|end of (?:the )?) rep\b|\bby (?:the )?end of (?:the |every )?set\b|\breps? (?:quickly )?(?:fade|drop|start to get hard)\b|\bfatigue kicks in\b/i.test(
    text
  );
}
