import { describe, expect, it } from "vitest";
import { classify429, quotaLabel } from "../src/gemini.js";

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

describe("имя исчерпанной квоты в логе", () => {
  it("берёт quotaId и метрику, когда Google их прислал", () => {
    const body = JSON.stringify({
      error: {
        details: [
          {
            violations: [
              {
                quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
              },
            ],
          },
        ],
      },
    });
    expect(quotaLabel(body)).toBe(
      "GenerateRequestsPerDayPerProjectPerModel-FreeTier / " +
        "generativelanguage.googleapis.com/generate_content_free_tier_requests",
    );
  });

  it("без quotaId довольствуется текстом ошибки", () => {
    expect(quotaLabel(PER_MINUTE)).toBe(
      "Quota exceeded for quota metric 'Generate requests per minute'",
    );
  });

  it("совсем чужой ответ печатает как есть, одной строкой", () => {
    expect(quotaLabel("<html>\n  429 Too Many Requests\n</html>")).toBe(
      "<html> 429 Too Many Requests </html>",
    );
  });

  it("пустое тело так и называет", () => {
    expect(quotaLabel("")).toBe("тело ответа пустое");
  });
});
