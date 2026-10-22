/**
 * Этап 7 - публикатор. Крон каждые 15 минут.
 *
 * Если сегодня прошло больше слотов publish.times, чем уже опубликовано, -
 * публикуем верхний пост очереди: сообщение в канал, channel_msg_id в базу,
 * хэш в seen_hashes, подтверждение со ссылкой в чат редакторов.
 * При короткой очереди - предупреждение.
 */
import { loadConfig } from "../src/config.js";
import { getDb, loadKnownHashes } from "../src/db.js";
import { env } from "../src/env.js";
import { channelSlug } from "../src/tme.js";
import { countPublishedToday, shouldPublishNow, slotsPassed } from "../src/schedule.js";
import { loadBoolSetting, loadPublishTimes } from "../src/settings.js";
import { isDuplicate } from "../src/dhash.js";
import {
  approvedPriority,
  LONG_QUOTE,
  RECENT_WINDOW,
  RESERVE_TTL_DAYS,
  archiveKey,
  planAuto,
  postNation,
  quoteLength,
  weekShares,
} from "../src/plan.js";
import { escapeHtml, isPermanentSendError, sendMessageHtml, sendPhotoHtml } from "../src/telegram.js";
import { cleanupChat, rememberEphemeral } from "../src/tidy.js";
import { heartbeatError, heartbeatOk } from "../src/heartbeat.js";

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
    .select("attribution, source, tags, caption_html")
    .eq("status", "published")
    .gte("published_at", weekAgo);
  // доли эпох (замер 24.08: ВМВ 70% и девятки подряд) и тем (замер
  // 15.09: infantry 30% и тройка подряд) считаются тем же счётчиком
  const shares = weekShares(
    (weekPosts ?? []) as Array<{
      attribution?: string | null;
      source?: string | null;
      tags?: { period?: string; subject?: string; rubric?: string } | null;
      caption_html?: string | null;
    }>,
  );

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
    rubrics: posts.map((p) => (p.tags as { rubric?: string } | null)?.rubric ?? ""),
    // страна поста - по тому, о ком подпись, а не по архиву
    nations: posts.map((p) =>
      postNation(p as { caption_html?: string | null; attribution?: string | null; source?: string | null }),
    ),
    ...shares,
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
    .select("id, image_url, image_hash, caption_html, status")
    .eq("status", "approved")
    .not("caption_html", "is", null)
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(1);
  if (dueErr) throw new Error(`чтение запланированных: ${dueErr.message}`);

  let queue = due;
  const autoPublish = await loadBoolSetting("auto_publish", cfg.publish.auto_publish);
  let autoPicked = false;

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
      .select("id, image_url, image_hash, caption_html, score, tags, attribution, source, status, created_at")
      .eq("status", "approved")
      .not("caption_html", "is", null)
      .is("scheduled_at", null)
      .order("id", { ascending: true })
      .limit(20);
    if (res.error) throw new Error(`чтение очереди: ${res.error.message}`);

    // хэш сверяем ещё раз прямо перед публикацией - и у резерва, и у
    // одобренных: одно фото приходит из двух источников (Commons и LOC),
    // а общий пул пускает резервную копию раньше одобренной. Сверка - по
    // ВСЕЙ таблице: одним запросом Supabase отдавал лишь первую тысячу
    // хэшей из ~4400 истории канала
    const seenHashes = await loadKnownHashes(db);
    const dropDuplicates = async <T extends { id: number; image_hash: string }>(
      rows: T[],
      kind: string,
    ): Promise<T[]> => {
      const alive: T[] = [];
      for (const cand of rows) {
        if (seenHashes.some((h) => isDuplicate(h, cand.image_hash))) {
          await db.from("candidates").update({ status: "rejected" }).eq("id", cand.id);
          console.log(`${kind}: #${cand.id} - дубликат уже вышедшего, отклонён`);
          continue;
        }
        alive.push(cand);
      }
      return alive;
    };
    const approved = await dropDuplicates(res.data ?? [], "очередь одобренных");

    // полная автоматизация (тумблер /auto в боте): резерв собранных без
    // аппрува кадров. Раньше он рассматривался, только когда одобренная
    // очередь пуста, - и правила разнообразия работали на пуле из
    // нескольких одобренных (см. APPROVED_PRIORITY). Теперь пул общий:
    // одобренный выходит первым, пока не даёт повтора
    let reserve: typeof approved = [];
    if (autoPublish) {
      const rres = await db
        .from("candidates")
        .select("id, image_url, image_hash, caption_html, score, tags, attribution, source, status, created_at")
        .in("status", ["new", "shown"])
        .not("caption_html", "is", null)
        // срок годности резерва: у старых кадров чаще мертвеет ссылка
        // архива, а оформление отстаёт от текущих правил
        .gte("created_at", new Date(now.getTime() - RESERVE_TTL_DAYS * 24 * 3600 * 1000).toISOString())
        .order("score", { ascending: false })
        .limit(20);
      if (rres.error) throw new Error(`чтение кандидатов автопостинга: ${rres.error.message}`);
      // дубли выкидываем до планировщика: он решает только «что интереснее»
      reserve = await dropDuplicates(rres.data ?? [], "автопостинг");
    }

    if (approved.length || reserve.length) {
      // темы последних постов: три парома «Зибель» подряд формально разные
      // кадры, а в ленте выглядят одним и тем же - такие темы придерживаем
      const recent = await recentContext(db, now);
      const approvedIds = new Set(approved.map((c) => c.id));
      const pool = [
        ...approved.map((c) => ({ ...c, priority: approvedPriority(c.created_at, now) })),
        ...reserve,
      ];
      // тот же планировщик, что показывает /queue - предпросмотр не врёт
      const [pick] = planAuto(pool, recent, 1);
      const chosen = pick ? [...approved, ...reserve].find((c) => c.id === pick.id) : undefined;
      queue = chosen ? [chosen] : [];
      if (chosen) {
        autoPicked = !approvedIds.has(chosen.id);
        console.log(
          autoPicked
            ? `автопостинг: выбран #${chosen.id} (тема "${chosen.tags?.subject ?? "-"}")` +
                (approved.length ? ` - одобренные дали бы повтор, их ${approved.length}` : "")
            : `очередь одобренных: выбран #${chosen.id} из ${approved.length}`,
        );
      }
    } else {
      queue = [];
    }
  }

  const post = queue?.[0];
  if (!post) {
    // если очередь ждёт поста, назначенного на ближайшие сутки, - это не
    // пустая очередь. Пост на следующую пятницу молчать до пятницы не
    // разрешает: раньше любой запланированный глушил предупреждение
    const { count: future } = await db
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", "approved")
      .not("caption_html", "is", null)
      .gt("scheduled_at", now.toISOString())
      .lte("scheduled_at", new Date(now.getTime() + 24 * 3600 * 1000).toISOString());
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

  // Строку ЗАХВАТЫВАЕМ до отправки: условное обновление в published из
  // того статуса, в каком мы её прочитали. Раньше фото уходило первым, а
  // пометка - потом, и сбой базы между ними (такой был 15.10: «Project not
  // specified.») оставлял пост в очереди: через 15 минут он выходил
  // второй раз. Кнопка «Сейчас» в боте захватывает так же, поэтому и
  // гонка «бот и публикатор в одну секунду» даёт один пост, а не два
  const { data: claimed, error: claimErr } = await db
    .from("candidates")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", post.id)
    .eq("status", post.status)
    .select("id");
  if (claimErr) throw new Error(`захват #${post.id}: ${claimErr.message}`);
  if (!claimed?.length) {
    console.log(`#${post.id} забрал кто-то раньше (бот или другой заход) - этот слот пропускаю`);
    await heartbeatOk("publisher");
    return;
  }

  let msgId: number;
  try {
    msgId = await sendPhotoHtml(env.channelId, post.image_url, post.caption_html);
  } catch (err) {
    const msg = (err as Error).message;
    if (!isPermanentSendError(err)) {
      // временная беда Телеграма или сети - возвращаем пост в очередь как
      // был, следующий заход попробует снова
      await db
        .from("candidates")
        .update({ status: post.status, published_at: null })
        .eq("id", post.id)
        .eq("status", "published")
        .is("channel_msg_id", null);
      throw err;
    }
    // этот пост не уйдёт и на повторе (мёртвая ссылка, фото не
    // обработалось, подпись не разобралась) - брак, очередь едет дальше
    await db
      .from("candidates")
      .update({ status: "failed", published_at: null })
      .eq("id", post.id)
      .eq("status", "published")
      .is("channel_msg_id", null);
    await sendMessageHtml(
      env.editorsChatId,
      `Пост #${post.id} не отправился и помечен браком, очередь едет дальше. Телеграм ответил: ${escapeHtml(msg.slice(0, 200))}`,
    );
    console.warn(`брак при отправке #${post.id}: ${msg}`);
    await heartbeatOk("publisher");
    return;
  }

  // пост уже в канале: номер сообщения обязан дойти до базы, иначе /undo
  // и «Удалить из канала» его не найдут. Сбой сети - повторяем
  for (let attempt = 1; ; attempt++) {
    const { error: updErr } = await db
      .from("candidates")
      .update({ channel_msg_id: msgId })
      .eq("id", post.id);
    if (!updErr) break;
    if (attempt >= 3) {
      await sendMessageHtml(
        env.editorsChatId,
        `Пост #${post.id} вышел в канал (сообщение ${msgId}), но номер не записался в базу - /undo его не найдёт.`,
      ).catch(() => undefined);
      throw new Error(`номер сообщения #${post.id}: ${updErr.message}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }

  const { error: hashErr } = await db
    .from("seen_hashes")
    .upsert(
      { image_hash: post.image_hash, origin: "published" },
      { onConflict: "image_hash", ignoreDuplicates: true },
    );
  // пост уже вышел и помечен - падать из-за хэша незачем, но знать надо
  if (hashErr) console.warn(`запись seen_hashes для #${post.id}: ${hashErr.message}`);

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
