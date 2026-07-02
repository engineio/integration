import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { SQL } from "bun";
import { test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { type Balance, PostgresBalance, TigerBeetleBalance } from "../../balance";
import { sharedTigerBeetle } from "../../balance/test/container";
import { Repository } from "../../db/repo";
import { routes, type State } from "../routes";
import { createTestDb, testPublicKey } from "./helpers";

// One Postgres for the whole test run: started lazily on first use, shared by every
// handler test file in the process, and reaped by testcontainers (Ryuk) on exit.
let containerP: Promise<StartedPostgreSqlContainer> | undefined;
const sharedContainer = () => (containerP ??= new PostgreSqlContainer("postgres:18-alpine").start());

// The balance store is pluggable, so every handler test runs against BOTH implementations to
// prove they're interchangeable behind the `Balance` interface. The bet ledger (repo) is
// always Postgres — only the balance store swaps. Each backend builds a fresh store bound to
// the per-test Postgres db (the TigerBeetle store ignores it and shares one cluster, isolated
// because every test uses a random user id).
type BackendName = "postgres" | "tigerbeetle";
const BACKENDS: { name: BackendName; make: (sql: SQL) => Promise<Balance> }[] = [
  {
    name: "postgres",
    make: async (sql) => {
      const balance = new PostgresBalance(sql);
      await balance.migrate();
      return balance;
    },
  },
  {
    name: "tigerbeetle",
    make: async () => new TigerBeetleBalance(await sharedTigerBeetle()),
  },
];

export interface Ctx {
  base: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (path: string, init: RequestInit) => Promise<{ status: number; body: any }>;
  session: (startingBalance?: number, currency?: string) => Promise<{ token: string; user: number; currency: string }>;
  /** Direct DB handle for assertions that need to inspect storage (e.g. partition routing). */
  sql: SQL;
}

/**
 * A concurrent test with its own isolated database, repos, and server (torn down after),
 * so tests across all handler files share nothing but the one Postgres container.
 *
 * Runs once per balance backend (postgres, tigerbeetle); the test name is suffixed with the
 * backend so failures are attributable. Tests that inspect Postgres-internal balance storage
 * (partition routing) are backend-specific — pass `{ backends: ["postgres"] }` to limit them.
 */
export function walletTest(name: string, body: (ctx: Ctx) => Promise<void>, opts?: { backends?: BackendName[] }) {
  const backends = BACKENDS.filter((b) => !opts?.backends || opts.backends.includes(b.name));
  for (const backend of backends) {
    test.concurrent(
      `${name} [${backend.name}]`,
      async () => {
        const [sql, destroy] = await createTestDb(await sharedContainer());
        const repo = new Repository(sql);
        await repo.migrate();
        const balance = await backend.make(sql);

        const state: State = {
          repo,
          balance,
          rgsPublicKey: createPublicKey(testPublicKey),
          devEndpoints: true,
          log: () => {},
        };
        const server = Bun.serve({
          port: 0,
          routes: routes(state),
          fetch() {
            return Response.json({ error: "not found" }, { status: 404 });
          },
        });
        const base = `http://localhost:${server.port}`;

        const call: Ctx["call"] = async (path, init) => {
          const res = await fetch(`${base}${path}`, init);
          return { status: res.status, body: await res.json() };
        };
        const session: Ctx["session"] = async (startingBalance = 1_000_000_000, currency = "USD") => {
          const provider = await repo.addProvider({ name: `Test Provider ${Math.floor(Math.random() * 2_000_000_000)}` });
          const game = await repo.addGame({ provider: provider.id, name: "Test Game", edge: 0.05 });
          const s = await repo.addSession({ user: Math.floor(Math.random() * 2_147_483_647), game: game.id, currency: currency as never });
          await balance.reset(s.user, currency, startingBalance);
          return { token: s.id, user: s.user, currency };
        };

        try {
          await body({ base, call, session, sql });
        } finally {
          await server.stop(true);
          await destroy();
        }
      },
      120_000,
    );
  }
}
