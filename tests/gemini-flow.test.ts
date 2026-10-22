import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Сквозные сценарии выбора модели и ключа на подставном Gemini и
 * виртуальном времени. Ревизия 16.10 нашла в этой логике петлю, которую
 * юнит-тесты отдельных функций не ловили: зависшие модели «возвращались»
 * быстрее, чем выяснялось, что лежит следующая, и кадр не доходил до той
 * модели, что отвечает.
 */

type Behaviour = "ok" | "hang" | "503" | "day429" | "badkey";
type Script = (key: string, model: string) => Behaviour;

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function stubGemini(models: string[], script: Script) {
  const calls: Array<{ key: string; model: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const key = init?.headers?.["x-goog-api-key"] ?? "";
      if (String(url).startsWith(`${BASE}?`)) {
        return new Response(
          JSON.stringify({
            models: models.map((m) => ({
              name: `models/${m}`,
              supportedGenerationMethods: ["generateContent"],
            })),
          }),
        );
      }
      const model = String(url).slice(BASE.length + 1).split(":")[0]!;
      calls.push({ key, model });
      switch (script(key, model)) {
        case "ok":
          return new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: JSON.stringify({ model }) }] } }],
            }),
          );
        case "503":
          return new Response("overloaded", { status: 503 });
        case "day429":
          return new Response(
            JSON.stringify({
              error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] },
            }),
            { status: 429 },
          );
        case "badkey":
          return new Response(JSON.stringify({ error: { message: "API key not valid", status: "API_KEY_INVALID" } }), {
            status: 400,
          });
        case "hang":
          // настоящий AbortSignal.timeout не подчиняется виртуальному
          // времени - зависание изображаем сами, той же минутой
          return new Promise((_, reject) =>
            setTimeout(() => reject(new Error("The operation was aborted due to timeout")), 60_000),
          );
      }
    }),
  );
  return calls;
}

/** Гоняет виртуальное время, пока вызов не завершится. */
async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: Error }> {
  let done = false;
  const out: { value?: T; error?: Error } = {};
  p.then(
    (v) => ((out.value = v), (done = true)),
    (e: Error) => ((out.error = e), (done = true)),
  );
  for (let i = 0; i < 5000 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.GEMINI_MODEL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GEMINI_API_KEYS;
  delete process.env.GEMINI_API_KEY;
});

async function gemini() {
  return import("../src/gemini.js");
}

describe("сквозной выбор модели", () => {
  it("полноценные зависают - кадр в том же вызове уходит на облегчённую", async () => {
    process.env.GEMINI_API_KEYS = "k1";
    const calls = stubGemini(
      ["gemini-flash-latest", "gemini-3.8-flash", "gemini-flash-lite-latest"],
      (_k, m) => (m.includes("lite") ? "ok" : "hang"),
    );
    const g = await gemini();
    const r = await settle(g.geminiJson<{ model: string }>([{ text: "x" }]));
    expect(r.error).toBeUndefined();
    expect(r.value?.model).toBe("gemini-flash-lite-latest");
    // каждая зависшая полноценная - ровно одна минута, без второй проверки
    expect(calls.filter((c) => c.model === "gemini-flash-latest")).toHaveLength(1);
    expect(calls.filter((c) => c.model === "gemini-3.8-flash")).toHaveLength(1);
  });

  it("сплошные 503 на шести полноценных - вызов доходит до облегчённой, а не умирает на четвёртой", async () => {
    process.env.GEMINI_API_KEYS = "k1";
    const full = ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview"];
    stubGemini([...full, "gemini-flash-lite-latest"], (_k, m) => (m.includes("lite") ? "ok" : "503"));
    const g = await gemini();
    const r = await settle(g.geminiJson<{ model: string }>([{ text: "x" }]));
    expect(r.error).toBeUndefined();
    expect(r.value?.model).toBe("gemini-flash-lite-latest");
  });

  it("все модели надолго на скамейке - отдельная ошибка со сроком, а не сбой кадра", async () => {
    // сбор 16.10 14:06: обычная ошибка списала 19 кадров за 4 секунды;
    // по сроку из GeminiBusyError сбор теперь ждёт, а не списывает
    process.env.GEMINI_API_KEYS = "k1";
    stubGemini(["gemini-flash-latest", "gemini-flash-lite-latest"], () => "503");
    const g = await gemini();
    let busy: Error | undefined;
    for (let i = 0; i < 6 && !busy; i++) {
      const r = await settle(g.geminiJson([{ text: String(i) }]));
      expect(r.value).toBeUndefined();
      if (r.error instanceof g.GeminiBusyError) busy = r.error;
    }
    expect(busy).toBeInstanceOf(g.GeminiBusyError);
    expect((busy as InstanceType<typeof g.GeminiBusyError>).waitMs).toBeGreaterThan(0);
    // и это не квота: предохранитель цел
    expect(g.quotaTripped()).toBe(false);
  });

  it("квота лучших кончилась, остальные полноценные лежат - соседний ключ, а не облегчённая", async () => {
    // полный сбор 22.10: 21 кадр из 28 ушёл облегчённой модели ключа #1,
    // хотя у ключа #2 лучшие модели были свежими
    process.env.GEMINI_API_KEYS = "k1,k2";
    const calls = stubGemini(
      ["gemini-flash-latest", "gemini-3.6-flash", "gemini-flash-lite-latest"],
      (key, model) => {
        if (model.includes("lite")) return "ok";
        if (model === "gemini-flash-latest") return key === "k1" ? "day429" : "ok";
        return "503";
      },
    );
    const g = await gemini();
    const r = await settle(g.geminiJson<{ model: string }>([{ text: "x" }]));
    expect(r.error).toBeUndefined();
    expect(r.value?.model).toBe("gemini-flash-latest");
    expect(calls.some((c) => c.key === "k2" && c.model === "gemini-flash-latest")).toBe(true);
    expect(calls.some((c) => c.model.includes("lite"))).toBe(false);
  });

  it("вернувшаяся со скамейки модель получает одну пробу, а не две", async () => {
    process.env.GEMINI_API_KEYS = "k1";
    const calls = stubGemini(["gemini-flash-latest", "gemini-flash-lite-latest"], (_k, m) =>
      m.includes("lite") ? "ok" : "503",
    );
    const g = await gemini();
    await settle(g.geminiJson([{ text: "1" }]));
    const before = calls.filter((c) => c.model === "gemini-flash-latest").length;
    expect(before).toBe(2);
    // отдых кончился - модель снова наверху лестницы
    await vi.advanceTimersByTimeAsync(g.OVERLOAD_BENCH_MS + 1000);
    const r = await settle(g.geminiJson<{ model: string }>([{ text: "2" }]));
    expect(r.value?.model).toBe("gemini-flash-lite-latest");
    expect(calls.filter((c) => c.model === "gemini-flash-latest").length - before).toBe(1);
  });

  it("квота кончилась у модели - берём другую модель того же ключа", async () => {
    process.env.GEMINI_API_KEYS = "k1,k2";
    const calls = stubGemini(["gemini-flash-latest", "gemini-3.8-flash"], (_k, m) =>
      m === "gemini-flash-latest" ? "day429" : "ok",
    );
    const g = await gemini();
    const r = await settle(g.geminiJson<{ model: string }>([{ text: "x" }]));
    expect(r.value?.model).toBe("gemini-3.8-flash");
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set(["k1"]));
    expect(g.quotaTripped()).toBe(false);
  });

  it("на ключе не осталось полноценных - второй ключ, а не облегчённая первого", async () => {
    process.env.GEMINI_API_KEYS = "k1,k2";
    const calls = stubGemini(["gemini-flash-latest", "gemini-flash-lite-latest"], (k, m) =>
      k === "k1" && m === "gemini-flash-latest" ? "day429" : "ok",
    );
    const g = await gemini();
    const r = await settle(g.geminiJson<{ model: string }>([{ text: "x" }]));
    expect(r.value?.model).toBe("gemini-flash-latest");
    expect(calls.at(-1)).toEqual({ key: "k2", model: "gemini-flash-latest" });
    expect(calls.some((c) => c.model.includes("lite"))).toBe(false);
  });

  it("недействительный ключ пропускается, второй работает", async () => {
    process.env.GEMINI_API_KEYS = "dead,k2";
    const calls = stubGemini(["gemini-flash-latest"], (k) => (k === "dead" ? "badkey" : "ok"));
    const g = await gemini();
    const r = await settle(g.geminiJson<{ model: string }>([{ text: "x" }]));
    expect(r.error).toBeUndefined();
    expect(calls.at(-1)?.key).toBe("k2");
  });

  it("квота кончилась везде - предохранитель срабатывает после трёх вызовов", async () => {
    process.env.GEMINI_API_KEYS = "k1,k2";
    stubGemini(["gemini-flash-latest"], () => "day429");
    const g = await gemini();
    for (let i = 0; i < 3; i++) {
      const r = await settle(g.geminiJson([{ text: String(i) }]));
      expect(r.error).toBeInstanceOf(g.GeminiQuotaError);
    }
    expect(g.quotaTripped()).toBe(true);
  });
});

describe("срок отдыха растёт", () => {
  it("2, 4, 8 минут и потолок 10", async () => {
    const g = await gemini();
    expect([1, 2, 3, 4, 9].map(g.benchDuration)).toEqual([120_000, 240_000, 480_000, 600_000, 600_000]);
  });
});
