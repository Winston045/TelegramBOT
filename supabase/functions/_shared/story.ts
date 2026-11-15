/**
 * Тип сюжета поста - «про что» он, а не «откуда» (редакция 15.11).
 *
 * Разбор 60 постов: источников около сорока, а лента однообразна -
 * военные сюжеты 88%, крючок «действие» 48%, «человек» 15%. Правила ленты
 * чередовали архивы, страны и эпохи, но почти каждый архив - это
 * «солдаты на войне», и сорок источников давали сорок вариаций одного
 * сюжета. Тип сюжета ставит модель при анализе (по смыслу подписи, а не
 * по технике в кадре); по нему видно перекос, а дальше - сетка ленты и
 * сбор под заказ.
 *
 * «Своё» (СССР) и «цвет эпохи» отдельными типами не размечаются: страна
 * поста и подлинный цвет у бота уже есть, счётчик берёт их оттуда.
 *
 * Файл без импортов: общий для Node и Deno.
 */

export type StoryType = {
  key: string;
  /** как тип называется в сводке */
  label: string;
  /** определение для модели */
  hint: string;
};

export const STORY_TYPES: StoryType[] = [
  {
    key: "human",
    label: "человек",
    hint: "судьба конкретного человека в кадре: кто он, что с ним было",
  },
  {
    key: "twist",
    label: "поворот",
    hint: "за кадром неожиданная развязка или ирония, которую раскрывает изюминка",
  },
  {
    key: "oddity",
    label: "диковина",
    hint: "странная техника, курьёз, редкость, которую не ждёшь увидеть",
  },
  {
    key: "disaster",
    label: "катастрофа",
    hint: "обломки, крушение, взрыв, разрушенный город или корабль",
  },
  {
    key: "landmark",
    label: "событие",
    hint: "знаковое событие, которое знают все, - с неожиданной стороны",
  },
  {
    key: "daily",
    label: "быт",
    hint: "тыл, улица, жизнь вокруг войны, повседневность эпохи",
  },
  {
    key: "science",
    label: "рекорды",
    hint: "наука, космос, полярные экспедиции, первые полёты и рекорды",
  },
  {
    key: "poster",
    label: "плакат",
    hint: "плакат, карикатура, документ эпохи",
  },
  {
    key: "service",
    label: "будни армии",
    hint: "обычная служба или бой без отдельной истории: солдаты, техника, учения",
  },
];

const KEYS = new Set(STORY_TYPES.map((t) => t.key));

/** Ключ типа из ответа модели; незнакомое - undefined. */
export function normalizeStory(value: unknown): string | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return KEYS.has(v) ? v : undefined;
}

/** Строка схемы JSON для промпта анализа. */
export const STORY_SCHEMA = `"story": "<тип сюжета поста: ${STORY_TYPES.map((t) => `"${t.key}"`).join(" | ")}>"`;

/** Определения типов для промпта. */
export function storyGuide(): string {
  return STORY_TYPES.map((t) => `- ${t.key}: ${t.hint}`).join("\n");
}

export type StoryRow = {
  story?: string;
  /** страна поста (postNation): «ussr» считается как «своё» */
  nation?: string;
  color?: boolean;
};

/**
 * Счётчик для сводки: «своё 5, человек 3, поворот 2, будни армии 9...».
 * «Своё» и «цвет» идут поверх типа сюжета: советский кадр одновременно
 * и «своё», и, например, «человек».
 */
export function storyTally(rows: StoryRow[]): { parts: Array<[string, number]>; unknown: number } {
  const counts = new Map<string, number>();
  let unknown = 0;
  let home = 0;
  let color = 0;
  for (const r of rows) {
    if (r.nation === "ussr") home++;
    if (r.color) color++;
    const key = normalizeStory(r.story);
    if (!key) {
      unknown++;
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts: Array<[string, number]> = [["своё", home]];
  for (const t of STORY_TYPES) parts.push([t.label, counts.get(t.key) ?? 0]);
  parts.push(["цвет", color]);
  return { parts, unknown };
}

/** Одна строка для сводки; пустые типы тоже видны - их и не хватает. */
export function storyLine(rows: StoryRow[]): string {
  const { parts, unknown } = storyTally(rows);
  const body = parts.map(([label, n]) => `${label} ${n}`).join(", ");
  return unknown ? `${body} (без разметки ${unknown})` : body;
}
