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
 *   /reserve [N]      - резерв: разобранные, но не решённые карточки,
 *                       по оценке, с кнопками. Gemini не тратит
 *   /more             - карточки из резерва, а если он пуст - новый сбор
 *   /schedule         - панель расписания: слоты и число постов (МСК)
 *   /auto             - тумблер полной автоматизации (посты без одобрения)
 *   /tidy             - автоочистка чата: служебные ответы бота удаляются
 *                       через выбранное время (выкл / 1 / 6 / 24 ч)
 *   /published        - последние вышедшие с кнопками удаления
 *   /ok, /skip        - то же, что кнопки (реплаем на карточку)
 *   /quote <текст>    - заменить цитату (реплаем)
 *   текст реплаем     - заменить подпись целиком
 *   /undo             - удалить вышедший пост (последний или реплаем -
 *                       конкретный), только после подтверждения кнопкой
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
import { draftTag, replaceBody, replaceQuote } from "../_shared/edit_caption.ts";
import { CAPTION_LIMIT, validateHtml, visibleLength } from "../_shared/validate.ts";
import {
  MAIN_KEYBOARD,
  RESERVE_PAGE,
  TOAST,
  backFor,
  deleteAskScreen,
  homeScreen,
  itemScreen,
  menuByText,
  publishedScreen,
  queueScreen,
  reserveScreen,
  settingsScreen,
  shortTitle,
  tidyScreen,
  whenScreen,
  type ListItem,
  type Screen,
} from "../_shared/menu.ts";
import { storyLine } from "../_shared/story.ts";
import {
  TASTE_DAYS,
  feedHistory,
  normalizeFeedMode,
  planGrid,
  tasteKeys,
  tasteMap,
  tastePenalty,
} from "../_shared/feed.ts";
import {
  EVENT_MEMORY_DAYS,
  HISTORY_WINDOW,
  HOME_NATION,
  eventKeys,
  LONG_QUOTE,
  RECENT_WINDOW,
  RESERVE_TTL_DAYS,
  archiveKey,
  buildPlan,
  headline,
  postNation,
  quoteLength,
  recentEvents,
  weekShares,
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
    ? "Автопостинг включён: всё, что собрано и не удалено, выходит само по расписанию."
    : "Автопостинг выключен: выходят только посты «следующим» и на время.";
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

/**
 * Длинные тире - самая заметная примета машинного текста. Чистим их на
 * выходе, перехватывая любой вызов Telegram API: ответы команд, панели,
 * правки подписей, всплывашки на кнопках. Правило в одном месте, поэтому
 * его нельзя забыть в новом сообщении.
 */
bot.api.config.use(async (prev, method, payload, signal) => {
  const p = payload as { text?: unknown; caption?: unknown };
  const plain = (t: string) => t.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, "-");
  if (typeof p.text === "string") p.text = plain(p.text);
  if (typeof p.caption === "string") p.caption = plain(p.caption);
  return prev(method, payload, signal);
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

/** Возраст карточки словами: «сегодня», «3 дня». */
function ageWords(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / (24 * 3600 * 1000));
  if (days <= 0) return "сегодня";
  return `${days} ${plural(days, "день", "дня", "дней")}`;
}

// Срок годности резерва (RESERVE_TTL_DAYS) - общий с публикатором, из
// _shared/plan.ts: карточку старше автопостинг не возьмёт, и в списке её
// надо помечать, иначе редактор ждёт от неё выхода зря.

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

/** Статусы, из которых пост можно отправить в канал. */
const PUBLISHABLE = ["new", "shown", "approved"];

/**
 * Удаляет пост из канала. Пост, который админ уже снёс руками, - не
 * ошибка: раньше «message to delete not found» вылетал до смены статуса,
 * и /undo с кнопкой «Удалить» навсегда застревали на этом посте.
 */
async function deleteChannelPost(msgId: number): Promise<void> {
  try {
    await bot.api.deleteMessage(CHANNEL_ID, msgId);
  } catch (err) {
    if (!/message to delete not found/i.test((err as Error).message)) throw err;
  }
}

/**
 * Публикует кандидата в канал и возвращает ссылку; null - пост уже не
 * публикуемый (его опубликовал, отклонил или забрал кто-то другой).
 *
 * Сначала строка ЗАХВАТЫВАЕТСЯ условным обновлением в published, и только
 * потом уходит фото. Раньше кнопка «Сейчас» читала строку и слала фото
 * без захвата: двойное нажатие или публикатор по расписанию в ту же
 * секунду давали пост дважды, а старая карточка могла выпустить уже
 * отклонённый пост. Отправка сорвалась - статус возвращается как был.
 */
async function publishCandidate(id: number): Promise<string | null> {
  const { data: row, error } = await db
    .from("candidates")
    .select("id, image_url, image_hash, caption_html, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || !row.caption_html || !PUBLISHABLE.includes(row.status)) return null;

  const { data: claimed, error: claimErr } = await db
    .from("candidates")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", row.status)
    .select("id");
  if (claimErr) throw new Error(claimErr.message);
  if (!claimed?.length) return null;

  let msgId: number;
  try {
    const msg = await bot.api.sendPhoto(CHANNEL_ID, row.image_url, {
      caption: row.caption_html,
      parse_mode: "HTML",
    });
    msgId = msg.message_id;
  } catch (err) {
    await db
      .from("candidates")
      .update({ status: row.status, published_at: null })
      .eq("id", id)
      .eq("status", "published")
      .is("channel_msg_id", null);
    throw err;
  }

  // пост уже в канале: номер сообщения обязан дойти до базы, иначе /undo
  // и «Удалить из канала» его не найдут. Сбой сети - повторяем
  for (let attempt = 1; ; attempt++) {
    const { error: updErr } = await db
      .from("candidates")
      .update({ channel_msg_id: msgId })
      .eq("id", id);
    if (!updErr) break;
    if (attempt >= 3) {
      throw new Error(
        `пост #${id} ушёл в канал (сообщение ${msgId}), но номер не записан: ${updErr.message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  const { error: hashErr } = await db.from("seen_hashes").upsert(
    { image_hash: row.image_hash, origin: "published" },
    { onConflict: "image_hash", ignoreDuplicates: true },
  );
  if (hashErr) console.error(`seen_hashes для #${id}: ${hashErr.message}`);
  return `https://t.me/${CHANNEL_SLUG}/${msgId}`;
}

/** Одобрение кандидата (кнопка или /ok). Возвращает текст результата. */
async function approve(id: number): Promise<string | null> {
  const { data, error } = await db
    .from("candidates")
    .update({ status: "approved" })
    .eq("id", id)
    .in("status", ["new", "shown", "rejected"])
    .select("id, caption_html, created_at");
  if (error) throw new Error(error.message);
  const c = data[0];
  if (!c) return null;

  if (INSTANT_PUBLISH && c.caption_html) {
    const url = await publishCandidate(id);
    if (url) return `Пост #${id} опубликован: ${url}`;
  }
  // пост старше срока годности автопостинг не берёт - «следующим» для
  // него значит ближайший слот по времени: время срок годности не держит
  const stale =
    new Date(c.created_at).getTime() < Date.now() - RESERVE_TTL_DAYS * 24 * 3600 * 1000;
  if (stale) {
    const [slot] = upcomingSlots(1, await getPublishTimes());
    if (slot) {
      await db
        .from("candidates")
        .update({ scheduled_at: new Date(slot.iso).toISOString() })
        .eq("id", id);
      return `Пост #${id} выйдет ${slot.label} МСК.`;
    }
  }
  return `Пост #${id} выйдет следующим.`;
}

// ---------- кнопки ----------

/** Перерисовать панель расписания в том же сообщении. */
async function renderPanel(
  ctx: { editMessageText: (text: string, other?: object) => Promise<unknown> },
  times: string[],
): Promise<void> {
  try {
    await ctx.editMessageText(schedulePanelText(times), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: panelKeyboard(times) },
    });
  } catch {
    // "message is not modified" при повторном нажатии - не ошибка
  }
}

// ---------- меню (_shared/menu.ts) ----------

type PanelCtx = {
  chat?: { id: number };
  reply: (text: string, other?: object) => Promise<{ message_id: number; chat: { id: number } }>;
};

/**
 * Открыть панель новым сообщением. Прежняя панель этого чата удаляется:
 * в чате всегда одна живая панель, а не лента из старых сводок.
 */
async function showPanel(ctx: PanelCtx, screen: Screen): Promise<void> {
  const m = await ctx.reply(screen.text, {
    parse_mode: "HTML",
    reply_markup: screen.keyboard,
    link_preview_options: { is_disabled: true },
  });
  const key = `menu_panel:${m.chat.id}`;
  try {
    const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
    const prev = Number(data?.value);
    if (Number.isFinite(prev) && prev > 0 && prev !== m.message_id) {
      await bot.api.deleteMessage(m.chat.id, prev).catch(() => {});
    }
    await db.from("settings").upsert({ key, value: m.message_id, updated_at: new Date().toISOString() });
  } catch {
    // уборка старой панели - удобство, не функция
  }
}

/** Перерисовать панель на месте (после нажатия кнопки). */
async function editPanel(
  ctx: { editMessageText: (text: string, other?: object) => Promise<unknown> },
  screen: Screen,
): Promise<void> {
  try {
    await ctx.editMessageText(screen.text, {
      parse_mode: "HTML",
      reply_markup: screen.keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch {
    // «message is not modified» при повторном нажатии - не ошибка
  }
}

const freshSinceIso = () =>
  new Date(Date.now() - RESERVE_TTL_DAYS * 24 * 3600 * 1000).toISOString();

async function buildQueue(): Promise<Screen> {
  const plan = await currentPlan(5);
  const items: ListItem[] = plan.map((e) => ({
    id: e.candidate.id,
    when: e.when,
    title: shortTitle(e.candidate.caption_html),
    mark: e.kind === "auto" ? undefined : planMark(e.kind),
  }));
  return queueScreen(items, await getAutoPublish());
}

async function buildReserve(page: number): Promise<Screen> {
  const now = new Date();
  const base = () =>
    db
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .in("status", ["new", "shown", "approved"])
      .is("scheduled_at", null)
      .not("caption_html", "is", null);
  const [{ count: total }, { count: stale }, { data, error }] = await Promise.all([
    base().gte("created_at", freshSinceIso()),
    base().lt("created_at", freshSinceIso()),
    db
      .from("candidates")
      .select("id, caption_html, score, created_at, status")
      .in("status", ["new", "shown", "approved"])
      .is("scheduled_at", null)
      .not("caption_html", "is", null)
      .gte("created_at", freshSinceIso())
      .order("score", { ascending: false })
      .order("id", { ascending: false })
      .range(page * RESERVE_PAGE, page * RESERVE_PAGE + RESERVE_PAGE - 1),
  ]);
  if (error) throw new Error(error.message);
  const items: ListItem[] = (data ?? []).map((c) => ({
    id: c.id,
    title: shortTitle(c.caption_html),
    mark:
      `оценка ${c.score ?? "?"} · ${ageWords(c.created_at, now)}` +
      (c.status === "approved" ? " · следующий" : ""),
  }));
  return reserveScreen(items, page, total ?? 0, stale ?? 0);
}

async function buildPublished(): Promise<Screen> {
  const { data, error } = await db
    .from("candidates")
    .select("id, caption_html, published_at")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  return publishedScreen(
    (data ?? []).map((c) => ({ id: c.id, when: moscowTime(c.published_at), title: shortTitle(c.caption_html) })),
  );
}

async function buildSettings(): Promise<Screen> {
  const [autoOn, times, tidyHours] = await Promise.all([
    getAutoPublish(),
    getPublishTimes(),
    getTidyTtlHours(),
  ]);
  return settingsScreen({ autoOn, times, tidyHours });
}

async function buildItem(id: number, from: string): Promise<Screen | undefined> {
  const { data: c, error } = await db
    .from("candidates")
    .select("id, caption_html, status, score, created_at, scheduled_at, published_at, channel_msg_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) return undefined;
  const now = new Date();
  const stale = new Date(c.created_at).getTime() < Date.now() - RESERVE_TTL_DAYS * 24 * 3600 * 1000;
  let statusLine: string | undefined;
  if (c.status === "published") statusLine = `вышел ${moscowTime(c.published_at)}`;
  else if (c.scheduled_at) statusLine = `на время, ${moscowTime(c.scheduled_at)}`;
  else if (c.status === "approved") statusLine = "следующий";
  else if (c.status === "rejected") statusLine = "удалён";
  else statusLine = "в резерве";
  return itemScreen(
    {
      id: c.id,
      title: shortTitle(c.caption_html, 200),
      status: c.status,
      statusLine,
      score: c.score,
      age: c.status === "published" ? undefined : ageWords(c.created_at, now),
      stale,
      scheduled: Boolean(c.scheduled_at),
      channelUrl: c.channel_msg_id ? `https://t.me/${CHANNEL_SLUG}/${c.channel_msg_id}` : undefined,
    },
    from,
  );
}

/** Экран, куда вернуться после действия над постом. */
async function buildBack(from: string): Promise<Screen> {
  const target = backFor(from);
  if (target === "m:queue") return buildQueue();
  if (target === "m:pub") return buildPublished();
  return buildReserve(Number(target.split(":")[2]) || 0);
}

type CbCtx = {
  callbackQuery: { data: string };
  from: { first_name?: string };
  answerCallbackQuery: (other?: object) => Promise<unknown>;
  editMessageText: (text: string, other?: object) => Promise<unknown>;
};

/** Нажатие в панели меню: m:раздел[:аргументы]. */
async function handleMenu(ctx: CbCtx, parts: string[]): Promise<void> {
  const [screen, a, b, c] = parts;
  const toast = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined);
  switch (screen) {
    case "home":
      await editPanel(ctx, await buildHome());
      return void (await toast());
    case "queue":
      await editPanel(ctx, await buildQueue());
      return void (await toast());
    case "res":
      await editPanel(ctx, await buildReserve(Math.max(0, Number(a) || 0)));
      return void (await toast());
    case "pub":
      await editPanel(ctx, await buildPublished());
      return void (await toast());
    case "set":
      await editPanel(ctx, await buildSettings());
      return void (await toast());
    case "sched": {
      const times = await getPublishTimes();
      await editPanel(ctx, { text: schedulePanelText(times), keyboard: { inline_keyboard: panelKeyboard(times) } });
      return void (await toast());
    }
    case "tidy":
      await editPanel(ctx, tidyScreen(await getTidyTtlHours()));
      return void (await toast());
    case "tidyset": {
      const hours = Number(a);
      if (!Number.isFinite(hours) || hours < 0) return void (await toast());
      const { error } = await db.from("settings").upsert({
        key: "chat_ttl_hours",
        value: hours,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(`сохранение автоочистки: ${error.message}`);
      if (hours === 0) await db.from("chat_cleanup").delete().gte("message_id", 0);
      await editPanel(ctx, await buildSettings());
      return void (await toast(TOAST.saved));
    }
    case "auto": {
      const on = a === "on";
      await setAutoPublish(on);
      await editPanel(ctx, await buildSettings());
      return void (await toast(on ? TOAST.autoOn : TOAST.autoOff));
    }
    case "more": {
      const r = await triggerCollect();
      return void (await ctx.answerCallbackQuery({ text: collectReply(r), show_alert: r !== "ok" }));
    }
    case "item": {
      const item = await buildItem(Number(a), b ?? "q");
      if (!item) return void (await toast(TOAST.gone));
      await editPanel(ctx, item);
      return void (await toast());
    }
    case "now": {
      const url = await publishCandidate(Number(a));
      if (!url) return void (await toast(TOAST.gone));
      const item = await buildItem(Number(a), b ?? "q");
      if (item) await editPanel(ctx, item);
      return void (await toast(TOAST.published));
    }
    case "next": {
      const result = await approve(Number(a));
      if (!result) return void (await toast(TOAST.gone));
      const item = await buildItem(Number(a), b ?? "q");
      if (item) await editPanel(ctx, item);
      return void (await toast(result.includes(" МСК") ? result.replace(/^Пост #\d+ /, "").replace(/\.$/, "") : TOAST.next));
    }
    case "drop": {
      const { data } = await db
        .from("candidates")
        .update({ status: "rejected" })
        .eq("id", Number(a))
        .in("status", ["new", "shown", "approved"])
        .select("id, tags");
      await markEditor(data, "drop");
      if (!data?.length) return void (await toast(TOAST.gone));
      await editPanel(ctx, await buildBack(b ?? "q"));
      return void (await toast(TOAST.dropped));
    }
    case "when": {
      const { data } = await db.from("candidates").select("caption_html").eq("id", Number(a)).maybeSingle();
      const slots = upcomingSlots(6, await getPublishTimes());
      await editPanel(ctx, whenScreen(Number(a), shortTitle(data?.caption_html), slots, b ?? "q"));
      return void (await toast());
    }
    case "at": {
      // m:at:id:from:YYYY-MM-DDTHH - двоеточие времени съела разбивка
      const isoShort = `${c}:${parts[4] ?? "00"}`;
      const scheduledAt = new Date(`${isoShort}:00${TZ_OFFSET}`).toISOString();
      if (new Date(scheduledAt).getTime() <= Date.now()) {
        return void (await ctx.answerCallbackQuery({ text: "Время уже прошло", show_alert: true }));
      }
      const { data } = await db
        .from("candidates")
        .update({ scheduled_at: scheduledAt, status: "approved" })
        .eq("id", Number(a))
        .in("status", ["approved", "new", "shown"])
        .select("id");
      if (!data?.length) return void (await toast(TOAST.gone));
      const item = await buildItem(Number(a), b ?? "q");
      if (item) await editPanel(ctx, item);
      return void (await toast(`Выйдет ${moscowTime(scheduledAt)}`));
    }
    case "delask": {
      const { data } = await db.from("candidates").select("caption_html").eq("id", Number(a)).maybeSingle();
      await editPanel(ctx, deleteAskScreen(Number(a), shortTitle(data?.caption_html), b ?? "p"));
      return void (await toast());
    }
    case "delyes": {
      const id = Number(a);
      const { data, error } = await db
        .from("candidates")
        .update({ status: "rejected" })
        .eq("id", id)
        .eq("status", "published")
        .not("channel_msg_id", "is", null)
        .select("id, channel_msg_id, tags");
      await markEditor(data, "delete_published");
      if (error) throw new Error(error.message);
      const row = data?.[0];
      if (!row) return void (await toast(TOAST.gone));
      try {
        await deleteChannelPost(Number(row.channel_msg_id));
      } catch (err) {
        await db.from("candidates").update({ status: "published" }).eq("id", id).eq("status", "rejected");
        throw err;
      }
      await editPanel(ctx, await buildPublished());
      return void (await toast(TOAST.deleted));
    }
    default:
      return void (await toast());
  }
}

bot.on("callback_query:data", async (ctx) => {
  const [action, idStr] = ctx.callbackQuery.data.split(":");
  const id = Number(idStr);
  const who = ctx.from.first_name || "админ";

  try {
    switch (action) {
      case "m": {
        await handleMenu(ctx, ctx.callbackQuery.data.split(":").slice(1));
        return;
      }
      case "ok": {
        const result = await approve(id);
        if (!result) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        const label = result.includes("опубликован")
          ? `Опубликовано − ${who}`
          : result.includes(" МСК")
            ? `${result.replace(/^Пост #\d+ /, "").replace(/\.$/, "")} − ${who}`
            : `Следующим − ${who}`;
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
          .select("id, tags");
        await markEditor(data, "skip");
        if (!data?.length) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        // чистота чата: пропущенная карточка удаляется целиком
        try {
          await ctx.deleteMessage();
        } catch {
          await ctx.editMessageReplyMarkup({
            reply_markup: doneKeyboard(`Удалено − ${who}`),
          });
        }
        await ctx.answerCallbackQuery({ text: "Удалено: в канал не выйдет" });
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
        // кнопки слотов рисуются заранее: прошедшее время публикатор
        // выпустил бы ближайшим заходом, мимо любого слота
        if (new Date(scheduledAt).getTime() <= Date.now()) {
          await ctx.answerCallbackQuery({
            text: "Время уже прошло",
            show_alert: true,
          });
          return;
        }
        // в /queue «Перенести» есть и у постов автовыбора (резерв): время
        // им назначает редактор - значит, это и одобрение
        const { data } = await db
          .from("candidates")
          .update({ scheduled_at: scheduledAt, status: "approved" })
          .eq("id", id)
          .in("status", ["approved", "new", "shown"])
          .select("id");
        if (!data?.length) {
          await ctx.answerCallbackQuery({ text: "Пост уже не в очереди" });
          return;
        }
        const label = isoShort.slice(5, 16).replace("-", ".").replace("T", " ");
        const [mm, rest] = [label.slice(0, 2), label.slice(3)];
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Выйдет ${rest.slice(0, 2)}.${mm} в ${rest.slice(3)} − ${who}`),
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
            text: "Архив не отдаёт фото − прислал текст и ссылку",
          });
        }
        return;
      }
      case "now": {
        const url = await publishCandidate(id);
        if (!url) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Опубликовано − ${who}`),
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
          .select("id, tags");
        await markEditor(data, "remove_from_plan");
        if (!data?.length) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Убрано из очереди − ${who}`),
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
        // кнопка помнит, какой черновик показала; старые кнопки без
        // отпечатка (до 18.10) принимаем как раньше
        const shownTag = ctx.callbackQuery.data.split(":")[2];
        if (shownTag && draftTag(data.caption_draft) !== shownTag) {
          await ctx.answerCallbackQuery({
            text: "Черновик уже другой: после этой правки прислали новую. Применяйте последнюю.",
            show_alert: true,
          });
          return;
        }
        // вышедший пост правкой в базе не изменить: канал и база разошлись
        // бы, а редактор получил бы «Подпись заменена»
        const { data: applied, error: updErr } = await db
          .from("candidates")
          .update({ caption_html: data.caption_draft, caption_draft: null })
          .eq("id", id)
          .in("status", ["new", "shown", "approved"])
          .select("id");
        if (updErr) throw new Error(updErr.message);
        if (!applied?.length) {
          await ctx.answerCallbackQuery({ text: "Пост уже вышел или снят − правка не применена", show_alert: true });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Подпись заменена − ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Подпись заменена" });
        return;
      }
      case "drop": {
        // отмена стирает только СВОЙ черновик: чужая правка, присланная
        // позже, должна дожить до своей кнопки «Применить»
        const shownTag = ctx.callbackQuery.data.split(":")[2];
        const { data, error } = await db
          .from("candidates")
          .select("caption_draft")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (data?.caption_draft && (!shownTag || draftTag(data.caption_draft) === shownTag)) {
          await db.from("candidates").update({ caption_draft: null }).eq("id", id);
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard("Правка отменена"),
        });
        await ctx.answerCallbackQuery({ text: "Отменено" });
        return;
      }
      case "del": {
        // захват до удаления, как у публикации: два нажатия (или /undo
        // двух редакторов) не должны снести два разных поста
        const { data, error } = await db
          .from("candidates")
          .update({ status: "rejected" })
          .eq("id", id)
          .eq("status", "published")
          .not("channel_msg_id", "is", null)
          .select("id, channel_msg_id, tags");
        await markEditor(data, "delete_published");
        if (error) throw new Error(error.message);
        const row = data?.[0];
        if (!row) {
          await ctx.answerCallbackQuery({ text: "Пост уже удалён" });
          return;
        }
        try {
          await deleteChannelPost(Number(row.channel_msg_id));
        } catch (err) {
          // пост остался в канале - и в базе он снова опубликованный
          await db.from("candidates").update({ status: "published" }).eq("id", id).eq("status", "rejected");
          throw err;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Удалено из канала − ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Удалено из канала" });
        return;
      }
      // ---------- автопостинг (/auto) ----------
      case "tidy": {
        const hours = Number(ctx.callbackQuery.data.split(":")[1]);
        if (!Number.isFinite(hours) || hours < 0) {
          await ctx.answerCallbackQuery({ text: "Неизвестная настройка" });
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
        await ctx.editMessageText("Новый слот. Час (МСК):", {
          reply_markup: { inline_keyboard: hourKeyboard() },
        });
        await ctx.answerCallbackQuery();
        return;
      }
      case "th": {
        const hour = Number(idStr);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          await ctx.answerCallbackQuery({ text: "Неизвестный час" });
          return;
        }
        await ctx.editMessageText(
          `Новый слот ${String(hour).padStart(2, "0")}:__. Минуты:`,
          { reply_markup: { inline_keyboard: minuteKeyboard(hour) } },
        );
        await ctx.answerCallbackQuery();
        return;
      }
      case "tset": {
        const t = unpackTime(idStr ?? "");
        if (!t) {
          await ctx.answerCallbackQuery({ text: "Неизвестное время" });
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
      case "keep": {
        await ctx.editMessageReplyMarkup({ reply_markup: doneKeyboard(`Оставлено − ${who}`) });
        await ctx.answerCallbackQuery({ text: "Пост остаётся в канале" });
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

/**
 * Сводка - главный экран меню (src: _shared/menu.ts). Раньше это был
 * ответ на /status с канцелярским полотном; теперь панель с кнопками.
 */
async function buildHome(): Promise<Screen> {
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
    // всё, что выйдет само: резерв и «следующим» без времени (модель
    // 15.11: одобрять не нужно - всё, что не удалено, уже в очереди)
    db
      .from("candidates")
      .select("tags, created_at, scheduled_at")
      .in("status", ["new", "shown", "approved"])
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
  const pool = (reserveRes.data ?? []) as Array<{
    tags: { hook?: string } | null;
    created_at: string;
    scheduled_at: string | null;
  }>;
  // пост на время выходит в своё время, срок годности ему не указ
  const staleBefore = now.getTime() - RESERVE_TTL_DAYS * 24 * 3600 * 1000;
  const reserve = pool.filter((r) => !r.scheduled_at);
  const freshReserve = reserve.filter((r) => new Date(r.created_at).getTime() >= staleBefore);
  const staleCount = reserve.length - freshReserve.length;
  const scheduledCount = pool.length - reserve.length;
  const oldestMs = reserve.length
    ? Math.max(...reserve.map((r) => now.getTime() - new Date(r.created_at).getTime()))
    : 0;
  const oldestDays = Math.floor(oldestMs / (24 * 3600 * 1000));
  // запас хода: сколько дней лента проживёт на готовом без новых сборов
  // готово - то, что публикатор реально возьмёт: свежий резерв и посты на
  // время. Раньше в счёт шли и просроченные - «27 готовых» при восьми живых
  const ready = freshReserve.length + scheduledCount;
  const perDay = Math.max(1, times.length);

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

  // Тревоги: строка появляется, ТОЛЬКО когда с показателем что-то не так.
  // Иначе сводка распухает до полотна, которое перестают читать - а
  // молчание блока само по себе значит «здесь порядок».
  const alerts: string[] = [];
  if (run && (run.quota_failed ?? 0) > 0) {
    alerts.push(`Сбор: лимит Gemini, не разобрано ${run.quota_failed} (сброс в 11:00)`);
  }
  if (passed > publishedToday) {
    alerts.push(`Пропущен слот: вышло ${publishedToday} из ${passed}`);
  }
  if (ready < perDay) alerts.push(`Готово меньше дневной нормы: ${ready} из ${perDay}`);
  const pubBeat = beat("publisher");
  const pubSilent = pubBeat?.last_ok
    ? now.getTime() - new Date(pubBeat.last_ok).getTime() > 2 * 3600 * 1000
    : true;
  if (pubSilent) alerts.push(`Публикатор: нет отклика с ${moscowTime(pubBeat?.last_ok ?? null)}`);
  const colBeat = beat("collector");
  if (colBeat?.last_error) alerts.push("Сбор: ошибка в последнем прогоне");
  // просроченные - не тревога: они просто не выйдут (строка ниже)
  void oldestDays;

  const nextTitle = next ? headline(next.candidate.caption_html, 60) : "";
  // типы сюжетов за неделю: про что лента, а не откуда кадры
  const { data: weekPosts } = await db
    .from("candidates")
    .select("tags, caption_html, attribution, source")
    .eq("status", "published")
    .gte("published_at", new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString());
  const storyWeek = (weekPosts ?? []).length
    ? storyLine(
        (weekPosts ?? []).map((p) => ({
          story: (p.tags as { story?: string } | null)?.story,
          color: (p.tags as { color?: boolean } | null)?.color,
          nation: postNation(p),
        })),
      )
    : undefined;
  return homeScreen({
    storyWeek,
    publishedToday,
    slotsToday: times.length,
    times,
    nextPost: next ? { when: next.when, title: nextTitle } : undefined,
    ready,
    stale: staleCount,
    lastRun: run
      ? { when: moscowTime(run.started_at), analyzed: run.analyzed, written: run.written }
      : undefined,
    autoOn,
    alerts,
  });
}

bot.command("status", async (ctx) => {
  await showPanel(ctx, await buildHome());
});

/** План публикаций: то же, что решит публикатор - и вручную, и автоматом. */
async function currentPlan(count: number): Promise<PlanEntry[]> {
  const autoPublish = await getAutoPublish();
  const times = await getPublishTimes();
  // сетка рубрик: в режиме on план строит она, как и публикатор
  const { data: modeRow } = await db.from("settings").select("value").eq("key", "feed_mode").maybeSingle();
  const feedMode = normalizeFeedMode(modeRow?.value);
  // вкус редакции - как у публикатора, чтобы план совпадал с выбором
  const taste =
    feedMode === "on"
      ? tasteMap(
          ((
            await db
              .from("candidates")
              .select("status, caption_html, tags, attribution, source")
              .in("status", ["rejected", "published"])
              .not("caption_html", "is", null)
              .gte("created_at", new Date(Date.now() - TASTE_DAYS * 86_400_000).toISOString())
              .limit(2000)
          ).data ?? []) as Array<{ status: string; caption_html: string | null; tags: Record<string, unknown> | null; attribution: string | null; source: string | null }>,
          (r) => tasteKeys(r, archiveKey(r.attribution) || (r.source ?? "")),
        )
      : new Map<string, number>();

  const [scheduledRes, approvedRes, reserveRes, recentRes, todayRes, weekRes] = await Promise.all([
    db
      .from("candidates")
      .select("id, caption_html, scheduled_at")
      .eq("status", "approved")
      .not("scheduled_at", "is", null)
      .order("scheduled_at", { ascending: true }),
    // одобренные и резерв планируются одним пулом - без оценки и тегов
    // одобренный для правил разнообразия «невидим», и превью разошлось
    // бы с тем, что реально выберет публикатор
    db
      .from("candidates")
      .select("id, caption_html, score, tags, attribution, source, created_at")
      .eq("status", "approved")
      .not("caption_html", "is", null)
      .is("scheduled_at", null)
      // «следующим» без времени стареет как весь резерв, как у публикатора
      .gte("created_at", new Date(Date.now() - RESERVE_TTL_DAYS * 24 * 3600 * 1000).toISOString())
      .order("id", { ascending: true })
      .limit(20),
    autoPublish
      ? db
          .from("candidates")
          .select("id, caption_html, score, tags, attribution, source")
          .in("status", ["new", "shown"])
          .not("caption_html", "is", null)
          // ровно как публикатор: свежий резерв, те же шестьдесят лучших -
          // иначе превью показывало «ближайшим» пост, который он не возьмёт
          .gte(
            "created_at",
            new Date(Date.now() - RESERVE_TTL_DAYS * 24 * 3600 * 1000).toISOString(),
          )
          .order("score", { ascending: false })
          .limit(60)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("candidates")
      .select("tags, caption_html, attribution, source")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(HISTORY_WINDOW),
    db
      .from("candidates")
      .select("published_at")
      .eq("status", "published")
      .gte("published_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString()),
    // недельные доли архивов, эпох, тем и стран - как у публикатора;
    // страна поста берётся из подписи, поэтому нужна и она
    // доли - за неделю, события - за EVENT_MEMORY_DAYS, как у публикатора
    db
      .from("candidates")
      .select("attribution, source, tags, caption_html, published_at")
      .eq("status", "published")
      .gte(
        "published_at",
        new Date(Date.now() - EVENT_MEMORY_DAYS * 24 * 3600 * 1000).toISOString(),
      ),
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

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const memoryRows = (weekRes.data ?? []) as Array<{
    attribution?: string | null;
    source?: string | null;
    tags?: PlanTags;
    caption_html?: string | null;
    published_at?: string | null;
  }>;
  // архивы и страны - на HISTORY_WINDOW постов, остальное - на ближних
  const historyRows = (recentRes.data ?? []) as Array<{
    tags: PlanTags;
    caption_html?: string | null;
    attribution?: string | null;
    source?: string | null;
  }>;
  const recentRows = historyRows.slice(0, RECENT_WINDOW);
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
        archives: historyRows.map((p) => archiveKey(p.attribution) || (p.source ?? "")),
        rubrics: recentRows.map((p) => p.tags?.rubric ?? ""),
        stories: historyRows.map((p) => p.tags?.story ?? ""),
        nations: historyRows.map((p) => postNation(p)),
        ...weekShares(memoryRows.filter((r) => (r.published_at ?? "") >= weekAgo)),
        weekEvents: recentEvents(memoryRows),
      },
      autoPublish,
      formatScheduled: moscowTime,
      planner:
        feedMode === "on"
          ? (pool, _recent, want) =>
              planGrid(pool, feedHistory(memoryRows, (r) => postNation(r), (r) => eventKeys(r)), want, {
                now: new Date(),
                nationOf: (c) => postNation(c),
                eventsOf: (c) => eventKeys(c),
                homeNation: HOME_NATION,
                postsPerWeek: times.length * 7,
                tasteOf: (c) => tastePenalty(taste, tasteKeys(c, archiveKey(c.attribution) || (c.source ?? ""))),
              })
          : undefined,
    },
    count,
  );
}

/**
 * Пометка удаления редакцией (22.11): по ним бот учится, какой контент
 * редакции не нужен (scripts/editor-taste.ts, вкус в весах архивов и
 * сетке). Раньше удаление отличалось от отсева только отсутствием
 * tags.gate - теперь явно. Сбой пометки не мешает самому удалению.
 */
async function markEditor(
  rows: Array<{ id: number; tags?: Record<string, unknown> | null }> | null | undefined,
  how: string,
): Promise<void> {
  for (const r of rows ?? []) {
    await db
      .from("candidates")
      .update({ tags: { ...(r.tags ?? {}), editor: how, editor_at: new Date().toISOString() } })
      .eq("id", r.id)
      .then(
        () => undefined,
        () => undefined,
      );
  }
}

/** Пометка, откуда пост в плане - объявлена функцией, её зовёт и /status. */
function planMark(kind: string): string {
  if (kind === "scheduled") return "на время";
  if (kind === "approved") return "следующим";
  return "автовыбор";
}

bot.command("queue", async (ctx) => {
  await showPanel(ctx as never, await buildQueue());
});

/**
 * Резерв: разобранные, но ещё не решённые карточки.
 *
 * Отдельная команда нужна потому, что подойти к резерву было нечем:
 * /queue показывает только план публикаций, а /more при пустом резерве
 * уходит собирать новую партию и жжёт Gemini. Здесь - ни одного обращения
 * к модели, только чтение базы.
 *
 * Порядок - по оценке, то есть тот же, в каком резерв разбирает
 * автопостинг: список должен показывать реальную очередь, а не порядок
 * записи в базу.
 */
bot.command("reserve", async (ctx) => {
  await showPanel(ctx as never, await buildReserve(0));
});

bot.command("auto", async (ctx) => {
  await showPanel(ctx as never, await buildSettings());
});

function tidyPanelText(ttl: number): string {
  return (
    `Очистка чата: ${ttl ? `через ${ttl} ч` : "выкл"}` +
    "\nКасается служебных сообщений бота. Карточки постов и канал не затрагиваются."
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
  await showPanel(ctx as never, tidyScreen(await getTidyTtlHours()));
});

bot.command("schedule", async (ctx) => {
  const times = await getPublishTimes();
  await showPanel(ctx as never, { text: schedulePanelText(times), keyboard: { inline_keyboard: panelKeyboard(times) } });
});

/** Запуск сбора свежей партии через GitHub Actions (more.yml). */
async function triggerCollect(): Promise<"ok" | "no_token" | number> {
  if (!GH_PAT) return "no_token";
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
  return res.status === 204 ? "ok" : res.status;
}

function collectReply(r: "ok" | "no_token" | number): string {
  if (r === "ok") return "Сбор запущен. Результат в резерве через ~20 мин.";
  if (r === "no_token") return "Сбор не запущен: нет токена GitHub (GH_PAT). Плановый сбор − 11:05.";
  return `Сбор не запущен: GitHub ${r}. Плановый сбор − 11:05.`;
}

bot.command("more", async (ctx) => {
  await ctx.reply(collectReply(await triggerCollect()));
});

bot.command("published", async (ctx) => {
  await showPanel(ctx as never, await buildPublished());
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
  const { data, error } = await db
    .from("candidates")
    .update({ status: "rejected" })
    .eq("id", id)
    .in("status", ["new", "shown", "approved"])
    .select("id, tags");
  await markEditor(data, "skip_command");
  if (error) throw new Error(error.message);
  await ctx.reply(data?.length ? `Пост #${id} пропущен.` : `#${id}: уже в другом статусе, не тронул.`);
});

bot.command("quote", async (ctx) => {
  const id = repliedCandidateId(ctx);
  const newQuote = ctx.match?.trim();
  if (!id || !newQuote) return;
  const { data: candidate, error } = await db
    .from("candidates")
    .select("caption_html, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!candidate?.caption_html) return;
  if (!["new", "shown", "approved"].includes(candidate.status)) {
    await ctx.reply(`#${id}: пост уже вышел или снят, цитата не изменена.`);
    return;
  }

  const updated = replaceQuote(candidate.caption_html, newQuote);
  const htmlCheck = validateHtml(updated);
  if (!htmlCheck.ok) {
    await ctx.reply(`Не приняла: ${htmlCheck.reason}.`);
    return;
  }
  if (visibleLength(updated) > CAPTION_LIMIT) {
    await ctx.reply(`С такой цитатой подпись длиннее ${CAPTION_LIMIT} символов.`);
    return;
  }
  const { error: updErr } = await db
    .from("candidates")
    .update({ caption_html: updated })
    .eq("id", id)
    .in("status", ["new", "shown", "approved"]);
  if (updErr) throw new Error(updErr.message);
  await ctx.reply(`Пост #${id}: цитата заменена.`);
});

/**
 * /undo больше не удаляет сразу. Раньше команда сносила «последний
 * вышедший» без вопросов: если за секунду до неё публикатор выпустил
 * плановый пост, удалялся он, а не тот, что имел в виду редактор; /undo
 * двух редакторов подряд сносил два поста. Теперь команда называет
 * КОНКРЕТНЫЙ пост (реплаем на карточку - именно его) и удаляет только
 * по кнопке, привязанной к его номеру.
 */
bot.command("undo", async (ctx) => {
  const target = repliedCandidateId(ctx);
  let query = db
    .from("candidates")
    .select("id, channel_msg_id, caption_html, published_at")
    .eq("status", "published")
    .not("channel_msg_id", "is", null);
  query = target ? query.eq("id", target) : query.order("published_at", { ascending: false });
  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  const post = data?.[0];
  if (!post) {
    await ctx.reply(
      target ? `#${target}: в канале его нет − удалять нечего.` : "Опубликованных постов нет − удалять нечего.",
    );
    return;
  }
  await ctx.reply(
    `Удалить из канала пост #${post.id} (вышел ${moscowTime(post.published_at)})?\n` +
      `${headline(post.caption_html)}\nhttps://t.me/${CHANNEL_SLUG}/${post.channel_msg_id}`,
    {
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Удалить из канала", callback_data: `del:${post.id}` },
            { text: "Оставить", callback_data: `keep:${post.id}` },
          ],
        ],
      },
    },
  );
});

// реплай обычным текстом - предложить замену подписи (с подтверждением:
// живой тест показал, что случайный реплай "ok" молча стирал подпись)
/**
 * Вход в меню. /start и /menu ставят нижнюю клавиатуру и открывают
 * сводку; дальше команды знать не нужно.
 */
async function openMenu(ctx: PanelCtx & Ctx): Promise<void> {
  await ctx.reply("Меню закреплено внизу.", {
    reply_markup: MAIN_KEYBOARD,
  });
  await showPanel(ctx, await buildHome());
}

bot.command(["start", "menu"], async (ctx) => {
  await openMenu(ctx as never);
});

// нажатие нижней кнопки приходит обычным текстом «Сводка», «Резерв»...
bot.on("message:text", async (ctx, next) => {
  const section = menuByText(ctx.message.text);
  if (!section) return next();
  // сама надпись кнопки в чате не нужна - убираем, если есть право
  await ctx.deleteMessage().catch(() => {});
  const screen =
    section === "queue"
      ? await buildQueue()
      : section === "reserve"
        ? await buildReserve(0)
        : section === "settings"
          ? await buildSettings()
          : await buildHome();
  await showPanel(ctx as never, screen);
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const id = repliedCandidateId(ctx);
  if (!id) return;

  const text = ctx.message.text.trim();
  if (text.length < 20) {
    await ctx.reply(
      "Не правка: короче 20 символов.\n" +
        "Правка подписи − ответ на карточку полным новым текстом.",
    );
    return;
  }

  const { data: candidate, error } = await db
    .from("candidates")
    .select("caption_html, status")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!candidate?.caption_html) return;
  if (!PUBLISHABLE.includes(candidate.status)) {
    await ctx.reply(`#${id}: пост уже вышел или снят, подпись не изменена.`);
    return;
  }

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
    .eq("id", id)
    .in("status", PUBLISHABLE);
  if (updErr) throw new Error(updErr.message);

  const tag = draftTag(updated);
  await ctx.reply(`Пост #${id}, новая подпись. Применить?\n\n${updated}`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Применить", callback_data: `apply:${id}:${tag}` },
          { text: "Отмена", callback_data: `drop:${id}:${tag}` },
        ],
      ],
    },
  });
});

// секрет обязателен: без него grammY не проверяет заголовок, и любой, кто
// знает адрес функции (она без JWT), подделает апдейт от имени редактора -
// например, /undo снесёт последний пост канала
const handler = webhookCallback(bot, "std/http", {
  secretToken: requireEnv("TG_WEBHOOK_SECRET").trim(),
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
