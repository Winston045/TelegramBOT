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

/**
 * Перегрузка временна, исчезновение - нет. Это два разных состояния, и
 * раньше они жили в одном списке «мёртвых» до конца прогона.
 *
 * Контрольный сбор 15.10 показал, чего это стоит: модели честно
 * отвечали 503 по минуте-другой, но каждая вычёркивалась навсегда, и за
 * три минуты бот спустился по всей лестнице до gemini-flash-lite-latest.
 * Облегчённая модель разобрала 15 кадров из 23 - и это видно по
 * результату: 10 из 11 отказов «без крючка» её, включая «морпехов с
 * трофейным флагом» (трофей - крючок по определению), а фронтовой
 * рисунок она пустила в резерв с оценкой 65, тогда как такой же рисунок
 * минутой позже оценила в 15 как «не фотографию».
 *
 * Поэтому: 404 - модель исчезла, вычёркиваем до конца прогона;
 * 503 - модель отдыхает на скамейке OVERLOAD_BENCH_MS и потом
 * возвращается, а бот поднимается обратно к лучшей свободной.
 */
const deadModels = new Set<string>();
const benchedUntil = new Map<string, number>();
export const OVERLOAD_BENCH_MS = 120_000;

/**
 * Сколько 503 подряд отправляют модель на скамейку. Двух достаточно:
 * случайный одиночный 503 модель не трогает, а лежачую мы покидаем
 * быстро - теперь это дёшево, потому что скамейка не пожизненная.
 */
const OVERLOAD_TRIP_AFTER = 2;
let overloadStreak = 0;
let currentModel: string | undefined;
let modelNames: string[] | undefined;

const NOT_TEXT = /image|tts|audio|embed|live|native/;

/**
 * Модели в порядке предпочтения: алиас flash-latest, затем стабильные
 * gemini-N-flash от свежей к старой, затем прочие полноценные flash.
 *
 * Облегчённые (*-lite) в лестницу не входят, пока есть хоть одна
 * полноценная - даже отдыхающая: лучше подождать её возвращения, чем
 * отдать подпись и оценку слабой модели, а пост потом уйдёт в канал
 * автопостингом без человеческих глаз. Lite остаётся только на случай,
 * когда полноценных у ключа нет вовсе.
 */
export function rankModels(names: string[]): string[] {
  const flash = names.filter((n) => n.includes("flash") && !NOT_TEXT.test(n));
  const full = flash.filter((n) => !/lite/.test(n));
  const stableVersion = (n: string) => Number(n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/)?.[1]);
  const latest: string[] = full.filter((n) => n === "gemini-flash-latest");
  const stable = full
    .filter((n) => Number.isFinite(stableVersion(n)))
    .sort((a, b) => stableVersion(b) - stableVersion(a));
  const other = full.filter((n) => !latest.includes(n) && !stable.includes(n)).sort();
  const ladder = [...latest, ...stable, ...other];
  return ladder.length ? ladder : flash.sort();
}

export type ModelChoice = { model: string } | { waitMs: number } | { none: true };

/**
 * Лучшая модель, свободная прямо сейчас. Если все полноценные на
 * скамейке - сколько ждать до ближайшей; если нет ни одной - none.
 */
export function chooseModel(
  names: string[],
  dead: ReadonlySet<string>,
  benched: ReadonlyMap<string, number>,
  now: number,
): ModelChoice {
  const ladder = rankModels(names.filter((n) => !dead.has(n)));
  if (!ladder.length) return { none: true };
  const free = ladder.find((n) => (benched.get(n) ?? 0) <= now);
  if (free) return { model: free };
  const earliest = Math.min(...ladder.map((n) => benched.get(n) ?? now));
  return { waitMs: Math.max(0, earliest - now) };
}

function benchModel(model: string) {
  benchedUntil.set(model, Date.now() + OVERLOAD_BENCH_MS);
  overloadStreak = 0;
  console.warn(
    `gemini: ${model} перегружена - отдыхает ${Math.round(OVERLOAD_BENCH_MS / 1000)} с, беру следующую`,
  );
}

async function loadModelNames(): Promise<string[]> {
  if (modelNames) return modelNames;
  try {
    const res = await fetch(`${BASE}?pageSize=1000`, {
      headers: { "x-goog-api-key": currentKey() },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ListModels HTTP ${res.status}`);
    const body = (await res.json()) as { models?: ModelInfo[] };
    modelNames = (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
  } catch (err) {
    console.warn(`gemini: не смог получить список моделей (${(err as Error).message}), беру ${FALLBACK_MODEL}`);
    modelNames = [FALLBACK_MODEL];
  }
  return modelNames;
}

/**
 * Модель для очередной попытки. Пересчитывается каждый раз (без сети -
 * список моделей читается один раз за прогон), поэтому, как только
 * лучшая модель отдохнула, бот к ней и возвращается.
 */
async function resolveModel(deadline: number): Promise<string> {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const names = await loadModelNames();
  for (;;) {
    const choice = chooseModel(names, deadModels, benchedUntil, Date.now());
    if ("model" in choice) {
      if (choice.model !== currentModel) {
        console.log(`gemini: выбрана модель ${choice.model}`);
        currentModel = choice.model;
        overloadStreak = 0;
      }
      return choice.model;
    }
    if ("none" in choice) return FALLBACK_MODEL;
    if (Date.now() + choice.waitMs > deadline) {
      throw new Error(
        `gemini: все модели перегружены, ближайшая освободится через ${Math.ceil(choice.waitMs / 1000)} с`,
      );
    }
    console.warn(`gemini: все модели перегружены - жду ${Math.ceil(choice.waitMs / 1000)} с`);
    await sleep(choice.waitMs);
  }
}

// бесплатный тариф: 10 запросов/мин — держим паузу между вызовами
const MIN_REQUEST_INTERVAL_MS = 6500;
let lastRequestAt = 0;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Один запрос к Gemini, ответ — распарсенный JSON типа T. */
/**
 * Что именно значит 429 от Gemini: лимит в минуту или суточная квота.
 *
 * Google возвращает оба одним кодом, но в теле ответа пишет, какая квота
 * исчерпана, и сколько ждать (retryDelay). Минутный лечится паузой тем же
 * ключом; суточный - только сбросом в 10:00 МСК и сменой ключа.
 */
export function classify429(body: string): { perMinute: boolean; waitMs: number } {
  const perMinute = /per[\s-]?minute/i.test(body);
  const seconds = Number(body.match(/"?retryDelay"?:\s*"?(\d+)s/i)?.[1]);
  const waitMs = Math.min(60_000, (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000);
  return { perMinute, waitMs };
}

/**
 * Как назвать в логе исчерпанную квоту.
 *
 * Разбор 19.08 упёрся в то, что тело 429 нигде не сохранялось: по логу
 * «квота ключа кончилась» нельзя отличить настоящий суточный лимит от
 * ответа, в котором про минуты просто не написано. Ключа в теле нет - он
 * уходит заголовком, - так что печатать безопасно.
 */
export function quotaLabel(body: string): string {
  const id = body.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1];
  const metric = body.match(/"quotaMetric"\s*:\s*"([^"]+)"/)?.[1];
  if (id ?? metric) return [id, metric].filter(Boolean).join(" / ");
  const message = body.match(/"message"\s*:\s*"([^"]{1,160})"/)?.[1];
  if (message) return message;
  const plain = body.slice(0, 160).replace(/\s+/g, " ").trim();
  return plain || "тело ответа пустое";
}

/**
 * Потолок времени на ОДИН вызов со всеми ретраями и сменами ключей.
 *
 * Без него худший случай - 4 попытки × 90 с таймаута × 2 ключа плюс паузы:
 * утренний прогон 25.08 потратил семь минут на один кадр (Gemini сутки
 * отвечал 503 и вис), и бюджет прогона кончился на 2 кадрах из 30. Лучше
 * бросить упрямый кадр и успеть остальные: перегрузка - не наша поломка,
 * и пересиживать её ретраями дороже, чем жить дальше.
 */
const CALL_BUDGET_MS = 150_000;

export async function geminiJson<T>(
  parts: GeminiPart[],
  opts: { model?: string; temperature?: number } = {},
): Promise<T> {
  if (quotaTripped()) {
    throw new GeminiQuotaError("дневная квота Gemini исчерпана — предохранитель разомкнут");
  }

  const totalKeys = env.geminiApiKeys.length;
  const callDeadline = Date.now() + CALL_BUDGET_MS;
  let lastError: Error | undefined;

  for (let keyTry = 0; keyTry < totalKeys; keyTry++) {
    let quotaFailure = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (Date.now() > callDeadline) {
        throw new Error(
          `gemini: вызов не уложился в ${Math.round(CALL_BUDGET_MS / 1000)} с (${lastError?.message ?? "без ответа"})`,
        );
      }
      const model = opts.model ?? (await resolveModel(callDeadline));
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
          // зависший запрос не должен вешать весь сбор. Было 90 с, и при
          // бюджете вызова в 150 с одно зависание съедало его почти
          // целиком - на вторую модель времени уже не оставалось (утро
          // 15.10: два кадра умерли именно так). Здоровый разбор кадра
          // укладывается в десятки секунд
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        lastError = new Error(`gemini: сеть/таймаут — ${(err as Error).message}`);
        // зависание у Gemini - та же перегрузка, только молчаливая: без
        // этого зачёта зависшая модель не уходила на скамейку, и бот
        // снова и снова ждал её по минуте
        if (!opts.model && ++overloadStreak >= OVERLOAD_TRIP_AFTER) benchModel(model);
        else await sleep(2000 * attempt);
        continue;
      }

      if (res.status === 429) {
        // Google отдаёт 429 и на СУТОЧНЫЙ лимит, и на лимит В МИНУТУ, а
        // лечатся они по-разному: суточный - только сбросом в 10:00,
        // минутный - паузой в полминуты. Раньше любой 429 считался
        // суточным: ключи гонялись по кругу, после трёх неудач рвался
        // предохранитель и сбор глох до завтра. Живой прогон 19.08 выдал
        // «ключ кончился» четыре раза подряд, переключаясь туда-обратно, -
        // так дневная квота себя не ведёт, исчерпанный ключ мёртв до
        // сброса. Различаем по телу ответа.
        const body = await res.text().catch(() => "");
        const { perMinute, waitMs } = classify429(body);
        // без имени квоты в логе разбор упирается в догадки
        console.warn(`gemini: 429 - ${quotaLabel(body)}`);
        if (perMinute) {
          // минутное окно: ждём и пробуем ТЕМ ЖЕ ключом, ключи тут ни при чём
          console.warn(`gemini: лимит в минуту, жду ${Math.round(waitMs / 1000)} с`);
          lastError = new Error("gemini: HTTP 429 (лимит в минуту)");
          await sleep(waitMs);
          continue;
        }
        quotaFailure = true;
        lastError = new Error("gemini: HTTP 429 (суточная квота)");
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
        // Алиас *-flash-latest ведёт на самую свежую модель, а она же и
        // самая загруженная: ежедневный сбор 19.08 потерял на 503 шесть
        // кадров из семнадцати - больше, чем на квоте. Перегруженная
        // модель уходит на скамейку, а вызов сразу пробует следующую
        if (!opts.model && ++overloadStreak >= OVERLOAD_TRIP_AFTER) {
          benchModel(model);
          continue;
        }
        // пауза короче прежней (была 5-10-20 с): при бюджете вызова в
        // 150 с длинные сны не давали дожить до смены модели - кадр
        // умирал по таймауту вызова, так и не попробовав живую модель
        await sleep(3000 * 2 ** (attempt - 1));
        continue;
      }
      // модель протухла — вычёркиваем и на следующей попытке выбираем заново
      if (res.status === 404 && !opts.model) {
        deadModels.add(model);
        console.warn(`gemini: модель ${model} недоступна (404) - вычёркиваю до конца прогона`);
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
      overloadStreak = 0;
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
