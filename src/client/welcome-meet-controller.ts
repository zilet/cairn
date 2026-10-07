// @ts-check
// The welcome's Meet stage: the coach's first conversation.
//
// One composer. On send, the welcome job starts (POST /api/welcome — a durable agent
// job of kind "welcome") and its three phases read in the house "agent is thinking"
// vocabulary: Reading what you said → Building your first week → Setting your
// starting fuel. Then the coach's own reply, and the reveal: the week as weekday rows
// and the starting fuel as an estimate. The server writes the exchange into Ask's
// history, so the conversation simply continues there.
//
// A reload mid-job finds the running job (GET /api/agent-jobs) and re-attaches.
(() => {
  type WelcomeResult = {
    ok?: boolean;
    error?: string;
    reply?: string;
    week?: unknown;
    week_state?: string;
    fuel?: unknown;
    fuel_state?: string;
  };

  function mountWelcomeMeet(host: HTMLElement, deps: WelcomeMeetDeps): () => void {
    let alive = true;
    let lastText = "";
    let jobId: string | null = null;
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
      const t = document.createElement("template");
      t.innerHTML = html.trim();
      const node = t.content.firstElementChild as HTMLElement | null;
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

    function paintPhase(working: HTMLElement | null, job: unknown, finished = false): void {
      const list = working?.querySelector<HTMLElement>(".wel-phs");
      if (!list) return;
      const at = CairnWelcomeModel.phaseIndex(job);
      // Never step backwards: a snapshot that knows less than the last phase stays put.
      const prev = Number(list.dataset.at || "0");
      const next = finished ? CairnWelcomeModel.PHASES.length : Math.max(prev, at < 0 ? 0 : at);
      list.dataset.at = String(next);
      list.innerHTML = CairnWelcomeClient.phasesHtml(next, finished);
    }

    function done(working: HTMLElement | null, raw: unknown): void {
      if (!alive) return;
      const result = (raw && typeof raw === "object" ? raw : {}) as WelcomeResult;
      if (result.ok !== true) {
        note("job_failed");
        working?.remove();
        fail(CairnWelcomeModel.humanMessage(result.error, `I couldn't reach ${label} just now.`));
        return;
      }
      paintPhase(working, null, true);
      CairnCoachLink.invalidate();
      try {
        localStorage.setItem("cairn.onboarded", "1");
      } catch {}
      // The phases have said their piece: they give way to the coach's own words.
      setTimeout(
        () => {
          if (!alive) return;
          working?.remove();
          const week = CairnWelcomeModel.weekRows(result.week);
          const reveal: WelcomeReveal = {
            reply: String(result.reply || ""),
            week,
            weekNote: CairnWelcomeModel.weekNote(result.week_state, week.length > 0),
            fuel: CairnWelcomeModel.fuelLines(result.fuel, result.fuel_state),
          };
          if (reveal.reply) append(CairnWelcomeClient.coachBubbleHtml(reveal.reply));
          append(CairnWelcomeClient.revealHtml(reveal));
          if (dock) dock.innerHTML = CairnWelcomeClient.doneDockHtml(CairnWelcomeModel.landed(result.week_state, result.fuel_state));
          // Focus moves to the next step quietly: a ring only for keyboard users.
          dock?.querySelector<HTMLButtonElement>("[data-wel-today]")?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
          scrollToEnd();
        },
        reducedMotion() ? 0 : 650
      );
    }

    const note = (code: string): void => {
      if (alive) CairnWelcomeModel.reportFailure("meet", deps.provider?.name, code);
    };

    function fail(message: string): void {
      if (!alive) return;
      append(CairnWelcomeClient.failBubbleHtml(message));
      setComposer(true);
    }

    function attach(id: string, working: HTMLElement | null): void {
      jobId = id;
      // The shared declaration of openJobStream predates phase handlers; the stream
      // itself (agent-job-client.ts) delivers them.
      const stream = openJobStream as unknown as (
        jobId: string,
        handlers: {
          guard?: () => boolean;
          onPhase?: (job: unknown) => unknown;
          onDone?: (result: unknown) => unknown;
          onError?: (error?: unknown) => unknown;
          onCanceled?: () => unknown;
        }
      ) => void;
      stream(id, {
        guard: () => !alive || !host.isConnected,
        onPhase: (job) => paintPhase(working, job),
        onDone: (result) => done(working, result),
        onError: () => {
          note("job_error");
          working?.remove();
          fail(`Something went wrong while ${label} was working.`);
        },
        onCanceled: () => {
          note("job_canceled");
          working?.remove();
          fail("That was stopped before it finished.");
        },
      });
    }

    async function start(text: string): Promise<void> {
      lastText = text;
      setComposer(false);
      host.querySelectorAll(".wel-msg.is-fail").forEach((el) => el.remove());
      const working = append(CairnWelcomeClient.workingHtml());
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
        working?.remove();
        fail(CairnWelcomeModel.humanMessage(response?.error, "Couldn't reach your server. Check the connection, then try again."));
        return;
      }
      attach(id, working);
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
      } else if (target?.closest("[data-wel-skip]")) {
        deps.onSkip();
      }
    });

    // Press-to-talk where the browser offers speech; the words land in the box to send.
    const voiceStop = new AbortController();
    const mic = host.querySelector<HTMLElement>(".wel-mic");
    const voice = (globalThis as { CairnCaptureVoice?: Window["CairnCaptureVoice"] }).CairnCaptureVoice;
    if (mic && voice) voice.setup({ mic, input, signal: voiceStop.signal });

    // A welcome already running (a reload, a second device) is re-attached, not re-asked.
    void (async () => {
      try {
        const list = (await api("/agent-jobs")) as { jobs?: Array<{ id?: unknown; kind?: string; status?: string; input?: { text?: unknown } }> };
        const running = (list?.jobs || []).find((j) => j.kind === "welcome" && (j.status === "running" || j.status === "queued"));
        if (!running || running.id == null || !alive || jobId) return;
        const said = typeof running.input?.text === "string" ? running.input.text : "";
        if (said) append(CairnWelcomeClient.userBubbleHtml(said));
        lastText = said;
        setComposer(false);
        attach(String(running.id), append(CairnWelcomeClient.workingHtml()));
      } catch {}
    })();

    setTimeout(() => {
      if (alive && !input.disabled) input.focus({ preventScroll: true });
    }, reducedMotion() ? 0 : 400);

    return () => {
      alive = false;
      voiceStop.abort();
      if (jobId) teardownJobs((id: string) => id === jobId);
    };
  }

  Object.assign(globalThis, { CairnWelcomeMeet: { mount: mountWelcomeMeet } });
})();
