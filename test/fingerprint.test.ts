import { describe, expect, it } from "vitest";
import { browserFingerprint } from "../src/utils.js";

describe("browserFingerprint", () => {
  it("is deterministic", () => {
    expect(browserFingerprint("user", "hello")).toBe(
      browserFingerprint("user", "hello"),
    );
  });

  it("changes by role", () => {
    expect(browserFingerprint("user", "hello")).not.toBe(
      browserFingerprint("assistant", "hello"),
    );
  });
});
