type DailyOutcomeReconcileHook = (date: string) => void;

let dailyOutcomeReconcileHook: DailyOutcomeReconcileHook | null = null;

export function registerDailyOutcomeReconcileHook(hook: DailyOutcomeReconcileHook): void {
  dailyOutcomeReconcileHook = hook;
}

export function requestDailyOutcomeReconciliation(date: string): void {
  if (!dailyOutcomeReconcileHook) return;
  try {
    dailyOutcomeReconcileHook(date);
  } catch {
    /* additive learning is never load-bearing on symptom writes */
  }
}
