// Бисекция бута вебхука, шаг 4: точная копия бута index.ts на реальных
// секретах — grammY на BOT_TOKEN, supabase-js на служебном ключе,
// webhookCallback с секретом. Регистраций команд нет.
import { Bot, webhookCallback } from "https://deno.land/x/grammy@v1.45.1/mod.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`переменная окружения ${name} не задана`);
  return v;
}

const bot = new Bot(requireEnv("BOT_TOKEN"));
const db = createClient(
  requireEnv("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SECRET_KEY") ?? requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);
const EDITORS = new Set(
  requireEnv("EDITOR_USER_IDS")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n)),
);
const handler = webhookCallback(bot, "std/http", {
  secretToken: Deno.env.get("TG_WEBHOOK_SECRET")?.trim() || undefined,
});
Deno.serve(() => new Response(`ok ${typeof handler} ${typeof db.from} ${EDITORS.size}`));
