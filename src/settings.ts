import { getDb } from "./db.js";
import { normalizeTimes } from "./schedule_panel.js";

/**
 * Времена публикации: то, что редакторы выставили в боте (/schedule),
 * перекрывает config.yaml. Если в базе пусто или таблицы ещё нет —
 * работаем по конфигу.
 */
/** Булев тумблер из settings; нет записи или таблицы - fallback. */
export async function loadBoolSetting(key: string, fallback: boolean): Promise<boolean> {
  try {
    const { data, error } = await getDb()
      .from("settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return fallback;
    return data.value === true;
  } catch {
    return fallback;
  }
}

export async function loadPublishTimes(fallback: string[]): Promise<string[]> {
  try {
    const { data, error } = await getDb()
      .from("settings")
      .select("value")
      .eq("key", "publish_times")
      .maybeSingle();
    if (error || !data) return fallback;
    const times = normalizeTimes(data.value);
    return times.length ? times : fallback;
  } catch {
    return fallback;
  }
}
