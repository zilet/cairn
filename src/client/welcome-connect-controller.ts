// @ts-check
// The welcome's Connect stage: three steps, each with live state, each laying one
// stone of the small cairn when it is done.
//
//   Set up    — install the provider's CLI when the server lacks it, polling
//               GET /api/agent-clis/update (a calm line; the log only under "details").
//   Sign in   — the friendly sign-in panel (agent-login-panel-client.ts): an
//               "Open <Provider> sign-in" button, a device code, a paste box. Never a
//               terminal up front.
//   Say hello — POST /api/agents/:name/verify, the real spawn path for THIS agent.
//               "busy" means the host had no spawn slot: wait and ask again, never a
//               failure.
// A failure names the step in plain words and always offers a way on: Try again, or
// Use a different one. Never a dead end.
(() => {
  type InstallStatus = {
    status?: string;
    agents?: string[];
    error?: string;
    /** The installer's classified failure: a reason code and a plain headline. */
    failure?: { reason?: string; message?: string } | null;
    stdout_tail?: string;
    stderr_tail?: string;
  };

  type VerifyResult = { ok?: boolean; reason?: string; message?: string; ms?: number };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  function mountWelcomeConnect(host: HTMLElement, deps: WelcomeConnectDeps): () => void {
    let alive = true;
    let provider = deps.provider;
    const label = provider.label;
    let panel: AgentLoginPanelHandle | null = null;
    let runSeq = 0;

    const stepEl = (key: WelcomeStepKey) => host.querySelector<HTMLElement>(`[data-wel-step="${key}"]`);

    function layStones(): void {
      const done = CairnWelcomeModel.STEPS.filter((s) => stepEl(s.key)?.dataset.state === "done").length;
      // cairnSvg emits its stones base-first, so document order is the order they are laid.
      host.querySelectorAll<SVGGElement>(".wel-mini .wel-stone").forEach((stone, i) => {
        const laid = i < done;
        stone.classList.toggle("is-laid", laid);
        stone.classList.toggle("is-open", !laid);
      });
    }

    function set(key: WelcomeStepKey, state: WelcomeStepState, status: string, body?: string, spin = true): void {
      const el = stepEl(key);
      if (!el || !alive) return;
      el.dataset.state = state;
      el.classList.toggle("is-current", state === "working" || state === "failed");
      const s = el.querySelector<HTMLElement>(".wel-step-s");
      if (s) {
        s.innerHTML = state === "working" && spin ? `<span class="aspin aspin-xs" aria-hidden="true"></span>${escHtml(status)}` : escHtml(status);
      }
      if (body !== undefined) {
        const x = el.querySelector<HTMLElement>(".wel-step-x");
        if (x) x.innerHTML = body;
      }
      layStones();
    }

    function body(key: WelcomeStepKey): HTMLElement | null {
      return stepEl(key)?.querySelector<HTMLElement>(".wel-step-x") || null;
    }

    const STEP_OF: Record<WelcomeStepKey, WelcomeFailureStep> = {
      setup: "connect.install",
      signin: "connect.signin",
      hello: "connect.verify",
    };
    const note = (key: WelcomeStepKey, code: string, status?: unknown): void => {
      if (alive) CairnWelcomeModel.reportFailure(STEP_OF[key], provider.name, code, status);
    };
    const statusOf = (error: unknown): unknown => (error as { status?: unknown } | null)?.status;

    function failActions(retry: string): string {
      return `<div class="wel-acts">
        <button class="btn btn-solid" type="button" data-wel-act="${escAttr(retry)}">Try again</button>
        <button class="linkbtn-quiet" type="button" data-wel-act="switch">Use a different one</button>
      </div>`;
    }

    function signInActions(): string {
      return `<div class="wel-acts">
        <button class="btn btn-solid" type="button" data-wel-act="signin-now">Sign in to ${escHtml(label)}</button>
        <button class="linkbtn-quiet" type="button" data-wel-act="switch">Use a different one</button>
      </div>`;
    }

    async function fresh(): Promise<CoachLinkProvider | null> {
      CairnCoachLink.invalidate();
      const m = await CairnCoachLink.read();
      return m?.providers.find((p) => p.name === provider.name) || null;
    }

    // ---- Set up ---------------------------------------------------------------
    function installTail(status: InstallStatus | null): string {
      return [status?.stdout_tail, status?.stderr_tail, status?.error]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n")
        .trim();
    }

    function setupDetailsHtml(): string {
      return `<button class="linkbtn-quiet wel-more" type="button" data-wel-act="setup-log" aria-expanded="false" aria-controls="welSetupLog">Show details</button>
        <pre class="wel-log-tail" id="welSetupLog" hidden></pre>`;
    }

    function paintTail(status: InstallStatus | null): void {
      const pre = host.querySelector<HTMLElement>("#welSetupLog");
      if (!pre) return;
      pre.textContent = installTail(status) || "Preparing…";
      if (!pre.hidden) pre.scrollTop = pre.scrollHeight;
    }

    // The headline for a failed setup: the installer's own plain sentence for the
    // failures a person can act on (a full disk says how much is free and what to do),
    // else the calm default. The raw log stays under "Show details".
    function installHeadline(status: InstallStatus | null): string {
      const reason = String(status?.failure?.reason || "");
      const message = String(status?.failure?.message || "").trim();
      if (message && (reason === "disk_full" || reason === "out_of_memory")) return message;
      if (reason === "not_runnable") return `${label} was set up but wouldn't start on your server. Try again, or use a different one.`;
      if (reason === "integrity") return `${label}'s download didn't match what Cairn expected, so nothing was installed. Updating Cairn fixes this.`;
      if (reason === "download_failed") return `Couldn't download ${label}. Check your server's internet connection, then try again.`;
      if (reason === "unsupported") return `${label} doesn't offer a version for this server.`;
      return `Setting up ${label} didn't finish.`;
    }

    async function install(seq: number): Promise<boolean> {
      set("setup", "working", `Setting up ${label} on your server. This takes a minute or two.`, setupDetailsHtml());
      let status: InstallStatus | null = null;
      let httpStatus: unknown;
      try {
        status = (await api(`/agent-clis/${encodeURIComponent(provider.name)}/install`, { method: "POST" })) as InstallStatus;
      } catch (error) {
        status = null;
        httpStatus = statusOf(error);
      }
      // Another tool is installing: wait for it, then ask for ours.
      for (let guard = 0; guard < 120 && status?.status === "running" && !status.agents?.includes(provider.name); guard++) {
        if (!alive || seq !== runSeq) return false;
        set("setup", "working", "Waiting for another setup to finish first…");
        await sleep(2500);
        try {
          status = (await api("/agent-clis/update")) as InstallStatus;
          if (status?.status !== "running") {
            status = (await api(`/agent-clis/${encodeURIComponent(provider.name)}/install`, { method: "POST" })) as InstallStatus;
          }
        } catch {}
      }
      paintTail(status);
      for (let guard = 0; guard < 400 && status?.status === "running"; guard++) {
        await sleep(2000);
        if (!alive || seq !== runSeq) return false;
        try {
          status = (await api("/agent-clis/update")) as InstallStatus;
        } catch {}
        paintTail(status);
      }
      if (!alive || seq !== runSeq) return false;
      if (status?.status === "succeeded") {
        const next = await fresh();
        if (next) provider = next;
        set("setup", "done", "Ready on your server", "");
        return true;
      }
      const reason = String(status?.failure?.reason || "");
      note("setup", reason ? `install_${reason}` : "install_failed", httpStatus);
      set("setup", "failed", installHeadline(status), failActions("setup") + setupDetailsHtml());
      paintTail(status);
      return false;
    }

    // ---- Sign in --------------------------------------------------------------
    function signIn(seq: number): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        set(
          "signin",
          "working",
          "",
          `<div class="wel-panel"></div>`,
          false // the panel below carries the live status
        );
        const slot = body("signin")?.querySelector<HTMLElement>(".wel-panel");
        const panelApi = (globalThis as { CairnAgentLoginPanel?: AgentLoginPanelApi }).CairnAgentLoginPanel;
        if (!slot || !panelApi) {
          note("signin", "login_unavailable");
          set("signin", "failed", "The sign-in couldn't start here.", failActions("signin"));
          resolve(false);
          return;
        }
        panel?.close();
        panel = panelApi.mount(slot, {
          name: provider.name,
          label,
          onConnected: () => {
            if (!alive || seq !== runSeq) return;
            panel?.close();
            panel = null;
            set("signin", "done", `Signed in to ${label}`, "");
            resolve(true);
          },
          onFailed: (message, reason) => {
            if (!alive || seq !== runSeq) return;
            note("signin", `login_${reason || "error"}`);
            set("signin", "failed", message, failActions("signin"));
            panel?.close();
            panel = null;
            resolve(false);
          },
          onBusy: (message) => {
            if (!alive || seq !== runSeq) return;
            note("signin", "login_busy");
            set("signin", "failed", message, failActions("signin"));
            resolve(false);
          },
        });
      });
    }

    // ---- Say hello ------------------------------------------------------------
    async function sayHello(seq: number): Promise<void> {
      set("hello", "working", `Asking ${label} to say hello…`, "");
      for (let attempt = 0; attempt < 30; attempt++) {
        let result: VerifyResult | null = null;
        let httpStatus: unknown;
        try {
          result = (await api(`/agents/${encodeURIComponent(provider.name)}/verify`, {
            method: "POST",
            acceptErrorBody: true,
          })) as VerifyResult;
        } catch (error) {
          result = null;
          httpStatus = statusOf(error);
        }
        if (!alive || seq !== runSeq) return;
        if (result?.ok) {
          CairnCoachLink.invalidate();
          // An answer is proof of the sign-in too, whatever the probe could read.
          if (stepEl("signin")?.dataset.state !== "done") set("signin", "done", `Signed in to ${label}`, "");
          set("hello", "done", `${label} answered. Your coach is ready.`, "");
          const next = await fresh();
          if (next) provider = next;
          await sleep(reducedMotion() ? 300 : 1100);
          if (alive && seq === runSeq) deps.onConnected(provider);
          return;
        }
        const reason = String(result?.reason || "");
        if (reason === "busy") {
          // The server is running other AI work right now: wait our turn.
          set("hello", "working", "Your server is busy with other work. Waiting for a free moment…");
          await sleep(4000);
          if (!alive || seq !== runSeq) return;
          continue;
        }
        if (reason === "not_installed") {
          set("hello", "waiting", "");
          void run();
          return;
        }
        const message = result?.message
          ? CairnWelcomeModel.humanMessage(result.message, `${label} didn't answer. Try again, or use a different one.`)
          : result
            ? `${label} didn't answer.`
            : "Couldn't reach your server. Check the connection, then try again.";
        if (reason === "not_signed_in") {
          // Back to the sign-in step, with the sign-in itself offered — not a dead end.
          note("hello", "not_signed_in");
          CairnCoachLink.invalidate();
          set("hello", "waiting", "");
          if (provider.canLogin) {
            set("signin", "failed", message, signInActions());
          } else {
            set("signin", "failed", `${message} Its owner can sign it in from Settings.`, failActions("signin"));
          }
          return;
        }
        note("hello", result ? "verify_failed" : "unreachable", httpStatus);
        set("hello", "failed", message, failActions("hello"));
        return;
      }
      note("hello", "stayed_busy");
      set("hello", "failed", "Your server stayed busy. Try again in a minute.", failActions("hello"));
    }

    // The hello said "not signed in": open the sign-in now, whatever the probe reads.
    async function signInThenHello(): Promise<void> {
      const seq = ++runSeq;
      set("hello", "waiting", "");
      if (!(await signIn(seq)) || !alive || seq !== runSeq) return;
      await sayHello(seq);
    }

    // ---- The run --------------------------------------------------------------
    async function run(from: WelcomeStepKey = "setup"): Promise<void> {
      const seq = ++runSeq;
      panel?.close();
      panel = null;
      const order: WelcomeStepKey[] = ["setup", "signin", "hello"];
      for (const key of order.slice(order.indexOf(from))) set(key, "waiting", "", "");
      if (from === "setup") set("setup", "working", "Checking your server…");
      const current = await fresh();
      if (!alive || seq !== runSeq) return;
      if (!current) {
        note(from, "unreachable");
        set(from, "failed", "Couldn't reach your server. Check the connection, then try again.", failActions(from));
        return;
      }
      provider = current;

      if (from === "setup") {
        if (provider.present) {
          set("setup", "done", "Ready on your server", "");
        } else if (!provider.installable) {
          note("setup", "not_installable");
          set("setup", "failed", `${label} can't be set up on this server.`, failActions("setup"));
          return;
        } else if (!(await install(seq))) {
          return;
        }
      }

      if (from === "setup" || from === "signin") {
        // Only a POSITIVE verdict skips the sign-in. A login the server cannot read
        // (a probe that timed out on a cold container) is not "already signed in".
        if (provider.signedIn) {
          set("signin", "done", `Already signed in to ${label}`, "");
        } else if (provider.canLogin) {
          if (!(await signIn(seq))) return;
        } else if (provider.configured === false) {
          note("signin", "login_unavailable");
          set("signin", "failed", `${label} signs in on the server itself. Its owner can do it from Settings.`, failActions("signin"));
          return;
        }
        // No in-app sign-in and no verdict either way: the hello below is the test.
      }
      if (!alive || seq !== runSeq) return;
      await sayHello(seq);
    }

    host.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const act = target?.closest<HTMLElement>("[data-wel-back]")
        ? "back"
        : target?.closest<HTMLElement>("[data-wel-act]")?.dataset.welAct;
      if (!act) return;
      if (act === "switch" || act === "back") {
        deps.onSwitch();
      } else if (act === "setup-log") {
        const btn = target?.closest<HTMLButtonElement>("[data-wel-act]");
        const pre = host.querySelector<HTMLElement>("#welSetupLog");
        if (!btn || !pre) return;
        pre.hidden = !pre.hidden;
        btn.setAttribute("aria-expanded", String(!pre.hidden));
        btn.textContent = pre.hidden ? "Show details" : "Hide details";
      } else if (act === "setup" || act === "signin" || act === "hello") {
        void run(act);
      } else if (act === "signin-now") {
        void signInThenHello();
      }
    });

    void run();

    return () => {
      alive = false;
      runSeq++;
      panel?.close();
      panel = null;
    };
  }

  Object.assign(globalThis, { CairnWelcomeConnect: { mount: mountWelcomeConnect } });
})();
