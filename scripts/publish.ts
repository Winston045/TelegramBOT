/**
 * Этап 7 - публикатор. Крон каждые 15 минут.
 *
 * Если сегодня прошло больше слотов publish.times, чем уже опубликовано, -
 * публикуем верхний пост очереди: сообщение в канал, channel_msg_id в базу,
 * хэш в seen_hashes, подтверждение со ссылкой в чат редакторов.
 * При короткой очереди - предупреждение.
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { env } from "../src/env.js";
import { channelSlug } from "../src/tme.js";
import { countPublishedToday, shouldPublishNow, slotsPassed } from "../src/schedule.js";
import { loadBoolSetting, loadPublishTimes } from "../src/settings.js";
import { isDuplicate } from "../src/dhash.js";
import { LONG_QUOTE, RECENT_WINDOW, archiveKey, planAuto, quoteLength } from "../src/plan.js";
import { isDeadImageError, sendMessageHtml, sendPhotoHtml } from "../src/telegram.js";
import { cleanupChat, rememberEphemeral } from "../src/tidy.js";
import { heartbeatError, heartbeatOk } from "../src/heartbeat.js";

/** Сколько дней кандидат из резерва считается свежим для автопостинга. */
const RESERVE_TTL_DAYS = 10;

/**
 * Чем жила лента последнее время: темы, эпохи, архивы, доля статики и
 * изюминок. Нужен и автопостингу, и очереди одобренных - порядок в ленте
 * решается одинаково, кто бы ни выбрал сам кадр.
 */
async function recentContext(db: ReturnType<typeof getDb>, now: Date) {
  const { data: lastPosts } = await db
    .from("candidates")
    .select("tags, caption_html, attribution, source")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(RECENT_WINDOW);
  const posts = lastPosts ?? [];

  // доли архивов за неделю: лента не должна быть «в среднем немецкой»,
  // даже если соседние посты честно чередуются
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: weekPosts } = await db
    .from("candidates")
    .select("attribution, source")
    .eq("status", "published")
    .gte("published_at", weekAgo);
  const week = weekPosts ?? [];
  const archiveShare: Record<string, number> = {};
  for (const p of week) {
    const key =
      archiveKey((p as { attribution?: string | null }).attribution) ||
      ((p as { source?: string | null }).source ?? "");
    if (key) archiveShare[key] = (archiveShare[key] ?? 0) + 1;
  }
  for (const key of Object.keys(archiveShare)) {
    archiveShare[key] = (archiveShare[key] ?? 0) / Math.max(1, week.length);
  }

  return {
    subjects: posts
      .map((p) => (p.tags as { subject?: string } | null)?.subject)
      .filter((s): s is string => Boolean(s)),
    periods: posts.map((p) => (p.tags as { period?: string } | null)?.period ?? ""),
    civilian: posts.some((p) => (p.tags as { military?: boolean } | null)?.military === false),
    statics: posts.filter((p) => (p.tags as { action?: boolean } | null)?.action === false).length,
    longs: posts.filter(
      (p) => quoteLength((p as { caption_html?: string | null }).caption_html ?? null) >= LONG_QUOTE,
    ).length,
    archives: posts.map(
      (p) =>
        archiveKey((p as { attribution?: string | null }).attribution) ||
        ((p as { source?: string | null }).source ?? ""),
    ),
    archiveShare,
  };
}

async function main() {
  const cfg = loadConfig();
  const db = getDb();
  const now = new Date();
  // заодно подчищаем созревшие служебные сообщения (/tidy в боте)
  const cleaned = await cleanupChat(db);
  if (cleaned) console.log(`автоочистка чата: удалено ${cleaned}`);
  const tz = cfg.publish.timezone;
  // расписание, выставленное редакторами в боте, перекрывает config.yaml
  const times = await loadPublishTimes(cfg.publish.times);

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
    if (!shouldPublishNow(now, times, tz, publishedToday)) {
      console.log(`слот не наступил (сегодня опубликовано: ${publishedToday})`);
      await heartbeatOk("publisher");
      return;
    }

    // одобренные без своего времени. Порядок внутри очереди решает
    // планировщик, а не номер карточки: редактор говорит, ЧТО достойно
    // канала, а чередование архивов, эпох и тем - забота ленты. До 13.08
    // здесь стоял простой order by id, и все правила разнообразия
    // работали только в автопостинге (живой случай 12.08: два кадра
    // Бундесархива подряд, хотя в очереди ждал британский)
    const res = await db
      .from("candidates")
      .select("id, image_url, image_hash, caption_html, score, tags, attribution, source")
      .eq("status", "approved")
      .not("caption_html", "is", null)
      .is("scheduled_at", null)
      .order("id", { ascending: true })
      .limit(20);
    if (res.error) throw new Error(`чтение очереди: ${res.error.message}`);
    const approved = res.data ?? [];
    if (approved.length) {
      const recent = await recentContext(db, now);
      const [pick] = planAuto(approved, recent, 1);
      const chosen = pick ? approved.find((c) => c.id === pick.id) : approved[0];
      queue = chosen ? [chosen] : [];
      if (chosen && approved.length > 1) {
        console.log(`очередь одобренных: выбран #${chosen.id} из ${approved.length}`);
      }
    } else {
      queue = [];
    }
  }

  // полная автоматизация (тумблер /auto в боте): очередь одобренных пуста -
  // берём лучший неопубликованный кандидат без аппрува админов
  const autoPublish = await loadBoolSetting("auto_publish", cfg.publish.auto_publish);
  let autoPicked = false;
  if (!queue?.length && autoPublish) {
    const res = await db
      .from("candidates")
      .select("id, image_url, image_hash, caption_html, score, tags, attribution, source")
      .in("status", ["new", "shown"])
      .not("caption_html", "is", null)
      // срок годности резерва: у старых кадров чаще мертвеет ссылка
      // архива, а оформление отстаёт от текущих правил
      .gte("created_at", new Date(now.getTime() - RESERVE_TTL_DAYS * 24 * 3600 * 1000).toISOString())
      .order("score", { ascending: false })
      .limit(20);
    if (res.error) throw new Error(`чтение кандидатов автопостинга: ${res.error.message}`);
    // без глаз редактора хэш сверяем ещё раз прямо перед публикацией:
    // в резерве могут лежать кадры, собранные до пополнения базы дедупа
    const { data: seen, error: seenErr } = await db.from("seen_hashes").select("image_hash");
    if (seenErr) throw new Error(`чтение seen_hashes: ${seenErr.message}`);
    const seenHashes = (seen ?? []).map((r) => r.image_hash as string);

    // темы последних постов: три парома «Зибель» подряд формально разные
    // кадры, а в ленте выглядят одним и тем же - такие темы придерживаем
    const recent = await recentContext(db, now);

    // битые кадры выкидываем до планировщика: он решает только «что интереснее»
    const alive: typeof res.data = [];
    for (const cand of res.data ?? []) {
      if (seenHashes.some((h) => isDuplicate(h, cand.image_hash))) {
        await db.from("candidates").update({ status: "rejected" }).eq("id", cand.id);
        console.log(`автопостинг: #${cand.id} - дубликат уже вышедшего, отклонён`);
        continue;
      }
      alive.push(cand);
    }

    // тот же планировщик, что показывает /queue - предпросмотр не врёт
    const [pick] = planAuto(alive, recent, 1);
    if (pick) {
      queue = alive.filter((c) => c.id === pick.id);
      autoPicked = true;
      console.log(`автопостинг: выбран #${pick.id} (тема "${pick.tags?.subject ?? "-"}")`);
    }
  }

  const post = queue?.[0];
  if (!post) {
    // если всё в очереди запланировано на будущее - это не пустая очередь
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
    // предупреждаем один раз на слот: крон ходит каждые 15 минут, и без
    // этой защиты пустая очередь превращается в спам (живой прогон)
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const slotKey = `${ymd}:${slotsPassed(now, times, tz)}`;
    const { data: warned } = await db
      .from("settings")
      .select("value")
      .eq("key", "empty_queue_warned")
      .maybeSingle();
    if (warned?.value === slotKey) {
      console.log(`слот наступил, очередь пуста — уже предупреждали (${slotKey})`);
      await heartbeatOk("publisher");
      return;
    }
    console.log("слот наступил, но очередь пуста");
    await sendMessageHtml(
      env.editorsChatId,
      autoPublish
        ? "Слот публикации пропущен: готовых кандидатов нет совсем. Автодобор возьмётся за это сам в ближайшие часы; ускорить - /more."
        : "Слот публикации пропущен: очередь пуста. Одобрите кандидатов.",
    );
    await db.from("settings").upsert({
      key: "empty_queue_warned",
      value: slotKey,
      updated_at: new Date().toISOString(),
    });
    await heartbeatOk("publisher");
    return;
  }

  // битая ссылка на фото не должна вечно блокировать очередь: архивы
  // иногда перекладывают файлы, пока пост ждёт публикации
  let msgId: number;
  try {
    msgId = await sendPhotoHtml(env.channelId, post.image_url, post.caption_html);
  } catch (err) {
    const msg = (err as Error).message;
    if (!isDeadImageError(msg)) throw err; // временная ошибка телеграма - пробуем в следующий заход
    await db.from("candidates").update({ status: "failed" }).eq("id", post.id);
    await sendMessageHtml(
      env.editorsChatId,
      `Пост #${post.id} не отправился: архив больше не отдаёт фото. Помечен браком, очередь едет дальше.`,
    );
    console.warn(`битая ссылка у #${post.id}: ${msg}`);
    await heartbeatOk("publisher");
    return;
  }

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

  // ссылка - на канал, куда реально публикуем (env), а не из config:
  // в тестовом режиме это разные каналы
  const target = env.channelId.startsWith("@") ? env.channelId : cfg.channel.id;
  const postUrl = `https://t.me/${channelSlug(target)}/${msgId}`;
  const { count } = await db
    .from("candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved");
  const left = count ?? 0;

  let confirmation = autoPicked
    ? `Автопостинг: опубликован пост #${post.id} (выбран ботом): ${postUrl}\nВ очереди осталось: ${left}.`
    : `Опубликован пост #${post.id}: ${postUrl}\nВ очереди осталось: ${left}.`;
  if (left < cfg.publish.min_queue_warning) {
    confirmation += `\nОчередь короче ${cfg.publish.min_queue_warning} - стоит одобрить ещё.`;
  }
  const confirmId = await sendMessageHtml(env.editorsChatId, confirmation);
  await rememberEphemeral(db, env.editorsChatId, confirmId);

  console.log(`опубликован #${post.id} → ${postUrl}`);
  await heartbeatOk("publisher");
}

main().catch(async (err) => {
  console.error("публикатор упал:", err);
  try {
    await heartbeatError("publisher", String(err));
  } catch {
    // база недоступна - heartbeat-проверка увидит устаревший last_ok
  }
  process.exit(1);
});
