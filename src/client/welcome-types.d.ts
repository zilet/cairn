// Types for the first-run welcome (welcome-*.ts, the lazy "welcome" bundle) and the
// eager coach link (coach-link-client.ts) that opens it from Today and Ask.

/** One AI provider the welcome offers, shaped from GET /api/settings → agents. */
type CoachLinkProvider = {
  name: string;
  /** The name a person knows it by ("Claude", "ChatGPT", "Google", "Grok"). */
  label: string;
  /** The plain plan line from the server ("Claude Pro or Max"). */
  plan: string;
  usable: boolean;
  present: boolean;
  installable: boolean;
  canLogin: boolean;
  /** Signed in, as far as the server's login probe knows (null: undetectable). */
  configured: boolean | null;
  /** POSITIVELY signed in (the probe said yes, or it answered a hello). Never from null. */
  signedIn: boolean;
};

type CoachLinkModel = {
  onboarded: boolean;
  /** The coach's own welcome (stage 3) has happened. Absent on an older server → true. */
  welcomed: boolean;
  providers: CoachLinkProvider[];
  /** The providers the rotation may use (an undetectable login included). */
  usable: CoachLinkProvider[];
  /** Usable AND positively signed in: the only ones the welcome calls connected. */
  ready: CoachLinkProvider[];
  /** Set when a hosted server's disk fits only about one provider (the picker says so). */
  smallDisk?: { total_mb: number } | null;
};

type WelcomeStage = "hello" | "connect" | "meet";

type WelcomeOpenOptions = {
  stage?: WelcomeStage;
  /** The provider for "connect" (and the one named in "meet"). */
  agent?: string | null;
  /** Replace the current history entry instead of pushing one (the boot open). */
  replace?: boolean;
};

type CoachLinkApi = {
  KEY: string;
  model(raw: unknown): CoachLinkModel;
  /** The last-known model, synchronously (null on a true cold start). */
  peek(): CoachLinkModel | null;
  /** Revalidate against the server; resolves the last-known model when offline. */
  read(): Promise<CoachLinkModel | null>;
  invalidate(): void;
  /** Open the full-screen welcome (loads its lazy bundle first). */
  openWelcome(opts?: WelcomeOpenOptions): void;
  /** Fill Today's #coachLinkSlot: connect, or say hello once a coach is connected. */
  mountToday(root: ParentNode): void;
  /** Ask without a coach: the composer gives way to one calm connect card. */
  mountAsk(dock: HTMLElement): void;
  cardHtml(kind: "today-connect" | "today-hello" | "ask"): string;
};

type WelcomeApi = {
  open(opts?: WelcomeOpenOptions): void;
  /** Leave the welcome for the app (Today unless told otherwise). */
  close(opts?: { markOnboarded?: boolean }): void;
  isOpen(): boolean;
  /** Called first by the app's popstate handler: true when the welcome handled it. */
  popped(): boolean;
};

declare const CairnCoachLink: CoachLinkApi;
declare const CairnWelcome: WelcomeApi;

type WelcomeStepKey = "setup" | "signin" | "hello";
type WelcomeStepState = "waiting" | "working" | "done" | "failed";
type WelcomeWeekRow = { day: string; dayLong: string; name: string; order: number; dow: number | null };

type WelcomePhaseMeta = import("../contracts/client-api.js").ClientWelcomePhaseMeta;

/** What a running welcome has already landed (from its job meta). */
type WelcomePartial = {
  step: string;
  /** The coach's reply, "" until the first pass is done. */
  reply: string;
  /** The fuel step is settled (the week is being built): `fuel` is final, null = none. */
  fuelKnown: boolean;
  fuel: { main: string; sub: string } | null;
  /** The week composer's own phase words, "" when none. */
  detail: string;
};

type WelcomeModelApi = {
  STEPS: ReadonlyArray<{ key: WelcomeStepKey; title: string }>;
  PHASES: ReadonlyArray<{ step: string; text: string }>;
  phaseIndex(job: unknown): number;
  partial(job: unknown): WelcomePartial;
  /** The server marked the job interrupted (a restart mid-run). */
  interrupted(error: unknown): boolean;
  weekRows(week: unknown): WelcomeWeekRow[];
  weekNote(state: unknown, hasRows: boolean): string | null;
  landed(weekState: unknown, fuelState: unknown): boolean;
  fuelLines(fuel: unknown, state: unknown): { main: string; sub: string } | null;
  /** A server message when it already reads as plain words, else the calm fallback. */
  humanMessage(raw: unknown, fallback: string): string;
  /** Leave one privacy-safe diagnostic (step, provider, code, status) for a failed step. */
  reportFailure(step: WelcomeFailureStep, provider: string | null | undefined, code: string, status?: unknown): boolean;
};

type WelcomeWorkingStep = "understand" | "week";

type WelcomeFailureStep = "hello" | "connect.install" | "connect.signin" | "connect.verify" | "meet";

type WelcomeReveal = {
  reply: string;
  week: WelcomeWeekRow[];
  weekNote: string | null;
  fuel: { main: string; sub: string } | null;
};

type WelcomeClientApi = {
  helloHtml(providers: CoachLinkProvider[], unreachable?: boolean, smallDisk?: CoachLinkModel["smallDisk"]): string;
  diskNoteHtml(smallDisk?: CoachLinkModel["smallDisk"]): string;
  connectHtml(provider: CoachLinkProvider): string;
  cairnHtml(laid: number, idPrefix: string): string;
  meetHtml(provider: CoachLinkProvider | null): string;
  userBubbleHtml(text: string): string;
  coachBubbleHtml(text: string): string;
  workingHtml(step?: WelcomeWorkingStep): string;
  fuelHtml(fuel: { main: string; sub: string }): string;
  waitDockHtml(): string;
  revealHtml(reveal: WelcomeReveal): string;
  /** `signIn`: the provider is signed out, so the way on is its sign-in. */
  failBubbleHtml(message: string, signIn?: boolean): string;
  doneDockHtml(inPlace: boolean): string;
};

declare const CairnWelcomeModel: WelcomeModelApi;
declare const CairnWelcomeClient: WelcomeClientApi;

type WelcomeConnectDeps = {
  provider: CoachLinkProvider;
  onSwitch(): void;
  onConnected(provider: CoachLinkProvider): void;
};

type WelcomeMeetDeps = {
  provider: CoachLinkProvider | null;
  onReconnect(): void;
  onDone(): void;
  /** Leave the welcome for the app, marking it done (Meet's "Look around first", and
   *  "Look around while I finish your week" — the job carries on server-side). */
  onSkip(): void;
};

declare const CairnWelcomeConnect: { mount(host: HTMLElement, deps: WelcomeConnectDeps): () => void };
declare const CairnWelcomeMeet: { mount(host: HTMLElement, deps: WelcomeMeetDeps): () => void };

type WelcomeRunApi = {
  create(deps: { append(html: string): HTMLElement | null; onWeekStarted(): void }): {
    begin(): void;
    phase(job: unknown): void;
    reveal(result: { reply?: string; week?: unknown; week_state?: string; fuel?: unknown; fuel_state?: string }): void;
    drop(): void;
    stop(): void;
    replied(): boolean;
  };
  watchJob(
    id: string,
    everyMs: number,
    onRow: (job: { status?: string; result?: unknown; error?: unknown; [key: string]: unknown }) => void,
    maxMs?: number
  ): () => void;
  /** The person left mid-week: follow the job to its end, then refresh what it touched. */
  followAfterLeave(id: string): void;
  /** The week landed: drop the caches it makes stale and repaint Today/Train if showing. */
  landed(): void;
};

declare const CairnWelcomeRun: WelcomeRunApi;
