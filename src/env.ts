import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
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
};
