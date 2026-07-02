import type { SQL } from "bun";
import { migrate } from "../database";
import { load } from "../migrate.macro" with { type: "macro" };
import { type Balance, ErrInsufficientBalance, type Transfer } from "./index";

// Bundled at build time (see migrate.macro.ts) so the binary is self-contained.
const migrations = load("./balance/sql");

// The Postgres ledger derives op_ts = uuid_extract_timestamp(op_key) for partition routing and
// replay-safety (see balance/sql/001_init.sql), so every op key MUST be a UUIDv7. The keys are
// the wallet's own bet-ledger transaction ids (minted as v7 — see the handlers), so transfer()
// asserts it defensively: a non-v7 key (e.g. a caller that passed a raw RGS id straight through)
// fails loudly here, rather than silently mis-routing the partition or breaking replay dedup.
// (TigerBeetle has no such requirement: any unique 128-bit id works, so it carries no guard.)
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Postgres-backed balance ledger (schema `balance`). Gets its own SQL connection so it is
 * genuinely independent of the bet ledger — it stands in for a separate account service.
 * There is no shared transaction with the bet ledger; consistency comes from idempotency
 * (each movement is keyed by a wallet-minted UUIDv7 op key) plus the RGS's retries.
 */
export class PostgresBalance implements Balance {
  constructor(private readonly sql: SQL) { }

  async migrate(): Promise<void> {
    return migrate(this.sql, migrations, "balance._migrations");
  }

  async get(userId: number, currency: string): Promise<number> {
    const [row] = await this.sql`
      SELECT amount FROM balance.account
      WHERE user_id = ${userId} AND currency = ${currency}::balance.currency AND type = 'available'
    `;
    return row ? Number(row.amount) : 0;
  }

  /**
   * Apply 1–2 double-entry movements via balance.transfer_v1 (one round trip), committed
   * immediately, returning the new available balance. Idempotent per movement `opKey`: a
   * replay re-sends the same keys and applies nothing. The function applies
   * available-debits before available-credits, so a same-batch win can never fund the
   * stake (e.g. $5 balance, $10 stake, $20 win is rejected, not netted to +$10).
   */
  async transfer(movements: [Transfer] | [Transfer, Transfer]): Promise<number> {
    const [m1, m2] = movements;
    const { userId, currency } = m1;
    if (m2 && (m2.userId !== userId || m2.currency !== currency)) {
      throw new Error("both movements must be for the same player and currency");
    }
    for (const m of movements) {
      if (!UUID_V7.test(m.opKey)) throw new Error(`balance op key must be a UUIDv7, got "${m.opKey}"`);
    }

    const [row] = await this.sql`
      SELECT balance.transfer_v1(
        ${userId}, ${currency},
        ${m1.debit}, ${m1.credit}, ${m1.amount}, ${m1.opKey}::uuid,
        ${m2?.debit ?? null}, ${m2?.credit ?? null}, ${m2?.amount ?? null}, ${m2?.opKey ?? null}::uuid
      ) AS amount`.catch((err) => {
      // The function raises SQLSTATE SEIPB when `available` can't cover a debit.
      if ((err as { errno?: unknown } | null)?.errno === "SEIPB") throw new ErrInsufficientBalance();
      throw err;
    });
    return Number(row.amount);
  }

  /** Dev/test helper: reset a player's currency to exactly `amount` available,
   *  clearing any escrow/payout from prior tests so one account can be reused. */
  async reset(userId: number, currency: string, amount: number): Promise<void> {
    await this.sql`SELECT balance.reset_v1(${userId}, ${currency}, ${amount})`;
  }
}
