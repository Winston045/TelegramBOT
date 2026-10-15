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

/**
 * Курсор - удобство, а не данные: он только помнит, на какой странице
 * выдачи мы остановились. Сбой базы на этом чтении НЕ должен стоить целого
 * источника, но раньше стоил: 15.10 единственный ответ Supabase
 * «Project not specified.» на курсоре events/term:1906 San Francisco
 * earthquake вылетел из адаптера наружу - и весь трек знаковых событий
 * отдал в партию ноль кадров, хотя Commons и LOC в том же прогоне
 * работали. Потерянный курсор означает «начнём со первой страницы»: это
 * дешевле молчащего источника. Ошибку печатаем - по логу видно, что база
 * икнула, а не что всё в порядке.
 */
export function dbCursorStore(): CursorStore {
  return {
    async get(source, query) {
      try {
        const { data, error } = await getDb()
          .from("source_cursors")
          .select("cursor")
          .eq("source", source)
          .eq("query", query)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return data?.cursor ?? 0;
      } catch (err) {
        console.warn(
          `  курсор ${source}/${query} не прочитан (${(err as Error).message}) - начинаю с первой страницы`,
        );
        return 0;
      }
    },
    async set(source, query, cursor) {
      try {
        const { error } = await getDb()
          .from("source_cursors")
          .upsert({ source, query, cursor, updated_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
      } catch (err) {
        console.warn(
          `  курсор ${source}/${query} не сохранён (${(err as Error).message}) - следующий прогон повторит страницу`,
        );
      }
    },
  };
}
