/**
 * Панель расписания публикаций в чате редакторов: текст и клавиатуры.
 * Без импортов - модуль общий для Node (тесты) и Deno (вебхук).
 *
 * Формат callback_data (свои префиксы, не пересекаются с ok/skip/re/...):
 *   tdel:HHMM - убрать слот      tadd - выбор часа нового слота
 *   th:H      - час выбран, к минутам      tset:HHMM - добавить слот
 *   tback     - назад к панели   tclose - закрыть панель
 */

export type Button = { text: string; callback_data: string };

/** Максимум слотов в день - защита от случайного спама расписанием. */
export const MAX_SLOTS = 12;

export function isValidTime(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Оставить корректные, убрать дубли, отсортировать. */
export function normalizeTimes(times: unknown): string[] {
  if (!Array.isArray(times)) return [];
  const valid = times.filter((t): t is string => typeof t === "string" && isValidTime(t));
  return [...new Set(valid)].sort();
}

/** "09:00" → "0900" для callback_data (двоеточие там разделитель). */
export function packTime(t: string): string {
  return t.replace(":", "");
}

export function unpackTime(packed: string): string | undefined {
  const m = packed.match(/^(\d{2})(\d{2})$/);
  if (!m) return undefined;
  const t = `${m[1]}:${m[2]}`;
  return isValidTime(t) ? t : undefined;
}

export function schedulePanelText(times: string[]): string {
  const lines = [
    "Расписание публикаций (время МСК)",
    "",
    `Постов в день: ${times.length}`,
    ...times.map((t, i) => `${i + 1}. ${t}`),
    "",
    "Убрать слот или добавить новый - кнопками ниже.",
  ];
  return lines.join("\n");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Главная клавиатура панели: убрать каждый слот, добавить, закрыть. */
export function panelKeyboard(times: string[]): Button[][] {
  const removeButtons = times.map((t) => ({
    text: `Убрать ${t}`,
    callback_data: `tdel:${packTime(t)}`,
  }));
  const rows = chunk(removeButtons, 3);
  rows.push([
    { text: "Добавить время", callback_data: "tadd" },
    { text: "Готово", callback_data: "tclose" },
  ]);
  return rows;
}

/** Выбор часа нового слота: 24 кнопки рядами по 6. */
export function hourKeyboard(): Button[][] {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    text: String(h).padStart(2, "0"),
    callback_data: `th:${h}`,
  }));
  const rows = chunk(hours, 6);
  rows.push([{ text: "Назад", callback_data: "tback" }]);
  return rows;
}

/** Выбор минут для выбранного часа. */
export function minuteKeyboard(hour: number): Button[][] {
  const hh = String(hour).padStart(2, "0");
  const row = ["00", "10", "20", "30", "40", "50"].map((mm) => ({
    text: `${hh}:${mm}`,
    callback_data: `tset:${hh}${mm}`,
  }));
  return [row, [{ text: "Назад", callback_data: "tadd" }]];
}
