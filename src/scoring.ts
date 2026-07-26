import { geminiJson, imagePart } from "./gemini.js";

export type VisionScore = {
  score: number; // 0-100
  tags: { period?: string; region?: string; subject?: string };
  unsafe: boolean;
};

const SCORING_PROMPT = `Ты отбираешь исторические фотографии для публичного телеграм-канала.
Оцени снимок и верни строго JSON без пояснений:

{"score": <0-100>, "tags": {"period": "<эпоха, напр. "WW2" | "interwar" | "WW1" | "cold_war">", "region": "<регион, напр. "europe" | "ussr" | "usa" | "asia">", "subject": "<тема одним словом, напр. "armor" | "aviation" | "street" | "portrait" | "navy" | "homefront">"}, "unsafe": <true|false>}

Критерии score:
- выразительность кадра и необычность сюжета;
- читаемость деталей (техника, лица, надписи);
- пригодность для широкой аудитории.

unsafe = true, если на снимке: тела погибших, казни, графическое насилие,
нацистская символика крупным планом. При unsafe score не важен.`;

export async function scoreImage(image: string | Buffer): Promise<VisionScore> {
  const img = await imagePart(image);
  const result = await geminiJson<VisionScore>([{ text: SCORING_PROMPT }, img]);
  return {
    score: Math.max(0, Math.min(100, Math.round(result.score ?? 0))),
    tags: result.tags ?? {},
    unsafe: Boolean(result.unsafe),
  };
}
