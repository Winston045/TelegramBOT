/**
 * Сбор кандидатов: источники → префильтр (→ дальше скоринг, этап 4).
 *
 * npm run collect -- --dry  — напечатать выживших после префильтра, в базу не писать.
 */
import { loadConfig } from "../src/config.js";
import { collectRaw } from "../src/sources/index.js";
import { prefilter } from "../src/prefilter.js";

const dry = process.argv.includes("--dry");

async function main() {
  const cfg = loadConfig();

  const raw = await collectRaw(cfg, cfg.collect.raw_limit);
  console.log(`сырых записей: ${raw.length}`);

  const { kept, rejected } = prefilter(raw, cfg);
  for (const [reason, count] of rejected) {
    console.log(`префильтр: ${reason} × ${count}`);
  }

  const survivors = kept.slice(0, cfg.collect.prefilter_keep);
  console.log(`выжило после префильтра: ${survivors.length} (лимит ${cfg.collect.prefilter_keep})`);

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

  // Этап 4: vision-скоринг, генерация подписей, запись в candidates.
  throw new Error("полный сбор ещё не реализован — запускайте с --dry (этап 4 впереди)");
}

main().catch((err) => {
  console.error("сбор упал:", err);
  process.exit(1);
});
