import { getDb } from "./db.js";

/**
 * Курсор пагинации на пару (источник, запрос). Храним в базе, чтобы каждый
 * ежедневный запуск двигался по выдаче дальше, а не топтался на первой странице.
 */
export interface CursorStore {
  get(source: string, query: string): Promise<number>;
  set(source: string, query: string, cursor: number): Promise<void>;
}

/** Для dry-запусков без базы: всё с нуля, ничего не сохраняем. */
export function memoryCursorStore(): CursorStore {
  const map = new Map<string, number>();
  return {
    async get(source, query) {
      return map.get(`${source}:${query}`) ?? 0;
    },
    async set(source, query, cursor) {
      map.set(`${source}:${query}`, cursor);
    },
  };
}

export function dbCursorStore(): CursorStore {
  return {
    async get(source, query) {
      const { data, error } = await getDb()
        .from("source_cursors")
        .select("cursor")
        .eq("source", source)
        .eq("query", query)
        .maybeSingle();
      if (error) throw new Error(`чтение курсора ${source}/${query}: ${error.message}`);
      return data?.cursor ?? 0;
    },
    async set(source, query, cursor) {
      const { error } = await getDb()
        .from("source_cursors")
        .upsert({ source, query, cursor, updated_at: new Date().toISOString() });
      if (error) throw new Error(`запись курсора ${source}/${query}: ${error.message}`);
    },
  };
}
