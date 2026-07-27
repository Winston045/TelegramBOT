// Проба npm-зависимостей: только импорт grammy из npm и ответ "ok".
// Если health отвечает, а эта функция виснет — платформа не поднимает
// свежие бандлы с npm-пакетами; код бота ни при чём.
import { Bot } from "npm:grammy@1.45.1";
Deno.serve(() => new Response(`ok ${typeof Bot}`));
