import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { env } from "../src/env.js";

const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

async function main() {
  const sql = postgres(env.supabaseDbUrl, { max: 1, onnotice: () => {} });

  try {
    await sql`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    const applied = new Set(
      (await sql`select name from schema_migrations`).map((r) => r.name as string),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      console.log(`applying ${file}...`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${file})`;
      });
      count++;
    }

    console.log(count === 0 ? "все миграции уже применены" : `применено миграций: ${count}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("миграция не удалась:", err);
  process.exit(1);
});
