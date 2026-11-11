/**
 * Разведка публичного канала по t.me без аккаунта: сколько сообщений
 * видно в ленте t.me/s, есть ли у них текст, и что отдают отдельные
 * посты (?embed=1). Нужна, когда обычная выгрузка (channel-posts.ts)
 * вернула пусто и неясно почему.
 *
 * Запуск: npx tsx scripts/tg-peek.ts tgHisto
 */
const slug = (process.argv[2] ?? "").replace(/^@/, "");

const strip = (html: string) =>
  html
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .trim();

async function get(url: string): Promise<{ status: number; html: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; story-team-bot/0.1)", "accept-language": "ru" },
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, html: await res.text() };
}

async function main() {
  if (!/^[A-Za-z0-9_]{4,64}$/.test(slug)) throw new Error("имя канала: латиница, цифры, _");
  const feed = await get(`https://t.me/s/${slug}`);
  const ids = [...feed.html.matchAll(/data-post="[^/"]+\/(\d+)"/g)].map((m) => Number(m[1]));
  console.log(`лента t.me/s/${slug}: HTTP ${feed.status}, ${feed.html.length} байт, сообщений ${ids.length}`);
  const redirected = /tgme_page_title/.test(feed.html) && !ids.length;
  if (redirected) console.log("  лента не открылась - Телеграм показал карточку канала вместо неё");

  const chunks = feed.html.split('class="tgme_widget_message_wrap').slice(1);
  for (const c of chunks) {
    const id = c.match(/data-post="[^/"]+\/(\d+)"/)?.[1];
    const date = c.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? "?";
    const text = strip(c.match(/tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
    const media = [
      /tgme_widget_message_photo/.test(c) ? "фото" : "",
      /tgme_widget_message_video/.test(c) ? "видео" : "",
      /tgme_widget_message_document/.test(c) ? "файл" : "",
      /tgme_widget_message_poll/.test(c) ? "опрос" : "",
      /tgme_widget_message_grouped/.test(c) ? "альбом" : "",
    ]
      .filter(Boolean)
      .join("+");
    const views = c.match(/tgme_widget_message_views">([^<]+)/)?.[1] ?? "?";
    console.log(`\n── #${id} ${date} [${media || "текст"}] просмотров ${views}`);
    console.log(text || "(без текста)");
  }

  // пригласительные ссылки из постов - открываем карточки (без вступления):
  // название, описание, подписчики, и есть ли у канала публичное имя
  const invites = [...new Set([...feed.html.matchAll(/https:\/\/t\.me\/(?:joinchat\/|\+)[A-Za-z0-9_-]+/g)].map((m) => m[0]))];
  for (const link of invites) {
    const page = await get(link);
    const meta = (prop: string) =>
      strip(page.html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1] ?? "");
    const extra = strip(page.html.match(/tgme_page_extra[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
    const domain = page.html.match(/tg:\/\/resolve\?domain=([A-Za-z0-9_]+)/)?.[1];
    console.log(`\nприглашение ${link}:`);
    console.log(`  название: ${meta("og:title") || "-"}`);
    console.log(`  описание: ${meta("og:description") || "-"}`);
    console.log(`  подпись: ${extra || "-"}`);
    console.log(`  публичное имя: ${domain ? "@" + domain : "нет - закрытый"}`);
    // у публичного канала можно прочитать и ленту
    if (domain && domain.toLowerCase() !== slug.toLowerCase()) {
      const inner = await get(`https://t.me/s/${domain}`);
      const posts = inner.html.split('class="tgme_widget_message_wrap').slice(1).slice(-15);
      for (const c of posts) {
        const id = c.match(/data-post="[^/"]+\/(\d+)"/)?.[1];
        const date = c.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? "?";
        const text = strip(c.match(/tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
        const photo = /tgme_widget_message_photo|tgme_widget_message_grouped/.test(c) ? " [фото]" : "";
        console.log(`\n  ── @${domain} #${id} ${date}${photo}`);
        console.log(`  ${(text || "(без текста)").replace(/\n/g, "\n  ")}`);
      }
    }
  }

  // лента пуста - пробуем отдельные посты: у части каналов t.me/s закрыт,
  // а встраивание постов работает
  if (!ids.length) {
    console.log("\nотдельные посты через встраивание:");
    let shown = 0;
    for (let id = 1; id <= 400 && shown < 15; id++) {
      const p = await get(`https://t.me/${slug}/${id}?embed=1&mode=tme`);
      if (!/tgme_widget_message_text|tgme_widget_message_photo/.test(p.html)) continue;
      shown++;
      const text = strip(p.html.match(/tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "");
      const date = p.html.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? "?";
      console.log(`\n── #${id} ${date}${/tgme_widget_message_photo/.test(p.html) ? " [фото]" : ""}`);
      console.log(text || "(без текста)");
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!shown) console.log("  ни один пост из первых 400 не встраивается - канал закрыт для просмотра без аккаунта");
  }
}

main().catch((err) => {
  console.error("разведка упала:", err);
  process.exit(1);
});
