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

const failingDb = {
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: dbError }) }),
      }),
    }),
    upsert: async () => ({ error: dbError }),
  }),
};

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
});
