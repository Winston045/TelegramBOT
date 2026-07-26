/**
 * Парсер публичной веб-версии канала: https://t.me/s/<channel>
 *
 * Страница отдаёт ~20 последних сообщений; более старые запрашиваются
 * параметром ?before=<message_id>. Фото лежат в style="background-image:url('...')"
 * у элементов с классом tgme_widget_message_photo_wrap.
 */

export type TmePost = {
  id: number;
  photoUrls: string[];
};

export type TmePage = {
  posts: TmePost[];
  /** Минимальный id на странице — для ?before= следующего запроса. */
  minId?: number;
};

const MESSAGE_SPLIT = /data-post="[^"/]+\/(\d+)"/g;
const PHOTO_URL =
  /tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g;

export function parseChannelPage(html: string): TmePage {
  const posts: TmePost[] = [];

  // Индексы начала каждого сообщения + его id
  const markers: { id: number; start: number }[] = [];
  for (const m of html.matchAll(MESSAGE_SPLIT)) {
    markers.push({ id: Number(m[1]), start: m.index });
  }

  for (let i = 0; i < markers.length; i++) {
    const { id, start } = markers[i]!;
    const end = i + 1 < markers.length ? markers[i + 1]!.start : html.length;
    const chunk = html.slice(start, end);
    const photoUrls = [...chunk.matchAll(PHOTO_URL)].map((m) => m[1]!);
    posts.push({ id, photoUrls });
  }

  const minId = markers.length
    ? Math.min(...markers.map((m) => m.id))
    : undefined;
  return { posts, minId };
}

export function channelSlug(channelId: string): string {
  return channelId.replace(/^@/, "");
}
