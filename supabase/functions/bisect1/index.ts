// Бисекция бута вебхука, шаг 1: конструктор grammY и webhookCallback.
import { Bot, webhookCallback } from "https://deno.land/x/grammy@v1.45.1/mod.ts";
const bot = new Bot("123456:TEST-not-a-real-token");
const handler = webhookCallback(bot, "std/http");
Deno.serve(() => new Response(`ok ${typeof handler}`));
