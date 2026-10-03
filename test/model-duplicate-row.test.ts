/**
 * v0.4.7.3f: one model rendered twice by the WorkBuddy menu.
 *
 * Measured on the live page, 2026-10-03, menu open, 23 rows: "Hy3" is at row 4
 * and again at row 18, the two rows are byte-identical, and neither carries
 * any stable identity - only `class`, `role`, `aria-selected`, `aria-disabled`.
 * The menu body is a `div.cr-slim-scroll` viewport 268px tall (~8 of 23 rows),
 * so row 18 sits at y=1203: rendered, clickable, and completely off screen.
 *
 * The old rule counted rows and called two of them MODEL_AMBIGUOUS, which is
 * why a task that could have run on Hy3 was dropped back onto the queue.
 *
 * These cases build that page - real geometry, real row height, real viewport -
 * and run the expressions that ship against it, so the resolution is exercised
 * the way production exercises it rather than against a hand-made option list.
 */

import { describe, expect, it } from "vitest";
import {
  LIST_MODEL_OPTIONS_EXPRESSION,
  WorkBuddyModelController,
  WorkBuddyModelError,
  findModelOption,
  isUsableModelRow,
  type ModelOption,
} from "../src/workbuddy/model.js";

/** Measured: the menu viewport, and the row pitch. */
const VIEWPORT = { top: 627, left: 462, width: 322, height: 268 };
const ROW_HEIGHT = 32;

type StubNode = {
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  text: string;
  children: StubNode[];
  parent: StubNode | null;
  rect: { top: number; left: number; width: number; height: number };
  style: { display: string; visibility: string; pointerEvents: string };
  onClick: (() => void) | null;
};

function node(spec: Partial<StubNode> & { tag: string }): StubNode {
  const built: StubNode = {
    tag: spec.tag,
    classes: spec.classes ?? [],
    attrs: spec.attrs ?? {},
    text: spec.text ?? "",
    children: [],
    parent: null,
    rect: spec.rect ?? { top: 0, left: 0, width: 0, height: 0 },
    style: spec.style ?? { display: "block", visibility: "visible", pointerEvents: "auto" },
    onClick: spec.onClick ?? null,
  };

  for (const child of spec.children ?? []) {
    child.parent = built;
    built.children.push(child);
  }

  return built;
}

/** The compound selectors the model expressions use: tag, .class, [attr='v']. */
function matchesSelector(candidate: StubNode, selector: string): boolean {
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(selector);
  const tag = tagMatch === null ? null : tagMatch[0];
  const rest = tag === null ? selector : selector.slice(tag.length);

  if (tag !== null && candidate.tag !== tag) return false;

  for (const match of rest.matchAll(/\.([\w-]+)/g)) {
    if (!candidate.classes.includes(match[1] as string)) return false;
  }

  for (const match of rest.matchAll(/\[([\w-]+)(?:=['"]?([^\]'"]*)['"]?)?\]/g)) {
    const name = match[1] as string;
    const has = Object.prototype.hasOwnProperty.call(candidate.attrs, name);
    if (match[2] === undefined) {
      if (!has) return false;
    } else if (candidate.attrs[name] !== match[2]) {
      return false;
    }
  }

  return true;
}

function queryAll(root: StubNode, selector: string): StubNode[] {
  const found: StubNode[] = [];

  const walk = (current: StubNode): void => {
    for (const child of current.children) {
      if (matchesSelector(child, selector)) found.push(child);
      walk(child);
    }
  };

  walk(root);
  return found;
}

/** What the page expressions get to touch, and nothing else. */
function asElement(target: StubNode, styles: WeakMap<object, StubNode["style"]>) {
  const element = {
    getAttribute: (name: string): string | null =>
      name === "class"
        ? target.classes.join(" ")
        : Object.prototype.hasOwnProperty.call(target.attrs, name)
          ? (target.attrs[name] as string)
          : null,
    hasAttribute: (name: string): boolean =>
      name === "class"
        ? target.classes.length > 0
        : Object.prototype.hasOwnProperty.call(target.attrs, name),
    textContent: target.text,
    querySelector: (selector: string) => {
      const hit = queryAll(target, selector)[0];
      return hit === undefined ? null : asElement(hit, styles);
    },
    querySelectorAll: (selector: string) => queryAll(target, selector).map((hit) => asElement(hit, styles)),
    getBoundingClientRect: () => ({
      top: target.rect.top,
      bottom: target.rect.top + target.rect.height,
      left: target.rect.left,
      right: target.rect.left + target.rect.width,
      width: target.rect.width,
      height: target.rect.height,
    }),
    closest: (selector: string) => {
      let current: StubNode | null = target;
      while (current !== null) {
        if (matchesSelector(current, selector)) return asElement(current, styles);
        current = current.parent;
      }
      return null;
    },
    click: () => {
      if (target.onClick !== null) target.onClick();
    },
  };

  styles.set(element, target.style);
  return element;
}

type RowSpec = {
  name: string;
  /** Extra attributes, i.e. whatever identity the row exposes. */
  attrs?: Record<string, string>;
  hidden?: boolean;
  disabled?: boolean;
  selected?: boolean;
  /** Pushes the row further down the menu, i.e. out of the scroll viewport. */
  offsetY?: number;
};

type PageState = {
  open: boolean;
  triggerLabel: string;
  clickedRows: number[];
  /** Whether a click really switches the model - false models a dead click. */
  applies: boolean;
  /** How many times the shipped read expression has run against this page. */
  reads: number;
};

/** One row, at the position it was read at: position decides what is on screen. */
function rowNode(spec: RowSpec, index: number, onClick: () => void): StubNode {
  return node({
    tag: "div",
    classes: spec.selected === true
      ? ["cr-model-selector__item", "cr-model-selector__item--selected"]
      : ["cr-model-selector__item"],
    attrs: {
      role: "option",
      "aria-selected": spec.selected === true ? "true" : "false",
      "aria-disabled": spec.disabled === true ? "true" : "false",
      ...(spec.attrs ?? {}),
    },
    rect: {
      top: VIEWPORT.top + index * ROW_HEIGHT + (spec.offsetY ?? 0),
      left: VIEWPORT.left,
      width: VIEWPORT.width,
      height: ROW_HEIGHT,
    },
    style: spec.hidden === true
      ? { display: "none", visibility: "visible", pointerEvents: "auto" }
      : { display: "flex", visibility: "visible", pointerEvents: "auto" },
    children: [
      node({
        tag: "div",
        classes: ["cr-model-selector__item-content"],
        children: [
          node({
            tag: "span",
            classes: ["cr-model-selector__item-name"],
            text: spec.name,
          }),
        ],
      }),
    ],
    onClick,
  });
}

/**
 * The measured page, rebuilt for every evaluation so the expressions always
 * read the current state and never a cached copy of it.
 */
type RowsSource = RowSpec[] | ((state: PageState) => RowSpec[]);

/**
 * `rows` may be a function of the live page so a case can model the menu
 * re-rendering: everything up to and including the read sees one DOM, and the
 * click - one round trip later - sees another. That window is exactly what the
 * click-time revalidation exists for.
 */
function makePage(options: { triggerLabel: string; rows: RowsSource; applies?: boolean }) {
  const state: PageState = {
    open: false,
    triggerLabel: options.triggerLabel,
    clickedRows: [],
    applies: options.applies ?? true,
    reads: 0,
  };

  const build = (): StubNode => {
    const trigger = node({
      tag: "button",
      classes: ["cr-model-selector__trigger"],
      attrs: { role: "combobox", title: state.triggerLabel },
      children: [
        node({
          tag: "span",
          classes: ["cr-model-selector__trigger-label"],
          text: state.triggerLabel,
        }),
      ],
      onClick: () => {
        state.open = !state.open;
      },
    });

    const specs = typeof options.rows === "function" ? options.rows(state) : options.rows;
    const rows = specs.map((spec, index) =>
      rowNode(spec, index, () => {
        state.clickedRows.push(index);
        if (state.applies) {
          state.triggerLabel = spec.name;
          state.open = false;
        }
      }),
    );

    const popover = node({
      tag: "div",
      classes: ["cr-model-selector__popover"],
      attrs: { role: "listbox" },
      rect: { top: VIEWPORT.top, left: VIEWPORT.left, width: VIEWPORT.width, height: VIEWPORT.height },
      children: [
        node({
          tag: "div",
          classes: ["cr-slim-scroll"],
          rect: {
            top: VIEWPORT.top,
            left: VIEWPORT.left,
            width: VIEWPORT.width,
            height: VIEWPORT.height,
          },
          children: rows,
        }),
      ],
    });

    return node({
      tag: "body",
      children: [trigger, ...(state.open ? [popover] : [])],
    });
  };

  const styles = new WeakMap<object, StubNode["style"]>();

  const evaluate = async (expression: string): Promise<unknown> => {
    const document = {
      querySelector: (selector: string) => {
        const hit = queryAll(build(), selector)[0];
        return hit === undefined ? null : asElement(hit, styles);
      },
      querySelectorAll: (selector: string) =>
        queryAll(build(), selector).map((hit) => asElement(hit, styles)),
    };

    const window_ = {
      getComputedStyle: (element: object) =>
        styles.get(element) ?? { display: "block", visibility: "visible", pointerEvents: "auto" },
    };

    const run = new Function(
      "document",
      "window",
      `return (${expression})`,
    ) as (doc: unknown, win: unknown) => unknown;

    const result = run(document, window_);

    // Counted after the read, so the read itself sees the pre-drift DOM.
    if (expression === LIST_MODEL_OPTIONS_EXPRESSION) state.reads += 1;

    return result;
  };

  const controller = new WorkBuddyModelController(evaluate, {
    timeoutMs: 150,
    pollIntervalMs: 5,
    sleep: async () => undefined,
  });

  return { state, controller };
}

/** The production catalogue shape: filler rows, "Hy3" at 4 and again at 18. */
function productionCatalog(
  hy3At: number[],
  decorate: (position: number) => Record<string, string>,
): RowSpec[] {
  const rows: RowSpec[] = [];

  for (let index = 0; index < 23; index += 1) {
    const name = hy3At.includes(index) ? "Hy3" : `model-${index}`;
    rows.push({ name, ...(hy3At.includes(index) ? { attrs: decorate(index) } : {}) });
  }

  return rows;
}

async function expectAmbiguous(
  promise: Promise<unknown>,
  reason: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(WorkBuddyModelError);

  const error = await promise.catch((thrown: unknown) => thrown);
  expect((error as WorkBuddyModelError).code).toBe("MODEL_AMBIGUOUS");
  expect((error as WorkBuddyModelError).message).toContain(reason);
}

describe("a model the menu renders twice", () => {
  it("treats two rows with the same stable identity as one model", async () => {
    // Same identity on both rows, and the second one scrolled out of view -
    // the production shape, with the identity the page does not offer today.
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([4, 18], () => ({ "data-model-id": "hy3" })),
    });

    const result = await controller.selectModel("Hy3");

    expect(result.changed).toBe(true);
    expect(result.current).toBe("Hy3");
    // The row the relay can actually see was the one it clicked.
    expect(state.clickedRows).toEqual([4]);
  });

  it("still refuses when two rows with the same name carry different identities", async () => {
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([0, 1], (position) => ({
        "data-model-id": position === 0 ? "hy3-a" : "hy3-b",
      })),
    });

    await expectAmbiguous(controller.selectModel("Hy3"), "identity_conflict");
    // Two models wearing one name: not a choice the relay is allowed to make.
    expect(state.clickedRows).toEqual([]);
  });

  it("picks the row that is on screen when a duplicate is scrolled out of it", async () => {
    // Exactly the measured page: two identical "Hy3" rows, no identity, one of
    // them below the 268px viewport.
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([4, 18], () => ({})),
    });

    const result = await controller.selectModel("Hy3");

    expect(result.current).toBe("Hy3");
    expect(state.clickedRows).toEqual([4]);
  });

  it("picks the visible row when the duplicate is not rendered at all", async () => {
    const rows = productionCatalog([4], () => ({}));
    rows.push({ name: "Hy3", hidden: true });

    const { state, controller } = makePage({ triggerLabel: "Hy4 preview", rows });

    const result = await controller.selectModel("Hy3");

    expect(result.current).toBe("Hy3");
    expect(state.clickedRows).toEqual([4]);
  });

  it("refuses two rows that are both usable and impossible to tell apart", async () => {
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([0, 1], () => ({})),
    });

    await expectAmbiguous(controller.selectModel("Hy3"), "indistinguishable");
    // Guessing would be a coin toss between two rows, so nothing is clicked.
    expect(state.clickedRows).toEqual([]);
  });

  it("refuses when every row with the name is out of the viewport", async () => {
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([10, 18], () => ({})),
    });

    await expectAmbiguous(controller.selectModel("Hy3"), "no_usable_row");
    expect(state.clickedRows).toEqual([]);
  });

  it("refuses duplicates that are provably one model but none of them usable", async () => {
    // The identity says the two rows are the same model; it says nothing about
    // which one to click, and both are below the fold. Taking the first row
    // anyway would be choosing by DOM order.
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([10, 18], () => ({ "data-model-id": "hy3" })),
    });

    await expectAmbiguous(controller.selectModel("Hy3"), "no_usable_row");
    expect(state.clickedRows).toEqual([]);
  });

  it("keeps a single row working exactly as before", async () => {
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([4], () => ({})),
    });

    const result = await controller.selectModel("Hy3");

    expect(result.changed).toBe(true);
    expect(result.previous).toBe("Hy4 preview");
    expect(result.current).toBe("Hy3");
    expect(state.clickedRows).toEqual([4]);
  });

  it("does not open the menu when the model is already active", async () => {
    const { state, controller } = makePage({
      triggerLabel: "Hy3",
      rows: productionCatalog([4, 18], () => ({})),
    });

    const result = await controller.selectModel("Hy3");

    expect(result.changed).toBe(false);
    expect(state.clickedRows).toEqual([]);
  });
});

describe("a click the page never confirms", () => {
  it("fails the switch even when the row was clicked", async () => {
    /*
     * The row accepted the click and the trigger stayed where it was. That is
     * not a switch, and it must not be reported as one - the confirmation is
     * the only evidence the relay has that WorkBuddy moved.
     */
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([4, 18], () => ({})),
      applies: false,
    });

    await expect(controller.selectModel("Hy3")).rejects.toBeInstanceOf(WorkBuddyModelError);

    const error = await controller.selectModel("Hy3").catch((thrown: unknown) => thrown);
    expect((error as WorkBuddyModelError).code).toBe("SWITCH_CONFIRM_TIMEOUT");
    expect(state.clickedRows).not.toHaveLength(0);
    expect(state.triggerLabel).toBe("Hy4 preview");
  });
});

/** Refused at click time: the row is no longer the one the resolution chose. */
async function expectRefusedClick(
  promise: Promise<unknown>,
  reason: string,
): Promise<void> {
  const error = await promise.catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(WorkBuddyModelError);
  expect((error as WorkBuddyModelError).code).toBe("MODEL_AMBIGUOUS");
  expect((error as WorkBuddyModelError).message).toContain(reason);
}

/**
 * The menu is live and the relay reads it once, then clicks. These cases move
 * the row in between - the window the click-time revalidation is there for.
 */
describe("a row that changes after it was read", () => {
  it("refuses to click when the row is still called Hy3 but is another model", async () => {
    // Read: index 4, "Hy3", data-model-id=hy3-a. Before the click the menu
    // re-renders and index 4 is still "Hy3" - with a different identity.
    const before = productionCatalog([4], () => ({ "data-model-id": "hy3-a" }));
    const after = productionCatalog([4], () => ({ "data-model-id": "hy3-b" }));

    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: (page) => (page.reads >= 1 ? after : before),
    });

    await expectRefusedClick(controller.selectModel("Hy3"), "row-identity-drifted");
    // The name matched, so only the identity could have caught this. Clicking
    // would have run the task on whatever model the row turned into.
    expect(state.clickedRows).toEqual([]);
    expect(state.triggerLabel).toBe("Hy4 preview");
  });

  it("refuses to click a row that became disabled", async () => {
    const rows = productionCatalog([4, 18], () => ({}));
    const drifted = rows.map((row, at) => (at === 4 ? { ...row, disabled: true } : row));

    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: (page) => (page.reads >= 1 ? drifted : rows),
    });

    await expectRefusedClick(controller.selectModel("Hy3"), "row-disabled");
    expect(state.clickedRows).toEqual([]);
  });

  it("refuses to click a row that scrolled out of the viewport", async () => {
    // Row 4 was picked precisely because it was the one on screen.
    const rows = productionCatalog([4, 18], () => ({}));
    const drifted = rows.map((row, at) => (at === 4 ? { ...row, offsetY: 2000 } : row));

    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: (page) => (page.reads >= 1 ? drifted : rows),
    });

    await expectRefusedClick(controller.selectModel("Hy3"), "row-offscreen");
    expect(state.clickedRows).toEqual([]);
  });

  it("refuses to click a row that stopped being rendered", async () => {
    const rows = productionCatalog([4, 18], () => ({}));
    const drifted = rows.map((row, at) => (at === 4 ? { ...row, hidden: true } : row));

    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: (page) => (page.reads >= 1 ? drifted : rows),
    });

    await expectRefusedClick(controller.selectModel("Hy3"), "row-hidden");
    expect(state.clickedRows).toEqual([]);
  });

  it("refuses to click a row the menu replaced with another model", async () => {
    const rows = productionCatalog([4, 18], () => ({}));
    const drifted = rows.map((row, at) => (at === 4 ? { ...row, name: "GLM-5.3-Flash" } : row));

    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: (page) => (page.reads >= 1 ? drifted : rows),
    });

    await expectRefusedClick(controller.selectModel("Hy3"), "row-is-another-model");
    expect(state.clickedRows).toEqual([]);
  });
});

/**
 * Identity is `attribute=value`, not the bare value: two rows that agree on a
 * string but not on where it came from are not one proven model.
 */
describe("identity is read with the attribute it came from", () => {
  it("does not merge rows that share a value across different attributes", async () => {
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([4, 18], (position) =>
        position === 4 ? { "data-model-id": "hy3" } : { "data-model-key": "hy3" },
      ),
    });

    await expectAmbiguous(controller.selectModel("Hy3"), "identity_conflict");
    // Same name, same value, different source: that is an unproven merge, and
    // an unproven merge is a guess.
    expect(state.clickedRows).toEqual([]);
  });
});

/** A label that appears once never depended on the viewport to be resolved. */
describe("a row the name alone identifies", () => {
  it("is still clicked when it sits below the fold", async () => {
    // Half the catalogue is scrolled out of the 268px viewport. Refusing those
    // rows would break switches that have always worked, so "on screen" is
    // only re-checked when it is what chose the row.
    const { state, controller } = makePage({
      triggerLabel: "Hy4 preview",
      rows: productionCatalog([18], () => ({})),
    });

    const result = await controller.selectModel("Hy3");

    expect(result.current).toBe("Hy3");
    expect(state.clickedRows).toEqual([18]);
  });
});

/** The resolution itself, without a page. */
describe("the duplicate-row resolution", () => {
  const row = (over: Partial<ModelOption> & { index: number; name: string }): ModelOption => ({
    selected: false,
    disabled: false,
    identity: null,
    rendered: true,
    clickable: true,
    inViewport: true,
    ...over,
  });

  it("calls a row that is rendered but scrolled away unusable", () => {
    expect(isUsableModelRow(row({ index: 4, name: "Hy3", inViewport: false }))).toBe(false);
    expect(isUsableModelRow(row({ index: 4, name: "Hy3" }))).toBe(true);
    expect(isUsableModelRow(row({ index: 4, name: "Hy3", disabled: true }))).toBe(false);
    expect(isUsableModelRow(row({ index: 4, name: "Hy3", rendered: false }))).toBe(false);
    expect(isUsableModelRow(row({ index: 4, name: "Hy3", clickable: false }))).toBe(false);
  });

  it("merges duplicates only when the page identified them as one model", () => {
    const same = findModelOption(
      [
        row({ index: 4, name: "Hy3", identity: "hy3" }),
        row({ index: 18, name: "Hy3", identity: "hy3", inViewport: false }),
      ],
      "Hy3",
    );

    expect(same.kind === "found" && same.basis).toBe("merged_identity");

    const different = findModelOption(
      [
        row({ index: 0, name: "Hy3", identity: "hy3-a" }),
        row({ index: 1, name: "Hy3", identity: "hy3-b" }),
      ],
      "Hy3",
    );

    expect(different.kind === "ambiguous" && different.reason).toBe("identity_conflict");
  });

  it("falls back to the usable row when the page identifies nothing", () => {
    // The measured production shape: row 4 on screen, row 18 below the fold.
    const resolved = findModelOption(
      [
        row({ index: 4, name: "Hy3" }),
        row({ index: 18, name: "Hy3", inViewport: false }),
      ],
      "Hy3",
    );

    expect(resolved.kind === "found" && resolved.option.index).toBe(4);
    expect(resolved.kind === "found" && resolved.basis).toBe("usable_row");
  });

  it("refuses duplicates that are the same model but none of them usable", () => {
    // Same identity on both rows, both scrolled out of the menu. Proving they
    // are one model says nothing about which one to click, so nothing is.
    const resolved = findModelOption(
      [
        row({ index: 10, name: "Hy3", identity: "data-model-id=hy3", inViewport: false }),
        row({ index: 18, name: "Hy3", identity: "data-model-id=hy3", inViewport: false }),
      ],
      "Hy3",
    );

    expect(resolved.kind === "ambiguous" && resolved.reason).toBe("no_usable_row");
  });

  it("never picks a row just because it came first", () => {
    const resolved = findModelOption(
      [row({ index: 0, name: "Hy3" }), row({ index: 1, name: "Hy3" })],
      "Hy3",
    );

    expect(resolved.kind).toBe("ambiguous");
  });

  it("refuses two usable duplicates the page does not identify", () => {
    const resolved = findModelOption(
      [
        row({ index: 10, name: "Hy3", inViewport: false }),
        row({ index: 18, name: "Hy3", inViewport: false }),
      ],
      "Hy3",
    );

    expect(resolved.kind === "ambiguous" && resolved.reason).toBe("no_usable_row");
  });
});
