type OnboardingDiscipline = "strength" | "endurance" | "hybrid";
type OnboardingSex = "female" | "male";

// @ts-check
{
  function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
    const el = root.querySelector<T>(selector);
    if (!el) throw new Error(`Missing onboarding element: ${selector}`);
    return el;
  }

  async function markOnboarded(): Promise<void> {
    try {
      await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboarded: true }) });
    } catch {}
  }

  async function maybeOnboard(): Promise<void> {
    let onboarded = true;
    try {
      const data = await api("/settings");
      onboarded = !!data?.settings?.onboarded;
      if (data?.settings && "art_enabled" in data.settings) artEnabled = !!data.settings.art_enabled;
    } catch {
      onboarded = true;
    }
    if (!onboarded) openOnboarding();
  }

  function openOnboarding(): void {
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `<div class="modal-card">
      <h2 class="modal-title">Welcome to Cairn</h2>
      <p class="ob-lead">A few basics, then you're in — I'll learn the rest as we go.</p>
      <div class="ob-grid">
        <div class="field"><label for="obSex">Sex <span class="ob-opt">— for health ranges</span></label>
          <select id="obSex">
            <option value="">Choose…</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select></div>
        <div class="field"><label for="obAge">Age</label>
          <input id="obAge" type="number" inputmode="numeric" min="13" max="100" placeholder="years"></div>
      </div>
      <div class="field"><label id="obDaysLbl">Days / week</label>
        <div class="seg" id="obDays" role="group" aria-labelledby="obDaysLbl">
          <button type="button" class="segbtn" data-dpw="3">3</button>
          <button type="button" class="segbtn active" data-dpw="4">4</button>
          <button type="button" class="segbtn" data-dpw="5">5</button>
          <button type="button" class="segbtn" data-dpw="6">6</button>
        </div>
      </div>
      <div class="field"><label>Your sport <span class="ob-opt">— optional</span></label>
        <div class="seg disc-seg" id="obDisc" role="group" aria-label="Primary discipline">
          <button type="button" class="segbtn active" data-disc="strength">Strength</button>
          <button type="button" class="segbtn" data-disc="endurance">Endurance</button>
          <button type="button" class="segbtn" data-disc="hybrid">Hybrid</button>
        </div></div>
      <div class="field"><label for="obGoal">Main goal</label>
        <select id="obGoal">
          <option value="">What matters most? (optional)</option>
          <option value="stay strong and age well">Stay strong &amp; age well</option>
          <option value="build muscle">Build muscle</option>
          <option value="lose fat and lean out">Lose fat / lean out</option>
          <option value="sport or event performance">Sport / performance</option>
          <option value="overall health and energy">Overall health &amp; energy</option>
        </select></div>
      <div class="field"><label for="obIntro">Anything else <span class="ob-opt">— optional</span></label>
        <textarea id="obIntro" class="ob-intro" rows="3"
          placeholder="injuries, how you eat, height &amp; weight, supplements you take… a sentence is plenty."></textarea></div>
      <button id="obStart" class="logbtn" style="width:100%;height:46px;margin-top:6px;letter-spacing:.05em">START</button>
      <button id="obSkip" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Skip — just get me in</button>
      <div id="obStatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>
    </div>`;
    document.body.appendChild(modal);

    let daysPerWeek = 4;
    modal.querySelectorAll<HTMLElement>("#obDays [data-dpw]").forEach((button) => {
      button.addEventListener("click", () => {
        daysPerWeek = Number(button.dataset.dpw) || 4;
        modal.querySelectorAll<HTMLElement>("#obDays .segbtn").forEach((el) => el.classList.toggle("active", el === button));
      });
    });

    let discipline: OnboardingDiscipline = "strength";
    modal.querySelectorAll<HTMLElement>("#obDisc [data-disc]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = button.dataset.disc;
        discipline = next === "endurance" || next === "hybrid" ? next : "strength";
        modal.querySelectorAll<HTMLElement>("#obDisc .segbtn").forEach((el) => el.classList.toggle("active", el === button));
      });
    });

    const intro = requiredElement<HTMLTextAreaElement>(modal, "#obIntro");
    setTimeout(() => {
      try {
        requiredElement<HTMLInputElement>(modal, "#obAge").focus();
      } catch {}
    }, 60);

    function enterApp(): void {
      state.plan = [];
      state.day = null;
      state.dayPicked = false;
      ["plan", "profile", "stats", "progress:weight", "progress:energy", "supplements", "memory"].forEach(swrInvalidate);
      swrInvalidate("today:session:");
      modal.remove();
      hideSaveBar();
      document.querySelectorAll<HTMLElement>(".tab").forEach((el) => el.classList.remove("active"));
      document.querySelector<HTMLElement>('.tab[data-tab="today"]')?.classList.add("active");
      state.tab = "today";
      document.body.dataset.tab = "today";
      renderToday();
    }

    function composeIntro(): string {
      const parts: string[] = [];
      const sex = requiredElement<HTMLSelectElement>(modal, "#obSex").value as OnboardingSex | "";
      if (sex) parts.push(`My sex is ${sex}.`);
      const age = Number(requiredElement<HTMLInputElement>(modal, "#obAge").value) || null;
      if (age) parts.push(`I'm ${age}.`);
      parts.push(`I train about ${daysPerWeek} days a week.`);
      if (discipline === "endurance") parts.push("I'm primarily an endurance athlete.");
      else if (discipline === "hybrid") parts.push("I train both strength and endurance (hybrid).");
      const goal = requiredElement<HTMLSelectElement>(modal, "#obGoal").value;
      if (goal) parts.push(`My main goal is to ${goal}.`);
      const note = intro.value.trim();
      if (note) parts.push(note);
      return parts.join(" ").trim();
    }

    async function persistBasics(): Promise<void> {
      const sex = requiredElement<HTMLSelectElement>(modal, "#obSex").value as OnboardingSex | "";
      if (discipline === "strength" && !sex) {
        setDiscipline("strength");
        return;
      }
      try {
        await api("/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ primary_discipline: discipline, ...(sex ? { sex } : {}) }),
        });
        setDiscipline(discipline);
      } catch {}
    }

    requiredElement<HTMLButtonElement>(modal, "#obSkip").addEventListener("click", async () => {
      await persistBasics();
      await markOnboarded();
      enterApp();
    });

    requiredElement<HTMLButtonElement>(modal, "#obStart").addEventListener("click", async () => {
      const status = requiredElement<HTMLElement>(modal, "#obStatus");
      const sex = requiredElement<HTMLSelectElement>(modal, "#obSex");
      if (!sex.value) {
        status.textContent = "Choose sex so Cairn can use the right health ranges.";
        sex.focus();
        return;
      }
      const text = composeIntro();
      const button = requiredElement<HTMLButtonElement>(modal, "#obStart");
      button.disabled = true;
      button.textContent = "GETTING TO KNOW YOU…";
      status.innerHTML = CairnUi.jobCaptionHtml();
      const capEl = status.querySelector<HTMLElement>(".job-cap");
      if (capEl) thinkingCaption(capEl, "onboard");
      if (!reducedMotion()) status.classList.add("is-thinking");
      try {
        await api("/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        await persistBasics();
        toast("You're all set");
      } catch {
        await persistBasics();
        await markOnboarded();
        toast("Saved — you can refine anytime in Me");
      }
      enterApp();
    });
  }

  Object.assign(globalThis, { maybeOnboard, openOnboarding });

  if (typeof window !== "undefined") {
    window.maybeOnboard = maybeOnboard;
    window.openOnboarding = openOnboarding;
  }
}
