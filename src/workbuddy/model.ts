/**
 * WorkBuddy model selector control over CDP.
 *
 * Every selector here was measured against the live WorkBuddy page rather
 * than guessed. The structural facts that drive the design:
 *
 *   button.cr-model-selector__trigger          role=combobox, aria-label
 *                                              "Select model", title mirrors
 *                                              the current model
 *     span.cr-model-selector__trigger-label    holds ONLY the model name
 *
 *   The menu is rendered lazily and portaled, so nothing exists until the
 *   trigger is clicked:
 *
 *   body > div                                 unnamed portal wrapper
 *     div.cr-model-selector__popover           role=listbox
 *       div.cr-menu.cr-model-selector__menu
 *         div.cr-slim-scroll                   the scroll viewport
 *           div.cr-model-selector__item        role=option, aria-selected
 *             div.cr-model-selector__item-content
 *               span.cr-model-selector__item-name   ONLY the model name
 *               span.cr-model-selector__item-badge  "限时免费" / "夜间折扣"
 *               span.cr-model-selector__item-credits "0.00x"
 *               span.cr-model-selector__item-check   selected checkmark
 *
 * The important consequence: the item's own textContent is polluted with the
 * badge and the credit multiplier (`"Hy4 preview限时免费0.00x"`), so never
 * match on it. Only `.cr-model-selector__item-name` is clean, and that is
 * what every lookup below uses, by exact equality.
 *
 * Exact equality is required, not merely preferred: the catalog contains both
 * "GLM-5.3" and "GLM-5.3-Flash", so a substring match for "GLM-5.3" would
 * silently resolve to the wrong row.
 */

export type WorkBuddyModelErrorCode =
  | "SELECTOR_NOT_FOUND"
  | "MENU_OPEN_TIMEOUT"
  | "MODEL_NOT_FOUND"
  | "MODEL_AMBIGUOUS"
  | "SWITCH_CONFIRM_TIMEOUT"
  | "CDP_RESPONSE_INVALID";

export class WorkBuddyModelError extends Error {
  readonly code: WorkBuddyModelErrorCode;
  readonly available: readonly string[];

  constructor(
    code: WorkBuddyModelErrorCode,
    message: string,
    available: readonly string[] = [],
  ) {
    super(message);
    this.name = "WorkBuddyModelError";
    this.code = code;
    this.available = available;
  }
}

export type ModelOption = {
  name: string;
  selected: boolean;
  disabled: boolean;
};

export type ModelSwitchResult = {
  changed: boolean;
  previous: string | null;
  current: string;
};

/**
 * Pure lookup so the exact-match rule is testable without a browser. Returns
 * the single matching option, or a discriminated miss explaining whether the
 * label was absent or resolved to more than one row.
 */
export function findModelOption(
  options: readonly ModelOption[],
  label: string,
):
  | { kind: "found"; option: ModelOption }
  | { kind: "not_found"; available: readonly string[] }
  | { kind: "ambiguous"; matches: readonly ModelOption[] } {
  const matches = options.filter((option) => option.name === label);

  if (matches.length === 1) {
    return { kind: "found", option: matches[0] as ModelOption };
  }

  if (matches.length > 1) {
    return { kind: "ambiguous", matches };
  }

  return { kind: "not_found", available: options.map((option) => option.name) };
}

const READ_CURRENT_MODEL_EXPRESSION = `(() => {
  const trigger = document.querySelector("button.cr-model-selector__trigger");
  if (!trigger) return JSON.stringify({ found: false, model: null });
  const label = trigger.querySelector(".cr-model-selector__trigger-label");
  const raw = label ? (label.textContent || "") : (trigger.getAttribute("title") || "");
  const model = raw.trim();
  return JSON.stringify({ found: true, model: model || null });
})()`;

const OPEN_MODEL_MENU_EXPRESSION = `(() => {
  const trigger = document.querySelector("button.cr-model-selector__trigger");
  if (!trigger) return JSON.stringify({ clicked: false });
  const popover = document.querySelector("div.cr-model-selector__popover[role='listbox']");
  if (!popover) trigger.click();
  return JSON.stringify({ clicked: true });
})()`;

const MODEL_MENU_OPEN_EXPRESSION = `(() => {
  const popover = document.querySelector("div.cr-model-selector__popover[role='listbox']");
  return JSON.stringify({ open: !!popover });
})()`;

const LIST_MODEL_OPTIONS_EXPRESSION = `(() => {
  const popover = document.querySelector("div.cr-model-selector__popover[role='listbox']");
  if (!popover) return JSON.stringify({ open: false, options: [] });
  const items = Array.from(
    popover.querySelectorAll("div.cr-model-selector__item[role='option']")
  );
  const options = items.map((item) => {
    const nameEl = item.querySelector(".cr-model-selector__item-name");
    return {
      name: nameEl ? (nameEl.textContent || "").trim() : "",
      selected: item.getAttribute("aria-selected") === "true",
      disabled: item.getAttribute("aria-disabled") === "true",
    };
  });
  return JSON.stringify({ open: true, options });
})()`;

const CLICK_MODEL_OPTION_EXPRESSION = (label: string) => `(() => {
  const wanted = ${JSON.stringify(label)};
  const popover = document.querySelector("div.cr-model-selector__popover[role='listbox']");
  if (!popover) return JSON.stringify({ clicked: false, reason: "menu-not-open" });
  const items = Array.from(
    popover.querySelectorAll("div.cr-model-selector__item[role='option']")
  );
  const hits = items.filter((item) => {
    const nameEl = item.querySelector(".cr-model-selector__item-name");
    return nameEl && (nameEl.textContent || "").trim() === wanted;
  });
  if (hits.length !== 1) {
    return JSON.stringify({ clicked: false, reason: "no-unique-match", count: hits.length });
  }
  hits[0].click();
  return JSON.stringify({ clicked: true });
})()`;

const CLOSE_MODEL_MENU_EXPRESSION = `(() => {
  const popover = document.querySelector("div.cr-model-selector__popover[role='listbox']");
  if (!popover) return JSON.stringify({ open: false });
  const trigger = document.querySelector("button.cr-model-selector__trigger");
  if (trigger) trigger.click();
  return JSON.stringify({ open: true });
})()`;

function parseJsonPayload<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export type WorkBuddyModelControllerOptions = {
  /** How long to wait for the menu to open and for the switch to confirm. */
  timeoutMs?: number;
  /** Poll interval used while waiting on the UI. */
  pollIntervalMs?: number;
  /** Injected so tests never sleep. */
  sleep?: (ms: number) => Promise<void>;
};

type EvaluateLike = (expression: string) => Promise<unknown>;

export class WorkBuddyModelController {
  private readonly evaluate: EvaluateLike;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    cdp: { evaluate: EvaluateLike } | EvaluateLike,
    options: WorkBuddyModelControllerOptions = {},
  ) {
    this.evaluate =
      typeof cdp === "function" ? cdp : cdp.evaluate.bind(cdp);
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Current model as shown on the trigger, or null when the UI is absent. */
  async getCurrentModel(): Promise<string | null> {
    const payload = parseJsonPayload<{ found?: boolean; model?: string | null }>(
      await this.evaluate(READ_CURRENT_MODEL_EXPRESSION),
      {},
    );

    if (payload.found !== true) {
      throw new WorkBuddyModelError(
        "SELECTOR_NOT_FOUND",
        "WorkBuddy model selector not found on the page",
      );
    }

    return payload.model ?? null;
  }

  /** Every row the real UI offers, in UI order. Opens the menu to read them. */
  async listAvailableModels(): Promise<string[]> {
    await this.openMenu();
    try {
      return (await this.readOptions()).map((option) => option.name);
    } finally {
      await this.closeMenu();
    }
  }

  /**
   * Switches WorkBuddy to `label`, or reports `changed: false` when the UI is
   * already there - in which case the menu is never opened at all.
   *
   * Throws ModelRouter-facing errors rather than falling back: silently using
   * a different model would defeat the whole point of routing.
   */
  async selectModel(label: string): Promise<ModelSwitchResult> {
    const previous = await this.getCurrentModel();

    if (previous === label) {
      return { changed: false, previous, current: label };
    }

    await this.openMenu();

    try {
      const options = await this.readOptions();
      const resolved = findModelOption(options, label);

      if (resolved.kind === "not_found") {
        throw new WorkBuddyModelError(
          "MODEL_NOT_FOUND",
          `WorkBuddy has no model labelled "${label}"`,
          resolved.available,
        );
      }

      if (resolved.kind === "ambiguous") {
        throw new WorkBuddyModelError(
          "MODEL_AMBIGUOUS",
          `Label "${label}" matched ${resolved.matches.length} WorkBuddy rows`,
          resolved.matches.map((option) => option.name),
        );
      }

      const clickPayload = parseJsonPayload<{ clicked?: boolean; reason?: string }>(
        await this.evaluate(CLICK_MODEL_OPTION_EXPRESSION(label)),
        {},
      );

      if (clickPayload.clicked !== true) {
        throw new WorkBuddyModelError(
          "MODEL_NOT_FOUND",
          `Could not click WorkBuddy model "${label}" (${clickPayload.reason ?? "unknown"})`,
          options.map((option) => option.name),
        );
      }
    } finally {
      // Selecting closes the popover on its own; this only covers the paths
      // that threw before the click landed.
      await this.closeMenu({ bestEffort: true });
    }

    const current = await this.waitUntilConfirmed(label);

    return { changed: true, previous, current };
  }

  private async openMenu(): Promise<void> {
    const payload = parseJsonPayload<{ clicked?: boolean }>(
      await this.evaluate(OPEN_MODEL_MENU_EXPRESSION),
      {},
    );

    if (payload.clicked !== true) {
      throw new WorkBuddyModelError(
        "SELECTOR_NOT_FOUND",
        "WorkBuddy model selector trigger not found",
      );
    }

    if (!(await this.pollMenuState(true))) {
      throw new WorkBuddyModelError(
        "MENU_OPEN_TIMEOUT",
        `WorkBuddy model menu did not open within ${this.timeoutMs}ms`,
      );
    }
  }

  private async closeMenu(options: { bestEffort?: boolean } = {}): Promise<void> {
    try {
      await this.evaluate(CLOSE_MODEL_MENU_EXPRESSION);
      if (!options.bestEffort) await this.pollMenuState(false);
    } catch {
      if (!options.bestEffort) throw new Error("Failed to close WorkBuddy model menu");
    }
  }

  private async readOptions(): Promise<ModelOption[]> {
    const payload = parseJsonPayload<{ open?: boolean; options?: ModelOption[] }>(
      await this.evaluate(LIST_MODEL_OPTIONS_EXPRESSION),
      {},
    );

    if (payload.open !== true || !Array.isArray(payload.options)) {
      throw new WorkBuddyModelError(
        "MENU_OPEN_TIMEOUT",
        "WorkBuddy model menu closed before its options could be read",
      );
    }

    return payload.options.map((option) => ({
      name: typeof option?.name === "string" ? option.name : "",
      selected: option?.selected === true,
      disabled: option?.disabled === true,
    }));
  }

  /**
   * A switch is only real once the trigger label changed. The checkmark and
   * aria-selected inside the popover are not enough on their own: the
   * popover unmounts on selection, so the durable evidence is the trigger.
   */
  private async waitUntilConfirmed(label: string): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const model = await this.getCurrentModel().catch(() => null);
      if (model === label) return label;
      await this.sleep(this.pollIntervalMs);
    }

    const actual = await this.getCurrentModel().catch(() => null);
    throw new WorkBuddyModelError(
      "SWITCH_CONFIRM_TIMEOUT",
      `WorkBuddy did not confirm the switch to "${label}" within ${this.timeoutMs}ms (still showing ${actual ?? "unknown"})`,
    );
  }

  private async pollMenuState(wantOpen: boolean): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() < deadline) {
      const payload = parseJsonPayload<{ open?: boolean }>(
        await this.evaluate(MODEL_MENU_OPEN_EXPRESSION),
        {},
      );
      if (payload.open === wantOpen) return true;
      await this.sleep(this.pollIntervalMs);
    }

    return false;
  }
}
