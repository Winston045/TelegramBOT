/**
 * Проверка пула ключей Gemini: сколько их видит бот и живой ли каждый.
 *
 * Спрашиваем список моделей, а не генерацию: этот вызов не расходует
 * дневную квоту на запросы к модели, но требует валидного ключа - то
 * есть отвечает ровно на нужный вопрос.
 *
 * Ключи в лог не печатаем: только маска вида "AIzaSy...4f2" - её хватает,
 * чтобы отличить один ключ от другого, и она бесполезна посторонним.
 *
 * Запуск: npx tsx scripts/keys-check.ts
 */
import { env } from "../src/env.js";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

/** «AIzaSy…x7Q» - достаточно, чтобы различать ключи, и нечего красть. */
function mask(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}…${key.slice(-3)}`;
}

async function checkKey(key: string): Promise<string> {
  const started = Date.now();
  try {
    const res = await fetch(`${API}?key=${encodeURIComponent(key)}&pageSize=1`, {
      signal: AbortSignal.timeout(20_000),
    });
    const ms = Date.now() - started;
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const first = body.models?.[0]?.name ?? "(без моделей)";
      return `живой, ${ms} мс, доступна ${first}`;
    }
    // 429 здесь означает лимит на сам список моделей - редкость, но
    // отличать её от «ключ негодный» важно
    if (res.status === 429) return `ОТКАЗ 429: лимит запросов уже выбран`;
    if (res.status === 400 || res.status === 403) return `ОТКАЗ ${res.status}: ключ не принят`;
    return `ОТКАЗ HTTP ${res.status}`;
  } catch (err) {
    return `ОТКАЗ ${(err as Error).message}`;
  }
}

async function main() {
  const keys = env.geminiApiKeys;
  console.log(`ключей Gemini в пуле: ${keys.length}\n`);

  for (const [i, key] of keys.entries()) {
    const verdict = await checkKey(key);
    console.log(`  ${i + 1}. ${mask(key)} → ${verdict}`);
  }

  console.log();
  if (keys.length === 1) {
    console.log(
      "В пуле один ключ. Второй добавляется секретом GEMINI_API_KEYS " +
        "(Settings → Secrets and variables → Actions).",
    );
  } else {
    console.log(
      `Пул из ${keys.length} ключей: партия в 30 кадров стоит 60 запросов, ` +
        "и теперь они делятся между ключами по кругу.",
    );
    console.log(
      "Важно: квота считается на проект Google Cloud. Удвоение реально, " +
        "только если ключи из разных проектов или аккаунтов.",
    );
  }
}

main().catch((err) => {
  console.error("проверка ключей упала:", err);
  process.exit(1);
});
