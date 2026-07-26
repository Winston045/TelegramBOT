/**
 * Тонкий клиент Gemini API (Google AI Studio, бесплатный тариф).
 * Никакого SDK — один POST на generateContent с responseMimeType: application/json.
 *
 * ВАЖНО: ключ должен быть из AI Studio без привязанного биллинга,
 * иначе бесплатный тариф исчезает (см. SPEC, «Два запрета»).
 */
import { env } from "./env.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_MODEL = "gemini-2.5-flash";

export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

const MAX_ATTEMPTS = 4;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Один запрос к Gemini, ответ — распарсенный JSON типа T. */
export async function geminiJson<T>(
  parts: GeminiPart[],
  opts: { model?: string; temperature?: number } = {},
): Promise<T> {
  const model = opts.model ?? GEMINI_MODEL;
  const url = `${BASE}/${model}:generateContent`;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: opts.temperature ?? 0.3,
        },
      }),
    });

    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`gemini: HTTP ${res.status}`);
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`gemini: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    }

    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("gemini: пустой ответ");
    return JSON.parse(text) as T;
  }
  throw lastError ?? new Error("gemini: все попытки исчерпаны");
}

/** Скачивает картинку (или берёт готовый Buffer) и упаковывает в inline-парт. */
export async function imagePart(image: string | Buffer): Promise<GeminiPart> {
  if (typeof image !== "string") {
    return { inline_data: { mime_type: "image/jpeg", data: image.toString("base64") } };
  }
  const res = await fetch(image);
  if (!res.ok) throw new Error(`картинка недоступна (HTTP ${res.status}): ${image}`);
  const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { inline_data: { mime_type: mime, data } };
}
