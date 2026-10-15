import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Курсор пагинации - удобство, а не данные. Живой случай 15.10: Supabase
 * ответил «Project not specified.» на чтении курсора
 * events/term:1906 San Francisco earthquake, ошибка вылетела из адаптера
 * наружу, и трек знаковых событий отдал в партию ноль кадров - при живых
 * Commons и LOC в том же прогоне. Потеря курсора стоит одной повторно
 * прочитанной страницы выдачи; потеря источника стоит целой партии.
 */
const dbError = { message: "Project not specified." };

const table = {
  select: () => ({
    eq: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: null, error: dbError }) }),
    }),
  }),
  upsert: async (_row: unknown) => ({ error: dbError }),
};
const failingDb = { from: () => table };

vi.mock("../src/db.js", () => ({ getDb: () => failingDb }));

const { dbCursorStore } = await import("../src/cursors.js");

afterEach(() => vi.restoreAllMocks());

describe("dbCursorStore: сбой базы не стоит источника", () => {
  it("непрочитанный курсор отдаёт нулевую страницу вместо исключения", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      dbCursorStore().get("events", "term:1906 San Francisco earthquake"),
    ).resolves.toBe(0);
    // молча глотать нельзя: по логу должно быть видно, что база икнула
    expect(warn.mock.calls.join(" ")).toContain("Project not specified.");
  });

  it("несохранённый курсор не роняет прогон", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(dbCursorStore().set("events", "term:Apollo 11", 50)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("непрочитанный курсор не затирается: шли от нуля, а не от сохранённого места", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const upsert = vi.spyOn(table, "upsert");
    const store = dbCursorStore();
    await store.get("events", "off:Apollo 11:");
    // адаптер после чтения пишет новую позицию - она посчитана от нуля и
    // откатила бы источник к началу выдачи
    await store.set("events", "off:Apollo 11:", 5);
    expect(upsert).not.toHaveBeenCalled();
  });
});
