/**
 * v0.4.7.3d: the page expression itself.
 *
 * The unit tests in workbuddy-user-turn.test.ts prove the *verdict* is right;
 * this file proves the *page adapter* hands it the right set to judge. The
 * expression shipped to the browser is evaluated here against a stub document,
 * so a bug of the shape "the snapshot stopped carrying the task id" fails here
 * instead of in production.
 */

import { describe, expect, it } from "vitest";
import { TURN_SNAPSHOT_EXPRESSION } from "../src/workbuddy/client.js";

const SMOKE_TASK = "relay-production-smoke-v0473c-001";

type StubNode = {
  text: string;
  classes?: string[];
  /** Selectors this node answers to, i.e. which chrome it renders. */
  has?: string[];
};

/**
 * The smallest `document` the expression needs: one composer and a list of
 * `.cr-agent` nodes. Nothing else on the page exists as far as it is concerned.
 */
function evaluatePage(
  nodes: StubNode[],
  options: { taskId: string; payloadPrefix: string; composer?: string },
): { inputText: string; turnCount: number; turns: Array<{ signature: string; role: string; containsTaskId: boolean }> } {
  const document = {
    querySelector: (selector: string) =>
      selector.includes("contenteditable") ? { innerText: options.composer ?? "" } : null,
    querySelectorAll: (selector: string) =>
      selector === ".cr-agent"
        ? nodes.map((node) => ({
            innerText: node.text,
            classList: { contains: (name: string) => (node.classes ?? []).includes(name) },
            querySelector: (inner: string) => ((node.has ?? []).includes(inner) ? { innerText: node.text } : null),
            querySelectorAll: () => [],
          }))
        : [],
  };

  const run = new Function(
    "document",
    // CDP evaluates the expression and hands back its value; a Function body
    // has to say so explicitly.
    // Parenthesised on purpose: the expression starts with a newline, and
    // `return` followed by a newline is a different statement.
    `return (${TURN_SNAPSHOT_EXPRESSION({ taskId: options.taskId, payloadPrefix: options.payloadPrefix })})`,
  ) as (doc: unknown) => string;

  return JSON.parse(run(document)) as {
    inputText: string;
    turnCount: number;
    turns: Array<{ signature: string; role: string; containsTaskId: boolean }>;
  };
}

describe("the turn snapshot the page produces", () => {
  const payloadPrefix = "Production smoke test only.";

  it("leaves WorkBuddy's status card out of the outbound turns", () => {
    /*
     * The production node, as the page rendered it: 20 characters of
     * WorkBuddy chrome, and the processing label inside it.
     */
    const page = evaluatePage(
      [{ text: "WorkBuddy ... 已处理 ... 思考中", classes: ["cr-agent", "cr-agent--processing"], has: [".cr-agent__processing-status"] }],
      { taskId: SMOKE_TASK, payloadPrefix },
    );

    expect(page.turnCount).toBe(1);
    expect(page.turns).toEqual([]);
  });

  it("reports the outbound turn with the task id it carries", () => {
    const page = evaluatePage(
      [
        { text: "WorkBuddy ... 已处理 ... 思考中", classes: ["cr-agent--processing"], has: [".cr-agent__processing-status"] },
        {
          text: `Production smoke test only.\n\nTASK_ID: ${SMOKE_TASK}`,
          has: [".cr-self-message__content"],
        },
      ],
      { taskId: SMOKE_TASK, payloadPrefix },
    );

    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]?.role).toBe("user");
    // The whole point of the field: without it there is nothing to match.
    expect(page.turns[0]?.containsTaskId).toBe(true);
  });

  it("identifies the outbound turn by the payload when the page marks nothing", () => {
    const page = evaluatePage(
      [{ text: `Production smoke test only.\n\nTASK_ID: ${SMOKE_TASK}` }],
      { taskId: SMOKE_TASK, payloadPrefix },
    );

    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]?.role).toBe("user");
  });

  it("does not let a finished answer become an outbound turn", () => {
    const page = evaluatePage(
      [
        { text: "已完成 12s", has: [".conversation-finished-footer", ".cr-collapse--completed"] },
        { text: "已完成 7m22s\n\nZHIXING_SMOKE_V0473C_OK" },
      ],
      { taskId: SMOKE_TASK, payloadPrefix },
    );

    expect(page.turns).toEqual([]);
  });
});
