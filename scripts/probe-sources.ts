/**
 * Проба КАНДИДАТОВ в источники - до того, как они попадут в config.yaml.
 *
 * sources-check проверяет то, что уже включено. Здесь - новые категории
 * Commons и запросы LOC из scripts/probe-candidates.yaml: живы ли они,
 * какие годы и размеры отдают и, главное, что в них лежит на самом деле -
 * по пять образцов заголовков. Решение «брать или нет» принимается по
 * образцам, а не по имени категории (урок PastVu: по имени - военная
 * хроника, на деле - соборы и колонны).
 *
 * Ничего не пишет в базу, Gemini не зовёт, курсоры не двигает.
 * Запуск: npx tsx scripts/probe-sources.ts
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { POLITE_GAP_MS, searchCategory } from "../src/sources/commons.js";
import { mapCommonsPage } from "../src/sources/bundesarchiv.js";
import { fetchQuery, mapLocResult } from "../src/sources/loc.js";
import { europeana } from "../src/sources/europeana.js";
import { memoryCursorStore } from "../src/cursors.js";
import type { RawItem } from "../src/sources/types.js";

type Candidates = {
  commons?: Array<{ category: string; terms?: string[]; deep?: boolean; lang?: string }>;
  loc?: string[];
  /** запросы Europeana - пробуются, только если задан EUROPEANA_API_KEY */
  europeana?: string[];
};

const PROBE = 12;
const SAMPLES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function summary(items: RawItem[]): string {
  const years = items.map((i) => i.year).filter((y): y is number => y !== undefined).sort((a, b) => a - b);
  const widths = items.map((i) => i.imageWidth).filter((w): w is number => w !== undefined).sort((a, b) => a - b);
  const median = widths.length ? widths[Math.floor(widths.length / 2)] : undefined;
  const withPlace = items.filter((i) => i.place || (i.description?.length ?? 0) >= 60).length;
  const licenses = [...new Set(items.map((i) => i.license))].slice(0, 3).join("; ");
  return (
    `записей ${items.length}, с годом ${years.length}` +
    (years.length ? ` (${years[0]}-${years[years.length - 1]})` : "") +
    `, с местом/описанием ${withPlace}` +
    (median ? `, ширина медиана ${median}` : "") +
    (licenses ? `, лицензии: ${licenses}` : "")
  );
}

function samples(items: RawItem[]) {
  for (const i of items.slice(0, SAMPLES)) {
    const desc = (i.description ?? "").replace(/\s+/g, " ").slice(0, 110);
    console.log(`      · ${i.year ?? "----"} · ${i.imageWidth ?? "?"}px · ${(i.title ?? "").slice(0, 90)}`);
    if (desc) console.log(`          ${desc}`);
  }
}

async function main() {
  const file = process.argv[2] ?? "scripts/probe-candidates.yaml";
  const cand = parse(readFileSync(file, "utf8")) as Candidates;

  console.log("═══ COMMONS ═══");
  let first = true;
  for (const c of cand.commons ?? []) {
    for (const term of c.terms?.length ? c.terms : [""]) {
      if (!first) await sleep(POLITE_GAP_MS);
      first = false;
      const label = `${c.deep ? "deepcat" : "incategory"} «${c.category}» «${term || "без слова"}»`;
      try {
        const pages = await searchCategory(c.category, term, PROBE, 0, c.deep);
        const items = pages
          .map((p) => mapCommonsPage(p, { lang: c.lang ?? "en", attributionPrefix: c.category }))
          .filter((it): it is RawItem => Boolean(it));
        console.log(`  ${label} → ${pages.length ? summary(items) : "ПУСТО"}`);
        samples(items);
      } catch (err) {
        console.log(`  ${label} → ОТКАЗ ${(err as Error).message}`);
      }
    }
  }

  console.log("\n═══ LIBRARY OF CONGRESS ═══");
  for (const q of cand.loc ?? []) {
    try {
      const results = await fetchQuery(q, PROBE, 1);
      const items = results.map(mapLocResult).filter((it): it is RawItem => Boolean(it));
      console.log(`  «${q}» → ${results.length ? summary(items) : "ПУСТО"}`);
      samples(items);
    } catch (err) {
      console.log(`  «${q}» → ОТКАЗ ${(err as Error).message}`);
    }
  }
  if (cand.europeana?.length) {
    console.log("\n═══ EUROPEANA ═══");
    if (!process.env.EUROPEANA_API_KEY?.trim()) {
      console.log("  EUROPEANA_API_KEY не задан - пропуск");
    } else {
      for (const q of cand.europeana) {
        try {
          const items = await europeana.fetch(PROBE, { enabled: true, weight: 1, queries: [q] }, memoryCursorStore());
          console.log(`  «${q}» → ${items.length ? summary(items) : "ПУСТО"}`);
          samples(items);
        } catch (err) {
          console.log(`  «${q}» → ОТКАЗ ${(err as Error).message}`);
        }
      }
    }
  }
  console.log("\nпроба завершена: база не тронута, Gemini не вызывался");
}

main().catch((err) => {
  console.error("проба упала:", err);
  process.exit(1);
});
