/**
 * Меню бота: экраны и кнопки (редакция 15.11: «бот должен быть
 * передовым: нативное меню на кнопках, а не команды; текст не ИИ»).
 *
 * Как устроено:
 * - внизу чата постоянная клавиатура из четырёх кнопок (MAIN_KEYBOARD):
 *   «Сводка», «Очередь», «Резерв», «Настройки»;
 * - нажатие открывает панель - одно сообщение, которое дальше меняется
 *   на месте: разделы, пост, назад. Чат не засыпается ответами;
 * - команды остались запасным путём, но знать их не нужно.
 *
 * Правила текста (редакция): по-человечески, коротко, без канцелярита и
 * восклицаний, без эмодзи и капса. Вместо дефиса в роли тире - знак
 * минус «−». Дефис внутри слов («из-за», «кто-то») остаётся дефисом.
 *
 * Файл без импортов: собирается и Deno (вебхук), и Node (тесты).
 */

/** Знак минус - им в меню пишется тире. */
export const DASH = "−";

/**
 * Тире в служебном тексте - знаком минус: « - » → « − », строка-пункт
 * «- текст» → «− текст». Дефис внутри слов («из-за») не трогается.
 */
export function humanDashes(text: string): string {
  return text.replace(/(^|\n)- /g, "$1− ").replace(/ - /g, " − ");
}

/** Тексты кнопок нижней клавиатуры - по ним бот узнаёт нажатие. */
export const MENU_BUTTONS = {
  home: "Сводка",
  queue: "Очередь",
  reserve: "Резерв",
  settings: "Настройки",
} as const;

export type MenuButton = keyof typeof MENU_BUTTONS;

/** Какой раздел открыть по тексту кнопки; undefined - это не кнопка меню. */
export function menuByText(text: string | undefined): MenuButton | undefined {
  const t = (text ?? "").trim();
  return (Object.keys(MENU_BUTTONS) as MenuButton[]).find((k) => MENU_BUTTONS[k] === t);
}

/** Постоянная клавиатура внизу чата. */
export const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: MENU_BUTTONS.home }, { text: MENU_BUTTONS.queue }],
    [{ text: MENU_BUTTONS.reserve }, { text: MENU_BUTTONS.settings }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Ответьте на карточку, чтобы поправить подпись",
};

type Button = { text: string; callback_data?: string; url?: string };
export type Screen = { text: string; keyboard: { inline_keyboard: Button[][] } };

const cb = (text: string, data: string): Button => ({ text, callback_data: data });

/** Склонение: 1 пост, 2 поста, 5 постов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Первая строка подписи без разметки, обрезанная по слову. */
export function shortTitle(captionHtml: string | null | undefined, max = 60): string {
  const line =
    (captionHtml ?? "")
      .replace(/<blockquote[^>]*>[\s\S]*$/, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .split("\n")
      .find((l) => l.trim()) ?? "";
  const clean = line.trim().replace(/\s+/g, " ");
  if (clean.length <= max) return clean || "без подписи";
  const cut = clean.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : max).trim()}…`;
}

// ---------- сводка ----------

export type HomeData = {
  publishedToday: number;
  slotsToday: number;
  times: string[];
  nextPost?: { when: string; title: string };
  ready: number;
  stale: number;
  lastRun?: { when: string; analyzed: number; written: number };
  autoOn: boolean;
  /** типы сюжетов за неделю (_shared/story.ts): «своё 5, человек 3...» */
  storyWeek?: string;
  /** что сломалось: каждая строка - готовая фраза */
  alerts: string[];
};

export function homeScreen(d: HomeData): Screen {
  const perDay = Math.max(1, d.times.length);
  const days = Math.floor(d.ready / perDay);
  const lines: string[] = [];
  lines.push("<b>Лента</b>");
  lines.push(`Сегодня вышло ${d.publishedToday} из ${d.slotsToday}. Слоты ${d.times.join(", ")}.`);
  lines.push(
    d.nextPost
      ? `Следующий пост ${d.nextPost.when}: ${d.nextPost.title}`
      : "Следующего поста нет: очередь пуста.",
  );
  lines.push(
    `Готово к выходу ${d.ready} ${plural(d.ready, "пост", "поста", "постов")}` +
      (d.ready ? `, хватит на ${days} ${plural(days, "день", "дня", "дней")}.` : "."),
  );
  if (d.stale) {
    lines.push(`Ещё ${d.stale} ${plural(d.stale, "лежит", "лежат", "лежат")} дольше двух недель и сами не выйдут.`);
  }
  lines.push("");
  lines.push("<b>Сбор</b>");
  lines.push(
    d.lastRun
      ? `${d.lastRun.when} разобрано ${d.lastRun.analyzed}, в резерв ${d.lastRun.written}.`
      : "Сборов ещё не было.",
  );
  if (d.storyWeek) {
    lines.push("");
    lines.push("<b>Сюжеты за неделю</b>");
    lines.push(d.storyWeek);
  }
  lines.push("");
  lines.push(
    d.autoOn
      ? "Автопостинг включён: всё, что не удалено, выходит само."
      : "Автопостинг выключен: выходят только посты «следующим» и на время.",
  );
  if (d.alerts.length) {
    lines.push("");
    lines.push("<b>Обратите внимание</b>");
    for (const a of d.alerts) lines.push(a);
  }
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [cb("Очередь", "m:queue"), cb("Резерв", "m:res:0")],
        [cb("Вышедшие", "m:pub"), cb("Собрать ещё", "m:more")],
        [cb("Настройки", "m:set"), cb("Обновить", "m:home")],
      ],
    },
  };
}

// ---------- списки ----------

export type ListItem = { id: number; when?: string; title: string; mark?: string };

/** Ряд кнопок с номерами: «1 2 3 4 5». */
function numberRow(items: ListItem[], from: string): Button[][] {
  const row = items.map((it, i) => cb(String(i + 1), `m:item:${it.id}:${from}`));
  // больше пяти в ряд Телеграм рисует тесно
  return row.length > 5 ? [row.slice(0, 5), row.slice(5)] : row.length ? [row] : [];
}

export function queueScreen(items: ListItem[], autoOn: boolean): Screen {
  if (!items.length) {
    return {
      text:
        "<b>Очередь</b>\n" +
        (autoOn
          ? "Пусто: резерв кончился. Утренний сбор наполнит его сам, можно и ускорить."
          : "Пусто. Автопостинг выключен, а постов «следующим» и на время нет."),
      keyboard: { inline_keyboard: [[cb("Собрать ещё", "m:more")], [cb("Назад", "m:home")]] },
    };
  }
  const lines = items.map(
    (it, i) => `${i + 1}. ${it.when ?? ""}${it.mark ? ` (${it.mark})` : ""}\n${it.title}`,
  );
  return {
    text: `<b>Очередь</b>\nЧто выйдет ближайшим, по порядку.\n\n${lines.join("\n\n")}\n\nОткройте пост по номеру.`,
    keyboard: { inline_keyboard: [...numberRow(items, "q"), [cb("Назад", "m:home")]] },
  };
}

export const RESERVE_PAGE = 6;

export function reserveScreen(items: ListItem[], page: number, total: number, stale: number): Screen {
  const pages = Math.max(1, Math.ceil(total / RESERVE_PAGE));
  if (!items.length) {
    return {
      text: "<b>Резерв</b>\nПусто. Утренний сбор наполнит его сам.",
      keyboard: { inline_keyboard: [[cb("Собрать ещё", "m:more")], [cb("Назад", "m:home")]] },
    };
  }
  const lines = items.map((it, i) => `${i + 1}. ${it.title}${it.mark ? `\n${it.mark}` : ""}`);
  const nav: Button[] = [];
  if (page > 0) nav.push(cb("‹ Раньше", `m:res:${page - 1}`));
  if (page + 1 < pages) nav.push(cb("Дальше ›", `m:res:${page + 1}`));
  const head =
    `<b>Резерв</b> ${DASH} ${total} ${plural(total, "пост", "поста", "постов")}` +
    (pages > 1 ? `, страница ${page + 1} из ${pages}` : "") +
    "\nЛучшие по оценке сверху. Всё, что здесь лежит, выйдет само, если не удалить." +
    (stale ? `\nСтарше двух недель: ${stale}, такие сами уже не выходят.` : "");
  return {
    text: `${head}\n\n${lines.join("\n\n")}`,
    keyboard: {
      inline_keyboard: [
        ...numberRow(items, `r${page}`),
        ...(nav.length ? [nav] : []),
        [cb("Назад", "m:home")],
      ],
    },
  };
}

export function publishedScreen(items: ListItem[]): Screen {
  if (!items.length) {
    return { text: "<b>Вышедшие</b>\nПока ничего не вышло.", keyboard: { inline_keyboard: [[cb("Назад", "m:home")]] } };
  }
  const lines = items.map((it, i) => `${i + 1}. ${it.when ?? ""}\n${it.title}`);
  return {
    text: `<b>Вышедшие</b>\nПоследние посты в канале.\n\n${lines.join("\n\n")}`,
    keyboard: { inline_keyboard: [...numberRow(items, "p"), [cb("Назад", "m:home")]] },
  };
}

// ---------- пост ----------

export type ItemData = {
  id: number;
  title: string;
  status: string;
  /** «выйдет сегодня в 14:00», «вышел 14.11 в 16:05» */
  whenLine?: string;
  score?: number | null;
  ageLine?: string;
  stale?: boolean;
  scheduled?: boolean;
  channelUrl?: string;
};

/** Куда вернуться из карточки поста: q - очередь, rN - страница резерва, p - вышедшие. */
export function backFor(from: string): string {
  if (from === "q") return "m:queue";
  if (from === "p") return "m:pub";
  const page = Number(from.replace(/^r/, ""));
  return `m:res:${Number.isFinite(page) ? page : 0}`;
}

export function itemScreen(d: ItemData, from: string): Screen {
  const back = cb("Назад", backFor(from));
  const facts = [
    d.score !== undefined && d.score !== null ? `оценка ${d.score}` : "",
    d.ageLine ?? "",
  ].filter(Boolean);
  const lines = [`<b>Пост ${d.id}</b>`, d.title];
  if (d.whenLine) lines.push("", d.whenLine);
  if (facts.length) lines.push(facts.join(", "));
  if (d.stale && !d.scheduled) lines.push("Лежит дольше двух недель, сам уже не выйдет.");

  if (d.status === "published") {
    const row: Button[] = [];
    if (d.channelUrl) row.push({ text: "Открыть в канале", url: d.channelUrl });
    row.push(cb("Удалить из канала", `m:delask:${d.id}:${from}`));
    return { text: lines.join("\n"), keyboard: { inline_keyboard: [row, [back]] } };
  }
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [cb("Показать как в канале", `show:${d.id}`)],
        [cb("Опубликовать сейчас", `m:now:${d.id}:${from}`), cb("На время", `m:when:${d.id}:${from}`)],
        [cb("Следующим", `m:next:${d.id}:${from}`), cb("Удалить", `m:drop:${d.id}:${from}`)],
        [back],
      ],
    },
  };
}

/** Выбор времени прямо в панели. */
export function whenScreen(
  id: number,
  title: string,
  slots: Array<{ label: string; iso: string }>,
  from: string,
): Screen {
  const rows: Button[][] = [];
  for (let i = 0; i < slots.length; i += 2) {
    rows.push(
      slots.slice(i, i + 2).map((s) => cb(s.label, `m:at:${id}:${from}:${s.iso.slice(0, 16)}`)),
    );
  }
  rows.push([cb("Отмена", `m:item:${id}:${from}`)]);
  return { text: `<b>Пост ${id}</b>\n${title}\n\nКогда выпустить? Время московское.`, keyboard: { inline_keyboard: rows } };
}

/** Подтверждение удаления из канала - необратимо, поэтому спрашиваем. */
export function deleteAskScreen(id: number, title: string, from: string): Screen {
  return {
    text: `<b>Пост ${id}</b>\n${title}\n\nУдалить его из канала? Вернуть потом не получится.`,
    keyboard: {
      inline_keyboard: [
        [cb("Да, удалить", `m:delyes:${id}:${from}`), cb("Нет", `m:item:${id}:${from}`)],
      ],
    },
  };
}

// ---------- настройки ----------

export type SettingsData = { autoOn: boolean; times: string[]; tidyHours: number };

export function settingsScreen(d: SettingsData): Screen {
  const tidy = d.tidyHours
    ? `Служебные сообщения бота удаляются через ${d.tidyHours} ${plural(d.tidyHours, "час", "часа", "часов")}.`
    : "Служебные сообщения бота не удаляются.";
  const text = [
    "<b>Настройки</b>",
    d.autoOn
      ? "Автопостинг включён: всё, что собрано и не удалено, выходит само по расписанию."
      : "Автопостинг выключен: выходят только посты «следующим» и на время.",
    `Расписание: ${d.times.join(", ")} по Москве.`,
    tidy,
  ].join("\n\n");
  return {
    text,
    keyboard: {
      inline_keyboard: [
        [cb(d.autoOn ? "Выключить автопостинг" : "Включить автопостинг", d.autoOn ? "m:auto:off" : "m:auto:on")],
        [cb("Расписание", "m:sched"), cb("Очистка чата", "m:tidy")],
        [cb("Назад", "m:home")],
      ],
    },
  };
}

export function tidyScreen(hours: number): Screen {
  const opt = (h: number, label: string) => cb((hours === h ? "· " : "") + label, `m:tidyset:${h}`);
  return {
    text:
      "<b>Очистка чата</b>\n" +
      "Через сколько удалять служебные сообщения бота. Карточки постов и сам канал это не трогает.",
    keyboard: {
      inline_keyboard: [
        [opt(0, "Не удалять"), opt(1, "1 час")],
        [opt(6, "6 часов"), opt(24, "24 часа")],
        [cb("Назад", "m:set")],
      ],
    },
  };
}

/** Короткие ответы на нажатия (всплывашки) - тоже живым языком. */
export const TOAST = {
  published: "Опубликовано",
  next: "Выйдет следующим",
  dropped: "Удалено, в канал не выйдет",
  gone: "Этот пост уже обработан",
  deleted: "Удалено из канала",
  collecting: "Сбор запущен, новые посты появятся минут через двадцать",
  collectFailed: "Сбор не запустился",
  autoOn: "Автопостинг включён",
  autoOff: "Автопостинг выключен",
  saved: "Сохранено",
} as const;
