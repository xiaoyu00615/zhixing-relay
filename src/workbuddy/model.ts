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
 *
 * THE MENU ALSO RENDERS THE SAME MODEL TWICE.
 *
 * Measured on the live page (2026-10-03, menu opened, 23 rows): "Hy3" appears
 * at row 4 and again at row 18. The two rows are byte-identical - same
 * `outerHTML`, same text ("Hy3限时免费0.00x"), same classes, same
 * `aria-selected` / `aria-disabled` - and neither carries any stable identity:
 * the only attributes are `class`, `role`, `aria-selected`, `aria-disabled`,
 * and no descendant has an `id` or a `data-*` either.
 *
 * The one thing that does tell them apart is where they are: the menu body is
 * a `div.cr-slim-scroll` viewport 268px tall showing ~8 of the 23 rows, and
 * row 18 sits at y=1203 - below the viewport, clipped, not on screen for the
 * user - while row 4 sits at y=755, inside it. Counting rows as "two models"
 * therefore failed a switch that was perfectly safe, so the duplicate is now
 * tolerated under the rules in `findModelOption`: never by picking the first
 * match, and only when the rows are provably the same thing.
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

/**
 * Attributes the page could use to say which model a row *is*, as opposed to
 * what it is called.
 *
 * None of them is present today - the measured Hy3 rows carry only `class`,
 * `role`, `aria-selected` and `aria-disabled` - so `identity` is null on the
 * live page and the resolution falls through to the visibility rules. The list
 * is read anyway, in this order, so that a UI that starts identifying its rows
 * is understood without another production incident. It deliberately excludes
 * `id`: React hands those out per render, so two renders of one model would
 * look like two models.
 */
export const IDENTITY_ATTRIBUTE_NAMES = [
  "data-model-id",
  "data-model",
  "data-model-key",
  "data-id",
  "data-key",
  "data-value",
  "data-testid",
  "value",
  "href",
] as const;

export type ModelOption = {
  /** Position in the open menu. Used to click the row that was decided on. */
  index: number;
  name: string;
  selected: boolean;
  disabled: boolean;
  /** Stable identity of the model behind the row, or null when the page hides it. */
  identity: string | null;
  /** The row is rendered at all: not display:none, not visibility:hidden, has a box. */
  rendered: boolean;
  /** The row can be clicked: pointer events are on and nothing disabled it. */
  clickable: boolean;
  /**
   * The row is inside the menu's scroll viewport, i.e. actually on screen.
   *
   * A row can be rendered and clickable and still be scrolled out of view -
   * which is exactly the difference between the two Hy3 rows.
   */
  inViewport: boolean;
};

export type ModelSwitchResult = {
  changed: boolean;
  previous: string | null;
  current: string;
};

/** Why a label that matched more than one row could not be trusted. */
export type ModelAmbiguityReason =
  /** The rows carry identities, and they disagree: two models, one name. */
  | "identity_conflict"
  /** No row is on screen and clickable, so there is nothing to choose. */
  | "no_usable_row"
  /** More than one row is on screen and clickable, and nothing tells them apart. */
  | "indistinguishable";

/**
 * Whether a row is one the relay may actually use: rendered, clickable, and
 * inside the scroll viewport.
 *
 * "Rendered" alone is not enough. A virtualised or oversized list keeps its
 * off-screen rows in the DOM with their geometry and their pointer events, so
 * `display`, `visibility` and `offsetParent` all say "fine" for a row the user
 * cannot see and did not scroll to.
 */
export function isUsableModelRow(option: ModelOption): boolean {
  return option.rendered && option.clickable && option.inViewport && !option.disabled;
}

/**
 * Pure resolution so the duplicate-row rule is testable without a browser.
 *
 * One match keeps today's behaviour. Several matches are only tolerated when
 * they are provably the same model:
 *
 *   every row carries an identity and they are all equal  -> one model,
 *                                                            rendered twice
 *   otherwise, and exactly one row is usable              -> that row
 *   identities present and different                      -> refuse
 *   nothing usable, or several usable and indistinguishable -> refuse
 *
 * Refusing is the default for everything that is not proven: choosing between
 * two rows the relay cannot tell apart is how a task would silently run on the
 * wrong model, and the router exists precisely so that cannot happen.
 */
export function findModelOption(
  options: readonly ModelOption[],
  label: string,
):
  | { kind: "found"; option: ModelOption; mergedDuplicates: boolean }
  | { kind: "not_found"; available: readonly string[] }
  | {
      kind: "ambiguous";
      reason: ModelAmbiguityReason;
      matches: readonly ModelOption[];
    } {
  const matches = options.filter((option) => option.name === label);

  if (matches.length === 1) {
    return { kind: "found", option: matches[0] as ModelOption, mergedDuplicates: false };
  }

  if (matches.length === 0) {
    return { kind: "not_found", available: options.map((option) => option.name) };
  }

  const identities = matches.map((option) => option.identity);

  if (identities.every((identity) => identity !== null)) {
    const first = identities[0] as string;

    if (identities.every((identity) => identity === first)) {
      const usable = matches.filter(isUsableModelRow);
      return {
        kind: "found",
        option: (usable[0] ?? matches[0]) as ModelOption,
        mergedDuplicates: true,
      };
    }

    return { kind: "ambiguous", reason: "identity_conflict", matches };
  }

  const usable = matches.filter(isUsableModelRow);

  if (usable.length === 1) {
    return { kind: "found", option: usable[0] as ModelOption, mergedDuplicates: false };
  }

  return {
    kind: "ambiguous",
    reason: usable.length === 0 ? "no_usable_row" : "indistinguishable",
    matches,
  };
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

/*
 * The facts the resolution needs, collected and nothing else decided: the row
 * index, the name, whatever identity the page exposes, and the three measured
 * ways a row can be unusable - not rendered, not clickable, or scrolled out of
 * the menu viewport.
 */
/** Exported so the expression itself, not a copy of it, is under test. */
export const LIST_MODEL_OPTIONS_EXPRESSION = `(() => {
  const popover = document.querySelector("div.cr-model-selector__popover[role='listbox']");
  if (!popover) return JSON.stringify({ open: false, options: [] });
  const items = Array.from(
    popover.querySelectorAll("div.cr-model-selector__item[role='option']")
  );
  const scroller = popover.querySelector(".cr-slim-scroll") || popover;
  const view = scroller.getBoundingClientRect();
  const identityAttrs = ${JSON.stringify(IDENTITY_ATTRIBUTE_NAMES)};

  const options = items.map((item, index) => {
    const nameEl = item.querySelector(".cr-model-selector__item-name");
    const rect = item.getBoundingClientRect();
    const style = window.getComputedStyle(item);

    let identity = null;
    for (const name of identityAttrs) {
      const value = item.getAttribute(name);
      if (value && value.trim()) {
        identity = value.trim();
        break;
      }
    }

    return {
      index: index,
      name: nameEl ? (nameEl.textContent || "").trim() : "",
      selected: item.getAttribute("aria-selected") === "true",
      disabled: item.getAttribute("aria-disabled") === "true",
      identity: identity,
      rendered:
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0,
      clickable:
        style.pointerEvents !== "none" &&
        item.getAttribute("aria-disabled") !== "true" &&
        !item.hasAttribute("disabled"),
      inViewport:
        rect.bottom > view.top &&
        rect.top < view.bottom &&
        rect.right > view.left &&
        rect.left < view.right,
    };
  });

  return JSON.stringify({ open: true, options });
})()`;

/*
 * Clicks the row the resolution picked, by position - not by name.
 *
 * Looking the label up again here would re-open the whole duplicate question,
 * so the row is addressed by index and the only check left is that the row
 * still says the label it was chosen for: if the menu changed between reading
 * it and clicking it, nothing is clicked.
 */
const CLICK_MODEL_OPTION_EXPRESSION = (request: { label: string; index: number }) => `(() => {
  const wanted = ${JSON.stringify(request.label)};
  const at = ${request.index};
  const popover = document.querySelector("div.cr-model-selector__popover[role='listbox']");
  if (!popover) return JSON.stringify({ clicked: false, reason: "menu-not-open" });
  const items = Array.from(
    popover.querySelectorAll("div.cr-model-selector__item[role='option']")
  );
  const item = items[at];
  if (!item) return JSON.stringify({ clicked: false, reason: "row-gone", count: items.length });
  const nameEl = item.querySelector(".cr-model-selector__item-name");
  const name = nameEl ? (nameEl.textContent || "").trim() : "";
  if (name !== wanted) {
    return JSON.stringify({ clicked: false, reason: "row-is-another-model", count: items.length });
  }
  item.click();
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

  /**
   * Every distinct label the real UI offers, in UI order. Opens the menu to
   * read them.
   *
   * Distinct: the menu lists "Hy3" twice, and a caller reading this as a
   * catalogue would otherwise be told the model exists twice.
   */
  async listAvailableModels(): Promise<string[]> {
    await this.openMenu();
    try {
      const names = (await this.readOptions()).map((option) => option.name);
      return names.filter((name, index) => names.indexOf(name) === index);
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
          `Label "${label}" matched ${resolved.matches.length} WorkBuddy rows ` +
            `that cannot be told apart (${resolved.reason}); refusing to guess`,
          resolved.matches.map((option) => option.name),
        );
      }

      const clickPayload = parseJsonPayload<{ clicked?: boolean; reason?: string }>(
        await this.evaluate(
          CLICK_MODEL_OPTION_EXPRESSION({ label, index: resolved.option.index }),
        ),
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

    return payload.options.map((option, index) => ({
      index: typeof option?.index === "number" ? option.index : index,
      name: typeof option?.name === "string" ? option.name : "",
      selected: option?.selected === true,
      disabled: option?.disabled === true,
      identity:
        typeof option?.identity === "string" && option.identity.length > 0
          ? option.identity
          : null,
      rendered: option?.rendered === true,
      clickable: option?.clickable === true,
      inViewport: option?.inViewport === true,
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
