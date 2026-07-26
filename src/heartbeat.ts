import { getDb } from "./db.js";

export type Job = "collector" | "publisher";

export async function heartbeatOk(job: Job): Promise<void> {
  const { error } = await getDb()
    .from("heartbeats")
    .upsert({ job, last_ok: new Date().toISOString(), last_error: null });
  if (error) console.error(`heartbeat ${job}: ${error.message}`);
}

export async function heartbeatError(job: Job, message: string): Promise<void> {
  const { error } = await getDb()
    .from("heartbeats")
    .upsert({ job, last_error: message.slice(0, 2000) });
  if (error) console.error(`heartbeat ${job}: ${error.message}`);
}
