/**
 * Этап 2 — разовый бэкфилл архива канала.
 *
 * Проходит t.me/s/<канал> от свежих сообщений к старым, качает все фото,
 * считает dHash и пишет в seen_hashes с origin = 'backfill'.
 *
 * Запуск:  npm run backfill            — полный проход
 *          npm run backfill -- --dry   — только посчитать, в базу не писать
 *
 * Скрипт идемпотентен: повторный запуск дописывает только новые хэши.
 */
import { loadConfig } from "../src/config.js";
import { dhash } from "../src/dhash.js";
import { getDb } from "../src/db.js";
import { parseChannelPage, channelSlug } from "../src/tme.js";

const PAGE_DELAY_MS = 700;
const dry = process.argv.includes("--dry");

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(slug: string, before?: number): Promise<string> {
  const url = `https://t.me/s/${slug}${before ? `?before=${before}` : ""}`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (story-team-bot backfill)" },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function hashPhoto(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  пропуск фото (HTTP ${res.status}): ${url}`);
      return null;
    }
    return await dhash(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.warn(`  пропуск фото (${(err as Error).message}): ${url}`);
    return null;
  }
}

async function main() {
  const cfg = loadConfig();
  const slug = channelSlug(cfg.channel.id);
  const db = dry ? null : getDb();

  let before: number | undefined;
  let totalPhotos = 0;
  let totalHashes = 0;
  let pages = 0;

  for (;;) {
    const page = parseChannelPage(await fetchPage(slug, before));
    if (page.posts.length === 0 || page.minId === undefined) break;
    pages++;

    const hashes: string[] = [];
    for (const post of page.posts) {
      for (const photoUrl of post.photoUrls) {
        totalPhotos++;
        const hash = await hashPhoto(photoUrl);
        if (hash) hashes.push(hash);
      }
    }

    if (hashes.length > 0) {
      totalHashes += hashes.length;
      if (db) {
        const { error } = await db.from("seen_hashes").upsert(
          hashes.map((image_hash) => ({ image_hash, origin: "backfill" })),
          { onConflict: "image_hash", ignoreDuplicates: true },
        );
        if (error) throw new Error(`запись в seen_hashes: ${error.message}`);
      }
    }

    console.log(
      `страница ${pages} (до #${page.minId}): фото ${totalPhotos}, хэшей ${totalHashes}`,
    );

    if (page.minId <= 1) break;
    before = page.minId;
    await sleep(PAGE_DELAY_MS);
  }

  console.log(
    `готово: страниц ${pages}, фото ${totalPhotos}, хэшей ${totalHashes}` +
      (dry ? " (dry run, база не тронута)" : ""),
  );
}

main().catch((err) => {
  console.error("бэкфилл упал:", err);
  process.exit(1);
});
