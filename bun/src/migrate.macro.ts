import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Migration {
  name: string;
  sql: string;
}

/**
 * Build-time macro: glob a directory of `.sql` files (relative to this file) and inline
 * their contents into the bundle. Import it `with { type: "macro" }` so the migrations
 * are baked into the binary — no runtime filesystem, and `bun build --compile` works.
 */
export function load(dir: string): Migration[] {
  const base = join(dirname(fileURLToPath(import.meta.url)), dir);
  return [...new Glob("*.sql").scanSync(base)]
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(base, name), "utf8") }));
}
