/**
 * Детектор стереокарточек: в начале XX века фото издавали парами для
 * стереоскопов - два почти одинаковых кадра на картонной подложке.
 * В LOC их тысячи, для канала они брак: мелко, двоится, рамки с текстом.
 *
 * Признак надёжный и дешёвый: кадр заметно шире обычного, а левая и
 * правая половины почти совпадают по dHash.
 */
import sharp from "sharp";
import { dhash, hammingDistance } from "./dhash.js";

/** Уже обычного 3:2 стереопары не бывают - карточки заметно вытянуты. */
const MIN_RATIO = 1.45;
/** Насколько похожи половины (бит из 64), чтобы считать их одним кадром. */
const MAX_HALF_DISTANCE = 10;

export async function isStereoPair(image: Buffer): Promise<boolean> {
  const meta = await sharp(image).metadata();
  if (!meta.width || !meta.height) return false;
  if (meta.width / meta.height < MIN_RATIO) return false;

  const half = Math.floor(meta.width / 2);
  // отступ от краёв: рамка карточки и вертикальные надписи не должны
  // портить сравнение самих кадров
  const inset = Math.max(1, Math.floor(half * 0.08));
  const width = half - inset * 2;
  if (width < 8) return false;

  const crop = (left: number) =>
    sharp(image).extract({ left, top: 0, width, height: meta.height! }).toBuffer();
  const [left, right] = await Promise.all([crop(inset), crop(half + inset)]);
  return hammingDistance(await dhash(left), await dhash(right)) <= MAX_HALF_DISTANCE;
}
