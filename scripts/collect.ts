/**
 * Сбор кандидатов: источники → префильтр → дедуп по dHash →
 * vision-скоринг → подписи для топ-N → валидация → запись в candidates.
 *
 * npm run collect -- --dry        — только источники + префильтр, без Gemini и базы.
 * npm run collect -- --keep 6 --top 2 — маленькая партия (тест): 6 на скоринг, 2 подписи.
 */
import { loadConfig } from "../src/config.js";
import { dbCursorStore, memoryCursorStore } from "../src/cursors.js";
import { ADAPTERS, collectRaw, type CollectedItem } from "../src/sources/index.js";
import { prefilter } from "../src/prefilter.js";
import { dhash, isDuplicate } from "../src/dhash.js";
import { getDb } from "../src/db.js";
import { GeminiQuotaError, quotaTripped } from "../src/gemini.js";
import { scoreImage, type VisionScore } from "../src/scoring.js";
import { assembleCaptionHtml, generateCaption } from "../src/caption.js";
import { validateCaption } from "../src/validate.js";
import { heartbeatError, heartbeatOk } from "../src/heartbeat.js";

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
type ScoredItem = HashedItem & { vision: VisionScore };

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

async function hashAndDedup(items: CollectedItem[], known: string[]): Promise<HashedItem[]> {
  const out: HashedItem[] = [];
  const batchHashes: string[] = [];
  for (const item of items) {
    try {
      const res = await fetch(item.imageUrl, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        console.warn(`  пропуск (HTTP ${res.status}): ${item.imageUrl}`);
        continue;
      }
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

  console.log("vision-скоринг...");
  const scored: ScoredItem[] = [];
  for (const item of hashed) {
    try {
      const vision = await scoreImage(item.imageBuffer);
      if (vision.unsafe) {
        console.log(`  unsafe: [${item.source}] ${item.sourceId}`);
        continue;
      }
      scored.push({ ...item, vision });
    } catch (err) {
      console.warn(`  скоринг упал: [${item.source}] ${item.sourceId} — ${(err as Error).message}`);
      if (err instanceof GeminiQuotaError && quotaTripped()) {
        console.error("❌ дневная квота Gemini исчерпана — прекращаю скоринг до следующего запуска");
        break;
      }
    }
  }

  scored.sort((a, b) => b.vision.score - a.vision.score);
  const top = scored.slice(0, numArg("--top") ?? cfg.collect.daily_candidates);
  console.log(`к генерации подписей: ${top.length}`);

  let written = 0;
  let failed = 0;
  for (const item of top) {
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
      tags: item.vision.tags,
      score: item.vision.score,
      license: item.license,
      attribution: item.attribution ?? null,
    };

    try {
      // умные цитаты: полное описание со страницы архива как доп. контекст
      let extraContext: string | undefined;
      try {
        extraContext = await ADAPTERS[item.source]?.details?.(item);
      } catch {
        extraContext = undefined;
      }
      const generated = await generateCaption(item, cfg, item.imageBuffer, extraContext);
      const captionHtml = assembleCaptionHtml(generated, item, cfg.channel);
      const check = validateCaption(captionHtml, item);

      const { error } = await db.from("candidates").upsert(
        check.ok
          ? { ...row, caption_html: captionHtml, quote_kind: generated.quote_kind, status: "new" }
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
      console.warn(`  подпись упала: [${item.source}] ${item.sourceId} — ${(err as Error).message}`);
      await db
        .from("candidates")
        .upsert({ ...row, status: "failed" }, { onConflict: "source,source_id", ignoreDuplicates: true });
      if (err instanceof GeminiQuotaError && quotaTripped()) {
        console.error("❌ дневная квота Gemini исчерпана — прекращаю генерацию до следующего запуска");
        break;
      }
    }
  }

  console.log(`готово: записано кандидатов ${written}, брака ${failed}`);
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
