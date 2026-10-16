import { describe, expect, it } from "vitest";

// db.ts тянет env на импорте только через getDb, сам selectAll чистый
const { PAGE_SIZE, selectAll } = await import("../src/db.js");

/** Таблица из n строк, отдаваемая страницами - как это делает PostgREST. */
function table(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  };
  return { page, calls };
}

describe("selectAll: Supabase молча режет выборку на 1000 строках", () => {
  it("читает таблицу больше одной страницы целиком", async () => {
    // seen_hashes: ~4400 хэшей истории канала - раньше видна была тысяча
    const { page, calls } = table(4423);
    const rows = await selectAll(page);
    expect(rows).toHaveLength(4423);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4423);
    expect(calls).toHaveLength(5);
  });

  it("ровно на границе страницы делает один лишний пустой запрос и останавливается", async () => {
    const { page, calls } = table(PAGE_SIZE * 2);
    expect(await selectAll(page)).toHaveLength(PAGE_SIZE * 2);
    expect(calls).toHaveLength(3);
  });

  it("пустая таблица - пустой список", async () => {
    const { page } = table(0);
    expect(await selectAll(page)).toEqual([]);
  });

  it("ошибка любой страницы - исключение, а не обрезанный список", async () => {
    let n = 0;
    const page = async () =>
      ++n === 2
        ? { data: null, error: { message: "timeout" } }
        : { data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i })), error: null };
    await expect(selectAll(page)).rejects.toThrow("timeout");
  });
});
