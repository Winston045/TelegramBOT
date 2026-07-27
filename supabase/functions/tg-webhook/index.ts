/**
 * Вебхук бота (Supabase Edge Function, Deno + grammY) — админ-панель в чате.
 *
 * Кнопки под карточками: Одобрить / Мимо. В очереди: Сейчас / Убрать.
 * У опубликованных: Удалить из канала.
 *
 * Команды (только вайтлист EDITOR_USER_IDS, остальных молча игнорируем):
 *   /status           — сводка: черновики, очередь, вышло, сбор, дедуп
 *   /queue            — очередь с кнопками
 *   /published        — последние вышедшие с кнопками удаления
 *   /ok, /skip        — то же, что кнопки (реплаем на карточку)
 *   /quote <текст>    — заменить цитату (реплаем)
 *   текст реплаем     — заменить подпись целиком
 *   /undo             — удалить последний опубликованный
 *
 * Деплой: workflow deploy-webhook (ставит и вебхук с callback_query).
 */
import { Bot, webhookCallback } from "npm:grammy@1.45.1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { entitiesToHtml } from "../_shared/entities.ts";
import { parseCandidateId } from "../_shared/service_line.ts";
import { replaceBody, replaceQuote } from "../_shared/edit_caption.ts";
import { CAPTION_LIMIT, validateHtml, visibleLength } from "../_shared/validate.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`переменная окружения ${name} не задана`);
  return v;
}

/** Тестовый режим: одобрение публикует сразу, минуя очередь и слоты. */
const INSTANT_PUBLISH = (Deno.env.get("INSTANT_PUBLISH") ?? "").trim() === "true";

const bot = new Bot(requireEnv("BOT_TOKEN"));
// имена с префиксом SUPABASE_ в secrets функций зарезервированы, поэтому
// свой ключ туда не положить — берём служебный, он всегда есть в среде
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

// не редактор — молча игнорируем (и сообщения, и нажатия кнопок)
bot.use((ctx, next) => {
  if (ctx.from && EDITORS.has(ctx.from.id)) return next();
});

type Ctx = Parameters<Parameters<typeof bot.command>[1]>[0];

function repliedCandidateId(ctx: Ctx): number | undefined {
  const replied = ctx.message?.reply_to_message;
  return parseCandidateId(replied?.caption ?? replied?.text ?? undefined);
}

/** Заголовок кандидата для списков: жирная часть подписи без тегов. */
function headline(captionHtml: string | null): string {
  if (!captionHtml) return "(без подписи)";
  const text = captionHtml.replace(/<[^>]+>/g, "").split("\n")[0] ?? "";
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

function moscowTime(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
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
          ? `Опубликовано — ${who}`
          : `В очереди — ${who}`;
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
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Пропущено — ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Пропущено" });
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
          reply_markup: doneKeyboard(`Опубликовано — ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Опубликовано" });
        await ctx.reply(`Пост #${id} опубликован: ${url}`);
        return;
      }
      case "rm": {
        const { data } = await db
          .from("candidates")
          .update({ status: "rejected" })
          .eq("id", id)
          .eq("status", "approved")
          .select("id");
        if (!data?.length) {
          await ctx.answerCallbackQuery({ text: "Уже обработано" });
          return;
        }
        await ctx.editMessageReplyMarkup({
          reply_markup: doneKeyboard(`Убрано из очереди — ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Убрано из очереди" });
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
          reply_markup: doneKeyboard(`Удалено из канала — ${who}`),
        });
        await ctx.answerCallbackQuery({ text: "Удалено из канала" });
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
  const [fresh, shown, queued, published] = await Promise.all([
    countByStatus("new"),
    countByStatus("shown"),
    countByStatus("approved"),
    countByStatus("published"),
  ]);
  const { count: seen } = await db
    .from("seen_hashes")
    .select("image_hash", { count: "exact", head: true });
  const { data: hb } = await db
    .from("heartbeats")
    .select("job, last_ok, last_error")
    .eq("job", "collector")
    .maybeSingle();

  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: today } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", "published")
    .gte("published_at", dayAgo);

  const lines = [
    "Сводка",
    "",
    `Черновиков на разборе в чате: ${shown}`,
    `Собрано, ещё не отправлено: ${fresh}`,
    `В очереди публикации: ${queued}`,
    `Вышло за сутки: ${today ?? 0} (всего: ${published})`,
    "",
    `Последний сбор: ${moscowTime(hb?.last_ok ?? null)}${hb?.last_error ? " — была ошибка" : ""}`,
    `База дедупа: ${seen ?? 0} фото`,
    "",
    INSTANT_PUBLISH
      ? "Режим: тестовый — одобрение публикует сразу"
      : "Режим: боевой — публикация по расписанию",
  ];
  await ctx.reply(lines.join("\n"));
});

bot.command("queue", async (ctx) => {
  const { data, error } = await db
    .from("candidates")
    .select("id, caption_html")
    .eq("status", "approved")
    .order("id", { ascending: true })
    .limit(10);
  if (error) throw new Error(error.message);
  if (!data.length) {
    await ctx.reply("Очередь пуста.");
    return;
  }
  await ctx.reply(`В очереди: ${data.length}. Порядок публикации сверху вниз.`);
  for (const c of data) {
    await ctx.reply(`#${c.id}. ${headline(c.caption_html)}`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Опубликовать сейчас", callback_data: `now:${c.id}` },
            { text: "Убрать", callback_data: `rm:${c.id}` },
          ],
        ],
      },
    });
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
    await ctx.reply("Опубликованных постов нет — удалять нечего.");
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

// реплай обычным текстом — заменить подпись целиком
bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const id = repliedCandidateId(ctx);
  if (!id) return;
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
    await ctx.reply(`Не принял: ${htmlCheck.reason}.`);
    return;
  }
  if (visibleLength(updated) > CAPTION_LIMIT) {
    await ctx.reply(`Не принял: длиннее ${CAPTION_LIMIT} символов.`);
    return;
  }

  const { error: updErr } = await db
    .from("candidates")
    .update({ caption_html: updated })
    .eq("id", id);
  if (updErr) throw new Error(updErr.message);
  await ctx.reply(`Пост #${id}: подпись заменена.`);
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
