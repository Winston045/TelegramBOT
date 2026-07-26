import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

let client: SupabaseClient | undefined;

export function getDb(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseSecretKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export type CandidateStatus =
  | "new"
  | "shown"
  | "approved"
  | "rejected"
  | "published"
  | "failed";

export type Candidate = {
  id: number;
  source: string;
  source_id: string;
  source_url: string;
  image_url: string;
  image_hash: string;
  raw_title: string | null;
  raw_desc: string | null;
  raw_lang: string | null;
  year: number | null;
  place: string | null;
  caption_html: string | null;
  quote_kind: "observation" | "context" | null;
  tags: { period?: string; region?: string; subject?: string } | null;
  score: number | null;
  license: string | null;
  attribution: string | null;
  status: CandidateStatus;
  shown_at: string | null;
  published_at: string | null;
  channel_msg_id: number | null;
  created_at: string;
};
