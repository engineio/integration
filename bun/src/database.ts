import { SQL } from "bun";
import type { Migration } from "./migrate.macro";

// Shared, schema-agnostic database plumbing: the migration runner. Not specific to the
// bet schema, so it lives here rather than under db/.

/**
 * Runs each migration once, in order, recording applied ones in a `_migrations` table
 * (named per `table` so the repo and balance schemas track migrations independently).
 * Each migration runs in its own transaction. Deliberately tiny.
 *
 * Migrations are passed in (bundled at build time via the `load` macro), so there's no
 * runtime filesystem access and `bun build --compile` produces a self-contained binary.
 *
 * If `table` is schema-qualified (e.g. `balance._migrations`), the schema is created
 * first, so callers don't have to bootstrap it before the migrations that use it.
 */
export async function migrate(sql: SQL, migrations: Migration[], table = "_migrations"): Promise<void> {
  const schema = table.includes(".") ? table.split(".")[0] : undefined;
  if (schema) {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  }

  await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  for (const { name, sql: content } of migrations) {
    const [done] = await sql.unsafe(`SELECT 1 FROM ${table} WHERE name = $1`, [name]);
    if (done) continue;

    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx.unsafe(`INSERT INTO ${table} (name) VALUES ($1)`, [name]);
    });
  }
}
