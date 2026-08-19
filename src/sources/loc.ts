/**
 * Library of Congress — JSON API поверх обычного поиска фотографий.
 * https://www.loc.gov/apis/json-and-yaml/
 *
 * Фотоколлекции LOC (FSA/OWI и др.) — public domain / no known restrictions.
 */
import type { SourceConfig } from "../config.js";
import type { RawItem, SourceAdapter } from "./types.js";

type LocResult = {
  id?: string;
  url?: string;
  title?: string;
  description?: string[] | string;
  date?: string;
  location?: string[];
  image_url?: string[];
  access_restricted?: boolean;
};

/** Сколько всего времени отводим источнику за один прогон. */
const LOC_TIME_BUDGET_MS = 6 * 60_000;

export function parseYear(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : undefined;
}

/** image_url в LOC несёт размеры во фрагменте: ...jpg#h=768&w=1024 */
function pickLargestImage(urls: string[]): { url: string; width?: number } | undefined {
  let best: { url: string; width?: number } | undefined;
  for (const raw of urls) {
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    const width = Number(url.match(/[#&]w=(\d+)/)?.[1]) || undefined;
    if (!best || (width ?? 0) > (best.width ?? 0)) best = { url, width };
  }
  return best;
}

/**
 * Ссылка на крупный рендер того же кадра через IIIF-сервис LOC.
 *
 * Поиск LOC отдаёт только служебные копии (обычно 1024 по длинной стороне,
 * иногда меньше) - в Телеграме такой кадр выглядит мылом, особенно рядом с
 * коммонсовскими 1600. Тот же файл лежит в image-services, где размер
 * задаём мы: /full/1600,/0/default.jpg
 *   storage-services/service/pnp/anrc/00300/00312v.jpg
 *   → image-services/iiif/service:pnp:anrc:00300:00312v/full/1600,/0/default.jpg
 *
 * Возвращает undefined, если ссылка не того вида: тогда качаем как раньше.
 * Проверять догадку не нужно - сборщик всё равно скачивает файл, и при
 * неудаче откатывается на исходный адрес.
 */
export function hiResLocUrl(imageUrl: string): string | undefined {
  const clean = imageUrl.split("#")[0] ?? "";
  const m = clean.match(/^https:\/\/tile\.loc\.gov\/storage-services\/(.+)\.(jpg|jpeg)$/i);
  if (!m?.[1]) return undefined;
  const id = m[1].split("/").filter(Boolean).join(":");
  if (!id) return undefined;
  return `https://tile.loc.gov/image-services/iiif/${id}/full/1600,/0/default.jpg`;
}

export function mapLocResult(r: LocResult): RawItem | undefined {
  if (r.access_restricted) return undefined;
  if (!r.image_url?.length || !r.id) return undefined;

  const image = pickLargestImage(r.image_url);
  if (!image) return undefined;
  // у коллекций LOC вместо фото — SVG-заглушка вида
  // /static/images/original-format/group-of-images.svg (живой прогон)
  if (image.url.includes("/static/images/") || /\.svg(\?|#|$)/.test(image.url)) {
    return undefined;
  }

  const sourceId = r.id.replace(/^https?:\/\/www\.loc\.gov\/item\//, "").replace(/\/$/, "");
  const description = Array.isArray(r.description) ? r.description.join(" ") : r.description;

  return {
    sourceId,
    sourceUrl: r.url ?? r.id,
    imageUrl: image.url,
    imageWidth: image.width,
    title: r.title,
    description,
    lang: "en",
    year: parseYear(r.date) ?? parseYear(r.title),
    place: r.location?.[0],
    license: "PD",
    // архив нужен балансиру: без него кадры LOC выпадали из чередования
    // архивов и могли идти в ленте подряд
    attribution: "Library of Congress",
  };
}

/** Один запрос к поиску LOC. Экспортирован для проверки источников. */
export async function fetchQuery(query: string, count: number, page: number): Promise<LocResult[]> {
  const url = new URL("https://www.loc.gov/photos/");
  url.searchParams.set("q", query);
  url.searchParams.set("fo", "json");
  // только результаты: без at= loc.gov шлёт мегабайты фасетов и служебных
  // блоков - именно эти ответы и не влезали в таймаут (три отвала подряд)
  url.searchParams.set("at", "results");
  url.searchParams.set("c", String(Math.min(count, 40)));
  url.searchParams.set("sp", String(page)); // пагинация: страница выдачи
  // без User-Agent loc.gov отдаёт 403 с датацентровых IP (GitHub Actions — Azure)
  // loc.gov регулярно отвечает медленно: один таймаут не должен уносить
  // весь источник, поэтому две попытки с запасом по времени
  let lastErr: unknown;
  for (const timeoutMs of [45_000, 60_000]) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent":
            "Mozilla/5.0 (compatible; story-team-bot/0.1; historical photo curation)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`loc: ${url} → HTTP ${res.status}`);
      const body = (await res.json()) as { results?: LocResult[] };
      return body.results ?? [];
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export const loc: SourceAdapter = {
  name: "loc",

  /** Полное описание с карточки предмета — контекст для подписи. */
  async details(item: RawItem): Promise<string | undefined> {
    try {
      const res = await fetch(`https://www.loc.gov/item/${item.sourceId}/?fo=json`, {
        headers: {
          accept: "application/json",
          "user-agent":
            "Mozilla/5.0 (compatible; story-team-bot/0.1; historical photo curation)",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        item?: { description?: string[]; notes?: string[]; summary?: string[] };
      };
      const parts = [
        ...(body.item?.description ?? []),
        ...(body.item?.summary ?? []),
        ...(body.item?.notes ?? []),
      ];
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      return text ? text.slice(0, 1500) : undefined;
    } catch {
      return undefined;
    }
  },

  async fetch(limit, cfg, cursors): Promise<RawItem[]> {
    const queries = cfg.queries?.length ? cfg.queries : [""];
    const perQuery = Math.ceil(limit / queries.length);
    const items: RawItem[] = [];
    // Бюджет времени на весь источник. loc.gov регулярно отвечает по
    // 45 секунд, а запросов семнадцать и у каждого две попытки - в плохой
    // день это полчаса, и сбор целиком убивало таймаутом воркфлоу (19.08:
    // два ежедневных прогона подряд отменены на 30-й минуте). Лучше
    // неполная выдача, чем мёртвый сбор: остальное доберём завтра.
    const deadline = Date.now() + LOC_TIME_BUDGET_MS;
    for (const q of queries) {
      if (Date.now() > deadline) {
        console.warn(`  loc: бюджет времени исчерпан, собрано ${items.length} - остальные запросы пропущены`);
        break;
      }
      // курсор — номер страницы прошлого запуска; 0 значит «ещё не ходили»
      const page = Math.max(1, (await cursors.get("loc", q)) + 1);
      let results: LocResult[];
      try {
        results = await fetchQuery(q, perQuery, page);
      } catch (err) {
        // один запрос не должен уносить весь источник: за концом выдачи
        // loc.gov отвечает 404, и без сброса курсора источник умирал
        // насовсем (живой случай: «loc: сбор упал» каждый день)
        console.warn(`  loc: «${q}» стр. ${page} — ${(err as Error).message}`);
        await cursors.set("loc", q, 0);
        // и сразу заходим с начала выдачи: иначе запрос впустую теряет
        // свою долю партии до следующего прогона (сухой прогон 12.08:
        // четыре запроса упёрлись в конец, LOC отдал 14 из 33)
        try {
          results = await fetchQuery(q, perQuery, 1);
        } catch {
          continue;
        }
        for (const r of results) {
          const item = mapLocResult(r);
          if (item) items.push(item);
        }
        await cursors.set("loc", q, results.length < perQuery ? 0 : 1);
        continue;
      }
      for (const r of results) {
        const item = mapLocResult(r);
        if (item) items.push(item);
      }
      // выдача кончилась — заворачиваем на начало
      await cursors.set("loc", q, results.length < perQuery ? 0 : page);
    }
    return items.slice(0, limit);
  },
};
