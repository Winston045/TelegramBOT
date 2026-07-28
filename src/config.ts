import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export type SourceConfig = {
  enabled: boolean;
  weight: number;
  queries?: string[];
  categories?: string[];
  /** диапазон лет для источников с фильтром по годам (pastvu) */
  years?: number[];
};

export type AppConfig = {
  sources: Record<string, SourceConfig>;
  collect: {
    raw_limit: number;
    prefilter_keep: number;
    daily_candidates: number;
    min_image_width: number;
    min_year?: number;
    max_year?: number;
    /** ниже этой оценки кандидат в резерв не пишется (по умолчанию 45) */
    min_score?: number;
  };
  publish: {
    times: string[];
    timezone: string;
    min_queue_warning: number;
    auto_publish: boolean;
  };
  balance: {
    max_same_tag_per_week: number;
  };
  filters: {
    stop_words: string[];
    block_nazi_symbols: boolean;
  };
  glossary: Record<string, string>;
  channel: {
    id: string;
    signature: string;
    signature_url: string;
  };
};

function fail(msg: string): never {
  throw new Error(`config.yaml: ${msg}`);
}

function assertConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) fail("корень должен быть объектом");
  const cfg = raw as Record<string, unknown>;

  for (const key of ["sources", "collect", "publish", "balance", "filters", "glossary", "channel"]) {
    if (!(key in cfg)) fail(`нет секции "${key}"`);
  }

  const sources = cfg.sources as Record<string, SourceConfig>;
  for (const [name, s] of Object.entries(sources)) {
    if (typeof s.enabled !== "boolean") fail(`sources.${name}.enabled должен быть boolean`);
    if (typeof s.weight !== "number") fail(`sources.${name}.weight должен быть числом`);
  }

  const collect = cfg.collect as AppConfig["collect"];
  for (const key of ["raw_limit", "prefilter_keep", "daily_candidates", "min_image_width"] as const) {
    if (typeof collect[key] !== "number" || collect[key] <= 0) {
      fail(`collect.${key} должен быть положительным числом`);
    }
  }

  const publish = cfg.publish as AppConfig["publish"];
  if (!Array.isArray(publish.times) || publish.times.length === 0) {
    fail("publish.times должен быть непустым списком");
  }
  for (const t of publish.times) {
    if (!/^\d{2}:\d{2}$/.test(t)) fail(`publish.times: "${t}" не в формате HH:MM`);
  }
  if (typeof publish.timezone !== "string") fail("publish.timezone должен быть строкой");
  if (typeof publish.min_queue_warning !== "number") fail("publish.min_queue_warning должен быть числом");
  if (typeof publish.auto_publish !== "boolean") fail("publish.auto_publish должен быть boolean");

  const filters = cfg.filters as AppConfig["filters"];
  if (!Array.isArray(filters.stop_words)) fail("filters.stop_words должен быть списком");

  const channel = cfg.channel as AppConfig["channel"];
  for (const key of ["id", "signature", "signature_url"] as const) {
    if (typeof channel[key] !== "string" || channel[key].length === 0) {
      fail(`channel.${key} должен быть непустой строкой`);
    }
  }

  return cfg as unknown as AppConfig;
}

let cached: AppConfig | undefined;

export function loadConfig(path = resolve(process.cwd(), "config.yaml")): AppConfig {
  if (!cached) {
    cached = assertConfig(parse(readFileSync(path, "utf8")));
  }
  return cached;
}
