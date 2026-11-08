/**
 * Предохранитель по хостам: кто ответил «слишком много запросов» (429),
 * того до конца прогона не трогаем.
 *
 * Редакция 08.11: «бот стучался в некоторые ресурсы беспрерывно, от чего
 * они его блокировали». Живые случаи: loc.gov - 429 на всех шестнадцати
 * запросах подряд (сбор 08.11); Викимедиа - десятки 429 подряд от справок
 * (сбор 22.10). Каждый источник лечился по-своему, а скачивание картинок,
 * карточки LOC и темы файлов Commons не лечились вовсе: после отказа шёл
 * следующий запрос к тому же серверу, и бан только продлевался.
 *
 * Хост считаем по семейству доменов (последние две части имени): у
 * loc.gov поиск и картинки (tile.loc.gov) режутся вместе, у Википедии -
 * все языковые разделы.
 */

/** Сколько отказов 429 подряд выдерживаем, прежде чем оставить хост в покое. */
const STRIKES_TO_BLOCK = 2;

const strikes = new Map<string, number>();
const blocked = new Set<string>();

/** Семейство хоста: «tile.loc.gov» → «loc.gov», «ru.wikipedia.org» → «wikipedia.org». */
export function hostFamily(url: string | URL): string {
  let host: string;
  try {
    host = (typeof url === "string" ? new URL(url) : url).hostname.toLowerCase();
  } catch {
    return "";
  }
  return host.split(".").slice(-2).join(".");
}

/** Отдыхает ли хост до конца прогона. */
export function isBlocked(url: string | URL): boolean {
  const family = hostFamily(url);
  return Boolean(family) && blocked.has(family);
}

/**
 * Хост ответил 429. `now: true` - блокировать сразу (loc.gov держит бан
 * часами, повтор лишь продлевает его); иначе - после серии отказов.
 * Возвращает true, если хост теперь отдыхает.
 */
export function noteRateLimit(url: string | URL, opts: { now?: boolean } = {}): boolean {
  const family = hostFamily(url);
  if (!family) return false;
  const n = (strikes.get(family) ?? 0) + 1;
  strikes.set(family, n);
  if (opts.now || n >= STRIKES_TO_BLOCK) {
    if (!blocked.has(family)) {
      console.warn(`  ${family}: лимит запросов (429) - до конца прогона больше не обращаемся`);
    }
    blocked.add(family);
  }
  return blocked.has(family);
}

/** Успешный ответ сбрасывает счёт отказов подряд. */
export function noteOk(url: string | URL): void {
  const family = hostFamily(url);
  if (family) strikes.delete(family);
}

/** Для тестов: забыть всё. */
export function resetHostGuard(): void {
  strikes.clear();
  blocked.clear();
}
