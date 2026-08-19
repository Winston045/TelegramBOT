import { describe, expect, it } from "vitest";
import { classify429 } from "../src/gemini.js";

/**
 * Ответы Gemini на 429 - в том виде, в каком их отдаёт API. Разница между
 * минутным лимитом и суточным видна только здесь, а лечатся они
 * по-разному: минутный - паузой, суточный - сбросом в 10:00 МСК.
 */
const PER_MINUTE = JSON.stringify({
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Generate requests per minute'",
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" }],
  },
});

const PER_DAY = JSON.stringify({
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Generate requests per day'",
    details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure" }],
  },
});

describe("разбор 429 от Gemini", () => {
  it("минутный лимит узнаётся и берёт паузу из ответа", () => {
    const { perMinute, waitMs } = classify429(PER_MINUTE);
    expect(perMinute).toBe(true);
    expect(waitMs).toBe(27_000);
  });

  it("суточная квота минутной не считается", () => {
    expect(classify429(PER_DAY).perMinute).toBe(false);
  });

  it("без подсказки в ответе ждём разумные полминуты", () => {
    const { perMinute, waitMs } = classify429(
      '{"error":{"message":"Quota exceeded per minute"}}',
    );
    expect(perMinute).toBe(true);
    expect(waitMs).toBe(30_000);
  });

  it("слишком долгую паузу обрезаем минутой", () => {
    expect(classify429('per minute, "retryDelay": "600s"').waitMs).toBe(60_000);
  });

  it("пустое тело - считаем суточной квотой, это безопаснее", () => {
    expect(classify429("").perMinute).toBe(false);
  });
});
