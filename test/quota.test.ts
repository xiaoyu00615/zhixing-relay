import { describe, expect, it } from "vitest";
import {
  AVAILABLE_DETECTION,
  COLLECT_QUOTA_SIGNALS_EXPRESSION,
  detectQuota,
  detectResetAt,
  parseQuotaSignalsPayload,
  parseResetAt,
  quotaBlockUntil,
  type QuotaSignals,
} from "../src/workbuddy/quota.js";

/**
 * Local-clock fixtures: the parser mixes clock times with local dates, so the
 * expectations are built with the local Date constructor and never with a
 * hardcoded UTC instant.
 */
const NOW = new Date(2026, 9, 1, 11, 0, 0, 0);

/** ISO instant for a wall-clock time N days from NOW, in local time. */
function at(dayOffset: number, hours: number, minutes = 0): string {
  const date = new Date(NOW);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function plus(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

/**
 * The real production sentence WorkBuddy printed when Hy4 preview ran out of
 * its free quota. Reproduced verbatim because this exact wording is the only
 * thing the detector can rely on.
 */
const PRODUCTION_NOTICE =
  "当前您在Hy4 preview模型的免费使用量已超过频率限制，可在 04:00 重置，请稍后再试。";

describe("detectQuota", () => {
  it("flags the real production quota sentence seen in the answer body", () => {
    const detection = detectQuota(
      { modelLabel: "Hy4 preview", noticeTexts: [], turnText: PRODUCTION_NOTICE },
      NOW,
    );

    expect(detection.status).toBe("quota_exhausted");
    expect(detection.source).toBe("turn");
    expect(detection.modelLabel).toBe("Hy4 preview");
  });

  it("reads the model label from the selector trigger, not from the sentence", () => {
    // The sentence names a model, the trigger names the one actually selected.
    // The detection must not guess a model from free text.
    const detection = detectQuota(
      { modelLabel: "Hy3", noticeTexts: [], turnText: PRODUCTION_NOTICE },
      NOW,
    );

    expect(detection.modelLabel).toBe("Hy3");
    expect(detection.status).toBe("quota_exhausted");
  });

  it("prefers a dedicated quota notice over the answer body", () => {
    const detection = detectQuota(
      {
        modelLabel: "Hy4 preview",
        noticeTexts: ["当前您在Hy4 preview模型的免费使用量已超过频率限制"],
        turnText: "我帮你跑完了门禁，全部通过。",
      },
      NOW,
    );

    expect(detection.status).toBe("quota_exhausted");
    expect(detection.source).toBe("notice");
  });

  it("treats a normal answer body as available", () => {
    const detection = detectQuota(
      {
        modelLabel: "Hy3",
        noticeTexts: [],
        turnText: "任务已完成，结论如下：门禁通过。",
      },
      NOW,
    );

    expect(detection.status).toBe("available");
    expect(detection.source).toBeNull();
    expect(detection.reason).toBeNull();
  });

  it("accepts a short marker from WorkBuddy's own notice element", () => {
    // "超过频率限制" on its own is far too generic for an answer body, but
    // inside the notice chrome it is conclusive.
    const detection = detectQuota(
      {
        modelLabel: "Hy4 preview",
        noticeTexts: ["达到频率限制，今日额度用完"],
        turnText: "下面是限流处理的建议。",
      },
      NOW,
    );

    expect(detection.status).toBe("quota_exhausted");
    expect(detection.source).toBe("notice");
  });

  it("does not treat an answer that merely discusses rate limits as a quota", () => {
    const detection = detectQuota(
      {
        modelLabel: "Hy3",
        noticeTexts: [],
        turnText:
          "注意：这个 API 有频率限制，超过频率限制会返回 429。下面给出限流处理建议。",
      },
      NOW,
    );

    expect(detection.status).toBe("available");
  });

  it("reports available when the trigger is missing entirely", () => {
    const detection = detectQuota(
      { modelLabel: null, noticeTexts: [], turnText: "" },
      NOW,
    );

    expect(detection.status).toBe("available");
    expect(detection.modelLabel).toBeNull();
  });
});

describe("parseResetAt", () => {
  it("parses a clock reset time later in the day", () => {
    expect(parseResetAt("可在 15:30 重置", NOW)).toBe(at(0, 15, 30));
  });

  it("rolls the clock to the next day when that instant already passed", () => {
    // NOW is 11:00 local, so 04:00 today is behind us - a block must not be
    // written with an expiry that has already elapsed.
    const parsed = parseResetAt("可在 04:00 重置", NOW);
    expect(parsed).toBe(at(1, 4, 0));
    expect(new Date(parsed as string).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("parses a full date with a time", () => {
    expect(parseResetAt("可在 2026-10-02 04:00 重置", NOW)).toBe(at(1, 4, 0));
  });

  it("parses an ISO timestamp without shifting it by the local offset", () => {
    expect(parseResetAt("2026-10-01T23:30:00.000Z", NOW)).toBe(
      "2026-10-01T23:30:00.000Z",
    );
  });

  it("parses a relative duration in hours and minutes", () => {
    expect(parseResetAt("23 小时 24 分钟后恢复", NOW)).toBe(
      plus((23 * 3600 + 24 * 60) * 1000),
    );
  });

  it("parses a relative duration in minutes only", () => {
    expect(parseResetAt("30 分钟后重置", NOW)).toBe(plus(30 * 60_000));
  });

  it("parses a relative duration in seconds", () => {
    expect(parseResetAt("45 秒后重置", NOW)).toBe(plus(45_000));
  });

  it("returns null instead of guessing when nothing parseable is present", () => {
    expect(parseResetAt("请稍后再试。", NOW)).toBeNull();
    expect(parseResetAt("", NOW)).toBeNull();
  });
});

describe("detectResetAt", () => {
  it("reads the reset time out of the reset clause", () => {
    expect(detectResetAt(PRODUCTION_NOTICE, NOW)).toBe(at(1, 4, 0));
  });
});

describe("quotaBlockUntil", () => {
  it("keeps a reset time that is in the future", () => {
    const reset = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(quotaBlockUntil(NOW, reset, 60_000).toISOString()).toBe(reset);
  });

  it("falls back when the notice gives no reset time", () => {
    const until = quotaBlockUntil(NOW, null, 3_600_000);
    expect(until.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it("never returns an instant that has already passed", () => {
    // A block that expired the moment it was written would let the router pick
    // the same exhausted model again and the retry would loop.
    const reset = new Date(NOW.getTime() - 60_000).toISOString();
    const until = quotaBlockUntil(NOW, reset, 3_600_000);
    expect(until.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("quota signal collection", () => {
  it("collects the current model, the turn text and the notice elements", () => {
    const collected = parseQuotaSignalsPayload(
      '{"modelLabel":"Hy4 preview","noticeTexts":["免费使用量已超过频率限制"],"turnText":"x"}',
    );

    expect(collected).toEqual({
      modelLabel: "Hy4 preview",
      noticeTexts: ["免费使用量已超过频率限制"],
      turnText: "x",
    });
  });

  it("survives a non-string payload without throwing", () => {
    expect(parseQuotaSignalsPayload(undefined)).toEqual({
      modelLabel: null,
      noticeTexts: [],
      turnText: "",
    });
    expect(parseQuotaSignalsPayload("not json")).toEqual({
      modelLabel: null,
      noticeTexts: [],
      turnText: "",
    });
  });

  it("drops non-string notice entries", () => {
    const collected = parseQuotaSignalsPayload(
      JSON.stringify({ noticeTexts: ["ok", 7, null] }),
    );

    expect(collected.noticeTexts).toEqual(["ok"]);
  });

  it("writes the CDP expression with single-quoted attribute selectors", () => {
    // Double quotes on both levels make evaluate() return undefined silently.
    expect(COLLECT_QUOTA_SIGNALS_EXPRESSION).toContain("[class*='quota']");
    expect(COLLECT_QUOTA_SIGNALS_EXPRESSION).toContain(
      "button.cr-model-selector__trigger",
    );
  });

  it("never reports a quota for an empty page", () => {
    const signals: QuotaSignals = {
      modelLabel: null,
      noticeTexts: [],
      turnText: "",
    };
    expect(detectQuota(signals, NOW)).toEqual(AVAILABLE_DETECTION);
  });
});
