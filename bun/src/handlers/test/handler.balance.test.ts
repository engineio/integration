import { randomUUIDv7 as uuid } from "bun";
import { describe, expect } from "bun:test";
import { walletTest } from "./harness";
import { signed } from "./helpers";

describe("balance", () => {
  walletTest("returns the player balance", async ({ call, session }) => {
    const s = await session(500_000_000);
    const { status, body } = await call("/v1/balance", signed({ token: s.token }));
    expect(status).toBe(200);
    expect(body.balance).toEqual({ amount: 500_000_000, currency: "USD" });
  });

  walletTest("ERR_IS for an unknown session", async ({ call }) => {
    const { status, body } = await call("/v1/balance", signed({ token: uuid() }));
    expect(status).toBe(400);
    expect(body.code).toBe("ERR_IS");
  });

  walletTest("an old session still resolves — the wallet never time-expires sessions", async ({ call, session, sql }) => {
    const s = await session(500_000_000);
    // Session lifetime is the RGS's to enforce, not the wallet's (contract §2, "Session lifetime").
    await sql`UPDATE repo.session SET created_at = now() - interval '25 hours' WHERE id = ${s.token}::uuid`;
    const { status, body } = await call("/v1/balance", signed({ token: s.token }));
    expect(status).toBe(200);
    expect(body.balance.amount).toBe(500_000_000);
  });
});

describe("ledger partitioning", () => {
  // The balance ledger is composite-partitioned: RANGE by ISO week on op_ts, then HASH by
  // op_key. op_ts = uuid_extract_timestamp(op_key), and op_key is the wallet's OWN UUIDv7 — the
  // debit's bet-ledger transaction id, minted by openBet — so a movement routes to the current
  // week's leaf regardless of the RGS id's format, and a replay reuses the same id (same op_ts)
  // and dedupes into the same leaf.
  walletTest("balance movements route to a weekly/hash leaf by the wallet's op key, and replays dedupe", async ({ call, session, sql }) => {
    // Postgres-only: asserts on balance.ledger partition routing, specific to the Postgres
    // backend's storage. TigerBeetle's idempotency is covered in balance/test/tigerbeetle.test.ts.
    const s = await session(100_000_000);

    // A NON-v7 RGS transaction id (UUIDv4): the balance ledger no longer depends on its format,
    // because the wallet keys the balance on its own bet-ledger transaction id (a minted UUIDv7).
    const debitId = crypto.randomUUID();
    await call("/v1/debit", signed({ token: s.token, round: 701, active: true, mode: "base", ip: "1.1.1.1", debit: { id: debitId, amount: 10_000_000, currency: "USD" } }));

    // The movement landed in a weekly+hash leaf (not the catch-all DEFAULT) — op_ts routing
    // works off the minted op key, even though the RGS id was a v4.
    const [row] = await sql`
      SELECT tableoid::regclass::text AS partition FROM balance.ledger WHERE user_id = ${s.user}
    `;
    expect(row.partition).toMatch(/ledger_p\d{6}_h\d$/); // ledger_p<ISO-year><ISO-week>_h<bucket>

    // Replaying the same debit (idempotent openBet returns the same transaction id) → no double-debit.
    const balBefore = (await call("/v1/balance", signed({ token: s.token }))).body.balance.amount;
    await call("/v1/debit", signed({ token: s.token, round: 701, active: true, mode: "base", ip: "1.1.1.1", debit: { id: debitId, amount: 10_000_000, currency: "USD" } }));
    const balAfter = (await call("/v1/balance", signed({ token: s.token }))).body.balance.amount;
    expect(balAfter).toBe(balBefore);

    const [{ n }] = await sql`SELECT count(*)::int AS n FROM balance.ledger WHERE user_id = ${s.user}`;
    expect(n).toBe(1); // exactly one ledger row despite the replay
  }, { backends: ["postgres"] });

  walletTest("account rows hash-partition across 8 partitions by user_id", async ({ session, sql }) => {
    // Postgres-only: asserts on balance.account hash-partition routing.
    // Spread several players and confirm their account rows land in more than one of the
    // 8 hash partitions (sanity that hashing distributes, and that upserts still routed).
    for (let i = 0; i < 12; i++) await session(10_000_000);
    const parts = await sql`
      SELECT DISTINCT tableoid::regclass::text AS partition FROM balance.account
    `;
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.partition).toMatch(/account_\d$/);
  }, { backends: ["postgres"] });
});
