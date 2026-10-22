/**
 * Сбор кандидатов: источники → префильтр → дедуп по dHash →
 * анализ (оценка + подпись одним запросом) → валидация → запись в candidates.
 *
 * npm run collect -- --dry       — только источники + префильтр, без Gemini и базы.
 * npm run collect -- --keep 6    — маленькая партия: 6 фото на анализ.
 *
 * Один запрос Gemini на фото (оценка + подпись сразу); все прошедшие порог
 * пишутся в резерв (status=new), откуда send-candidates раздаёт карточки.
 */
import { loadConfig } from "../src/config.js";
import { dbCursorStore, memoryCursorStore } from "../src/cursors.js";
import {
  ADAPTERS,
  collectRaw,
  interleaveBySource,
  lastSourceCounts,
  type CollectedItem,
} from "../src/sources/index.js";
import { reportHealth } from "../src/health.js";
import { minWidthFor, prefilter } from "../src/prefilter.js";
import sharp from "sharp";
import { byPromise, promise } from "../src/promise.js";
import { buildAnalysisQueue } from "../src/queue.js";
import { hiResLocUrl } from "../src/sources/loc.js";
import { dhash, isDuplicate } from "../src/dhash.js";
import { isStereoPair } from "../src/stereo.js";
import { getDb, loadKnownHashes, selectAll } from "../src/db.js";
import { GeminiBusyError, GeminiQuotaError, isLiteModel, lastUsedModel, quotaTripped } from "../src/gemini.js";
import { analyzeImage } from "../src/analyze.js";
import { passesGate } from "../src/scoring.js";
import { reviewQuote } from "../src/critic.js";
import { assembleCaptionHtml, descriptiveSentences, type GeneratedCaption } from "../src/caption.js";
import { validateCaption } from "../src/validate.js";
import { guardCopies, guardNumbers } from "../src/factcheck.js";
import { rubricCaptionFlaw, rubricOf } from "../src/rubrics.js";
import { subjectReference } from "../src/wiki.js";
import { heartbeatError, heartbeatOk } from "../src/heartbeat.js";
import { env } from "../src/env.js";
import { sendMessageHtml } from "../src/telegram.js";

/** Квота кончилась - молчать нельзя, редакторы должны знать, почему нет карточек. */
let quotaNotified = false;
async function notifyQuotaExhausted() {
  if (quotaNotified) return;
  quotaNotified = true;
  try {
    await sendMessageHtml(
      env.editorsChatId,
      "Дневная квота Gemini исчерпана - сбор остановлен, карточек не будет. " +
        "Квота сбрасывается в полночь по Калифорнии: 10:00 МСК летом, 11:00 зимой.",
    );
  } catch {
    // чата может не быть в dry-запусках или при неполных секретах
  }
}

const dry = process.argv.includes("--dry");

/**
 * Общий бюджет прогона. У воркфлоу таймаут 30 минут, и когда сбор в него
 * упирался, job убивали на полпути: 18 и 19.08 два ежедневных прогона
 * подряд отменены, карточки не пришли, heartbeat замолчал на 50 часов.
 * Теперь анализ останавливается сам, не доходя до потолка, - партия
 * выходит неполной, зато прогон завершается штатно: пишет воронку,
 * ставит отметку и отдаёт то, что успел.
 *
 * 19 минут, а не 22: бюджет проверяется перед кадром, а один кадр - это
 * два вызова Gemini по 150 с плюс справка. Начатый на 21-й минуте кадр
 * вместе с подготовкой job, карточками и сводкой выводил за 30 минут, и
 * job убивали уже после сбора, на рассылке.
 */
const RUN_BUDGET_MS = 19 * 60_000;
const runStartedAt = Date.now();

function numArg(name: string): number | undefined {
  const i = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  const raw = process.argv[i]!.includes("=")
    ? process.argv[i]!.split("=")[1]
    : process.argv[i + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type HashedItem = CollectedItem & { imageHash: string; imageBuffer: Buffer };

/** Меньше этого после паузы ждать Gemini незачем: кадр уже не успеть разобрать. */
const MIN_ANALYSIS_LEFT_MS = 3 * 60_000;
/** Ниже - явный брак, второе мнение по нему не спрашиваем. */
const SECOND_OPINION_MIN = 40;
/** Неудач подряд, после которых второе мнение в прогоне выключается. */
const SECOND_OPINION_MAX_MISSES = 2;

/** Осталось ли время прогона: и на скачивание, и на анализ. */
function timeLeftMs(): number {
  return RUN_BUDGET_MS - (Date.now() - runStartedAt);
}

/**
 * Сбой Gemini, который лечится повтором: перегрузка, таймаут, обрыв сети.
 * Пустой ответ (кадр завернула защита), 400 или ошибка базы на повторе
 * не пройдут - второй подход тратил бы на них квоту впустую.
 */
function isTransientFailure(message: string): boolean {
  return /HTTP 5\d\d|таймаут|timeout|aborted|не уложился|перегружен|fetch failed|ECONNRESET|socket/i.test(
    message,
  );
}

/**
 * Скачивание картинки. Викимедиа лимитирует запросы с датацентровых IP
 * (GitHub Actions) кодом 429, и бан держится минутами - короткие ретраи
 * его не пересиживают (живой прогон 03.08: 17 из 24 файлов подряд).
 * Поэтому: вежливый темп, длинное ожидание на первый 429 и быстрый отказ,
 * когда хост забанил нас всерьёз - лучше меньше партия, чем мёртвый прогон.
 */
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Редактор цитат работает только на полноценных моделях. Все на скамейке -
 * ждём их, пока бюджет позволяет: невычитанная изюминка облегчённой
 * модели хуже, чем пара минут паузы. Не дождались - цитата первого захода,
 * её всё равно проверят страховки чисел и списывания.
 */
async function reviewWithWait<T extends { caption: GeneratedCaption; rewritten: boolean }>(
  review: () => Promise<T>,
  generated: GeneratedCaption,
): Promise<T | { caption: GeneratedCaption; rewritten: false }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await review();
    } catch (err) {
      if (!(err instanceof GeminiBusyError)) throw err;
      const pauseMs = err.waitMs + 1000;
      if (timeLeftMs() - pauseMs <= MIN_ANALYSIS_LEFT_MS) break;
      console.log(`  редактор цитаты ждёт полноценную модель ${Math.round(pauseMs / 1000)} с`);
      await sleepMs(pauseMs);
    }
  }
  console.warn("  редактор цитаты пропущен: полноценные модели заняты, бюджет на исходе");
  return { caption: generated, rewritten: false };
}
let politeDelayMs = 800; // после первого 429 темп снижается
let consecutive429 = 0;

async function fetchImage(url: string): Promise<Response | null> {
  // после серии банов не тратим время на ретраи - одна попытка и дальше
  const delays = consecutive429 >= 3 ? [] : [2_000, 20_000, 45_000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: {
        "user-agent": "story-team-bot/0.1 (Telegram history channel; contact via t.me/Story_Teams)",
        accept: "image/*",
      },
    });
    if (res.ok) {
      consecutive429 = 0;
      return res;
    }
    if (res.status === 429) {
      politeDelayMs = 3_000;
      consecutive429++;
    }
    const retriable = res.status === 429 || res.status >= 500;
    const delay = delays[attempt];
    if (!retriable || delay === undefined) {
      console.warn(`  пропуск (HTTP ${res.status}): ${url}`);
      return null;
    }
    await sleepMs(delay);
  }
}

async function hashAndDedup(
  items: CollectedItem[],
  known: string[],
  cfg: ReturnType<typeof loadConfig>,
): Promise<HashedItem[]> {
  const out: HashedItem[] = [];
  const batchHashes: string[] = [];
  for (const item of items) {
    // скачивание тоже ест бюджет прогона: архив с ретраями 2+20+45 с на
    // файл мог оставить на анализ меньше, чем стоит один кадр
    if (timeLeftMs() < 8 * 60_000) {
      console.warn(`  скачивание остановлено бюджетом: обработано ${out.length} из ${items.length}`);
      break;
    }
    try {
      // у LOC сначала пробуем крупный рендер: поиск отдаёт служебную копию
      // ~1024, и в ленте она заметно мылит рядом с коммонсовскими 1600
      const hiRes = item.source === "loc" ? hiResLocUrl(item.imageUrl) : undefined;
      let imageUrl = item.imageUrl;
      // сбой крупного рендера (IIIF не успел за 60 с) - не повод терять
      // кадр: обычная копия обычно на месте
      let res = hiRes ? await fetchImage(hiRes).catch(() => null) : null;
      if (res && hiRes) imageUrl = hiRes;
      // IIIF может не знать этот файл - тогда работаем по-старому
      if (!res) res = await fetchImage(item.imageUrl);
      if (!res) continue;
      // пауза между скачиваниями: вежливо к архивам, дешевле, чем ретраи
      await sleepMs(politeDelayMs);
      const imageBuffer = Buffer.from(await res.arrayBuffer());
      // ширину знают не все источники (Europeana её не сообщает), и до
      // скачивания порог к таким кадрам не применялся: превью в 512 px
      // ушло бы на анализ, а потом мылом в канал. Меряем сам файл; не
      // картинка вовсе (страница вместо файла) - sharp бросит, кадр мимо
      if (item.imageWidth === undefined) {
        const { width } = await sharp(imageBuffer).metadata();
        const min = minWidthFor(item, cfg);
        if (!width || width < min) {
          console.log(`  мелкая после скачивания (${width ?? "?"} px < ${min}): [${item.source}] ${item.sourceId}`);
          continue;
        }
      }
      // метаданные молчат, а кадр всё равно стереопара - ловим по картинке
      if (await isStereoPair(imageBuffer)) {
        console.log(`  стереопара: [${item.source}] ${item.sourceId}`);
        continue;
      }
      const imageHash = await dhash(imageBuffer);
      if ([...known, ...batchHashes].some((h) => isDuplicate(h, imageHash))) {
        console.log(`  дубликат: [${item.source}] ${item.sourceId}`);
        continue;
      }
      batchHashes.push(imageHash);
      out.push({ ...item, imageUrl, imageHash, imageBuffer });
    } catch (err) {
      console.warn(`  пропуск (${(err as Error).message}): ${item.imageUrl}`);
    }
  }
  return out;
}

async function main() {
  const cfg = loadConfig();

  // dry живёт без базы — курсоры в памяти (каждый раз первая страница);
  // --only <источник> — прогнать один источник, игнорируя enabled
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : undefined;
  const cursors = dry ? memoryCursorStore() : dbCursorStore();
  const raw = await collectRaw(cfg, cfg.collect.raw_limit, cursors, only);
  console.log(`сырых записей: ${raw.length}`);

  const { kept, rejected } = prefilter(raw, cfg);
  for (const [reason, count] of rejected) {
    console.log(`префильтр: ${reason} × ${count}`);
  }

  const keepLimit = numArg("--keep") ?? cfg.collect.prefilter_keep;
  // сначала сортируем по «обещанию» (метаданные, без ИИ), потом мешаем по
  // архивам. Перемешивание держит порядок внутри архива, поэтому от
  // каждого первым берётся самый перспективный кадр, а не случайный.
  // Последним словом - очередь с потолками: дубли названий и монокультура
  // ВМВ/одного архива режутся ДО траты квоты
  //
  // Уже разобранные кадры отсекаем ДО очереди: раньше они занимали в ней
  // места и выбывали только потом, и партия мельчала, хотя в запасе
  // ждали новые кадры. Ключи читаются целиком, постранично
  const db = dry ? undefined : getDb();
  const existingKeys = db
    ? new Set(
        (
          await selectAll<{ source: string; source_id: string }>((from, to) =>
            db.from("candidates").select("source, source_id").order("id").range(from, to),
          )
        ).map((r) => `${r.source}:${r.source_id}`),
      )
    : new Set<string>();
  const unseen = kept.filter((i) => !existingKeys.has(`${i.source}:${i.sourceId}`));
  if (unseen.length < kept.length) {
    console.log(`уже разобраны раньше: ${kept.length - unseen.length}`);
  }
  const ranked = byPromise(unseen);
  const { queue: survivors, cuts } = buildAnalysisQueue(interleaveBySource(ranked), keepLimit);
  const avg = survivors.length
    ? survivors.reduce((s, it) => s + promise(it), 0) / survivors.length
    : 0;
  const inQueue = new Set(survivors);
  const rest = ranked.filter((it) => !inQueue.has(it));
  const avgRest = rest.length ? rest.reduce((s, it) => s + promise(it), 0) / rest.length : 0;
  console.log(
    `выжило после префильтра: ${survivors.length} (лимит ${keepLimit}), ` +
      `обещание очереди ${avg.toFixed(1)}` +
      (rest.length ? ` против ${avgRest.toFixed(1)} у отложенных` : ""),
  );
  if (cuts.duplicates || cuts.archiveCapped || cuts.ww2Capped || cuts.rubricCapped || cuts.nationCapped) {
    console.log(
      `потолки очереди: дублей названий ${cuts.duplicates}, ` +
        `придержано потолком архива ${cuts.archiveCapped}, потолком ВМВ ${cuts.ww2Capped}, ` +
        `рубрик сверх потолка ${cuts.rubricCapped}, потолком страны ${cuts.nationCapped}`,
    );
  }
  const queuedRubrics = survivors.filter((i) => i.rubric).map((i) => i.rubric);
  if (queuedRubrics.length) console.log(`рубрики в очереди: ${queuedRubrics.join(", ")}`);

  if (dry) {
    for (const item of survivors) {
      const title = (item.title ?? "(без заголовка)").slice(0, 80);
      console.log(
        `[${item.source}] ${item.year} · ${item.place} · ${title}\n` +
          `  ${item.sourceUrl}\n  ${item.imageUrl}`,
      );
    }
    console.log("(dry run, база не тронута)");
    return;
  }

  if (!db) return;
  const fresh = survivors;

  console.log("дедуп по dHash...");
  // вся история канала и все кандидаты, постранично: одним запросом
  // Supabase отдавал лишь первую тысячу хэшей
  const known = await loadKnownHashes(db, { candidates: true });
  const hashed = await hashAndDedup(fresh, known, cfg);
  console.log(`уникальных: ${hashed.length}`);

  // один запрос Gemini на фото: оценка + подпись сразу. Все прошедшие
  // порог кандидаты пишутся в базу со статусом new — это резерв, из
  // которого /more шлёт карточки вообще без обращения к Gemini
  // сколько ключей в пуле - видно сразу: добавленный секрет либо
  // подхватился, либо нет, и гадать по отказам 429 не приходится
  console.log(
    `анализ (оценка + подпись одним запросом), ключей Gemini: ${env.geminiApiKeys.length}...`,
  );
  const minScore = cfg.collect.min_score ?? 45;
  const hooklessMinScore = cfg.collect.hookless_min_score ?? 85;
  let written = 0;
  let failed = 0;
  let quotaFailed = 0;
  let skippedDull = 0;
  let skippedHookless = 0;
  let rewritten = 0;
  // тело длиннее одного предложения: не брак, а сигнал, что промпт
  // недожимает. Живой случай - вьетнамский пост 502-го полка, где во
  // второе предложение уехали и справка, и второй раз названное место
  let longBody = 0;
  // сбои сети и перегрузка Gemini (503, таймауты): это не брак подписи и
  // не квота. Утро 25.08: два таких сбоя ушли в сводку как «брак подписи»
  let netFailed = 0;
  // кадры рубрик, чья подпись не дотянула до рубрики (нет изюминки, не
  // назван жанр) - отдельный счётчик, чтобы видеть, как рубрика приживается
  let rubricFlawed = 0;
  // второе мнение полноценной модели по отказам облегчённой
  const secondOpinion = cfg.collect.second_opinion !== false;
  let secondOpinions = 0;
  let rescuedBySecond = 0;
  let secondOpinionMisses = 0;

  /**
   * Отсеянный на анализе кадр запоминается в базе статусом rejected, без
   * подписи. Раньше он не оставлял следа: когда выдача архива шла по
   * второму кругу, тот же скучный кадр снова получал слот и снова жёг
   * запрос к Gemini. Теперь его ключ отсекается до очереди, а хэш ловит
   * его копии в других архивах.
   */
  const rememberRejected = async (
    item: HashedItem,
    a: { score: number; tags: Record<string, unknown>; score_why?: string },
    gate: string,
    model: string | undefined,
  ) => {
    const { error } = await db.from("candidates").upsert(
      {
        source: item.source,
        source_id: item.sourceId,
        source_url: item.sourceUrl,
        image_url: item.imageUrl,
        image_hash: item.imageHash,
        raw_title: item.title ?? null,
        raw_desc: item.description ?? null,
        raw_lang: item.lang,
        year: item.year ?? null,
        place: item.place ?? null,
        // модель - чтобы отказы облегчённой можно было перепроверить
        tags: {
          ...a.tags,
          gate,
          ...(a.score_why ? { why: a.score_why } : {}),
          ...(model ? { model } : {}),
        },
        score: a.score,
        license: item.license,
        attribution: item.attribution ?? null,
        status: "rejected",
      },
      { onConflict: "source,source_id", ignoreDuplicates: true },
    );
    // не записался - не беда для прогона: худшее, что будет, - повторный анализ
    if (error) console.warn(`  не запомнил отсев [${item.source}] ${item.sourceId}: ${error.message}`);
  };

  let outOfTime = false;
  let analyzed = 0;
  // спасённые вторым подходом: 503 и таймаут - это состояние сервиса, а не
  // свойство снимка, и терять из-за них кадр насовсем незачем. Утро 15.10:
  // четыре кадра из шести умерли так, и партия пришла пустой при живой
  // квоте. Теперь сорванный кадр встаёт в КОНЕЦ очереди и получает второй
  // подход - к тому времени перегруженная модель уже вычеркнута, и разбор
  // обычно проходит. Второй раз подряд не пробуем: упрямый кадр дороже
  // остальной партии.
  let recovered = 0;
  const queue = [...hashed];
  const secondTry = new Set<HashedItem>();
  let resuming = false;
  for (let qi = 0; qi < queue.length; qi++) {
    const item = queue[qi]!;
    if (Date.now() - runStartedAt > RUN_BUDGET_MS) {
      outOfTime = true;
      console.warn(
        `бюджет прогона исчерпан: проанализировано ${analyzed} из ${hashed.length}, остальные ждут следующего раза`,
      );
      break;
    }
    // повторный подход тем же кадром заново «разобранным» не считаем, а
    // сбой первого подхода снимаем: дальше кадр получит РОВНО один исход -
    // запись, отсев или новый сбой. Иначе кадр, спасённый от 503 и потом
    // честно отсеянный как скучный, числился и сбоем, и мусором (живой
    // случай 15.10: воронка показала «сбоев 1», а настоящих было ноль)
    const retrying = secondTry.has(item);
    // после ожидания свободной модели тот же кадр идёт заново, но исход у
    // него по-прежнему один - счётчики второй раз не трогаем
    if (resuming) resuming = false;
    else if (retrying) netFailed--;
    else analyzed++;
    // умные цитаты: полное описание со страницы архива как доп. контекст
    let extraContext: string | undefined;
    try {
      extraContext = await ADAPTERS[item.source]?.details?.(item);
    } catch {
      extraContext = undefined;
    }

    try {
      let a = await analyzeImage(item, cfg, item.imageBuffer, extraContext);
      // какая модель оценила и подписала кадр - при перегрузке это может
      // быть облегчённая; храним рядом с тегами, чтобы потом сверить её
      // посты с остальными по живым данным, а не по догадкам
      let model = lastUsedModel();
      // спасён - значит, Gemini наконец ответила; дальше кадр судят по
      // существу, как любой другой
      if (retrying) {
        recovered++;
        console.log(`  спасён вторым подходом: [${item.source}] ${item.sourceId}`);
      }
      // цензуры нет: unsafe — только пометка в логе, решают редакторы
      if (a.unsafe) console.log(`  пометка unsafe: [${item.source}] ${item.sourceId}`);
      // рубрику, тему и «мирность» кадра рубрики ставит источник, а не
      // модель: плакат с солдатами она пометила бы infantry, и правило
      // чередования тем путало бы его с пехотой ядра
      const rubric = rubricOf(item.rubric);
      const tagRubric = (x: typeof a) => {
        if (!rubric) return;
        x.tags = {
          ...x.tags,
          rubric: item.rubric,
          ...(rubric.subject ? { subject: rubric.subject } : {}),
          ...(rubric.military !== undefined ? { military: rubric.military } : {}),
        };
      };
      tagRubric(a);
      const gateMin = rubric?.minScore ?? minScore;
      const gateHookless = rubric?.hooklessMinScore ?? hooklessMinScore;
      let verdict = passesGate(a, { minScore: gateMin, hooklessMinScore: gateHookless });
      // Второе мнение: отказ облегчённой модели перепроверяет полноценная.
      // Аудит 22.10 (scripts/gate-audit.ts): облегчённая ставила «45, без
      // крючка» почти любому кадру; полноценная из 16 таких отказов три
      // подняла до 62-72 (плакат, марш, портрет), остальные подтвердила
      // близкими оценками - теряет годное модель, а не порог. Явный брак (стереопара, репродукция - ниже
      // SECOND_OPINION_MIN) не перепроверяем: там модели согласны
      if (
        !verdict.pass &&
        secondOpinion &&
        isLiteModel(model) &&
        a.score >= SECOND_OPINION_MIN &&
        secondOpinionMisses < SECOND_OPINION_MAX_MISSES &&
        timeLeftMs() > MIN_ANALYSIS_LEFT_MS
      ) {
        try {
          const second = await analyzeImage(item, cfg, item.imageBuffer, extraContext, { fullOnly: true });
          tagRubric(second);
          const secondModel = lastUsedModel();
          const secondVerdict = passesGate(second, { minScore: gateMin, hooklessMinScore: gateHookless });
          secondOpinions++;
          secondOpinionMisses = 0;
          console.log(
            `  второе мнение (${secondModel}): ${a.score} [${a.tags.hook ?? "none"}] → ${second.score} [${second.tags.hook ?? "none"}]` +
              `${secondVerdict.pass ? " - проходит" : ""}: [${item.source}] ${item.sourceId}`,
          );
          if (secondVerdict.pass) rescuedBySecond++;
          a = second;
          model = secondModel;
          verdict = secondVerdict;
        } catch (err) {
          // полноценные заняты или кончились - остаётся вердикт облегчённой.
          // Облегчённая работает именно тогда, когда полноценные лежат, и
          // каждая попытка может ждать до 150 с: после двух неудач подряд
          // второе мнение в этом прогоне больше не спрашиваем
          secondOpinionMisses++;
          console.log(`  второе мнение не получено (${(err as Error).message}): [${item.source}] ${item.sourceId}`);
        }
      }
      const hook = a.tags.hook ?? "none";
      if (!verdict.pass) {
        const why = a.score_why ? ` - ${a.score_why}` : "";
        const tag = item.rubric ? ` {${item.rubric}}` : "";
        if (verdict.reason === "dull") {
          skippedDull++;
          console.log(`  скучное (score ${a.score} < ${gateMin}): [${item.source}] ${item.sourceId}${tag}${why}`);
        } else {
          skippedHookless++;
          console.log(
            `  без крючка (score ${a.score} < ${gateHookless}): [${item.source}] ${item.sourceId}${tag}${why}`,
          );
        }
        await rememberRejected(item, a, verdict.reason, model);
        continue;
      }
      // обоснование балла видно в логе сбора: по нему ловим завышения
      if (a.score_why) console.log(`  score ${a.score} [${hook}] (${model ?? "?"}): ${a.score_why}`);

      const row = {
        source: item.source,
        source_id: item.sourceId,
        source_url: item.sourceUrl,
        image_url: item.imageUrl,
        image_hash: item.imageHash,
        raw_title: item.title ?? null,
        raw_desc: item.description ?? null,
        raw_lang: item.lang,
        year: item.year ?? null,
        place: item.place ?? null,
        // обоснование храним рядом с тегами: отдельной колонки ради одной
        // строки заводить не стоит, а в отчёте по подписям оно нужно
        tags: {
          ...a.tags,
          ...(a.score_why ? { why: a.score_why } : {}),
          ...(model ? { model } : {}),
          // о чём справка: по нему видно, откуда в изюминке факт
          ...(a.subject_wiki ? { subject_wiki: a.subject_wiki } : {}),
        },
        score: a.score,
        license: item.license,
        attribution: item.attribution ?? null,
      };

      // второй заход: редактор выбраковывает пустые цитаты. Стоит один
      // запрос на кандидата, но только на тех, кто прошёл порог оценки.
      // На исходе бюджета пропускаем: кадр с цитатой как есть лучше, чем
      // job, убитый таймаутом воркфлоу посреди записи
      // справка о самом предмете в кадре (аэростат, эсминец, танк) - из
      // неё редактор строит изюминку, а не из статьи о событии вокруг.
      // Сбой Википедии - не беда: тогда редактор работает как раньше
      const enoughTime = timeLeftMs() > 3 * 60_000;
      const subjectContext =
        enoughTime && a.subject_wiki ? await subjectReference(a.subject_wiki) : undefined;
      if (subjectContext) console.log(`  справка о предмете: «${a.subject_wiki}» [${item.source}] ${item.sourceId}`);
      const reviewed = enoughTime
        ? await reviewWithWait(() => reviewQuote(item, cfg, a, extraContext, subjectContext, { throwBusy: true }), a)
        : { caption: a, rewritten: false };
      if (reviewed.rewritten) {
        console.log(`  цитата переписана редактором: [${item.source}] ${item.sourceId}`);
        rewritten++;
      }

      // числа изюминки должны быть в источниках (src/factcheck.ts)
      const sources = [item.title, item.description, item.place, extraContext, subjectContext]
        .filter(Boolean)
        .join("\n");
      // страховки по очереди: каждая видит итог предыдущей
      const guards = [
        (r: typeof reviewed) => guardNumbers(r, a, sources),
        (r: typeof reviewed) => guardCopies(r, a),
      ];
      for (const guard of guards) {
        const check = guard(reviewed);
        if (check.outcome === "ok") continue;
        const what = check.outcome === "editor_rejected" ? "правка редактора отклонена" : "изюминка снята";
        console.warn(`  ${check.bad.join(", ")} - ${what}: [${item.source}] ${item.sourceId}`);
        reviewed.caption = check.caption;
      }

      // кадр рубрики обязан быть видимо рубрикой: повседневность - только
      // изюминкой, плакат - названным плакатом. Не дотянул - не в резерв
      const flaw = rubric ? rubricCaptionFlaw(rubric, reviewed.caption) : undefined;
      if (flaw) {
        rubricFlawed++;
        console.log(`  рубрика ${item.rubric}: ${flaw} - [${item.source}] ${item.sourceId}`);
        await rememberRejected(item, a, `rubric:${item.rubric}`, model);
        continue;
      }

      const sentences = descriptiveSentences(reviewed.caption.caption);
      if (sentences > 1) {
        longBody++;
        console.warn(
          `  тело в ${sentences} предложения: [${item.source}] ${item.sourceId} - «${reviewed.caption.caption.replace(/\n/g, " ")}»`,
        );
      }

      const captionHtml = assembleCaptionHtml(reviewed.caption, item, cfg.channel);
      // контекст (описание с карточки, вики-справка) - легальный источник
      // фактов для изюминки, его годы валидатор тоже должен знать
      const context = [extraContext, subjectContext].filter(Boolean).join("\n");
      const check = validateCaption(captionHtml, { ...item, context: context || undefined });
      const { error } = await db.from("candidates").upsert(
        check.ok
          ? {
              ...row,
              caption_html: captionHtml,
              // у короткого поста цитаты нет - маркер вида цитаты не нужен
              quote_kind: reviewed.caption.quote ? reviewed.caption.quote_kind : null,
              status: "new",
            }
          : { ...row, status: "failed" },
        { onConflict: "source,source_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);

      if (check.ok) {
        written++;
      } else {
        failed++;
        console.warn(`  брак подписи: [${item.source}] ${item.sourceId} — ${check.reason}`);
      }
    } catch (err) {
      // все модели на скамейке - кадр не виноват. Есть время дождаться -
      // ждём и берём тот же кадр снова; нет - останавливаемся честно:
      // неразобранные кадры не помечены и достанутся следующему сбору
      if (err instanceof GeminiBusyError) {
        const pauseMs = err.waitMs + 1000;
        if (timeLeftMs() - pauseMs > MIN_ANALYSIS_LEFT_MS) {
          console.warn(`  Gemini занята: жду ${Math.ceil(pauseMs / 1000)} с и продолжаю с того же кадра`);
          await sleepMs(pauseMs);
          resuming = true;
          qi--;
          continue;
        }
        if (retrying) netFailed++;
        else analyzed--;
        outOfTime = true;
        console.warn(
          `Gemini занята до конца бюджета: проанализировано ${analyzed} из ${hashed.length}, остальные ждут следующего сбора`,
        );
        break;
      }
      // сорванный лимитом кадр - не брак подписи: подписи у него не было
      // вовсе. Считаем отдельно, иначе диагноз врёт («брака подписи 4»
      // при четырёх отказах по квоте - живой случай 13.08)
      if (err instanceof GeminiQuotaError) {
        quotaFailed++;
      } else {
        netFailed++;
        // перегрузка и таймаут лечатся повтором, брак кадра - нет:
        // в конец очереди кадр уходит ровно один раз
        if (!retrying && isTransientFailure((err as Error).message)) {
          secondTry.add(item);
          queue.push(item);
        }
      }
      console.warn(`  анализ упал: [${item.source}] ${item.sourceId} — ${(err as Error).message}`);
      if (err instanceof GeminiQuotaError && quotaTripped()) {
        console.error("❌ дневная квота Gemini исчерпана — прекращаю до следующего запуска");
        if (written === 0) await notifyQuotaExhausted();
        break;
      }
    }
  }

  // сквозная воронка: сразу видно, на каком сите теряется контент
  console.log(
    "воронка: " +
      [
        `сырых ${raw.length}`,
        `префильтр ${kept.length}`,
        `на анализ ${survivors.length}`,
        `новых ${fresh.length}`,
        `уникальных ${hashed.length}`,
        `разобрано ${analyzed}`,
        `в резерв ${written}`,
      ].join(" → ") + (outOfTime ? " (прогон оборван бюджетом времени)" : ""),
  );
  console.log(
    `отсев на анализе: мусора ${skippedDull} (score < ${minScore}), без крючка ${skippedHookless} (слабее ${hooklessMinScore}), ` +
      `брака подписи ${failed}, сорвано квотой ${quotaFailed}, сбоев сети/сервиса ${netFailed}, ` +
      `цитат переписано ${rewritten}, тело длиннее предложения ${longBody}` +
      (recovered ? `, спасено вторым подходом ${recovered}` : "") +
      (rubricFlawed ? `, не дотянули до рубрики ${rubricFlawed}` : "") +
      (secondOpinions ? `, второе мнение ${secondOpinions} (спасено ${rescuedBySecond})` : ""),
  );

  // та же воронка в базу: по ней бот сам замечает, что что-то сломалось
  const { error: runErr } = await db.from("collect_runs").insert({
    raw: raw.length,
    prefiltered: kept.length,
    analyzed,
    written,
    junk: skippedDull,
    broken: failed,
    quota_failed: quotaFailed,
    hookless: skippedHookless,
    out_of_time: outOfTime,
    net_failed: netFailed,
    // реальная очередь анализа: prefiltered - это ВСЕ прошедшие фильтр,
    // а сюда попало не больше лимита партии (сводка считала недождавшихся
    // от 64 вместо 30 - живой случай 25.08)
    queued: hashed.length,
    sources: lastSourceCounts,
  });
  if (runErr) console.warn(`запись прогона в историю: ${runErr.message}`);

  await reportHealth(db, cfg);
  await heartbeatOk("collector");
}

main().catch(async (err) => {
  console.error("сбор упал:", err);
  if (!dry) {
    try {
      await heartbeatError("collector", String(err));
    } catch {
      // база недоступна — heartbeat проверит это по устаревшему last_ok
    }
  }
  process.exit(1);
});
