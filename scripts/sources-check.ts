/**
 * Проверка источников перед сбором: кто жив, кто молчит, кто врёт.
 *
 * Опрашиваем КАЖДЫЙ архив Commons и КАЖДЫЙ запрос LOC по отдельности -
 * иначе беда одного тонет в общей цифре. Живой случай 14.08: «commons:
 * получено 0» на самом деле означало девять отказов подряд по лимиту
 * Викимедиа, а выглядело как поломка адаптера.
 *
 * Ничего не пишет в базу, Gemini не зовёт, курсоры не двигает.
 *
 * Запуск: npx tsx scripts/sources-check.ts
 */
import { loadConfig } from "../src/config.js";
import { POLITE_GAP_MS, searchCategory } from "../src/sources/commons.js";
import { fetchQuery, mapLocResult } from "../src/sources/loc.js";
import { mapCommonsPage } from "../src/sources/bundesarchiv.js";
import { prefilter } from "../src/prefilter.js";
import type { RawItem } from "../src/sources/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PROBE = 6; // сколько записей просим у каждого архива на пробу

/** Строка итога: «ok 6» или «ОТКАЗ HTTP 429». */
function verdict(count: number | null, error?: string): string {
  if (error) return `ОТКАЗ ${error}`;
  if (count === 0) return "пусто (0 записей)";
  return `ok ${count}`;
}

async function checkCommons(cfg: ReturnType<typeof loadConfig>) {
  const src = cfg.sources.commons;
  console.log("\n═══ COMMONS ═══");
  if (!src?.enabled) {
    console.log("источник выключен в config.yaml");
    return [] as RawItem[];
  }
  const archives = src.archives ?? [];
  const shared = src.categories?.length ? src.categories : [""];
  const all: RawItem[] = [];
  let alive = 0;

  for (const [i, archive] of archives.entries()) {
    if (i) await sleep(POLITE_GAP_MS);
    const terms = archive.terms?.length ? archive.terms : shared;
    const term = terms[0] ?? "";
    const started = Date.now();
    try {
      const pages = await searchCategory(archive.category, term, PROBE, 0);
      const items = pages
        .map((p) => mapCommonsPage(p, { lang: archive.lang, attributionPrefix: archive.attribution }))
        .filter((it): it is RawItem => Boolean(it));
      all.push(...items);
      if (pages.length) alive++;
      const ms = Date.now() - started;
      console.log(
        `  ${archive.attribution.padEnd(22)} «${term || "без слова"}» → ${verdict(pages.length)}` +
          `, годных ${items.length}, ${ms} мс`,
      );
      if (!pages.length) {
        console.log(`      категория «${archive.category}» - проверьте имя, поиск ничего не вернул`);
      }
    } catch (err) {
      console.log(`  ${archive.attribution.padEnd(22)} → ${verdict(null, (err as Error).message)}`);
    }
  }
  console.log(`  итого живых архивов: ${alive} из ${archives.length}`);
  return all;
}

async function checkLoc(cfg: ReturnType<typeof loadConfig>) {
  const src = cfg.sources.loc;
  console.log("\n═══ LIBRARY OF CONGRESS ═══");
  if (!src?.enabled) {
    console.log("источник выключен в config.yaml");
    return [] as RawItem[];
  }
  const queries = src.queries ?? [];
  const all: RawItem[] = [];
  let alive = 0;

  for (const q of queries) {
    const started = Date.now();
    try {
      const results = await fetchQuery(q, PROBE, 1);
      const items = results.map(mapLocResult).filter((it): it is RawItem => Boolean(it));
      all.push(...items);
      if (results.length) alive++;
      console.log(
        `  «${q}» → ${verdict(results.length)}, годных ${items.length}, ${Date.now() - started} мс`,
      );
    } catch (err) {
      console.log(`  «${q}» → ${verdict(null, (err as Error).message)}`);
    }
  }
  console.log(`  итого рабочих запросов: ${alive} из ${queries.length}`);
  return all;
}

/** Что бы отсеял префильтр на этой пробе - видно, куда уходит материал. */
function checkPrefilter(items: RawItem[], cfg: ReturnType<typeof loadConfig>) {
  console.log("\n═══ ПРЕФИЛЬТР НА ПРОБЕ ═══");
  if (!items.length) {
    console.log("проверять нечего - источники не дали записей");
    return;
  }
  const { kept, rejected } = prefilter(items, cfg);
  console.log(`  пришло ${items.length}, прошло ${kept.length}`);
  for (const [reason, count] of rejected) console.log(`  отсев ${reason}: ${count}`);
  const noWidth = items.filter((i) => i.imageWidth === undefined).length;
  if (noWidth) console.log(`  без известной ширины: ${noWidth} (порог по размеру к ним не применялся)`);
}

async function main() {
  const cfg = loadConfig();
  console.log(`ПРОВЕРКА ИСТОЧНИКОВ · порог ширины ${cfg.collect.min_image_width}\n`);

  const enabled = Object.entries(cfg.sources)
    .filter(([, s]) => s.enabled)
    .map(([name, s]) => `${name} (вес ${s.weight})`);
  const off = Object.entries(cfg.sources)
    .filter(([, s]) => !s.enabled)
    .map(([name]) => name);
  console.log(`включены: ${enabled.join(", ") || "нет"}`);
  console.log(`выключены: ${off.join(", ") || "нет"}`);

  const items = [...(await checkCommons(cfg)), ...(await checkLoc(cfg))];
  checkPrefilter(items, cfg);
  console.log("\nпроверка завершена: база не тронута, Gemini не вызывался");
}

main().catch((err) => {
  console.error("проверка источников упала:", err);
  process.exit(1);
});
