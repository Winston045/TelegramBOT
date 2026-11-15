import { describe, expect, it } from "vitest";
import {
  DASH,
  MAIN_KEYBOARD,
  backFor,
  deleteAskScreen,
  homeScreen,
  humanDashes,
  itemScreen,
  menuByText,
  plural,
  publishedScreen,
  queueScreen,
  reserveScreen,
  settingsScreen,
  shortTitle,
  tidyScreen,
  whenScreen,
  type Screen,
} from "../src/menu.js";
import { panelKeyboard, schedulePanelText } from "../supabase/functions/_shared/schedule_panel.js";

const home: Screen = homeScreen({
  publishedToday: 1,
  slotsToday: 3,
  times: ["12:00", "14:00", "16:00"],
  nextPost: { when: "сегодня 14:00", title: "Морпехи на наблюдательном пункте" },
  ready: 18,
  stale: 2,
  lastRun: { when: "15.11, 11:05", analyzed: 22, written: 10 },
  autoOn: true,
  alerts: ["Пропущен слот: вышло 1 из 2"],
});
const items = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 700 + i, when: "сегодня 14:00", title: `Пост ${i}`, mark: "оценка 70" }));
const screens: Screen[] = [
  home,
  queueScreen(items.slice(0, 5), true),
  queueScreen([], true),
  queueScreen([], false),
  reserveScreen(items, 0, 14, 3),
  reserveScreen(items, 2, 14, 0),
  reserveScreen([], 0, 0, 0),
  publishedScreen(items.slice(0, 5)),
  publishedScreen([]),
  itemScreen({ id: 712, title: "Пост", status: "shown", statusLine: "в резерве", score: 65, age: "1 день назад", stale: true }, "r0"),
  itemScreen({ id: 712, title: "Пост", status: "published", statusLine: "вышел 14.11, 16:05", channelUrl: "https://t.me/Story_Teams/7213" }, "p"),
  whenScreen(712, "Пост", [{ label: "15.11 14:00", iso: "2026-11-15T14:00:00+03:00" }], "q"),
  deleteAskScreen(712, "Пост", "p"),
  settingsScreen({ autoOn: true, times: ["12:00", "14:00", "16:00"], tidyHours: 6 }),
  settingsScreen({ autoOn: false, times: ["12:00"], tidyHours: 0 }),
  tidyScreen(6),
  { text: schedulePanelText(["12:00", "14:00"]), keyboard: { inline_keyboard: panelKeyboard(["12:00", "14:00"]) } },
];

describe("меню: стиль текста (редакция 15.11)", () => {
  it("ни одного дефиса в роли тире и ни одного эмодзи", () => {
    for (const s of screens) {
      expect(s.text).not.toMatch(/ - |\n- /);
      expect(s.text).not.toMatch(/\p{Extended_Pictographic}/u);
      for (const b of s.keyboard.inline_keyboard.flat()) {
        expect(b.text).not.toMatch(/ - /);
        expect(b.text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("без капса и канцелярита старой сводки", () => {
    const all = screens.map((s) => s.text).join("\n");
    expect(all).not.toMatch(/СВОДКА|ВКЛЮЧЁН|Требует внимания|Запас хода/);
  });

  it("интерфейс, а не собеседник: без обращений, уговоров и восклицаний (редакция 15.11)", () => {
    // первая версия меню говорила фразами чат-бота: «Откройте пост по
    // номеру», «Всё, что здесь лежит, выйдет само, если не удалить»
    const all = screens.map((s) => s.text.replace(/<[^>]+>/g, "")).join("\n");
    expect(all).not.toMatch(/откройте|нажмите|выберите|стоит|можно|если не|обратите|\bвы\b|\bвас\b|!/i);
    // строки короткие: поле и значение, не абзацы (заголовки постов - исключение)
    for (const line of all.split("\n")) {
      if (/^(Пост|\d+\.)/.test(line) || line.length < 3) continue;
      expect(line.length).toBeLessThanOrEqual(90);
    }
  });

  it("сводка - поля со значениями", () => {
    expect(home.text).toContain("Сегодня: 1 из 3 (12:00, 14:00, 16:00)");
    expect(home.text).toContain("Готово: 18, запас 6 дн.");
    expect(home.text).toContain("Просрочено: 2");
    expect(home.text).toContain("Автопостинг: вкл");
    expect(home.text).toContain("Разобрано: 22, в резерв: 10");
    expect(home.text).toContain("<b>Неполадки</b>");
  });

  it("тире в служебных сообщениях превращается в минус, дефис в словах остаётся", () => {
    expect(humanDashes("Сбор прошёл - смотрите /status")).toBe(`Сбор прошёл ${DASH} смотрите /status`);
    expect(humanDashes("Итог:\n- партия мала\n- сито строгое")).toBe(`Итог:\n${DASH} партия мала\n${DASH} сито строгое`);
    expect(humanDashes("из-за погоды")).toBe("из-за погоды");
  });

  it("склонения", () => {
    expect(plural(1, "пост", "поста", "постов")).toBe("пост");
    expect(plural(3, "пост", "поста", "постов")).toBe("поста");
    expect(plural(11, "пост", "поста", "постов")).toBe("постов");
    expect(plural(21, "пост", "поста", "постов")).toBe("пост");
  });
});

describe("меню: кнопки", () => {
  it("данные кнопок укладываются в лимит Телеграма (64 байта)", () => {
    const long = whenScreen(123456, "Пост", [{ label: "31.12 23:50", iso: "2026-12-31T23:50:00+03:00" }], "r12");
    for (const s of [...screens, long]) {
      for (const b of s.keyboard.inline_keyboard.flat()) {
        if (b.callback_data) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      }
    }
  });

  it("нижняя клавиатура: четыре раздела, бот узнаёт нажатие по тексту", () => {
    const texts = MAIN_KEYBOARD.keyboard.flat().map((b) => b.text);
    expect(texts).toEqual(["Сводка", "Очередь", "Резерв", "Настройки"]);
    expect(menuByText("Резерв")).toBe("reserve");
    expect(menuByText(" Сводка ")).toBe("home");
    expect(menuByText("привет")).toBeUndefined();
  });

  it("пост в резерве: показать, сейчас, на время, следующим, удалить, назад на ту же страницу", () => {
    const s = itemScreen({ id: 712, title: "Пост", status: "shown" }, "r2");
    const data = s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toEqual(["show:712", "m:now:712:r2", "m:when:712:r2", "m:next:712:r2", "m:drop:712:r2", "m:res:2"]);
    expect(s.text).toContain("Пост #712");
  });

  it("вышедший пост: ссылка в канал и удаление только через подтверждение", () => {
    const s = itemScreen({ id: 712, title: "Пост", status: "published", channelUrl: "https://t.me/x/1" }, "p");
    const buttons = s.keyboard.inline_keyboard.flat();
    expect(buttons[0]?.url).toBe("https://t.me/x/1");
    expect(buttons[1]?.callback_data).toBe("m:delask:712:p");
    const ask = deleteAskScreen(712, "Пост", "p").keyboard.inline_keyboard.flat();
    expect(ask.map((b) => b.callback_data)).toEqual(["m:delyes:712:p", "m:item:712:p"]);
  });

  it("листание резерва: «раньше» и «дальше» только где есть куда", () => {
    const first = reserveScreen(items, 0, 14, 0).keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(first).toContain("m:res:1");
    expect(first).not.toContain("m:res:-1");
    const last = reserveScreen(items.slice(0, 2), 2, 14, 0).keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(last).toContain("m:res:1");
    expect(last).not.toContain("m:res:3");
  });

  it("назад: очередь, вышедшие, страница резерва", () => {
    expect(backFor("q")).toBe("m:queue");
    expect(backFor("p")).toBe("m:pub");
    expect(backFor("r3")).toBe("m:res:3");
  });

  it("заголовок поста - первая строка без цитаты и разметки, обрезка по слову", () => {
    const html = "Советские морпехи на наблюдательном пункте у берега освобождённого Севастополя.\n<blockquote>Севастополь, 1944 год.</blockquote>";
    const t = shortTitle(html, 40);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toContain("1944");
    expect(shortTitle("<b>Танк &amp; экипаж</b>")).toBe("Танк & экипаж");
  });
});
