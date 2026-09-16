import { randomUUIDv7 as uuid } from "bun";
import { describe, expect } from "bun:test";
import { walletTest } from "./harness";
import { signed } from "./helpers";

// A debit body (active=true keeps the round open so more debits can be added; active=false closes
// it). Each debit carries its own transaction id, so a round can accumulate several.
const debit = (token: string, round: number, id: string, amount: number, active = true) =>
  signed({ token, round, active, mode: "base", ip: "1.1.1.1", debit: { id, amount, currency: "USD" } });

describe("rollback", () => {
  walletTest("refunds the stake", async ({ call, session }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", debit(s.token, 20, debitId, 10_000_000));
    const { status, body } = await call("/v1/rollback", signed({ token: s.token, round: 20, rollbacks: [{ id: uuid(), ref: debitId }] }));
    expect(status).toBe(200);
    expect(body.rollback_ids).toHaveLength(1);
    expect(body.balance.amount).toBe(100_000_000);
  });

  walletTest("is idempotent on replay", async ({ call, session }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", debit(s.token, 21, debitId, 10_000_000));
    const rb = { token: s.token, round: 21, rollbacks: [{ id: uuid(), ref: debitId }] };
    const first = (await call("/v1/rollback", signed(rb))).body;
    const second = (await call("/v1/rollback", signed(rb))).body;
    expect(second.rollback_ids[0]).toBe(first.rollback_ids[0]);
    expect(second.balance.amount).toBe(100_000_000);
  });

  walletTest("a rollback before any debit fences it; a straggler debit is then refused", async ({ call, session }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    const rbReq = { token: s.token, round: 88_888, rollbacks: [{ id: uuid(), ref: debitId }] };

    // The rollback arrives with no debit (we never received it — e.g. we were down while the RGS
    // gave up). It tombstones that debit and succeeds, moving no money (no stake was ever taken).
    const first = await call("/v1/rollback", signed(rbReq));
    expect(first.status).toBe(200);
    expect(first.body.balance.amount).toBe(100_000_000);

    // Idempotent: a replay of the orphan rollback returns the same rollback id.
    const second = await call("/v1/rollback", signed(rbReq));
    expect(second.body.rollback_ids[0]).toBe(first.body.rollback_ids[0]);

    // The straggler debit (same ext_id the rollback fenced) is refused, and takes no stake.
    const straggler = await call("/v1/debit", debit(s.token, 88_888, debitId, 10_000_000));
    expect(straggler.status).toBe(400);
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(100_000_000);
  });

  walletTest("refuses to reverse a round already settled by a credit", async ({ call, session }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", debit(s.token, 22, debitId, 10_000_000));
    // Settle the round with a win.
    await call("/v1/credit", signed({ token: s.token, round: 22, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 30_000_000, ref: debitId, currency: "USD" } }));
    const before = (await call("/v1/balance", signed({ token: s.token }))).body.balance.amount;

    // A rollback of the settled round must NOT silently succeed or refund anything.
    const { status } = await call("/v1/rollback", signed({ token: s.token, round: 22, rollbacks: [{ id: uuid(), ref: debitId }] }));
    expect(status).toBe(400);
    const after = (await call("/v1/balance", signed({ token: s.token }))).body.balance.amount;
    expect(after).toBe(before); // balance untouched
  });

  walletTest("a late rollback lands long after session launch", async ({ call, session, sql }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", debit(s.token, 23, debitId, 10_000_000));
    // The wallet never time-expires sessions: the RGS can cancel a round long after launch and
    // the refund must still land, authorized against the bet's recorded session (contract §2,
    // "Session lifetime").
    await sql`UPDATE repo.session SET created_at = now() - interval '25 hours' WHERE id = ${s.token}::uuid`;
    const { status, body } = await call("/v1/rollback", signed({ token: s.token, round: 23, rollbacks: [{ id: uuid(), ref: debitId }] }));
    expect(status).toBe(200);
    expect(body.balance.amount).toBe(100_000_000);
  });

  walletTest("ERR_IS when the token doesn't match the session that opened the round", async ({ call, session }) => {
    const s = await session(100_000_000);
    const other = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", debit(s.token, 24, debitId, 10_000_000));
    // A live token from a DIFFERENT session must not reverse this round's debits — the bet's
    // recorded session is the authority (session-to-bet alignment), checked before anything moves.
    const rb = await call("/v1/rollback", signed({ token: other.token, round: 24, rollbacks: [{ id: uuid(), ref: debitId }] }));
    expect(rb.status).toBe(400);
    expect(rb.body.code).toBe("ERR_IS");
    // Nothing was refunded: the stake is still out.
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(90_000_000);
  });

  walletTest("reverses ONE of several debits; the others stand and the round stays open", async ({ call, session }) => {
    const s = await session(100_000_000);
    const round = 30;
    const d1 = uuid(), d2 = uuid(), d3 = uuid();
    await call("/v1/debit", debit(s.token, round, d1, 10_000_000));
    await call("/v1/debit", debit(s.token, round, d2, 20_000_000));
    await call("/v1/debit", debit(s.token, round, d3, 30_000_000));
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(40_000_000); // 100 - 60

    // Reverse only the middle debit, keeping the round open (active: true).
    const rb = await call("/v1/rollback", signed({ token: s.token, round, active: true, rollbacks: [{ id: uuid(), ref: d2 }] }));
    expect(rb.status).toBe(200);
    expect(rb.body.rollback_ids).toHaveLength(1);
    expect(rb.body.balance.amount).toBe(60_000_000); // only d2's 20 refunded

    // The round is still open: a further debit is accepted (d1/d3 were untouched).
    const more = await call("/v1/debit", debit(s.token, round, uuid(), 5_000_000));
    expect(more.status).toBe(200);
    expect(more.body.balance.amount).toBe(55_000_000);
  });

  walletTest("reverses MULTIPLE debits and closes the round atomically", async ({ call, session }) => {
    const s = await session(100_000_000);
    const round = 31;
    const d1 = uuid(), d2 = uuid();
    await call("/v1/debit", debit(s.token, round, d1, 10_000_000));
    await call("/v1/debit", debit(s.token, round, d2, 20_000_000));
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(70_000_000);

    // Abandon the whole round in one request: reverse both debits, active omitted (→ close).
    const rb = await call("/v1/rollback", signed({ token: s.token, round, rollbacks: [{ id: uuid(), ref: d1 }, { id: uuid(), ref: d2 }] }));
    expect(rb.status).toBe(200);
    expect(rb.body.rollback_ids).toHaveLength(2);
    expect(rb.body.balance.amount).toBe(100_000_000); // both refunded

    // Round is closed now: a further debit is refused.
    const after = await call("/v1/debit", debit(s.token, round, uuid(), 5_000_000));
    expect(after.status).toBe(400);
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(100_000_000);
  });
});
