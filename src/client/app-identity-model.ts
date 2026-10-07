// @ts-check
// The installed app's identity (icon + name), as pure rules. An iOS home-screen app
// keeps the icon and name it was added with, and re-adding it starts on empty
// storage, so when the identity changes a standalone iOS install is offered ONE
// calm, optional note about re-adding. This module decides when that note shows and
// what re-adding would ask for again; the controller reads storage and paints.

type AppIdentityEnv = {
  userAgent?: string;
  maxTouchPoints?: number;
  /** iOS Safari's own flag for a home-screen launch. */
  navigatorStandalone?: boolean;
  /** `(display-mode: standalone)` matched. */
  displayStandalone?: boolean;
};

type AppIdentityNoteInput = {
  iosStandalone: boolean;
  outboxCount: number;
  /** The identity this install was added with (its stamp). */
  installedWith: number;
  /** The identity whose note was dismissed here, or 0. */
  dismissedFor: number;
  current: number;
};

type AppIdentityReentry = {
  preferences: string[];
};

type AppIdentityModelApi = {
  VERSION: number;
  PRE_STAMP_VERSION: number;
  STAMP_KEY: string;
  DISMISS_KEY: string;
  PREFERENCES: ReadonlyArray<{ key: string; label: string }>;
  isIOS(env: AppIdentityEnv): boolean;
  isIOSStandalone(env: AppIdentityEnv): boolean;
  stampFor(stored: string | null, hasPriorState: boolean, current: number): number;
  noteVisible(input: AppIdentityNoteInput): boolean;
  reentry(read: (key: string) => string | null): AppIdentityReentry;
  parseVersion(value: string | null): number;
};
declare const CairnAppIdentityModel: AppIdentityModelApi;

{
  // The icon/name version: the `.vN` every icon url carries. Never hand-edit it —
  // `node scripts/bump-icons.mjs` moves it together with the icon files, manifest,
  // index.html and sw.js (test/pwaInstallIdentity.test.js holds all five together).
  const APP_IDENTITY_VERSION = 3;
  // What an install made before this stamp existed was added with. Frozen: it is a
  // fact about the past, so the note stays OFF until APP_IDENTITY_VERSION moves past it.
  const PRE_STAMP_IDENTITY_VERSION = 2;
  const APP_IDENTITY_STAMP_KEY = "cairn.app.identity.v1";
  const APP_IDENTITY_DISMISS_KEY = "cairn.app.readd.dismissed.v1";
  // The per-device preferences a re-added app starts without. Everything else lives
  // on the Cairn server and comes back on its own.
  const APP_IDENTITY_PREFERENCES: ReadonlyArray<{ key: string; label: string }> = [
    { key: "cairn-bm-unit", label: "your body measurement units" },
    { key: "restSec", label: "your rest timer length" },
    { key: "cairn.wakeLock.v1", label: "the keep-screen-awake setting" },
  ];

  function isIOS(env: AppIdentityEnv): boolean {
    const ua = String(env.userAgent || "");
    // iPadOS reports a Mac user agent; a touch screen gives it away.
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(env.maxTouchPoints || 0) > 1);
  }

  function isIOSStandalone(env: AppIdentityEnv): boolean {
    if (env.navigatorStandalone === true) return true;
    return !!env.displayStandalone && isIOS(env);
  }

  function parseVersion(value: string | null): number {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  // The identity to record for this install. A stored stamp wins. Without one, an
  // install that already holds Cairn state predates the stamp (it was added with the
  // pre-stamp identity); an empty one was just added, so it already shows the current
  // icon and name and must never be told to re-add.
  function stampFor(stored: string | null, hasPriorState: boolean, current: number): number {
    const existing = parseVersion(stored);
    if (existing) return existing;
    return hasPriorState ? Math.min(PRE_STAMP_IDENTITY_VERSION, current) : current;
  }

  // Shown only in a standalone iOS install, only with nothing waiting to sync (a
  // re-add would lose it), only while the install predates the current identity, and
  // never again once dismissed for this identity.
  function noteVisible(input: AppIdentityNoteInput): boolean {
    if (!input.iosStandalone) return false;
    if (!(input.outboxCount === 0)) return false;
    if (!(input.installedWith > 0) || input.installedWith >= input.current) return false;
    return input.dismissedFor < input.current;
  }

  function reentry(read: (key: string) => string | null): AppIdentityReentry {
    const has = (key: string): boolean => {
      try {
        return String(read(key) || "").trim() !== "";
      } catch {
        return false;
      }
    };
    return {
      preferences: APP_IDENTITY_PREFERENCES.filter((pref) => has(pref.key)).map((pref) => pref.label),
    };
  }

  const CAIRN_APP_IDENTITY_MODEL: AppIdentityModelApi = {
    VERSION: APP_IDENTITY_VERSION,
    PRE_STAMP_VERSION: PRE_STAMP_IDENTITY_VERSION,
    STAMP_KEY: APP_IDENTITY_STAMP_KEY,
    DISMISS_KEY: APP_IDENTITY_DISMISS_KEY,
    PREFERENCES: APP_IDENTITY_PREFERENCES,
    isIOS,
    isIOSStandalone,
    stampFor,
    noteVisible,
    reentry,
    parseVersion,
  };

  Object.assign(globalThis, { CairnAppIdentityModel: CAIRN_APP_IDENTITY_MODEL });
}
