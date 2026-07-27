// Бисекция бута вебхука, шаг 2: клиент supabase-js с jsr.
import { createClient } from "jsr:@supabase/supabase-js@2";
const db = createClient("https://example.supabase.co", "not-a-key", {
  auth: { persistSession: false },
});
Deno.serve(() => new Response(`ok ${typeof db.from}`));
