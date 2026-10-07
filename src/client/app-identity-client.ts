// @ts-check
// Views for the installed app's identity: the one-time iOS re-add note, and the
// Settings -> Data "This app" block (build, shell). Pure renderers —
// app-identity-controller.ts loads, decides and wires.

type AppIdentityShellState = "checking" | "current" | "behind" | "none" | "unknown";

type AppIdentityCardModel = {
  /** `version@build_id` from /api/health, or "" while unknown. */
  build: string;
  /** The derived cache name the running worker holds, or "". */
  shell: string;
  shellState: AppIdentityShellState;
};

type AppIdentityViewApi = {
  readdNoteHtml(reentry: { preferences: string[] }): string;
  appCardHtml(model: AppIdentityCardModel): string;
  shellLine(state: AppIdentityShellState): string;
};
declare const CairnAppIdentity: AppIdentityViewApi;

{
  function listSentence(items: string[]): string {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }

  // Calm and optional: what re-adding refreshes, and exactly what this phone would
  // ask for again. Nothing is lost on the server either way, and signing in is never
  // a reason to hold back: a Home Screen app signs itself in.
  function readdNoteHtml(reentry: { preferences: string[] }): string {
    const again = reentry.preferences;
    const reentryLine = again.length
      ? `A re-added app starts fresh on this phone, so these would need entering again: ${escHtml(listSentence(again))}.`
      : "Nothing needs entering again — everything else comes back from your Cairn server.";
    const signInLine =
      "If Cairn asks you to sign in, the Home Screen app needs its own sign-in: a passkey or a pairing code.";
    return `<section class="sess app-readd" aria-labelledby="appReaddTitle">
      <div class="sess-line app-readd-title" id="appReaddTitle"><b>Cairn has a new icon and name</b></div>
      <div class="sess-line app-readd-sub">This home-screen app keeps the icon and name it was added with. To pick up the new ones, remove Cairn from your home screen and add it again from Safari — only if you like; everything works as it is.</div>
      <div class="sess-line app-readd-sub">${reentryLine} ${signInLine}</div>
      <div class="app-readd-actions"><button class="ghostbtn" type="button" data-readd-dismiss>Got it</button></div>
    </section>`;
  }

  function shellLine(state: AppIdentityShellState): string {
    if (state === "current") return "This app is running the server's current shell.";
    if (state === "behind") return "A newer shell is on the server — it lands the next time Cairn opens.";
    if (state === "none") return "No offline shell on this device yet.";
    if (state === "checking") return "Checking this app's shell…";
    return "This app's shell could not be read.";
  }

  function appCardHtml(model: AppIdentityCardModel): string {
    const build = model.build ? escHtml(model.build) : "Checking…";
    const shell = model.shell ? `<code class="app-id-code">${escHtml(model.shell)}</code>` : "";
    return `<div class="app-id" data-appid-shell-state="${escAttr(model.shellState)}">
      <dl class="app-id-rows">
        <div class="app-id-row"><dt>Server build</dt><dd><code class="app-id-code">${build}</code></dd></div>
        <div class="app-id-row"><dt>This app's shell</dt><dd>${shell}<span class="app-id-shell-line" role="status" aria-live="polite">${escHtml(shellLine(model.shellState))}</span></dd></div>
      </dl>
    </div>`;
  }

  const CAIRN_APP_IDENTITY: AppIdentityViewApi = { readdNoteHtml, appCardHtml, shellLine };

  Object.assign(globalThis, { CairnAppIdentity: CAIRN_APP_IDENTITY });
}
