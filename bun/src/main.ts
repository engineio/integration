import { SQL } from "bun";
import { createPublicKey } from "node:crypto";
import { createClient, type Client } from "tigerbeetle-node";
import type { Balance } from "./balance";
import { PostgresBalance } from "./balance/postgres";
import { TigerBeetleBalance } from "./balance/tigerbeetle";
import { Repository } from "./db/repo";
import { Env, signal } from "./env";
import { routes } from "./handlers/routes";

async function main() {
  // read env
  const env = Env.read((env) => ({
    port: env.Number("PORT", 3000),
    databaseUrl: env.String("DATABASE_URL"),
    dbPoolMax: env.Number("DB_POOL_MAX", 10),
    rgsPublicKey: env.Base64("RGS_PUBLIC_KEY"),
    // Off by default: the dev session route is unauthenticated and resets balances.
    devEndpoints: env.Boolean("DEV_ENDPOINTS", false),
    // Which balance store backs the wallet: the Postgres ledger (default) or TigerBeetle.
    // Both implement the same `Balance` interface, so the handlers don't change. The bet
    // ledger (repo) is always Postgres regardless — only the balance store swaps.
    balanceBackend: env.String("BALANCE_BACKEND", "postgres"),
    tbClusterId: env.Number("TB_CLUSTER_ID", 0),
    tbAddress: env.String("TB_ADDRESS", "3000"),
  }));

  // create repositories
  const db = new SQL({ url: env.databaseUrl, max: env.dbPoolMax })
  const repo = new Repository(db);
  // Postgres ledger (default) or TigerBeetle, selected by env. Both implement `Balance`, so
  // the handlers don't care which is wired in. The bet ledger (repo) is always Postgres.
  let balance: Balance;
  let tbClient: Client | undefined;
  if (env.balanceBackend === "tigerbeetle") {
    tbClient = createClient({ cluster_id: BigInt(env.tbClusterId), replica_addresses: [env.tbAddress] });
    balance = new TigerBeetleBalance(tbClient);
  } else {
    // Postgres needs its schema migrated before serving; TigerBeetle has none.
    const pg = new PostgresBalance(db);
    await pg.migrate();
    balance = pg;
  }

  // run bet-ledger migrations — fail fast (don't serve against a half-migrated schema)
  await repo.migrate();

  // start the server & handle calls
  const server = Bun.serve({
    port: env.port,
    fetch() {
      return Response.json({ error: "not found" }, { status: 404 });
    },
    routes: routes({
      repo,
      balance,
      rgsPublicKey: createPublicKey(env.rgsPublicKey),
      devEndpoints: env.devEndpoints,
      log: (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) =>
        console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields }))
    }),
  });

  // listen for shutdown signal
  await signal("SIGINT", "SIGTERM");

  // cleanup before exit
  await server.stop();
  await db.end();
  tbClient?.destroy();
  process.exit(0);
}

// Not awaited at the top level: `main()` keeps the process alive via Bun.serve and the
// shutdown-signal await. Avoiding top-level await also lets `bun build --bytecode` work.
main().catch((error) => {
  // A fatal boot error (bad env, failed migration, etc.) must exit non-zero so the
  // orchestrator restarts us rather than treating a dead process as healthy.
  console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), msg: "fatal", error: String(error) }));
  process.exit(1);
});
