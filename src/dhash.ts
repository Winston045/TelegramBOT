import sharp from "sharp";

/**
 * dHash: grayscale → 9×8 → сравнение соседних пикселей по горизонтали → 64 бита.
 * Возвращает 16 hex-символов.
 */
export async function dhash(image: Buffer): Promise<string> {
  const { data } = await sharp(image)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hex = "";
  let nibble = 0;
  let bits = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col]!;
      const right = data[row * 9 + col + 1]!;
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bits++;
      if (bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

/** Расстояние Хэмминга между двумя hex-хэшами одной длины. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`хэши разной длины: ${a.length} и ${b.length}`);
  }
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (xor) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

/** Порог, ниже которого два хэша считаем одним изображением. */
export const DUPLICATE_THRESHOLD = 5;

export function isDuplicate(a: string, b: string): boolean {
  return hammingDistance(a, b) <= DUPLICATE_THRESHOLD;
}
