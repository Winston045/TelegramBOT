/**
 * Логика слотов публикации.
 *
 * GitHub-крон приходит с опозданием и иногда пропускает запуски, поэтому
 * «наступил ли слот» считаем не по точному времени, а самовосстанавливающимся
 * правилом: опубликовано сегодня меньше, чем слотов уже прошло → пора
 * публиковать. Пропущенный запуск догоняется следующим.
 */

/** "2026-07-26" в нужной таймзоне. */
export function tzDateString(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Минут с полуночи в нужной таймзоне. */
export function tzMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function slotToMinutes(slot: string): number {
  const [h, m] = slot.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Сколько слотов из times уже наступило сегодня (в таймзоне tz). */
export function slotsPassed(now: Date, times: string[], tz: string): number {
  const current = tzMinutes(now, tz);
  return times.filter((t) => slotToMinutes(t) <= current).length;
}

export function shouldPublishNow(
  now: Date,
  times: string[],
  tz: string,
  publishedToday: number,
): boolean {
  return publishedToday < slotsPassed(now, times, tz);
}

/** Считает, сколько из published_at (ISO-строки) приходится на «сегодня» в tz. */
export function countPublishedToday(
  publishedAt: (string | null)[],
  now: Date,
  tz: string,
): number {
  const today = tzDateString(now, tz);
  return publishedAt.filter((ts) => ts && tzDateString(new Date(ts), tz) === today)
    .length;
}
