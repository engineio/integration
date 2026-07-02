import { randomUUIDv7 as uuid } from "bun";
import { describe, expect } from "bun:test";
import { walletTest } from "./harness";
import { signed } from "./helpers";

// Out-of-order arrival and replay scenarios. The RGS retries calls and they can be reordered in
// flight, so every operation must be idempotent on its transaction and the wallet must never
// double-charge, double-pay, or refund a stake it never took. A bet is a container for 1..N debits
// plus 0..N credits (each idempotent on its own ext_id, accumulating while the round is open;
// `active:false` closes it); the idempotency unit is the transaction's id, not the round. These run
// against BOTH balance backends (postgres + tigerbeetle); the bet-first ordering means the bet
// ledger decides the outcome before any money moves, so the guarantees hold identically on each.
describe("out-of-order & idempotency", () => {
  const debit = (token: string, round: number, id: string, amount: number, credit?: { id: string; amount: number; ref: string }, active = true) =>
    signed({ token, round, active, mode: "base", ip: "1.1.1.1", debit: { id, amount, currency: "USD" }, credit: credit ? { ...credit, currency: "USD" } : null });

  // --- replays of the same op ------------------------------------------------------------

  walletTest("debit → credit → the original debit replays: idempotent, no re-charge", async ({ call, session }) => {
    const s = await session(100_000_000);
    const d = uuid();
    const first = await call("/v1/debit", debit(s.token, 1, d, 10_000_000));
    expect(first.status).toBe(200);
    expect(first.body.balance.amount).toBe(90_000_000); // 100 - 10 stake

    await call("/v1/credit", signed({ token: s.token, round: 1, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 30_000_000, ref: d, currency: "USD" } }));
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(120_000_000); // +30 win

    // The original debit arrives again (delayed / retried) AFTER the round was settled.
    const replay = await call("/v1/debit", debit(s.token, 1, d, 10_000_000));
    expect(replay.status).toBe(200);
    expect(replay.body.debit_id).toBe(first.body.debit_id); // same wallet debit id
    expect(replay.body.balance.amount).toBe(120_000_000);   // NOT re-charged to 110
  });

  walletTest("debit → rollback → the original debit replays: no re-charge", async ({ call, session }) => {
    const s = await session(100_000_000);
    const d = uuid();
    const first = await call("/v1/debit", debit(s.token, 2, d, 10_000_000));
    await call("/v1/rollback", signed({ token: s.token, round: 2, rollbacks: [{ id: uuid(), ref: d }] }));
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(100_000_000); // refunded

    const replay = await call("/v1/debit", debit(s.token, 2, d, 10_000_000));
    expect(replay.status).toBe(200);
    expect(replay.body.debit_id).toBe(first.body.debit_id);
    expect(replay.body.balance.amount).toBe(100_000_000); // a replay after a rollback does not re-take the stake
  });

  walletTest("a buy-feature (debit + concurrent win) replays idempotently", async ({ call, session }) => {
    const s = await session(100_000_000);
    const d = uuid();
    const c = uuid();
    const first = await call("/v1/debit", debit(s.token, 3, d, 10_000_000, { id: c, amount: 5_000_000, ref: d }));
    expect(first.status).toBe(200);
    expect(first.body.balance.amount).toBe(95_000_000); // 100 - 10 stake + 5 win

    const replay = await call("/v1/debit", debit(s.token, 3, d, 10_000_000, { id: c, amount: 5_000_000, ref: d }));
    expect(replay.body.debit_id).toBe(first.body.debit_id);
    expect(replay.body.credit_id).toBe(first.body.credit_id);
    expect(replay.body.balance.amount).toBe(95_000_000); // neither leg re-applied
  });

  // --- multiple debits on one round ------------------------------------------------------

  walletTest("a second debit with a DIFFERENT id on the same round ADDS another debit", async ({ call, session }) => {
    const s = await session(100_000_000);
    const first = await call("/v1/debit", debit(s.token, 4, uuid(), 10_000_000));
    expect(first.body.balance.amount).toBe(90_000_000);

    // The idempotency unit is the debit's id, not the round: a fresh debit id on the same (open)
    // round appends a NEW debit and takes another stake.
    const second = await call("/v1/debit", debit(s.token, 4, uuid(), 10_000_000));
    expect(second.status).toBe(200);
    expect(second.body.debit_id).not.toBe(first.body.debit_id);
    expect(second.body.balance.amount).toBe(80_000_000); // both stakes taken
  });

  walletTest("debits accumulate, then one credit settles the whole round", async ({ call, session }) => {
    const s = await session(100_000_000);
    const round = 40;
    const d1 = uuid();
    await call("/v1/debit", debit(s.token, round, d1, 10_000_000));
    await call("/v1/debit", debit(s.token, round, uuid(), 25_000_000));
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(65_000_000); // 100 - 35

    // One credit with active:false closes the round; the win nets against the total of all stakes.
    const credit = await call("/v1/credit", signed({ token: s.token, round, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 50_000_000, ref: d1, currency: "USD" } }));
    expect(credit.status).toBe(200);
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(115_000_000); // 65 + 50
  });

  walletTest("multiple credits accumulate while the round is open; active:false closes it", async ({ call, session }) => {
    const s = await session(100_000_000);
    const round = 43;
    const d = uuid();
    await call("/v1/debit", debit(s.token, round, d, 10_000_000)); // open, -10
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(90_000_000);

    // First credit keeps the round OPEN (active:true) — a partial/staged payout.
    const c1 = await call("/v1/credit", signed({ token: s.token, round, active: true, ip: "1.1.1.1", credit: { id: uuid(), amount: 5_000_000, ref: d, currency: "USD" } }));
    expect(c1.status).toBe(200);
    expect(c1.body.balance.amount).toBe(95_000_000); // +5

    // Second, DIFFERENT credit also lands and pays — then active:false closes the round.
    const c2 = await call("/v1/credit", signed({ token: s.token, round, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 7_000_000, ref: d, currency: "USD" } }));
    expect(c2.status).toBe(200);
    expect(c2.body.credit_id).not.toBe(c1.body.credit_id);
    expect(c2.body.balance.amount).toBe(102_000_000); // +7

    // Closed now — a further credit is refused.
    const c3 = await call("/v1/credit", signed({ token: s.token, round, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 99_000_000, ref: d, currency: "USD" } }));
    expect(c3.status).toBe(400);
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(102_000_000); // not paid
  });

  walletTest("a credit with no win + active:false closes a losing round (pays nothing)", async ({ call, session }) => {
    const s = await session(100_000_000);
    const round = 44;
    const d = uuid();
    await call("/v1/debit", debit(s.token, round, d, 10_000_000)); // open, -10
    // A null credit object closes the round as a loss — no payout, just the stake gone.
    const close = await call("/v1/credit", signed({ token: s.token, round, active: false, ip: "1.1.1.1", credit: null }));
    expect(close.status).toBe(200);
    expect(close.body.credit_id).toBeUndefined(); // no win paid → no credit id
    expect(close.body.balance.amount).toBe(90_000_000); // only the stake taken

    // Closed — a debit on it is refused.
    const after = await call("/v1/debit", debit(s.token, round, uuid(), 10_000_000));
    expect(after.status).toBe(400);
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(90_000_000);
  });

  walletTest("a debit after the round is closed is refused", async ({ call, session }) => {
    const s = await session(100_000_000);
    const round = 41;
    // active:false closes the round on this single-shot debit.
    await call("/v1/debit", debit(s.token, round, uuid(), 10_000_000, undefined, false));
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(90_000_000);

    const after = await call("/v1/debit", debit(s.token, round, uuid(), 10_000_000));
    expect(after.status).toBe(400); // nothing after closed
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(90_000_000); // no extra stake
  });

  walletTest("a new credit after the round was closed is refused", async ({ call, session }) => {
    const s = await session(100_000_000);
    const round = 42;
    const d = uuid();
    await call("/v1/debit", debit(s.token, round, d, 10_000_000));
    // active:false settles AND closes the round.
    const c1 = await call("/v1/credit", signed({ token: s.token, round, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 20_000_000, ref: d, currency: "USD" } }));
    expect(c1.status).toBe(200);
    const settled = (await call("/v1/balance", signed({ token: s.token }))).body.balance.amount;

    // A NEW credit id on the now-closed round is refused — nothing lands after close.
    const c2 = await call("/v1/credit", signed({ token: s.token, round, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 99_000_000, ref: d, currency: "USD" } }));
    expect(c2.status).toBe(400);
    expect(c2.body.code).toBe("ERR_BC"); // round is complete, not a generic bad request
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(settled); // not paid twice
  });

  // --- rollback / credit before their debit ----------------------------------------------

  walletTest("rollback before any debit fences it; the straggler debit AND a later credit are refused", async ({ call, session }) => {
    const s = await session(100_000_000);
    const d = uuid();

    // Rollback arrives with no debit (we never received it). It tombstones that debit, moving nothing.
    const rb = await call("/v1/rollback", signed({ token: s.token, round: 5, rollbacks: [{ id: uuid(), ref: d }] }));
    expect(rb.status).toBe(200);
    expect(rb.body.balance.amount).toBe(100_000_000);

    // The straggler debit for the fenced ext_id is refused — and takes no stake.
    const straggler = await call("/v1/debit", debit(s.token, 5, d, 10_000_000));
    expect(straggler.status).toBe(400);
    expect(straggler.body.code).toBe("ERR_BAD"); // fenced debit = bad request, not ERR_BC
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(100_000_000);

    // A credit for the debit-less round is rejected too — there is no bet to settle.
    const credit = await call("/v1/credit", signed({ token: s.token, round: 5, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 5_000_000, ref: d, currency: "USD" } }));
    expect(credit.status).toBe(404);
  });

  walletTest("a credit for a never-debited round is ERR_BNF (credits do not fence)", async ({ call, session }) => {
    const s = await session(100_000_000);
    const res = await call("/v1/credit", signed({ token: s.token, round: 6, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 5_000_000, ref: uuid(), currency: "USD" } }));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ERR_BNF");
  });

  // --- settle/reverse conflicts ----------------------------------------------------------

  walletTest("rollback after a credit-settled round is refused (not reversible)", async ({ call, session }) => {
    const s = await session(100_000_000);
    const d = uuid();
    await call("/v1/debit", debit(s.token, 7, d, 10_000_000));
    await call("/v1/credit", signed({ token: s.token, round: 7, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 30_000_000, ref: d, currency: "USD" } }));
    const before = (await call("/v1/balance", signed({ token: s.token }))).body.balance.amount;

    const res = await call("/v1/rollback", signed({ token: s.token, round: 7, rollbacks: [{ id: uuid(), ref: d }] }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ERR_BC"); // settled round is complete
    expect((await call("/v1/balance", signed({ token: s.token }))).body.balance.amount).toBe(before); // untouched
  });

  // --- a rollback racing an in-flight (pending) debit ------------------------------------

  walletTest("a rollback while the referenced debit is still pending is retryable (not terminal)", async ({ call, session, sql }) => {
    const s = await session(100_000_000);
    const round = 8;
    const debitRef = uuid();

    // Simulate a debit that recorded the bet (`pending`) + a `pending` debit transaction but crashed
    // before confirming its stake — the exact in-flight window. (record_debit_v1 writes the bet
    // pending + the debit txn pending, then the handler moves money and confirms; here we stop after
    // the record.)
    const [sess] = await sql`SELECT game FROM repo.session WHERE id = ${s.token}::uuid`;
    await sql`INSERT INTO repo.bet (id, session, "user", game, currency, status)
              VALUES (${round}, ${s.token}::uuid, ${s.user}, ${Number(sess.game)}, 'USD'::repo.currency, 'pending'::repo.bet_status)`;
    await sql`INSERT INTO repo.transaction (id, bet_id, type, status, amount, ext_id)
              VALUES (${uuid()}::uuid, ${round}, 'debit', 'pending'::repo.transaction_status, 10000000, ${debitRef}::uuid)`;

    // A rollback can't reverse a not-yet-funded debit, but it may still resolve — so it's a
    // retryable 5xx, not a terminal 4xx. The RGS re-drives until the debit confirms (then reverse)
    // or is rejected (then nothing to reverse).
    const res = await call("/v1/rollback", signed({ token: s.token, round, rollbacks: [{ id: uuid(), ref: debitRef }] }));
    expect(res.status).toBe(500);

    // The bet is left untouched (still pending) — the rollback did not settle or void it.
    const [b] = await sql`SELECT status FROM repo.bet WHERE id = ${round}`;
    expect(b.status).toBe("pending");
  });

  // --- plain replays of credit and rollback ----------------------------------------------

  walletTest("credit and rollback are each idempotent on replay", async ({ call, session }) => {
    const s = await session(100_000_000);

    const d1 = uuid();
    await call("/v1/debit", debit(s.token, 9, d1, 10_000_000));
    const creditReq = signed({ token: s.token, round: 9, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 20_000_000, ref: d1, currency: "USD" } });
    const c1 = (await call("/v1/credit", creditReq)).body;
    const c2 = (await call("/v1/credit", creditReq)).body;
    expect(c2.credit_id).toBe(c1.credit_id);
    expect(c2.balance.amount).toBe(c1.balance.amount);

    const d2 = uuid();
    await call("/v1/debit", debit(s.token, 10, d2, 10_000_000));
    const rbReq = signed({ token: s.token, round: 10, rollbacks: [{ id: uuid(), ref: d2 }] });
    const r1 = (await call("/v1/rollback", rbReq)).body;
    const r2 = (await call("/v1/rollback", rbReq)).body;
    expect(r2.rollback_ids[0]).toBe(r1.rollback_ids[0]);
    expect(r2.balance.amount).toBe(r1.balance.amount);
  });
});
