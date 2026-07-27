/**
 * Этап 7 — публикатор. Крон каждые 15 минут.
 *
 * Если сегодня прошло больше слотов publish.times, чем уже опубликовано, —
 * публикуем верхний пост очереди: сообщение в канал, channel_msg_id в базу,
 * хэш в seen_hashes, подтверждение со ссылкой в чат редакторов.
 * При короткой очереди — предупреждение.
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { env } from "../src/env.js";
import { channelSlug } from "../src/tme.js";
import { countPublishedToday, shouldPublishNow } from "../src/schedule.js";
import { sendMessageHtml, sendPhotoHtml } from "../src/telegram.js";
import { heartbeatError, heartbeatOk } from "../src/heartbeat.js";

async function main() {
  const cfg = loadConfig();
  const db = getDb();
  const now = new Date();
  const tz = cfg.publish.timezone;

  // опубликованное за последние 48 часов достаточно, чтобы посчитать «сегодня»
  const twoDaysAgo = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const { data: recent, error: recErr } = await db
    .from("candidates")
    .select("published_at")
    .eq("status", "published")
    .gte("published_at", twoDaysAgo);
  if (recErr) throw new Error(`чтение публикаций: ${recErr.message}`);

  const publishedToday = countPublishedToday(
    recent.map((r) => r.published_at),
    now,
    tz,
  );

  // запланированные на конкретное время публикуются, как только оно наступило,
  // вне зависимости от слотов
  const { data: due, error: dueErr } = await db
    .from("candidates")
    .select("id, image_url, image_hash, caption_html")
    .eq("status", "approved")
    .not("caption_html", "is", null)
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1);
  if (dueErr) throw new Error(`чтение запланированных: ${dueErr.message}`);

  let queue = due;

  if (!queue?.length) {
    if (!shouldPublishNow(now, cfg.publish.times, tz, publishedToday)) {
      console.log(`слот не наступил (сегодня опубликовано: ${publishedToday})`);
      await heartbeatOk("publisher");
      return;
    }

    // верхний пост очереди: одобренные без своего времени, в порядке одобрения
    const res = await db
      .from("candidates")
      .select("id, image_url, image_hash, caption_html")
      .eq("status", "approved")
      .not("caption_html", "is", null)
      .is("scheduled_at", null)
      .order("id", { ascending: true })
      .limit(1);
    if (res.error) throw new Error(`чтение очереди: ${res.error.message}`);
    queue = res.data;
  }

  // auto_publish: без аппрува берём лучший из new
  if (!queue?.length && cfg.publish.auto_publish) {
    const res = await db
      .from("candidates")
      .select("id, image_url, image_hash, caption_html")
      .eq("status", "new")
      .not("caption_html", "is", null)
      .order("score", { ascending: false })
      .limit(1);
    if (res.error) throw new Error(`чтение new: ${res.error.message}`);
    queue = res.data;
  }

  const post = queue?.[0];
  if (!post) {
    // если всё в очереди запланировано на будущее — это не пустая очередь
    const { count: future } = await db
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", "approved")
      .not("scheduled_at", "is", null);
    if (future && future > 0) {
      console.log(`слот наступил, но все ${future} в очереди ждут своего времени`);
      await heartbeatOk("publisher");
      return;
    }
    console.log("слот наступил, но очередь пуста");
    await sendMessageHtml(
      env.editorsChatId,
      "Слот публикации пропущен: очередь пуста. Одобрите кандидатов.",
    );
    await heartbeatOk("publisher");
    return;
  }

  const msgId = await sendPhotoHtml(env.channelId, post.image_url, post.caption_html);

  const { error: updErr } = await db
    .from("candidates")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      channel_msg_id: msgId,
    })
    .eq("id", post.id);
  if (updErr) throw new Error(`пометка published #${post.id}: ${updErr.message}`);

  const { error: hashErr } = await db
    .from("seen_hashes")
    .upsert(
      { image_hash: post.image_hash, origin: "published" },
      { onConflict: "image_hash", ignoreDuplicates: true },
    );
  if (hashErr) throw new Error(`запись seen_hashes: ${hashErr.message}`);

  // ссылка — на канал, куда реально публикуем (env), а не из config:
  // в тестовом режиме это разные каналы
  const target = env.channelId.startsWith("@") ? env.channelId : cfg.channel.id;
  const postUrl = `https://t.me/${channelSlug(target)}/${msgId}`;
  const { count } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved");
  const left = count ?? 0;

  let confirmation = `Опубликован пост #${post.id}: ${postUrl}\nВ очереди осталось: ${left}.`;
  if (left < cfg.publish.min_queue_warning) {
    confirmation += `\nОчередь короче ${cfg.publish.min_queue_warning} — стоит одобрить ещё.`;
  }
  await sendMessageHtml(env.editorsChatId, confirmation);

  console.log(`опубликован #${post.id} → ${postUrl}`);
  await heartbeatOk("publisher");
}

main().catch(async (err) => {
  console.error("публикатор упал:", err);
  try {
    await heartbeatError("publisher", String(err));
  } catch {
    // база недоступна — heartbeat-проверка увидит устаревший last_ok
  }
  process.exit(1);
});
