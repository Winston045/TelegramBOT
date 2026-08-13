/**
 * Вебхук бота (Supabase Edge Function, Deno + grammY) - админ-панель в чате.
 *
 * Кнопки под карточками: Одобрить / Мимо. В очереди: Сейчас / Убрать.
 * У опубликованных: Удалить из канала.
 *
 * Команды (только вайтлист EDITOR_USER_IDS, остальных молча игнорируем):
 *   /status           - сводка для админа: запас хода, ближайший пост, слоты,
 *                       итог последнего сбора, крючки резерва, режимы.
 *                       Блок «Требует внимания» появляется только при беде
 *   /queue            - план публикаций: что и когда выйдет, с кнопками
 *                       (одобренное и то, что выберет автопостинг)
 *   /schedule         - панель расписания: слоты и число постов (МСК)
 *   /auto             - тумблер полной автоматизации (посты без одобрения)
 *   /tidy             - автоочистка чата: служебные ответы бота удаляются
 *                       через выбранное время (выкл / 1 / 6 / 24 ч)
 *   /published        - последние вышедшие с кнопками удаления
 *   /ok, /skip        - то же, что кнопки (реплаем на карточку)
 *   /quote <текст>    - заменить цитату (реплаем)
 *   текст реплаем     - заменить подпись целиком
 *   /undo             - удалить последний опубликованный
 *
 * Деплой: workflow deploy-webhook (ставит и вебхук с callback_query).
 */
// не npm: - свежие бандлы с npm-зависимостями переставали подниматься
// (июльский инцидент: health отвечал, любая функция с npm: висла);
// deno.land/x и jsr идут другим пайплайном и грузятся стабильно
import { Bot, webhookCallback } from "https://deno.land/x/grammy@v1.45.1/mod.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { entitiesToHtml } from "../_shared/entities.ts";
import { parseCandidateId } from "../_shared/service_line.ts";
import { replaceBody, replaceQuote } from "../_shared/edit_caption.ts";
import { CAPTION_LIMIT, validateHtml, visibleLength } from "../_shared/validate.ts";
import {
  LONG_QUOTE,
  RECENT_WINDOW,
  archiveKey,
  buildPlan,
  headline,
  quoteLength,
  type PlanEntry,
  type PlanTags,
} from "../_shared/plan.ts";
import {
  MAX_SLOTS,
  hourKeyboard,
  minuteKeyboard,
  normalizeTimes,
  panelKeyboard,
  schedulePanelText,
  unpackTime,
} from "../_shared/schedule_panel.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`переменная окружения ${name} не задана`);
  return v;
}

/** Тестовый режим: одобрение публикует сразу, минуя очередь и слоты. */
const INSTANT_PUBLISH = (Deno.env.get("INSTANT_PUBLISH") ?? "").trim() === "true";

/** Слоты публикации по умолчанию (из config.yaml при деплое) и таймзона канала. */
const DEFAULT_TIMES = (Deno.env.get("PUBLISH_TIMES") ?? "09:00,12:30,15:00,18:00,21:00")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TZ_OFFSET = (Deno.env.get("PUBLISH_TZ_OFFSET") ?? "+03:00").trim();

/** GH_PAT + GH_REPO + GH_BRANCH - для /more: запуск сбора через Actions. */
const GH_PAT = Deno.env.get("GH_PAT")?.trim();
const GH_REPO = Deno.env.get("GH_REPO")?.trim() ?? "Winston045/TelegramBOT";
const GH_BRANCH = Deno.env.get("GH_BRANCH")?.trim() ?? "claude/starting-work-tpehs7";

/** Времена публикации: настройка из бота перекрывает config.yaml. */
async function getPublishTimes(): Promise<string[]> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", "publish_times")
    .maybeSingle();
  if (error || !data) return DEFAULT_TIMES;
  const times = normalizeTimes(data.value);
  return times.length ? times : DEFAULT_TIMES;
}

/** Тумблер полной автоматизации: посты уходят в канал без одобрения. */
async function getAutoPublish(): Promise<boolean> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", "auto_publish")
    .maybeSingle();
  if (error || !data) return false;
  return data.value === true;
}

async function setAutoPublish(on: boolean): Promise<void> {
  const { error } = await db.from("settings").upsert({
    key: "auto_publish",
    value: on,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`сохранение auto_publish: ${error.message}`);
}

function autoPanelText(on: boolean): string {
  return on
    ? "Автопостинг ВКЛЮЧЁН: посты уходят в канал по расписанию без одобрения.\n" +
        "Карточки в чат приходят как обычно - кнопкой 'Мимо' можно снять кандидата до публикации."
    : "Автопостинг выключен: в канал уходят только одобренные посты.";
}

function autoPanelKeyboard(on: boolean) {
  return {
    inline_keyboard: [
      [
        on
          ? { text: "Выключить автопостинг", callback_data: "aoff" }
          : { text: "Включить автопостинг", callback_data: "aon" },
      ],
    ],
  };
}

async function savePublishTimes(times: string[]): Promise<void> {
  const { error } = await db.from("settings").upsert({
    key: "publish_times",
    value: times,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`сохранение расписания: ${error.message}`);
}

/** Ближайшие слоты публикации: [{label: "28.07 09:00", iso}]. */
function upcomingSlots(count: number, times: string[]): Array<{ label: string; iso: string }> {
  const out: Array<{ label: string; iso: string }> = [];
  const now = Date.now();
  for (let day = 0; day < 3 && out.length < count; day++) {
    const d = new Date(now + day * 24 * 3600 * 1000);
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
    for (const t of times) {
      const iso = `${ymd}T${t}:00${TZ_OFFSET}`;
      const ts = new Date(iso).getTime();
      if (ts > now + 60_000 && out.length < count) {
        const [, m, dd] = ymd.split("-");
        out.push({ label: `${dd}.${m} ${t}`, iso });
      }
    }
  }
  return out;
}

// grammY перед первым апдейтом зовёт getMe; когда api.telegram.org
// недоступен из сети Supabase (было 27.07), этот вызов висит без таймаута
// и вешает весь воркер. Identity бота задаём заранее (BOT_INFO кладёт
// деплой, зашитое значение - запасной вариант), вызовам API - таймаут.
const FALLBACK_BOT_INFO = {
  id: 8845582261,
  is_bot: true as const,
  first_name: "Тея",
  username: "V1story_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};
const botInfo = (() => {
  try {
    return JSON.parse(Deno.env.get("BOT_INFO") ?? "") ?? FALLBACK_BOT_INFO;
  } catch {
    return FALLBACK_BOT_INFO;
  }
})();
const bot = new Bot(requireEnv("BOT_TOKEN"), {
  botInfo,
  client: { timeoutSeconds: 25 },
});
// имена с префиксом SUPABASE_ в secrets функций зарезервированы, поэтому
// свой ключ туда не положить - берём служебный, он всегда есть в среде
const db = createClient(
  requireEnv("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SECRET_KEY") ?? requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);
const CHANNEL_ID = requireEnv("CHANNEL_ID");
const CHANNEL_SLUG = CHANNEL_ID.replace(/^@/, "");
const EDITORS = new Set(
  requireEnv("EDITOR_USER_IDS")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n)),
);

// не редактор - молча игнорируем (и сообщения, и нажатия кнопок)
bot.use((ctx, next) => {
  if (ctx.from && EDITORS.has(ctx.from.id)) return next();
});

/** Автоочистка: сколько часов живут служебные ответы бота (0 - вечно). */
const DEFAULT_TTL_HOURS = 6;
async function getTidyTtlHours(): Promise<number> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", "chat_ttl_hours")
    .maybeSingle();
  if (error || !data) return DEFAULT_TTL_HOURS;
  const n = Number(data.value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_HOURS;
}

async function rememberEphemeral(chatId: number, messageId: number): Promise<void> {
  try {
    const ttl = await getTidyTtlHours();
    if (!ttl) return;
    await db.from("chat_cleanup").upsert({
      chat_id: chatId,
      message_id: messageId,
      delete_after: new Date(Date.now() + ttl * 3600_000).toISOString(),
    });
  } catch {
    // очистка - удобство, а не функция: её сбой не должен ломать ответ
  }
}

// служебные ответы бота смертны: всё, что он отвечает на команды и кнопки,
// помечается на автоудаление. Карточки кандидатов сюда не попадают - они
// приходят из кронов и живут до решения редактора
bot.use(async (ctx, next) => {
  const isCommand = Boolean(ctx.message?.text?.startsWith("/"));
  if (isCommand || ctx.callbackQuery) {
    const origReply = ctx.reply.bind(ctx);
    ctx.reply = (async (text: never, other?: never) => {
      const m = await origReply(text, other);
      await rememberEphemeral(m.chat.id, m.message_id);
      return m;
    }) as typeof ctx.reply;
    const origPhoto = ctx.replyWithPhoto.bind(ctx);
    ctx.replyWithPhoto = (async (photo: never, other?: never) => {
      const m = await origPhoto(photo, other);
      await rememberEphemeral(m.chat.id, m.message_id);
      return m;
    }) as typeof ctx.replyWithPhoto;
  }
  // команду редактора тоже подчищаем - сработает, если у бота есть право
  // удалять чужие сообщения, иначе просто останется
  if (isCommand && ctx.chat && ctx.message) {
    await rememberEphemeral(ctx.chat.id, ctx.message.message_id);
  }
  return next();
});

type Ctx = Parameters<Parameters<typeof bot.command>[1]>[0];

function repliedCandidateId(ctx: Ctx): number | undefined {
  const replied = ctx.message?.reply_to_message;
  return parseCandidateId(replied?.caption ?? replied?.text ?? undefined);
}

function moscowTime(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Дата в московском поясе как «2026-08-13» - для сравнения суток. */
function mskDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(d);
}

/** «WW2 8, korea 1» - три самых частых значения из списка. */
function topThree(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (!counts.size) return "-";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

/** Сколько слотов расписания уже прошло сегодня. */
function slotsPassedToday(times: string[], now: Date): number {
  const hhmm = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  return times.filter((t) => t <= hhmm).length;
}

/** Склонение: 1 день, 2 дня, 5 дней. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function doneKeyboard(label: string) {
  return { inline_keyboard: [[{ text: label, callback_data: "noop" }]] };
}

async function countByStatus(status: string): Promise<number> {
  const { count } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", status);
  return count ?? 0;
}

/** Публикует кандидата в канал, помечает в базе, возвращает ссылку. */
async function publishCandidate(c: {
  id: number;
  image_url: string;
  image_hash: string;
  caption_html: string;
}): Promise<string> {
  const msg = await bot.api.sendPhoto(CHANNEL_ID, c.image_url, {
    caption: c.caption_html,
    parse_mode: "HTML",
  });
  await db
    .from("candidates")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      channel_msg_id: msg.message_id,
    })
    .eq("id", c.id);
  await db.from("seen_hashes").upsert(
    { image_hash: c.image_hash, origin: "published" },
    { onConflict: "image_hash", ignoreDuplicates: true },
  );
  return `https://t.me/${CHANNEL_SLUG}/${msg.message_id}`;
}

/** Одобрение кандидата (кнопка или /ok). Возвращает текст результата. */
async function approve(id: number): Promise<string | null> {
  const { data, error } = await db
    .from("candidates")
    .update({ status: "approved" })
    .eq("id", id)
    .in("status", ["new", "shown", "rejected"])
    .select("id, image_url, image_hash, caption_html");
  if (error) throw new Error(error.message);
  const c = data[0];
  if (!c) return null;

  if (INSTANT_PUBLISH && c.caption_html) {
    const url = await publishCandidate(c as Parameters<typeof publishCandidate>[0]);
    return `Пост #${id} опубликован: ${url}`;
  }
  const queued = await countByStatus("approved");
  return `Пост #${id} в очереди публикации. Всего в очереди: ${queued}.`;
}

// ---------- кнопки ----------

/** Перерисовать панель расписания в том же сообщении. */
async function renderPanel(
  ctx: { editMessageText: (text: string, other?: object) => Promise<unknown> },
  times: string[],
): Promise<void> {
  try {
    await ctx.editMessageText(schedulePanelText(times), {
      reply_markup: { inline_keyboard: panelKeyboard(times) },
    });
  } catch {
    // "message is not modified" при повторном нажатии - не ошибка
  }
}

bot.on("callback_query:data", async (ctx) => {
  const [action, idStr] = ctx.callbackQuery.data.split(":");
  const id = Number(idStr);
  const who = ctx.from.first_name || "админ";

  try {
    switch (action) {
      case "ok": {
        const result = await approve(id);
        if (!result) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        const label = result.includes("опубликован")
          ? `Опубликовано - ${who}`
          : `В очереди - ${who}`;
        await ctx.editMessageReplyMarkup({ reply_markup: doneKeyboard(label) });
        await ctx.answerCallbackQuery({ text: label });
        if (result.includes("https://")) await ctx.reply(result);
        return;
      }
      case "skip": {
        const { data } = await db
          .from("candidates")
          .update({ status: "rejected" })
          .eq("id", id)
          .in("status", ["new", "shown", "approved"])
          .select("id");
        if (!data?.length) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        // чистота чата: пропущенная карточка удаляется целиком
        try {
          await ctx.deleteMessage();
        } catch {
          await ctx.editMessageReplyMarkup({
            reply_markup: doneKeyboard(`Пропущено - ${who}`),
          });
        }
        await ctx.answerCallbackQuery({ text: "Пропущено, карточка убрана" });
        return;
      }
      case "re": {
        const slots = upcomingSlots(6, await getPublishTimes());
        const rows = [];
        for (let i = 0; i < slots.length; i += 2) {
          rows.push(
            slots.slice(i, i + 2).map((s) => ({
              text: s.label,
              callback_data: `sl:${id}:${s.iso.slice(0, 16)}`,
            })),
          );
        }
        rows.push([{ text: "Отмена", callback_data: `reb:${id}` }]);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows } });
        await ctx.answerCallbackQuery({ text: "Выберите время" });
        return;
      }
      case "sl": {
        const isoShort = ctx.callbackQuery.data.split(":").slice(2).join(":");
        const scheduledAt = new Date(`${isoShort}:00${TZ_OFFSET}`).toISOString();
        const { data } = await db
          .from("candidates")
          .update({ scheduled_at: scheduledAt })
          .eq("id", id)
          .eq("status", "approved")
          .select("id");
        if (!data?.length) {
          await ctx.answerCallbackQuery({ text: "Пост уже не в очереди" });
          return;
        }
        const label = isoShort.slice(5, 16).replace("-", ".").replace("T", " ");
        const [mm, rest] = [label.slice(0, 2), label.slice(3)];
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Выйдет ${rest.slice(0, 2)}.${mm} в ${rest.slice(3)} - ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Запланировано" });
        return;
      }
      case "reb": {
        await ctx.editMessageReplyMarkup({
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Опубликовать сейчас", callback_data: `now:${id}` },
                { text: "Перенести", callback_data: `re:${id}` },
                { text: "Убрать", callback_data: `rm:${id}` },
              ],
            ],
          },
        });
        await ctx.answerCallbackQuery({ text: "Отменено" });
        return;
      }
      // предпросмотр из плана: фото с готовой подписью, как выйдет в канал
      case "show": {
        const { data, error } = await db
          .from("candidates")
          .select("image_url, caption_html")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data?.caption_html) {
          await ctx.answerCallbackQuery({ text: "Подписи нет" });
          return;
        }
        try {
          await ctx.replyWithPhoto(data.image_url, {
            caption: data.caption_html,
            parse_mode: "HTML",
          });
          await ctx.answerCallbackQuery();
        } catch {
          // архив не отдал фото телеграму - показываем хотя бы текст;
          // молчание в ответ на кнопку хуже любого запасного варианта
          await ctx.reply(
            `${data.caption_html}\n\nФото по кнопке не отдалось, вот ссылка:\n${data.image_url}`,
            { parse_mode: "HTML" },
          );
          await ctx.answerCallbackQuery({
            text: "Архив не отдаёт фото - прислал текст и ссылку",
          });
        }
        return;
      }
      case "now": {
        const { data, error } = await db
          .from("candidates")
          .select("id, image_url, image_hash, caption_html, status")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data || data.status === "published" || !data.caption_html) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        const url = await publishCandidate(data);
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Опубликовано - ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Опубликовано" });
        await ctx.reply(`Пост #${id} опубликован: ${url}`);
        return;
      }
      case "rm": {
        // из плана убирается и одобренное, и то, что выбрал автопостинг
        const { data } = await db
          .from("candidates")
          .update({ status: "rejected" })
          .eq("id", id)
          .in("status", ["approved", "new", "shown"])
          .select("id");
        if (!data?.length) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Убрано из очереди - ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Убрано из очереди" });
        return;
      }
      case "apply": {
        const { data, error } = await db
          .from("candidates")
          .select("caption_draft")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data?.caption_draft) {
          await ctx.answerCallbackQuery({ text: "Черновика уже нет" });
          return;
        }
        const { error: updErr } = await db
          .from("candidates")
          .update({ caption_html: data.caption_draft, caption_draft: null })
          .eq("id", id);
        if (updErr) throw new Error(updErr.message);
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Подпись заменена - ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Подпись заменена" });
        return;
      }
      case "drop": {
        await db.from("candidates").update({ caption_draft: null }).eq("id", id);
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard("Правка отменена"),
        });
        await ctx.answerCallbackQuery({ text: "Отменено" });
        return;
      }
      case "del": {
        const { data, error } = await db
          .from("candidates")
          .select("id, channel_msg_id, status")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data?.channel_msg_id || data.status !== "published") {
          await ctx.answerCallbackQuery({ text: "Пост уже удалён" });
          return;
        }
        await ctx.api.deleteMessage(CHANNEL_ID, Number(data.channel_msg_id));
        await db.from("candidates").update({ status: "rejected" }).eq("id", id);
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Удалено из канала - ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Удалено из канала" });
        return;
      }
      // ---------- автопостинг (/auto) ----------
      case "tidy": {
        const hours = Number(ctx.callbackQuery.data.split(":")[1]);
        if (!Number.isFinite(hours) || hours < 0) {
          await ctx.answerCallbackQuery({ text: "Не понял настройку" });
          return;
        }
        const { error } = await db.from("settings").upsert({
          key: "chat_ttl_hours",
          value: hours,
          updated_at: new Date().toISOString(),
        });
        if (error) throw new Error(`сохранение автоочистки: ${error.message}`);
        // выключили - снимаем и уже намеченные удаления, чтобы не сработали
        if (hours === 0) await db.from("chat_cleanup").delete().gte("message_id", 0);
        try {
          await ctx.editMessageText(tidyPanelText(hours), {
            reply_markup: tidyPanelKeyboard(hours),
          });
        } catch {
          // message is not modified - не ошибка
        }
        await ctx.answerCallbackQuery({
          text: hours ? `Служебное живёт ${hours} ч` : "Автоочистка выключена",
        });
        return;
      }
      case "aon":
      case "aoff": {
        const on = action === "aon";
        await setAutoPublish(on);
        try {
          await ctx.editMessageText(autoPanelText(on), {
            reply_markup: autoPanelKeyboard(on),
          });
        } catch {
          // message is not modified - не ошибка
        }
        await ctx.answerCallbackQuery({
          text: on ? "Автопостинг включён" : "Автопостинг выключен",
        });
        return;
      }
      // ---------- панель расписания (/schedule) ----------
      case "tdel": {
        const t = unpackTime(idStr ?? "");
        const times = await getPublishTimes();
        if (!t || !times.includes(t)) {
          await renderPanel(ctx, times);
          await ctx.answerCallbackQuery({ text: "Слота уже нет" });
          return;
        }
        if (times.length <= 1) {
          await ctx.answerCallbackQuery({
            text: "Нельзя убрать последний слот: посты перестанут выходить",
            show_alert: true,
          });
          return;
        }
        const next = times.filter((x) => x !== t);
        await savePublishTimes(next);
        await renderPanel(ctx, next);
        await ctx.answerCallbackQuery({ text: `Слот ${t} убран` });
        return;
      }
      case "tadd": {
        await ctx.editMessageText("Новый слот - выберите час (МСК):", {
          reply_markup: { inline_keyboard: hourKeyboard() },
        });
        await ctx.answerCallbackQuery();
        return;
      }
      case "th": {
        const hour = Number(idStr);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          await ctx.answerCallbackQuery({ text: "Не понял час" });
          return;
        }
        await ctx.editMessageText(
          `Час ${String(hour).padStart(2, "0")} - выберите минуты (МСК):`,
          { reply_markup: { inline_keyboard: minuteKeyboard(hour) } },
        );
        await ctx.answerCallbackQuery();
        return;
      }
      case "tset": {
        const t = unpackTime(idStr ?? "");
        if (!t) {
          await ctx.answerCallbackQuery({ text: "Не понял время" });
          return;
        }
        const times = await getPublishTimes();
        if (times.includes(t)) {
          await renderPanel(ctx, times);
          await ctx.answerCallbackQuery({ text: `Слот ${t} уже есть` });
          return;
        }
        if (times.length >= MAX_SLOTS) {
          await ctx.answerCallbackQuery({
            text: `Больше ${MAX_SLOTS} слотов в день нельзя`,
            show_alert: true,
          });
          return;
        }
        const next = normalizeTimes([...times, t]);
        await savePublishTimes(next);
        await renderPanel(ctx, next);
        await ctx.answerCallbackQuery({ text: `Слот ${t} добавлен` });
        return;
      }
      case "tback": {
        await renderPanel(ctx, await getPublishTimes());
        await ctx.answerCallbackQuery();
        return;
      }
      case "tclose": {
        const times = await getPublishTimes();
        await ctx.editMessageText(
          `Расписание сохранено (МСК): ${times.join(", ")}.\n` +
            `Постов в день: ${times.length}. Открыть снова: /schedule`,
        );
        await ctx.answerCallbackQuery();
        return;
      }
      default:
        await ctx.answerCallbackQuery({ text: "Уже обработано" });
    }
  } catch (err) {
    console.error("callback error:", err);
    await ctx.answerCallbackQuery({
      text: "Ошибка, попробуйте ещё раз",
      show_alert: true,
    });
  }
});

// ---------- команды ----------

bot.command("status", async (ctx) => {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();

  const [fresh, shown, queued, beatsRes, recentPubRes, runRes, reserveRes, times, autoOn, plan] =
    await Promise.all([
    countByStatus("new"),
    countByStatus("shown"),
    countByStatus("approved"),
    db.from("heartbeats").select("job, last_ok, last_error"),
    db
      .from("candidates")
      .select("published_at")
      .eq("status", "published")
      .gte("published_at", twoDaysAgo),
    db
      .from("collect_runs")
      .select("analyzed, written, quota_failed, started_at")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("candidates")
      .select("tags, created_at")
      .in("status", ["new", "shown"])
      .not("caption_html", "is", null),
    getPublishTimes(),
    getAutoPublish(),
    currentPlan(1),
  ]);

  // ---- лента: слоты и сутки
  const today = mskDate(now);
  const publishedToday = ((recentPubRes.data ?? []) as Array<{ published_at: string | null }>)
    .filter((r) => r.published_at && mskDate(new Date(r.published_at)) === today).length;
  const passed = slotsPassedToday(times, now);

  // ---- резерв: крючки и возраст
  const reserve = (reserveRes.data ?? []) as Array<{
    tags: { hook?: string } | null;
    created_at: string;
  }>;
  const hooks = topThree(reserve.map((r) => r.tags?.hook ?? "без крючка"));
  const oldestMs = reserve.length
    ? Math.max(...reserve.map((r) => now.getTime() - new Date(r.created_at).getTime()))
    : 0;
  const oldestDays = Math.floor(oldestMs / (24 * 3600 * 1000));
  // запас хода: сколько дней лента проживёт на готовом без новых сборов
  const ready = fresh + shown + queued;
  const perDay = Math.max(1, times.length);
  const runway = (ready / perDay).toFixed(1);

  // ---- сбор: воронка последнего прогона
  const run = runRes.data as {
    analyzed: number;
    written: number;
    quota_failed: number | null;
    started_at: string;
  } | null;

  // ---- служба: пульс работ (нужен только тревогам)
  const beats = (beatsRes.data ?? []) as Array<{
    job: string;
    last_ok: string | null;
    last_error: string | null;
  }>;
  const beat = (job: string) => beats.find((b) => b.job === job);

  const [next] = plan;
  const nextPost = next
    ? `${next.when}, #${next.candidate.id} (${planMark(next.kind)})`
    : "нечего публиковать";

  // Тревоги: строка появляется, ТОЛЬКО когда с показателем что-то не так.
  // Иначе сводка распухает до полотна, которое перестают читать - а
  // молчание блока само по себе значит «здесь порядок».
  const alerts: string[] = [];
  if (run && (run.quota_failed ?? 0) > 0) {
    alerts.push(`Партию оборвал лимит Gemini: ${run.quota_failed} кадров. Сброс в 10:00 МСК`);
  }
  if (passed > publishedToday) {
    alerts.push(`Слот прошёл, а пост не вышел: ${publishedToday} из ${passed}`);
  }
  if (ready < perDay) alerts.push("Готового меньше, чем постов на день - нужен /more");
  const pubBeat = beat("publisher");
  const pubSilent = pubBeat?.last_ok
    ? now.getTime() - new Date(pubBeat.last_ok).getTime() > 2 * 3600 * 1000
    : true;
  if (pubSilent) alerts.push(`Публикатор молчит с ${moscowTime(pubBeat?.last_ok ?? null)}`);
  const colBeat = beat("collector");
  if (colBeat?.last_error) alerts.push("Последний сбор закончился ошибкой");
  if (reserve.length && oldestDays >= 10) {
    alerts.push(`В резерве есть карточки старше 10 дней - автопостинг их уже не берёт`);
  }

  // null - строка, которой в этом прогоне нет; пустая строка - разделитель
  const lines: Array<string | null> = [
    `<b>СВОДКА</b> · ${moscowTime(now.toISOString())} МСК`,
    "",
    `Готово к выходу: <b>${ready}</b> (на разборе ${shown}, одобрено ${queued})`,
    `Запас хода: ${runway} ${plural(Math.round(Number(runway)), "день", "дня", "дней")} при ${perDay} постах в сутки`,
    "",
    `Ближайший пост: ${nextPost}`,
    `Сегодня: ${publishedToday} из ${times.length} - ${times.join(", ")} МСК`,
    "",
    run
      ? `Сбор ${moscowTime(run.started_at)}: ${run.analyzed} на анализ → ${run.written} в резерв`
      : "Сборов ещё не было",
    `Резерв по крючкам: ${hooks}`,
    "",
    autoOn ? "Автопостинг включён - посты выходят сами" : "Автопостинг выключен - только одобренные",
    INSTANT_PUBLISH ? "Режим тестовый - одобрение выводит сразу" : null,
    alerts.length ? "" : null,
    alerts.length ? "<b>Требует внимания</b>" : null,
    ...alerts.map((a) => `- ${a}`),
    "",
    "<i>Подробности: /queue · /schedule · /auto</i>",
  ];

  await ctx.reply(lines.filter((l) => l !== null).join("\n"), { parse_mode: "HTML" });
});

/** План публикаций: то же, что решит публикатор - и вручную, и автоматом. */
async function currentPlan(count: number): Promise<PlanEntry[]> {
  const autoPublish = await getAutoPublish();
  const times = await getPublishTimes();

  const [scheduledRes, approvedRes, reserveRes, recentRes, todayRes] = await Promise.all([
    db
      .from("candidates")
      .select("id, caption_html, scheduled_at")
      .eq("status", "approved")
      .not("scheduled_at", "is", null)
      .order("scheduled_at", { ascending: true }),
    db
      .from("candidates")
      .select("id, caption_html")
      .eq("status", "approved")
      .is("scheduled_at", null)
      .order("id", { ascending: true }),
    autoPublish
      ? db
          .from("candidates")
          .select("id, caption_html, score, tags, attribution, source")
          .in("status", ["new", "shown"])
          .not("caption_html", "is", null)
          .order("score", { ascending: false })
          .limit(40)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("candidates")
      .select("tags, caption_html, attribution, source")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(RECENT_WINDOW),
    db
      .from("candidates")
      .select("published_at")
      .eq("status", "published")
      .gte("published_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString()),
  ]);

  const todayMsk = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(
    new Date(),
  );
  const publishedToday = (todayRes.data ?? []).filter(
    (r: { published_at: string | null }) =>
      r.published_at &&
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(
        new Date(r.published_at),
      ) === todayMsk,
  ).length;

  const recentRows = (recentRes.data ?? []) as Array<{
    tags: PlanTags;
    caption_html?: string | null;
    attribution?: string | null;
    source?: string | null;
  }>;
  return buildPlan(
    {
      now: new Date(),
      tzOffset: TZ_OFFSET,
      times,
      publishedToday,
      scheduled: scheduledRes.data ?? [],
      approved: approvedRes.data ?? [],
      reserve: reserveRes.data ?? [],
      recent: {
        subjects: recentRows
          .map((p) => p.tags?.subject)
          .filter((s): s is string => Boolean(s)),
        periods: recentRows.map((p) => p.tags?.period ?? ""),
        civilian: recentRows.some((p) => p.tags?.military === false),
        statics: recentRows.filter((p) => p.tags?.action === false).length,
        longs: recentRows.filter((p) => quoteLength(p.caption_html ?? null) >= LONG_QUOTE).length,
        archives: recentRows.map((p) => archiveKey(p.attribution) || (p.source ?? "")),
      },
      autoPublish,
      formatScheduled: moscowTime,
    },
    count,
  );
}

/** Пометка, откуда пост в плане - объявлена функцией, её зовёт и /status. */
function planMark(kind: string): string {
  if (kind === "scheduled") return "на время";
  if (kind === "approved") return "одобрен";
  return "автовыбор";
}

bot.command("queue", async (ctx) => {
  const plan = await currentPlan(10);
  const autoOn = await getAutoPublish();
  if (!plan.length) {
    await ctx.reply(
      autoOn
        ? "Публиковать нечего: резерв пуст. Автодобор наполнит его сам, ускорить - /more."
        : "Очередь пуста: одобрите карточки или включите автопостинг (/auto).",
    );
    return;
  }

  await ctx.reply(
    `План публикаций: ${plan.length}.` +
      (autoOn
        ? "\nАвтопостинг включён - посты с пометкой «автовыбор» выйдут сами."
        : "\nАвтопостинг выключен - выйдет только одобренное."),
  );
  for (const entry of plan) {
    const c = entry.candidate;
    await ctx.reply(
      `${entry.when} - ${planMark(entry.kind)}\n#${c.id}. ${headline(c.caption_html)}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Показать", callback_data: `show:${c.id}` },
              { text: "Сейчас", callback_data: `now:${c.id}` },
              { text: "Перенести", callback_data: `re:${c.id}` },
              { text: "Убрать", callback_data: `rm:${c.id}` },
            ],
          ],
        },
      },
    );
  }
});

bot.command("auto", async (ctx) => {
  const on = await getAutoPublish();
  await ctx.reply(autoPanelText(on), { reply_markup: autoPanelKeyboard(on) });
});

function tidyPanelText(ttl: number): string {
  return (
    (ttl
      ? `Автоочистка чата ВКЛЮЧЕНА: служебные ответы бота удаляются через ${ttl} ч.`
      : "Автоочистка чата выключена: служебные ответы бота остаются навсегда.") +
    "\nКарточки кандидатов и посты канала не трогаются никогда."
  );
}

function tidyPanelKeyboard(ttl: number) {
  const opt = (hours: number, label: string) => ({
    text: (ttl === hours ? "• " : "") + label,
    callback_data: `tidy:${hours}`,
  });
  return {
    inline_keyboard: [
      [opt(0, "Выкл"), opt(1, "1 час"), opt(6, "6 часов"), opt(24, "24 часа")],
    ],
  };
}

bot.command("tidy", async (ctx) => {
  const ttl = await getTidyTtlHours();
  await ctx.reply(tidyPanelText(ttl), { reply_markup: tidyPanelKeyboard(ttl) });
});

bot.command("schedule", async (ctx) => {
  const times = await getPublishTimes();
  await ctx.reply(schedulePanelText(times), {
    reply_markup: { inline_keyboard: panelKeyboard(times) },
  });
});

bot.command("more", async (ctx) => {
  if (!GH_PAT) {
    await ctx.reply(
      "Команда не настроена: нужен секрет GH_PAT (токен GitHub с правом " +
        "запуска Actions). Добавьте его в GitHub Secrets и перезапустите деплой вебхука.",
    );
    return;
  }
  // workflow_dispatch, а не repository_dispatch: последнему нужно право
  // Contents write, а у токена только Actions - и его здесь достаточно
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/actions/workflows/more.yml/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${GH_PAT}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: GH_BRANCH }),
    },
  );
  if (res.status === 204) {
    await ctx.reply("Запустила сбор свежей партии. Карточки придут через несколько минут.");
  } else {
    await ctx.reply(`Не получилось запустить сбор: GitHub ответил ${res.status}.`);
  }
});

bot.command("published", async (ctx) => {
  const { data, error } = await db
    .from("candidates")
    .select("id, caption_html, published_at, channel_msg_id")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  if (!data.length) {
    await ctx.reply("Опубликованных постов пока нет.");
    return;
  }
  await ctx.reply("Последние публикации:");
  for (const c of data) {
    const url = c.channel_msg_id
      ? `https://t.me/${CHANNEL_SLUG}/${c.channel_msg_id}`
      : "";
    await ctx.reply(
      `#${c.id}. ${headline(c.caption_html)}\n${moscowTime(c.published_at)}${url ? `\n${url}` : ""}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Удалить из канала", callback_data: `del:${c.id}` }],
          ],
        },
        link_preview_options: { is_disabled: true },
      },
    );
  }
});

bot.command("ok", async (ctx) => {
  const id = repliedCandidateId(ctx);
  if (!id) return;
  const result = await approve(id);
  await ctx.reply(result ?? `#${id}: уже в другом статусе, не тронул.`);
});

bot.command("skip", async (ctx) => {
  const id = repliedCandidateId(ctx);
  if (!id) return;
  const { error } = await db
    .from("candidates")
    .update({ status: "rejected" })
    .eq("id", id)
    .in("status", ["new", "shown", "approved"]);
  if (error) throw new Error(error.message);
  await ctx.reply(`Пост #${id} пропущен.`);
});

bot.command("quote", async (ctx) => {
  const id = repliedCandidateId(ctx);
  const newQuote = ctx.match?.trim();
  if (!id || !newQuote) return;
  const { data: candidate, error } = await db
    .from("candidates")
    .select("caption_html")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!candidate?.caption_html) return;

  const updated = replaceQuote(candidate.caption_html, newQuote);
  if (visibleLength(updated) > CAPTION_LIMIT) {
    await ctx.reply(`С такой цитатой подпись длиннее ${CAPTION_LIMIT} символов.`);
    return;
  }
  const { error: updErr } = await db
    .from("candidates")
    .update({ caption_html: updated })
    .eq("id", id);
  if (updErr) throw new Error(updErr.message);
  await ctx.reply(`Пост #${id}: цитата заменена.`);
});

bot.command("undo", async (ctx) => {
  const { data, error } = await db
    .from("candidates")
    .select("id, channel_msg_id")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const last = data[0];
  if (!last?.channel_msg_id) {
    await ctx.reply("Опубликованных постов нет - удалять нечего.");
    return;
  }
  await ctx.api.deleteMessage(CHANNEL_ID, Number(last.channel_msg_id));
  const { error: updErr } = await db
    .from("candidates")
    .update({ status: "rejected" })
    .eq("id", last.id);
  if (updErr) throw new Error(updErr.message);
  await ctx.reply(`Пост #${last.id} удалён из канала.`);
});

// реплай обычным текстом - предложить замену подписи (с подтверждением:
// живой тест показал, что случайный реплай "ok" молча стирал подпись)
bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const id = repliedCandidateId(ctx);
  if (!id) return;

  const text = ctx.message.text.trim();
  if (text.length < 20) {
    await ctx.reply(
      "Короткий реплай не считаю правкой подписи. " +
        "Одобрить или пропустить пост можно кнопками под карточкой; " +
        "чтобы заменить подпись - ответьте на карточку полным новым текстом.",
    );
    return;
  }

  const { data: candidate, error } = await db
    .from("candidates")
    .select("caption_html")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!candidate?.caption_html) return;

  const bodyHtml = entitiesToHtml(ctx.message.text, ctx.message.entities ?? []);
  const updated = replaceBody(candidate.caption_html, bodyHtml);

  const htmlCheck = validateHtml(updated);
  if (!htmlCheck.ok) {
    await ctx.reply(`Не приняла: ${htmlCheck.reason}.`);
    return;
  }
  if (visibleLength(updated) > CAPTION_LIMIT) {
    await ctx.reply(`Не приняла: длиннее ${CAPTION_LIMIT} символов.`);
    return;
  }

  const { error: updErr } = await db
    .from("candidates")
    .update({ caption_draft: updated })
    .eq("id", id);
  if (updErr) throw new Error(updErr.message);

  await ctx.reply(`Новая подпись для поста #${id} - проверьте и подтвердите:\n\n${updated}`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Применить", callback_data: `apply:${id}` },
          { text: "Отмена", callback_data: `drop:${id}` },
        ],
      ],
    },
  });
});

const handler = webhookCallback(bot, "std/http", {
  secretToken: Deno.env.get("TG_WEBHOOK_SECRET")?.trim() || undefined,
});

Deno.serve(async (req) => {
  try {
    return await handler(req);
  } catch (err) {
    console.error("webhook error:", err);
    // телеграму отвечаем 200, чтобы он не ретраил бесконечно
    return new Response("ok");
  }
});
