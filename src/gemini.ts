/**
 * Тонкий клиент Gemini API (Google AI Studio, бесплатный тариф).
 * Никакого SDK — один POST на generateContent с responseMimeType: application/json.
 *
 * ВАЖНО: ключ должен быть из AI Studio без привязанного биллинга,
 * иначе бесплатный тариф исчезает (см. SPEC, «Два запрета»).
 */
import sharp from "sharp";
import { env } from "./env.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Имена моделей протухают (живой прогон: gemini-2.5-flash закрыт для новых
 * ключей). Поэтому модель не хардкодим, а выбираем из ListModels:
 * приоритет — переменная окружения GEMINI_MODEL, затем алиас *-flash-latest,
 * затем самая свежая стабильная gemini-N-flash.
 */
const FALLBACK_MODEL = "gemini-flash-latest";

export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

const MAX_ATTEMPTS = 4;

/**
 * Предохранитель по дневной квоте: если несколько вызовов подряд умерли
 * окончательным 429 — квота суток сожжена, дальнейшие вызовы бессмысленны
 * (живой прогон: 30 вызовов × ретраи = 100 минут впустую).
 */
export class GeminiQuotaError extends Error {}
const QUOTA_TRIP_AFTER = 3;
let consecutiveQuotaFails = 0;

export function quotaTripped(): boolean {
  return consecutiveQuotaFails >= QUOTA_TRIP_AFTER;
}

/**
 * Пул ключей: при окончательном 429 на текущем ключе переключаемся на
 * следующий — квота у каждого своя. Предохранитель срабатывает, только
 * когда квоту сожгли ВСЕ ключи.
 */
let keyIdx = 0;
function currentKey(): string {
  const keys = env.geminiApiKeys;
  return keys[keyIdx % keys.length]!;
}
function rotateKey(): boolean {
  const keys = env.geminiApiKeys;
  if (keys.length < 2) return false;
  keyIdx = (keyIdx + 1) % keys.length;
  console.log(`gemini: квота ключа кончилась, переключаюсь на ключ #${keyIdx + 1} из ${keys.length}`);
  return true;
}

type ModelInfo = { name: string; supportedGenerationMethods?: string[] };

let resolvedModel: string | undefined;
const deadModels = new Set<string>();

function pickModel(models: ModelInfo[]): string | undefined {
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((name) => !deadModels.has(name));

  const latestAlias = usable.filter((n) => /^gemini-flash-latest$/.test(n));
  if (latestAlias.length) return latestAlias[0];

  // стабильные gemini-N[.M]-flash, самая свежая версия
  const stable = usable
    .map((n) => ({ n, m: n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/) }))
    .filter((x): x is { n: string; m: RegExpMatchArray } => x.m !== null)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
  if (stable.length) return stable[0]!.n;

  // хоть какой-нибудь flash без картинко-генерации и tts
  return usable.find((n) => n.includes("flash") && !/image|tts|audio|embed/.test(n));
}

async function resolveModel(): Promise<string> {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (resolvedModel) return resolvedModel;
  try {
    const res = await fetch(`${BASE}?pageSize=1000`, {
      headers: { "x-goog-api-key": currentKey() },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ListModels HTTP ${res.status}`);
    const body = (await res.json()) as { models?: ModelInfo[] };
    const picked = pickModel(body.models ?? []);
    if (picked) {
      resolvedModel = picked;
      console.log(`gemini: выбрана модель ${picked}`);
      return picked;
    }
  } catch (err) {
    console.warn(`gemini: не смог выбрать модель (${(err as Error).message}), беру ${FALLBACK_MODEL}`);
  }
  resolvedModel = FALLBACK_MODEL;
  return FALLBACK_MODEL;
}

// бесплатный тариф: 10 запросов/мин — держим паузу между вызовами
const MIN_REQUEST_INTERVAL_MS = 6500;
let lastRequestAt = 0;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Один запрос к Gemini, ответ — распарсенный JSON типа T. */
export async function geminiJson<T>(
  parts: GeminiPart[],
  opts: { model?: string; temperature?: number } = {},
): Promise<T> {
  if (quotaTripped()) {
    throw new GeminiQuotaError("дневная квота Gemini исчерпана — предохранитель разомкнут");
  }

  const totalKeys = env.geminiApiKeys.length;
  let lastError: Error | undefined;

  for (let keyTry = 0; keyTry < totalKeys; keyTry++) {
    let quotaFailure = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const model = opts.model ?? (await resolveModel());
      const url = `${BASE}/${model}:generateContent`;

      const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": currentKey(),
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: opts.temperature ?? 0.3,
            },
          }),
          // зависший запрос не должен вешать весь суточный сбор
          signal: AbortSignal.timeout(90_000),
        });
      } catch (err) {
        lastError = new Error(`gemini: сеть/таймаут — ${(err as Error).message}`);
        await sleep(2000 * attempt);
        continue;
      }

      if (res.status === 429) {
        quotaFailure = true;
        lastError = new Error(`gemini: HTTP 429`);
        // есть запасные ключи — не ждём минутные окна, после второй
        // неудачи сразу переключаемся; единственный ключ — ждём долго
        if (totalKeys > 1 && attempt >= 2) break;
        await sleep(20_000 * attempt);
        continue;
      }
      if (res.status >= 500) {
        // 503 у Gemini - это «модель перегружена», и держится он десятками
        // секунд. Паузы 2-4-8 не пересиживали: живой прогон 16.08 потерял
        // кадр, исчерпав все четыре попытки за четырнадцать секунд.
        // Ключи тут не помогают - перегружен сам сервис, а не наш лимит
        lastError = new Error(`gemini: HTTP ${res.status}`);
        await sleep(5000 * 2 ** (attempt - 1));
        continue;
      }
      // модель протухла — вычёркиваем и на следующей попытке выбираем заново
      if (res.status === 404 && !opts.model) {
        deadModels.add(model);
        resolvedModel = undefined;
        lastError = new Error(`gemini: модель ${model} недоступна (404)`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`gemini: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
      }

      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("gemini: пустой ответ");
      consecutiveQuotaFails = 0;
      return JSON.parse(text) as T;
    }

    // не квотная ошибка — ротация ключей не поможет
    if (!quotaFailure) throw lastError ?? new Error("gemini: все попытки исчерпаны");
    // квота этого ключа кончилась — пробуем следующий
    if (keyTry < totalKeys - 1) rotateKey();
  }

  consecutiveQuotaFails++;
  throw new GeminiQuotaError(
    `gemini: HTTP 429 на всех ключах (${totalKeys}) после ретраев (подряд: ${consecutiveQuotaFails})`,
  );
}

/**
 * Скачивает картинку (или берёт готовый Buffer), ужимает до 1024px
 * и упаковывает в inline-парт. Полноразмерные сканы (у LOC бывают 5000px)
 * сжигают токен-квоту бесплатного тарифа за один-два запроса.
 */
export async function imagePart(image: string | Buffer): Promise<GeminiPart> {
  let buffer: Buffer;
  if (typeof image === "string") {
    const res = await fetch(image, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`картинка недоступна (HTTP ${res.status}): ${image}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    buffer = image;
  }
  const resized = await sharp(buffer)
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { inline_data: { mime_type: "image/jpeg", data: resized.toString("base64") } };
}
