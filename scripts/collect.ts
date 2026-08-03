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
  lastSourceCounts,
  type CollectedItem,
} from "../src/sources/index.js";
import { reportHealth } from "../src/health.js";
import { prefilter } from "../src/prefilter.js";
import { dhash, isDuplicate } from "../src/dhash.js";
import { getDb } from "../src/db.js";
import { GeminiQuotaError, quotaTripped } from "../src/gemini.js";
import { analyzeImage } from "../src/analyze.js";
import { reviewQuote } from "../src/critic.js";
import { assembleCaptionHtml } from "../src/caption.js";
import { validateCaption } from "../src/validate.js";
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
        "Квота сбрасывается в 10:00 МСК.",
    );
  } catch {
    // чата может не быть в dry-запусках или при неполных секретах
  }
}

const dry = process.argv.includes("--dry");

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

async function loadKnownHashes(): Promise<string[]> {
  const db = getDb();
  const [seen, cands] = await Promise.all([
    db.from("seen_hashes").select("image_hash"),
    db.from("candidates").select("image_hash"),
  ]);
  if (seen.error) throw new Error(`чтение seen_hashes: ${seen.error.message}`);
  if (cands.error) throw new Error(`чтение candidates: ${cands.error.message}`);
  return [...seen.data, ...cands.data].map((r) => r.image_hash as string);
}

/**
 * Скачивание картинки. Викимедиа режет анонимные запросы с датацентровых
 * IP (GitHub Actions) кодом 429 - обязателен User-Agent, а на отказ
 * отвечаем паузой и повтором, иначе от партии выживают единицы.
 */
async function fetchImage(url: string): Promise<Response | null> {
  const RETRY_DELAYS_MS = [1000, 3000, 8000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
      headers: {
        "user-agent": "story-team-bot/0.1 (Telegram history channel; contact via t.me/Story_Teams)",
        accept: "image/*",
      },
    });
    if (res.ok) return res;
    const retriable = res.status === 429 || res.status >= 500;
    const delay = RETRY_DELAYS_MS[attempt];
    if (!retriable || delay === undefined) {
      console.warn(`  пропуск (HTTP ${res.status}): ${url}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function hashAndDedup(items: CollectedItem[], known: string[]): Promise<HashedItem[]> {
  const out: HashedItem[] = [];
  const batchHashes: string[] = [];
  for (const item of items) {
    try {
      const res = await fetchImage(item.imageUrl);
      if (!res) continue;
      // пауза между скачиваниями: вежливо к архивам, дешевле, чем ретраи
      await new Promise((r) => setTimeout(r, 300));
      const imageBuffer = Buffer.from(await res.arrayBuffer());
      const imageHash = await dhash(imageBuffer);
      if ([...known, ...batchHashes].some((h) => isDuplicate(h, imageHash))) {
        console.log(`  дубликат: [${item.source}] ${item.sourceId}`);
        continue;
      }
      batchHashes.push(imageHash);
      out.push({ ...item, imageHash, imageBuffer });
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
  const survivors = kept.slice(0, keepLimit);
  console.log(`выжило после префильтра: ${survivors.length} (лимит ${keepLimit})`);

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

  const db = getDb();

  // существующие (source, source_id) не трогаем и не скорим повторно
  const { data: existing, error: exErr } = await db
    .from("candidates")
    .select("source, source_id");
  if (exErr) throw new Error(`чтение candidates: ${exErr.message}`);
  const existingKeys = new Set(existing.map((r) => `${r.source}:${r.source_id}`));
  const fresh = survivors.filter((i) => !existingKeys.has(`${i.source}:${i.sourceId}`));

  console.log("дедуп по dHash...");
  const known = await loadKnownHashes();
  const hashed = await hashAndDedup(fresh, known);
  console.log(`уникальных: ${hashed.length}`);

  // один запрос Gemini на фото: оценка + подпись сразу. Все прошедшие
  // порог кандидаты пишутся в базу со статусом new — это резерв, из
  // которого /more шлёт карточки вообще без обращения к Gemini
  console.log("анализ (оценка + подпись одним запросом)...");
  const minScore = cfg.collect.min_score ?? 45;
  let written = 0;
  let failed = 0;
  let skippedDull = 0;
  let rewritten = 0;

  for (const item of hashed) {
    // умные цитаты: полное описание со страницы архива как доп. контекст
    let extraContext: string | undefined;
    try {
      extraContext = await ADAPTERS[item.source]?.details?.(item);
    } catch {
      extraContext = undefined;
    }

    try {
      const a = await analyzeImage(item, cfg, item.imageBuffer, extraContext);
      // цензуры нет: unsafe — только пометка в логе, решают редакторы
      if (a.unsafe) console.log(`  пометка unsafe: [${item.source}] ${item.sourceId}`);
      if (a.score < minScore) {
        skippedDull++;
        console.log(`  скучное (score ${a.score} < ${minScore}): [${item.source}] ${item.sourceId}`);
        continue;
      }

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
        tags: a.tags,
        score: a.score,
        license: item.license,
        attribution: item.attribution ?? null,
      };

      // второй заход: редактор выбраковывает пустые цитаты. Стоит один
      // запрос на кандидата, но только на тех, кто прошёл порог оценки
      const reviewed = await reviewQuote(item, cfg, a, extraContext);
      if (reviewed.rewritten) {
        console.log(`  цитата переписана редактором: [${item.source}] ${item.sourceId}`);
        rewritten++;
      }

      const captionHtml = assembleCaptionHtml(reviewed.caption, item, cfg.channel);
      const check = validateCaption(captionHtml, item);
      const { error } = await db.from("candidates").upsert(
        check.ok
          ? {
              ...row,
              caption_html: captionHtml,
              quote_kind: reviewed.caption.quote_kind,
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
      failed++;
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
        `в резерв ${written}`,
      ].join(" → "),
  );
  console.log(
    `отсев на анализе: мусора ${skippedDull} (score < ${minScore}), брака подписи ${failed}, цитат переписано ${rewritten}`,
  );

  // та же воронка в базу: по ней бот сам замечает, что что-то сломалось
  const { error: runErr } = await db.from("collect_runs").insert({
    raw: raw.length,
    prefiltered: kept.length,
    analyzed: hashed.length,
    written,
    junk: skippedDull,
    broken: failed,
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
