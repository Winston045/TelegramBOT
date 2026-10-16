import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

let client: SupabaseClient | undefined;

export function getDb(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseSecretKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/** Размер страницы: потолок ответа PostgREST у Supabase по умолчанию. */
export const PAGE_SIZE = 1000;

/**
 * Читает выборку ЦЕЛИКОМ, страницами по PAGE_SIZE.
 *
 * Supabase отдаёт на один запрос не больше 1000 строк и молча обрезает
 * остальное - без ошибки. Проверка дублей грузила seen_hashes одним
 * запросом, а там ~4400 хэшей истории канала плюс всё, что вышло при
 * боте: сверка шла лишь с первой тысячей, и повтор старого поста мог
 * выйти в канал. `page(from, to)` строит запрос с .range(from, to) и
 * обязательной сортировкой по уникальному ключу - без неё страницы
 * между запросами могут перекрываться и терять строки.
 */
export async function selectAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

/** Все известные хэши: история канала, вышедшие посты, кандидаты. */
export async function loadKnownHashes(
  db: SupabaseClient,
  opts: { candidates?: boolean } = {},
): Promise<string[]> {
  const seen = await selectAll<{ image_hash: string }>((from, to) =>
    db.from("seen_hashes").select("image_hash").order("image_hash").range(from, to),
  );
  const cands = opts.candidates
    ? await selectAll<{ image_hash: string }>((from, to) =>
        db.from("candidates").select("image_hash").order("id").range(from, to),
      )
    : [];
  return [...seen, ...cands].map((r) => r.image_hash);
}

export type CandidateStatus =
  | "new"
  | "shown"
  | "approved"
  | "rejected"
  | "published"
  | "failed";

export type Candidate = {
  id: number;
  source: string;
  source_id: string;
  source_url: string;
  image_url: string;
  image_hash: string;
  raw_title: string | null;
  raw_desc: string | null;
  raw_lang: string | null;
  year: number | null;
  place: string | null;
  caption_html: string | null;
  quote_kind: "observation" | "context" | null;
  tags: { period?: string; region?: string; subject?: string } | null;
  score: number | null;
  license: string | null;
  attribution: string | null;
  status: CandidateStatus;
  shown_at: string | null;
  published_at: string | null;
  channel_msg_id: number | null;
  created_at: string;
};
