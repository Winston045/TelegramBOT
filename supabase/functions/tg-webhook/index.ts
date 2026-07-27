/**
 * Этап 6 — вебхук бота (Supabase Edge Function, Deno + grammY).
 *
 * Команды редакторов (все — только из вайтлиста EDITOR_USER_IDS,
 * остальных молча игнорируем):
 *   /ok      (реплай) — кандидата в очередь публикации
 *   /skip    (реплай) — в отказ
 *   /quote t (реплай) — заменить только цитату
 *   текст    (реплай) — заменить подпись целиком (entities → HTML)
 *   /queue            — сколько постов в очереди
 *   /undo             — удалить последний опубликованный
 *
 * Деплой:  supabase functions deploy tg-webhook --no-verify-jwt
 * Вебхук:  https://api.telegram.org/bot<TOKEN>/setWebhook
 *            ?url=https://<project>.supabase.co/functions/v1/tg-webhook
 *            &secret_token=<TG_WEBHOOK_SECRET>
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

/** Тестовый режим: /ok публикует сразу, минуя очередь и слоты. */
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
const EDITORS = new Set(
  requireEnv("EDITOR_USER_IDS")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n)),
);

// не редактор — молча игнорируем
bot.use((ctx, next) => {
  if (ctx.from && EDITORS.has(ctx.from.id)) return next();
});

type Ctx = Parameters<Parameters<typeof bot.command>[1]>[0];

function repliedCandidateId(ctx: Ctx): number | undefined {
  const replied = ctx.message?.reply_to_message;
  return parseCandidateId(replied?.caption ?? replied?.text ?? undefined);
}

async function loadCandidate(id: number) {
  const { data, error } = await db
    .from("candidates")
    .select("id, status, caption_html, channel_msg_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

bot.command("ok", async (ctx) => {
  const id = repliedCandidateId(ctx);
  if (!id) return;
  const { data, error } = await db
    .from("candidates")
    .update({ status: "approved" })
    .eq("id", id)
    .in("status", ["new", "shown", "rejected"])
    .select("id, image_url, image_hash, caption_html");
  if (error) throw new Error(error.message);
  const approved = data[0];
  if (!approved) {
    await ctx.reply(`#${id}: уже в другом статусе, не тронул`);
    return;
  }

  if (INSTANT_PUBLISH && approved.caption_html) {
    const msg = await ctx.api.sendPhoto(CHANNEL_ID, approved.image_url, {
      caption: approved.caption_html,
      parse_mode: "HTML",
    });
    await db
      .from("candidates")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        channel_msg_id: msg.message_id,
      })
      .eq("id", id);
    await db.from("seen_hashes").upsert(
      { image_hash: approved.image_hash, origin: "published" },
      { onConflict: "image_hash", ignoreDuplicates: true },
    );
    const slug = CHANNEL_ID.replace(/^@/, "");
    await ctx.reply(
      `🚀 #${id} опубликован сразу (тестовый режим): https://t.me/${slug}/${msg.message_id}`,
    );
    return;
  }

  const { count } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved");
  await ctx.reply(`✅ #${id} в очереди публикации (всего: ${count ?? "?"})`);
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
  await ctx.reply(`🚫 #${id} в отказе`);
});

bot.command("quote", async (ctx) => {
  const id = repliedCandidateId(ctx);
  const newQuote = ctx.match?.trim();
  if (!id || !newQuote) return;
  const candidate = await loadCandidate(id);
  if (!candidate?.caption_html) return;

  const updated = replaceQuote(candidate.caption_html, newQuote);
  if (visibleLength(updated) > CAPTION_LIMIT) {
    await ctx.reply(`✋ с такой цитатой подпись длиннее ${CAPTION_LIMIT} символов`);
    return;
  }
  const { error } = await db
    .from("candidates")
    .update({ caption_html: updated })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await ctx.reply(`✏️ #${id}: цитата заменена`);
});

bot.command("queue", async (ctx) => {
  const { count, error } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved");
  if (error) throw new Error(error.message);
  await ctx.reply(`в очереди публикации: ${count ?? 0}`);
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
    await ctx.reply("нечего удалять: опубликованных нет");
    return;
  }
  await ctx.api.deleteMessage(CHANNEL_ID, Number(last.channel_msg_id));
  const { error: updErr } = await db
    .from("candidates")
    .update({ status: "rejected" })
    .eq("id", last.id);
  if (updErr) throw new Error(updErr.message);
  await ctx.reply(`↩️ пост #${last.id} удалён из канала`);
});

// реплай обычным текстом — заменить подпись целиком
bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const id = repliedCandidateId(ctx);
  if (!id) return;
  const candidate = await loadCandidate(id);
  if (!candidate?.caption_html) return;

  const bodyHtml = entitiesToHtml(ctx.message.text, ctx.message.entities ?? []);
  const updated = replaceBody(candidate.caption_html, bodyHtml);

  const htmlCheck = validateHtml(updated);
  if (!htmlCheck.ok) {
    await ctx.reply(`✋ не принял: ${htmlCheck.reason}`);
    return;
  }
  if (visibleLength(updated) > CAPTION_LIMIT) {
    await ctx.reply(`✋ не принял: длиннее ${CAPTION_LIMIT} символов`);
    return;
  }

  const { error } = await db
    .from("candidates")
    .update({ caption_html: updated })
    .eq("id", id);
  if (error) throw new Error(error.message);
  await ctx.reply(`✏️ #${id}: подпись заменена`);
});

const handler = webhookCallback(bot, "std/http", {
  secretToken: Deno.env.get("TG_WEBHOOK_SECRET") || undefined,
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
