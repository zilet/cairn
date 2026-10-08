// @ts-check
// Settings -> Agents: the Everyday / Deep work model on a provider card
// (settings.model_class_bindings, provider -> fast|deep -> model).
//
// "CLI default" is always first and is the default: Cairn then passes no --model and the
// CLI runs whatever the person's plan gives it. The choices are the CLI's LIVE catalog
// when it reports one, else the curated aliases from agents.json, plus "Other…" for a
// model neither shows yet. The pure helpers render and validate; wire() binds the selects
// and fetches each catalog once per Settings visit, in the background.
{
type AgentModelsAgent = { name: string; present?: boolean; models_list?: boolean; model_choices?: unknown[] } & Record<
  string,
  unknown
>;

type AgentModelsPickOptions = {
  meta: Record<string, AgentModelsAgent | undefined>;
  modelClassBindings?: Record<string, Record<string, unknown>>;
  agentCatalog?: Record<string, unknown[] | null | undefined>;
};

const MODEL_CLASSES = [
  ["fast", "Everyday model"],
  ["deep", "Deep work model"],
] as const;
const MODEL_OTHER = "__other__";
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,80}$/;

function modelsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** A free-text model id the "Other…" field accepts (the server applies the same rule). */
function modelIdValid(value: unknown): boolean {
  return typeof value === "string" && MODEL_ID_RE.test(value.trim());
}

/** Whether this provider's card offers a model choice: installed, and its CLI takes a model. */
function agentTakesModel(agent: AgentModelsAgent | undefined): boolean {
  if (!agent || agent.present === false) return false;
  const capabilities = modelsRecord(agent.capabilities);
  return capabilities.model === true && capabilities.execution_profile_noop !== true;
}

function modelList(values: unknown): string[] {
  const out: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const v = typeof value === "string" ? value.trim() : "";
    if (v && v.length <= 160 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 50);
}

/** The offered models: the live catalog when it has entries, else the curated aliases. */
function modelChoices(agent: AgentModelsAgent | undefined, catalog: unknown[] | null | undefined): string[] {
  const live = modelList(catalog);
  return live.length ? live : modelList(agent?.model_choices);
}

/** The model bound to one class for one provider ("" = CLI default). */
function modelBinding(
  bindings: Record<string, Record<string, unknown>> | undefined,
  provider: string,
  cls: string
): string {
  const value = modelsRecord(bindings?.[provider])[cls];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Apply one dropdown choice to the working bindings (mutates). "" clears the class back
 * to the CLI default; "Other…" is not a value and changes nothing. A value must be an
 * offered choice or a well-formed id. Returns whether the bindings changed.
 */
function applyModelChoice(
  bindings: Record<string, Record<string, unknown>>,
  provider: string,
  cls: string,
  value: string,
  choices: readonly string[] = []
): boolean {
  if (!provider || !MODEL_CLASSES.some(([key]) => key === cls) || value === MODEL_OTHER) return false;
  const model = String(value ?? "").trim();
  const before = modelBinding(bindings, provider, cls);
  if (!model) {
    if (!before) return false;
    const next = { ...(bindings[provider] || {}) };
    delete next[cls];
    if (Object.keys(next).length) bindings[provider] = next;
    else delete bindings[provider];
    return true;
  }
  if (!choices.includes(model) && !modelIdValid(model)) return false;
  if (before === model) return false;
  bindings[provider] = { ...(bindings[provider] || {}), [cls]: model };
  return true;
}

function modelOptionsHtml(current: string, choices: readonly string[]): string {
  const custom = current && !choices.includes(current) ? [current] : [];
  return [
    `<option value=""${current ? "" : " selected"}>CLI default</option>`,
    ...[...choices, ...custom].map(
      (model) => `<option value="${escAttr(model)}"${model === current ? " selected" : ""}>${escHtml(model)}</option>`
    ),
    `<option value="${MODEL_OTHER}">Other…</option>`,
  ].join("");
}

/** The two compact selects on a provider card; "" when this provider takes no model. */
function pickHtml(options: AgentModelsPickOptions, name: string): string {
  const agent = options.meta[name];
  if (!agentTakesModel(agent)) return "";
  const choices = modelChoices(agent, options.agentCatalog?.[name]);
  const fields = MODEL_CLASSES.map(([cls, label]) => {
    const id = `agent-model-${name}-${cls}`.replace(/[^A-Za-z0-9_-]/g, "-");
    const current = modelBinding(options.modelClassBindings, name, cls);
    return `<div class="agent-model-field">
          <label for="${escAttr(id)}">${escHtml(label)}</label>
          <select id="${escAttr(id)}" data-model-class="${cls}" data-provider="${escAttr(name)}">${modelOptionsHtml(current, choices)}</select>
          <input class="agent-model-other" data-model-other="${cls}" data-provider="${escAttr(name)}" hidden maxlength="80" autocomplete="off" spellcheck="false" placeholder="model name" aria-label="${escAttr(`${label}: model name`)}" aria-describedby="${escAttr(`${id}-hint`)}">
          <span class="agent-model-hint" id="${escAttr(`${id}-hint`)}" hidden>Letters, numbers and . _ : / - only.</span>
        </div>`;
  }).join("");
  return `<div class="agent-model-pick" role="group" aria-label="${escAttr(`${name} models`)}">
        <div class="agent-model-fields">${fields}</div>
        <p class="agent-model-help">CLI default uses whatever your plan gives you. Pick a model only if your plan includes it.</p>
      </div>`;
}

// ---- controller: one catalog map per Settings visit ----
// Keyed by that visit's agentInfo cache (a fresh object per mount), unless the screen
// hands its own map in. null = a request in flight.
const visitCatalogs = new WeakMap<object, Record<string, string[] | null>>();
function catalog(deps: ClientSettingsAgentsControllerDeps): Record<string, string[] | null> {
  if (deps.agentCatalog) return deps.agentCatalog;
  let map = visitCatalogs.get(deps.agentInfo);
  if (!map) visitCatalogs.set(deps.agentInfo, (map = {}));
  return map;
}

// Fetch each installed provider's live catalog once, in the background: the cards render
// at once with the curated choices and redraw only when a non-empty catalog arrives.
function loadCatalogs(deps: ClientSettingsAgentsControllerDeps, redraw: () => void): void {
  const map = catalog(deps);
  for (const name of deps.workingModel.order) {
    const agent = deps.meta[name] as AgentModelsAgent | undefined;
    if (!agent || !agent.models_list || !agentTakesModel(agent) || name in map) continue;
    map[name] = null;
    Promise.resolve()
      .then(() => deps.api(`/agents/${encodeURIComponent(name)}/models`) as Promise<SettingsScreenAgentModelsResponse>)
      .then(
        (response) => {
          const models = response && response.ok && Array.isArray(response.models) ? response.models : [];
          map[name] = models.filter((m): m is string => typeof m === "string");
        },
        () => {
          map[name] = [];
        }
      )
      .then(() => {
        if ((map[name] || []).length && deps.root.isConnected !== false) redraw();
      });
  }
}

function wire(deps: ClientSettingsAgentsControllerDeps, wrap: HTMLElement, redraw: () => void): void {
  if (!deps.workingModel.model_class_bindings) deps.workingModel.model_class_bindings = {};
  const bindings = deps.workingModel.model_class_bindings;
  const choicesFor = (provider: string) =>
    modelChoices(deps.meta[provider] as AgentModelsAgent | undefined, catalog(deps)[provider]);
  wrap.querySelectorAll<HTMLSelectElement>("[data-model-class]").forEach((select) =>
    select.addEventListener("change", () => {
      const provider = select.dataset.provider || "";
      const cls = select.dataset.modelClass || "";
      const other = select.closest(".agent-model-field")?.querySelector<HTMLInputElement>("[data-model-other]") ?? null;
      if (select.value === MODEL_OTHER) {
        if (other) {
          other.hidden = false;
          other.value = modelBinding(bindings, provider, cls);
          other.focus();
        }
        return;
      }
      if (other) other.hidden = true;
      if (applyModelChoice(bindings, provider, cls, select.value, choicesFor(provider))) deps.markDirty();
    })
  );
  wrap.querySelectorAll<HTMLInputElement>("[data-model-other]").forEach((input) =>
    input.addEventListener("change", () => {
      const provider = input.dataset.provider || "";
      const cls = input.dataset.modelOther || "";
      const hint = input.parentElement?.querySelector<HTMLElement>(".agent-model-hint") ?? null;
      const value = input.value.trim();
      const valid = !value || modelIdValid(value);
      input.setAttribute("aria-invalid", valid ? "false" : "true");
      if (hint) hint.hidden = valid;
      if (!valid || !value) return;
      if (applyModelChoice(bindings, provider, cls, value, choicesFor(provider))) deps.markDirty();
      redraw();
    })
  );
  loadCatalogs(deps, redraw);
}

const CAIRN_SETTINGS_AGENT_MODELS = {
  pickHtml,
  modelChoices,
  modelIdValid,
  agentTakesModel,
  applyModelChoice,
  modelBinding,
  catalog,
  wire,
};

Object.assign(globalThis, { CairnSettingsAgentModels: CAIRN_SETTINGS_AGENT_MODELS });

if (typeof window !== "undefined") {
  window.CairnSettingsAgentModels = CAIRN_SETTINGS_AGENT_MODELS;
}
}
