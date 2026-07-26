import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { dhash, hammingDistance, isDuplicate } from "../src/dhash.js";

// Фотоподобная сцена: градиентное небо, «здания», «дорога».
const SCENE_A = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cdd7e0"/>
      <stop offset="1" stop-color="#6b7a88"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#sky)"/>
  <rect x="80" y="220" width="240" height="380" fill="#3d4147"/>
  <rect x="360" y="140" width="180" height="460" fill="#565b63"/>
  <rect x="600" y="300" width="320" height="300" fill="#2c2f34"/>
  <circle cx="1000" cy="150" r="70" fill="#e8e3d5"/>
  <rect x="0" y="600" width="1200" height="200" fill="#8d857a"/>
  <polygon points="200,600 500,800 -100,800" fill="#6e675e"/>
</svg>`;

// Другая сцена: поле, дерево, тёмное небо.
const SCENE_B = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
  <rect width="1200" height="500" fill="#2a2f3a"/>
  <rect y="500" width="1200" height="300" fill="#b8a97c"/>
  <rect x="560" y="260" width="40" height="260" fill="#4a3b28"/>
  <circle cx="580" cy="220" r="120" fill="#3e5230"/>
  <circle cx="180" cy="120" r="40" fill="#d9d9d9"/>
</svg>`;

async function render(svg: string, width: number, gray = false): Promise<Buffer> {
  let img = sharp(Buffer.from(svg)).resize(width).jpeg();
  if (gray) img = img.grayscale();
  return img.toBuffer();
}

describe("dhash", () => {
  it("одно фото в двух размерах даёт расстояние ≤ 5", async () => {
    const big = await dhash(await render(SCENE_A, 1200));
    const small = await dhash(await render(SCENE_A, 480));
    expect(hammingDistance(big, small)).toBeLessThanOrEqual(5);
  });

  it("одно фото в цвете и ч/б даёт расстояние ≤ 5", async () => {
    const color = await dhash(await render(SCENE_A, 1200));
    const bw = await dhash(await render(SCENE_A, 1200, true));
    expect(hammingDistance(color, bw)).toBeLessThanOrEqual(5);
  });

  it("уменьшенное ч/б против цветного оригинала — всё ещё дубликат", async () => {
    const original = await dhash(await render(SCENE_A, 1200));
    const smallBw = await dhash(await render(SCENE_A, 480, true));
    expect(isDuplicate(original, smallBw)).toBe(true);
  });

  it("разные фото дубликатами не считаются", async () => {
    const a = await dhash(await render(SCENE_A, 1200));
    const b = await dhash(await render(SCENE_B, 1200));
    expect(hammingDistance(a, b)).toBeGreaterThan(10);
    expect(isDuplicate(a, b)).toBe(false);
  });

  it("хэш — 16 hex-символов (64 бита)", async () => {
    const h = await dhash(await render(SCENE_A, 1200));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hammingDistance: 0 для равных, точный счёт для известных битов", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  it("hammingDistance бросает ошибку на хэшах разной длины", () => {
    expect(() => hammingDistance("abc", "abcd")).toThrow();
  });
});
