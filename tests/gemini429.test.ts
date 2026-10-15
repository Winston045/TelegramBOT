import { describe, expect, it } from "vitest";
import { chooseModel, classify429, quotaLabel, rankModels } from "../src/gemini.js";

/** Список моделей ключа - как его отдавал ListModels в прогоне 15.10. */
const MODELS = [
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-2.5-flash",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-preview-tts",
];

describe("лестница моделей", () => {
  it("алиас latest, затем стабильные от свежей к старой; lite и не-текстовые вне лестницы", () => {
    expect(rankModels(MODELS)).toEqual([
      "gemini-flash-latest",
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-2.5-flash",
    ]);
  });

  it("lite берётся, только когда полноценных у ключа нет вовсе", () => {
    expect(rankModels(["gemini-flash-lite-latest", "gemini-2.5-flash-image"])).toEqual([
      "gemini-flash-lite-latest",
    ]);
  });
});

describe("выбор модели: перегрузка временна, исчезновение - нет", () => {
  const T = 1_000_000;

  it("отдыхающую модель пропускает, исчезнувшую - тоже", () => {
    const benched = new Map([["gemini-flash-latest", T + 60_000]]);
    const dead = new Set(["gemini-3.8-flash"]);
    expect(chooseModel(MODELS, dead, benched, T)).toEqual({ model: "gemini-3.7-flash" });
  });

  it("отдохнувшая модель возвращается наверх лестницы", () => {
    // контрольный сбор 15.10 съехал до lite и остался там до конца прогона
    const benched = new Map([["gemini-flash-latest", T - 1]]);
    expect(chooseModel(MODELS, new Set(), benched, T)).toEqual({ model: "gemini-flash-latest" });
  });

  it("все полноценные отдыхают - ждём ближайшую, а не спускаемся до lite", () => {
    const benched = new Map(
      rankModels(MODELS).map((m, i) => [m, T + 30_000 + i * 10_000] as [string, number]),
    );
    expect(chooseModel(MODELS, new Set(), benched, T)).toEqual({ waitMs: 30_000 });
  });

  it("все полноценные исчезли - тогда уж lite", () => {
    const dead = new Set(rankModels(MODELS));
    expect(chooseModel(MODELS, dead, new Map(), T)).toEqual({ model: "gemini-flash-lite-latest" });
  });

  it("пустой список - честное «нет»", () => {
    expect(chooseModel([], new Set(), new Map(), T)).toEqual({ none: true });
  });
});

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
