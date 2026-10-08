// @ts-check
// The welcome's Meet stage: the coach's first conversation.
//
// One composer. On send, the welcome job starts (POST /api/welcome — a durable agent
// job of kind "welcome") and the conversation fills in one thing at a time as the job
// lands it (welcome-meet-run.ts): the coach's reply, the starting point for food, then
// the first week, day by day. Once the reply is in, the person need not wait for the
// week: "Look around while I finish your week" leaves for the app, and the job carries
// on server-side. The server writes the exchange into Ask's history, so the
// conversation simply continues there.
//
// A reload mid-job finds the running job (GET /api/agent-jobs) and re-attaches; the
// job's phase meta repaints whatever already landed. A restart during the week re-queues
// the same job to finish it (the boot's resume), so it simply re-attaches; one cut short
// earlier (the boot marks it interrupted) says so calmly and offers Try again with the same words.
(() => {
  type WelcomeResult = {
    ok?: boolean;
    error?: string;
    reason?: string;
    reply?: string;
    week?: unknown;
    week_state?: string;
    fuel?: unknown;
    fuel_state?: string;
  };
  type StreamHandlers = {
    guard?: () => boolean;
    onPhase?: (job: unknown) => unknown;
    onDone?: (result: unknown) => unknown;
    onError?: (error?: unknown) => unknown;
    onCanceled?: () => unknown;
  };

  // The last welcome this browser started, so a reload after a restart can say what
  // happened instead of showing a blank composer. Per-device convenience only.
  const LAST_KEY = "cairn.welcome.job";
  const remember = (value: { id: string; text: string } | null): void => {
    try {
      if (value) localStorage.setItem(LAST_KEY, JSON.stringify(value));
      else localStorage.removeItem(LAST_KEY);
    } catch {}
  };
  const recalled = (): { id: string; text: string } | null => {
    try {
      const raw = JSON.parse(localStorage.getItem(LAST_KEY) || "null") as { id?: unknown; text?: unknown } | null;
      return raw && typeof raw.id === "string" && typeof raw.text === "string" ? { id: raw.id, text: raw.text } : null;
    } catch {
      return null;
    }
  };

  // How often the Meet stage checks the job itself while it waits: the live stream can
  // be closed for good by a proxy during a restart, and then only a read sees the end.
  const WATCH_MS = 15000;

  function mountWelcomeMeet(host: HTMLElement, deps: WelcomeMeetDeps): () => void {
    let alive = true;
    let lastText = "";
    let jobId: string | null = null;
    let settled = false;
    let stopWatch: () => void = () => {};
    const log = host.querySelector<HTMLElement>(".wel-log");
    const dock = host.querySelector<HTMLElement>(".wel-dock");
    const form = host.querySelector<HTMLFormElement>(".wel-compose");
    const input = host.querySelector<HTMLTextAreaElement>(".wel-text");
    const send = host.querySelector<HTMLButtonElement>(".wel-send");
    if (!log || !dock || !form || !input || !send) return () => {};
    const label = deps.provider?.label || "your AI";

    const scrollToEnd = (): void => {
      const pane = host.closest<HTMLElement>(".wel") || host;
      requestAnimationFrame(() => {
        pane.scrollTo({ top: pane.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
      });
    };

    const autosize = (): void => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
      send.disabled = !input.value.trim();
    };

    function append(html: string): HTMLElement | null {
      if (!log) return null;
      const box = document.createElement("div");
      box.innerHTML = html.trim();
      const node = box.firstElementChild as HTMLElement | null;
      if (!node) return null;
      if (!reducedMotion()) node.classList.add("wel-in");
      log.appendChild(node);
      scrollToEnd();
      return node;
    }

    function setComposer(on: boolean): void {
      form?.classList.toggle("is-off", !on);
      if (input) input.disabled = !on;
      if (send) send.disabled = !on || !input?.value.trim();
    }

    // The composer's place in the dock: back for a retry, "look around" while the week composes.
    let composerHome: Node | null = null;
    function dockWaiting(): void {
      if (!dock || !form || dock.querySelector("[data-wel-leave]")) return;
      composerHome = form;
      form.remove();
      dock.insertAdjacentHTML("beforeend", CairnWelcomeClient.waitDockHtml());
    }
    function dockComposer(): void {
      if (!dock) return;
      dock.querySelector(".wel-wait")?.remove();
      if (composerHome && !composerHome.parentNode) dock.appendChild(composerHome);
      composerHome = null;
    }

    const run = CairnWelcomeRun.create({ append, onWeekStarted: dockWaiting });

    const note = (code: string): void => {
      if (alive) CairnWelcomeModel.reportFailure("meet", deps.provider?.name, code);
    };

    function fail(message: string, signIn = false): void {
      if (!alive) return;
      run.stop();
      host.querySelector(".is-working")?.remove();
      dockComposer();
      append(CairnWelcomeClient.failBubbleHtml(message, signIn));
      setComposer(true);
    }

    function done(raw: unknown): void {
      if (!alive || settled) return;
      settled = true;
      stopWatch();
      const result = (raw && typeof raw === "object" ? raw : {}) as WelcomeResult;
      if (result.ok !== true) {
        const signedOut = result.reason === "not_signed_in";
        note(signedOut ? "not_signed_in" : "job_failed");
        // Signed out: the way on is that provider's sign-in, not the same message again.
        fail(CairnWelcomeModel.humanMessage(result.error, `I couldn't reach ${label} just now.`), signedOut);
        if (signedOut) CairnCoachLink.invalidate();
        return;
      }
      remember(null);
      try {
        localStorage.setItem("cairn.onboarded", "1");
      } catch {}
      CairnWelcomeRun.landed();
      // They watched it land right here: the app's one-shot "ready" notice is said.
      (globalThis as { CairnFirstWeek?: FirstWeekApi }).CairnFirstWeek?.seen();
      run.reveal(result);
      if (dock)
        dock.innerHTML = CairnWelcomeClient.doneDockHtml(
          CairnWelcomeModel.landed(result.week_state, result.fuel_state)
        );
      // Focus moves to the next step quietly: a ring only for keyboard users.
      dock
        ?.querySelector<HTMLButtonElement>("[data-wel-today]")
        ?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
      scrollToEnd();
    }

    function ended(error: unknown, canceled = false): void {
      if (!alive || settled) return;
      settled = true;
      stopWatch();
      if (canceled) {
        note("job_canceled");
        fail("That was stopped before it finished.");
      } else if (CairnWelcomeModel.interrupted(error)) {
        note("job_interrupted");
        fail("That got interrupted partway through. Try again and I'll pick it up from what you said.");
      } else {
        note("job_error");
        fail(`Something went wrong while ${label} was working.`);
      }
    }

    // One job row, from the stream or a read: a phase repaints what landed; an end ends.
    function onRow(job: { status?: string; result?: unknown; error?: unknown }): void {
      const status = String(job.status || "");
      if (status === "done") done(job.result);
      else if (status === "error") ended(job.error);
      else if (status === "canceled") ended(null, true);
      else run.phase(job);
    }

    function attach(id: string): void {
      jobId = id;
      settled = false;
      // The shared declaration of openJobStream predates phase handlers; the stream
      // itself (agent-job-client.ts) delivers them.
      const stream = openJobStream as unknown as (jobId: string, handlers: StreamHandlers) => void;
      stream(id, {
        guard: () => !alive || !host.isConnected,
        onPhase: (job) => run.phase(job),
        onDone: (result) => done(result),
        onError: (error) => ended(error),
        onCanceled: () => ended(null, true),
      });
      stopWatch();
      stopWatch = CairnWelcomeRun.watchJob(id, WATCH_MS, (job) => {
        if (alive) onRow(job);
      });
    }

    async function start(text: string): Promise<void> {
      lastText = text;
      setComposer(false);
      if (jobId) teardownJobs((id: string) => id === jobId);
      stopWatch();
      jobId = null;
      run.drop();
      host.querySelectorAll(".wel-msg.is-fail").forEach((el) => el.remove());
      dockComposer();
      run.begin();
      type Enqueued = { ok?: boolean; error?: string; job?: { id?: unknown } };
      let response: Enqueued | null = null;
      try {
        response = (await enqueueJob("/welcome", {
          text,
          ...(deps.provider ? { agent: deps.provider.name } : {}),
        })) as Enqueued;
      } catch {
        response = null;
      }
      if (!alive) return;
      const id = response?.job?.id != null ? String(response.job.id) : "";
      if (!response || response.ok === false || !id) {
        note("enqueue_failed");
        run.drop();
        fail(
          CairnWelcomeModel.humanMessage(
            response?.error,
            "Couldn't reach your server. Check the connection, then try again."
          )
        );
        return;
      }
      remember({ id, text });
      attach(id);
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || input.disabled) return;
      append(CairnWelcomeClient.userBubbleHtml(text));
      input.value = "";
      autosize();
      void start(text);
    });
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", (event) => {
      // Enter sends on a keyboard; Shift+Enter (and every touch keyboard) adds a line.
      const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
      if (event.key === "Enter" && !event.shiftKey && !coarse && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    host.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-wel-retry]")) {
        if (lastText) void start(lastText);
      } else if (target?.closest("[data-wel-reconnect]")) {
        deps.onReconnect();
      } else if (target?.closest("[data-wel-today]")) {
        deps.onDone();
      } else if (target?.closest("[data-wel-leave]")) {
        // The week carries on server-side; whoever is on Today/Train sees it land.
        if (jobId && !settled) CairnWelcomeRun.followAfterLeave(jobId);
        deps.onSkip();
      } else if (target?.closest("[data-wel-skip]")) {
        deps.onSkip();
      }
    });

    // Press-to-talk where the browser offers speech; the words land in the box to send.
    const voiceStop = new AbortController();
    const mic = host.querySelector<HTMLElement>(".wel-mic");
    const voice = (globalThis as { CairnCaptureVoice?: Window["CairnCaptureVoice"] }).CairnCaptureVoice;
    if (mic && voice) voice.setup({ mic, input, signal: voiceStop.signal });

    // Resume what this person already said: a welcome still running (a reload, a second
    // device) is re-attached, not re-asked; the last one this device started that a
    // restart cut short is named, with Try again.
    function resume(said: string): void {
      if (said) append(CairnWelcomeClient.userBubbleHtml(said));
      lastText = said;
      setComposer(false);
    }
    void (async () => {
      try {
        type Row = {
          id?: unknown;
          kind?: string;
          status?: string;
          input?: { text?: unknown };
          meta?: unknown;
          error?: unknown;
        };
        const list = (await api("/agent-jobs")) as { jobs?: Row[] };
        if (!alive || jobId) return;
        const running = (list?.jobs || []).find(
          (j) => j.kind === "welcome" && (j.status === "running" || j.status === "queued")
        );
        if (running && running.id != null) {
          resume(typeof running.input?.text === "string" ? running.input.text : "");
          run.begin();
          run.phase(running);
          attach(String(running.id));
          return;
        }
        const last = recalled();
        if (!last) return;
        const got = (await api(`/agent-jobs/${encodeURIComponent(last.id)}`)) as { job?: Row } | null;
        if (!alive || jobId) return;
        const job = got?.job;
        if (job?.kind === "welcome" && job.status === "error" && CairnWelcomeModel.interrupted(job.error)) {
          resume(last.text);
          ended(job.error);
        } else {
          remember(null);
        }
      } catch {}
    })();

    setTimeout(
      () => {
        if (alive && !input.disabled) input.focus({ preventScroll: true });
      },
      reducedMotion() ? 0 : 400
    );

    return () => {
      alive = false;
      run.stop();
      stopWatch();
      voiceStop.abort();
      if (jobId) teardownJobs((id: string) => id === jobId);
    };
  }

  Object.assign(globalThis, { CairnWelcomeMeet: { mount: mountWelcomeMeet } });
})();
