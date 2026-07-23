export {};

declare global {
  declare let pollToken: number;
  declare let primaryDiscipline: string;
  declare const PROGRESS_SEG: readonly ClientSegment[];
  declare const PROGRESS_HANDLERS: Record<string, () => unknown>;
  declare const PLAN_HANDLERS: Record<string, () => unknown>;
  declare const art: (fn: string, ...args: unknown[]) => string;
  declare const stagger: (index?: number | null) => string;
  declare const reducedMotion: () => boolean;
  declare const fmtK: (value: unknown) => string;
  declare const sleep: (ms: number) => Promise<void>;
  declare function isEndurance(): boolean;
  declare function isHybrid(): boolean;
  declare function showEnduranceTab(): boolean;
  declare function withViewTransition(fn: () => unknown): Promise<unknown>;
  declare function loadChatFuel(token: number, messages?: unknown[]): Promise<void>;
}
