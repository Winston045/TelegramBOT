import "dotenv/config";

// trim обязателен: в секретах GitHub легко остаётся случайный пробел или
// перевод строки, а "@Story_Teams" с пробелом ломает и chat_id, и ссылки
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`переменная окружения ${name} не задана`);
  return value;
}

export const env = {
  get botToken() {
    return required("BOT_TOKEN");
  },
  get channelId() {
    return required("CHANNEL_ID");
  },
  get editorsChatId() {
    return required("EDITORS_CHAT_ID");
  },
  get editorUserIds(): number[] {
    return required("EDITOR_USER_IDS")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  },
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseSecretKey() {
    return required("SUPABASE_SECRET_KEY");
  },
  get supabaseDbUrl() {
    return required("SUPABASE_DB_URL");
  },
  get geminiApiKey() {
    return required("GEMINI_API_KEY");
  },
  /**
   * Пул ключей Gemini: GEMINI_API_KEYS через запятую (несколько бесплатных
   * ключей = кратная квота), иначе одиночный GEMINI_API_KEY.
   */
  get geminiApiKeys(): string[] {
    // объединяем оба секрета: GitHub не показывает значение уже сохранённого
    // ключа, поэтому добавить второй проще отдельным секретом, а не
    // переписывая список целиком. Дубликаты схлопываем
    const keys = [
      ...(process.env.GEMINI_API_KEYS ?? "").split(","),
      ...(process.env.GEMINI_API_KEY ?? "").split(","),
    ]
      .map((s) => s.trim())
      .filter(Boolean);
    const unique = [...new Set(keys)];
    if (!unique.length) throw new Error("ни одного ключа Gemini не задано");
    return unique;
  },
};
