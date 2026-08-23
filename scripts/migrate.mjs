// Applies supabase/migrations/*.sql in filename order, once each.
// Usage: node --env-file=.env.local scripts/migrate.mjs
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const dir = path.join(process.cwd(), "supabase", "migrations");
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  await sql`
    create table if not exists schema_migration (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const applied = new Set(
    (await sql`select name from schema_migration`).map((r) => r.name),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const body = await readFile(path.join(dir, file), "utf8");
    // Each migration runs in its own transaction: a failure leaves the
    // database on the last good migration rather than half-applied.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migration (name) values (${file})`;
    });
    console.log(`  apply ${file}`);
    ran++;
  }

  console.log(ran ? `\n${ran} migration(s) applied.` : "\nAlready up to date.");
} catch (err) {
  console.error("\nMigration failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
