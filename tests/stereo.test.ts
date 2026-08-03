import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { isStereoPair } from "../src/stereo.js";

/** Случайный «снимок» из шума - у настоящих фото dHash половин расходится. */
async function noiseImage(width: number, height: number, seed: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  let x = seed;
  for (let i = 0; i < data.length; i++) {
    // простой детерминированный генератор, чтобы тест был воспроизводим
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    data[i] = x % 256;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("isStereoPair", () => {
  it("два одинаковых кадра рядом - стереопара", async () => {
    const half = await noiseImage(300, 240, 7);
    const card = await sharp({
      create: { width: 600, height: 240, channels: 3, background: "#888" },
    })
      .composite([
        { input: half, left: 0, top: 0 },
        { input: half, left: 300, top: 0 },
      ])
      .png()
      .toBuffer();
    expect(await isStereoPair(card)).toBe(true);
  });

  it("широкая панорама из разных половин - не стереопара", async () => {
    const left = await noiseImage(300, 240, 7);
    const right = await noiseImage(300, 240, 999);
    const pano = await sharp({
      create: { width: 600, height: 240, channels: 3, background: "#888" },
    })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: right, left: 300, top: 0 },
      ])
      .png()
      .toBuffer();
    expect(await isStereoPair(pano)).toBe(false);
  });

  it("обычные пропорции кадра не проверяются вовсе", async () => {
    const normal = await noiseImage(400, 300, 7);
    expect(await isStereoPair(normal)).toBe(false);
  });
});
