import type { SourceConfig } from "../config.js";

export type RawItem = {
  sourceId: string;
  sourceUrl: string;
  imageUrl: string;
  title?: string;
  description?: string;
  lang: string;          // язык метаданных
  year?: number;
  place?: string;
  license: string;
  attribution?: string;
};

export interface SourceAdapter {
  name: string;
  fetch(limit: number, cfg: SourceConfig): Promise<RawItem[]>;
}
