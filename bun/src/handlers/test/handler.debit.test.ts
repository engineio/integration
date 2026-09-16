import { randomUUIDv7 as uuid } from "bun";
import { describe, expect } from "bun:test";
import { walletTest } from "./harness";
import { signed } from "./helpers";

describe("debit", () => {
  walletTest("debits the stake", async ({ call, session }) => {
    const s = await session(100_000_000);
    const { status, body } = await call(
      "/v1/debit",
      signed({ token: s.token, round: 1, active: true, mode: "base", ip: "1.1.1.1", debit: { id: uuid(), amount: 10_000_000, currency: "USD" } }),
    );
    expect(status).toBe(200);
    expect(body.balance.amount).toBe(90_000_000);
  });

  walletTest("settles a concurrent credit (buy-feature)", async ({ call, session }) => {
    const s = await session(100_000_000);
    const { status, body } = await call(
      "/v1/debit",
      signed({
        token: s.token,
        round: 2,
        active: false,
        mode: "base",
        ip: "1.1.1.1",
        debit: { id: uuid(), amount: 10_000_000, currency: "USD" },
        credit: { id: uuid(), amount: 25_000_000, ref: uuid(), currency: "USD" },
      }),
    );
    expect(status).toBe(200);
    // 100 - 10 + 25 = 115
    expect(body.balance.amount).toBe(115_000_000);
  });

  walletTest("is idempotent on replay", async ({ call, session }) => {
    const s = await session(100_000_000);
    const req = { token: s.token, round: 3, active: true, mode: "base", ip: "1.1.1.1", debit: { id: uuid(), amount: 10_000_000, currency: "USD" } };
    const first = (await call("/v1/debit", signed(req))).body;
    const second = (await call("/v1/debit", signed(req))).body;
    expect(second.debit_id).toBe(first.debit_id);
    expect(second.balance.amount).toBe(90_000_000);
  });

  walletTest("ERR_IPB when balance can't cover the stake", async ({ call, session }) => {
    const s = await session(5_000_000);
    const { status, body } = await call(
      "/v1/debit",
      signed({ token: s.token, round: 4, active: true, mode: "base", ip: "1.1.1.1", debit: { id: uuid(), amount: 10_000_000, currency: "USD" } }),
    );
    expect(status).toBe(400);
    expect(body.code).toBe("ERR_IPB");
  });

  walletTest("single-shot debit rejects when the stake alone exceeds balance, even if the win nets positive", async ({ call, session }) => {
    const s = await session(5_000_000); // $5
    const { status, body } = await call(
      "/v1/debit",
      signed({
        token: s.token,
        round: 6,
        active: false,
        mode: "base",
        ip: "1.1.1.1",
        debit: { id: uuid(), amount: 10_000_000, currency: "USD" }, // $10 stake > $5 balance
        credit: { id: uuid(), amount: 20_000_000, ref: uuid(), currency: "USD" }, // $20 win — net +$10
      }),
    );
    // The win must NOT fund the stake: the debit is insufficient, full stop.
    expect(status).toBe(400);
    expect(body.code).toBe("ERR_IPB");
    // And the balance is untouched (neither stake nor win applied).
    const bal = await call("/v1/balance", signed({ token: s.token }));
    expect(bal.body.balance.amount).toBe(5_000_000);
  });

  walletTest("rolls back the bet ledger when the balance transfer fails", async ({ call, session }) => {
    const s = await session(5_000_000);
    await call(
      "/v1/debit",
      signed({ token: s.token, round: 40, active: true, mode: "base", ip: "1.1.1.1", debit: { id: uuid(), amount: 10_000_000, currency: "USD" } }),
    );
    // The failed debit must not have left a bet behind (two-phase compensation).
    const { body } = await call("/v1/credit", signed({ token: s.token, round: 40, active: false, ip: "1.1.1.1" }));
    expect(body.code).toBe("ERR_BNF");
  });

  walletTest("accepts a debit on an old session — session lifetime is the RGS's to enforce", async ({ call, session, sql }) => {
    const s = await session(100_000_000);
    // The wallet never rejects on token age (contract §2, "Session lifetime"): the RGS decides
    // when a session may no longer bet, and may send extra debits for an active round any time.
    await sql`UPDATE repo.session SET created_at = now() - interval '25 hours' WHERE id = ${s.token}::uuid`;
    const { status, body } = await call(
      "/v1/debit",
      signed({ token: s.token, round: 7, active: true, mode: "base", ip: "1.1.1.1", debit: { id: uuid(), amount: 10_000_000, currency: "USD" } }),
    );
    expect(status).toBe(200);
    expect(body.balance.amount).toBe(90_000_000);
  });

  walletTest("ERR_BAD when debit currency != session currency", async ({ call, session }) => {
    const s = await session(100_000_000, "USD");
    const { status, body } = await call(
      "/v1/debit",
      signed({ token: s.token, round: 5, active: true, mode: "base", ip: "1.1.1.1", debit: { id: uuid(), amount: 10_000_000, currency: "EUR" } }),
    );
    expect(status).toBe(400);
    expect(body.code).toBe("ERR_BAD");
  });
});

describe("bet-ledger partitioning", () => {
  // repo.bet is RANGE-partitioned by round id, repo.transaction by bet_id with the same
  // boundaries — so a round's bet and all its transactions co-locate in one range partition,
  // and lookups by round prune to it. (Postgres-only: inspects repo storage, which is the
  // same regardless of which balance backend is in use.)
  walletTest("a round's bet + transactions co-locate in one range partition", async ({ call, session, sql }) => {
    const s = await session(100_000_000);
    const round = 2_500_000; // lands in the [2M,3M) range partition, not the low-id one
    const debitId = uuid();

    const open = await call("/v1/debit", signed({ token: s.token, round, active: true, mode: "base", ip: "1.1.1.1", debit: { id: debitId, amount: 10_000_000, currency: "USD" } }));
    expect(open.status).toBe(200);
    const close = await call("/v1/credit", signed({ token: s.token, round, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 30_000_000, ref: debitId, currency: "USD" } }));
    expect(close.status).toBe(200);

    const [{ p: betPart }] = await sql`SELECT tableoid::regclass::text AS p FROM repo.bet WHERE id = ${round}`;
    const txnParts = await sql`SELECT DISTINCT tableoid::regclass::text AS p FROM repo.transaction WHERE bet_id = ${round}`;
    expect(betPart).toMatch(/bet_r2$/);                 // round 2.5M → range index 2
    expect(txnParts.length).toBe(1);                    // debit + credit share one partition
    expect(txnParts[0].p).toMatch(/transaction_r2$/);
  }, { backends: ["postgres"] });
});
