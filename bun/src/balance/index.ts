/**
 * The balance ledger as an injectable interface. The wallet handlers depend on this
 * interface, not on the Postgres implementation, so the balance can be swapped for a
 * remote service, a different store, or a mock without touching the handlers. This models
 * the common real-world shape where balances live in a separate account service.
 *
 * `transfer` is **idempotent**: each movement carries an `opKey` (the RGS transaction id),
 * and re-applying a key that was already settled is a no-op that returns the unchanged
 * balance. That property — not a shared transaction with the bet ledger — is what keeps
 * the two stores consistent under the RGS's retries. `transfer` commits immediately and
 * returns the new available balance.
 */

// A player's money sits in buckets. `available` is what they can spend;
// `engineBet`/`enginePayout` are the internal counter-accounts a wager/win moves
// through; `testFunds` is the dev/test source that top-ups are drawn from.
export type BalanceBucket = "available" | "engineBet" | "enginePayout" | "testFunds";

export interface Transfer {
  userId: number;
  currency: string;
  amount: number;
  /** Destination bucket (incremented). */
  credit: BalanceBucket;
  /** Source bucket (decremented). */
  debit: BalanceBucket;
  /** Idempotency key — the RGS transaction id behind this movement. Re-applying the
   *  same key is a no-op. */
  opKey: string;
}

export interface Balance {
  /** A player's spendable (`available`) balance for a currency. */
  get(userId: number, currency: string): Promise<number>;
  /** Apply 1–2 double-entry movements for a single player and return the new available
   *  balance. Idempotent per movement `opKey`; commits immediately. */
  transfer(movements: [Transfer] | [Transfer, Transfer]): Promise<number>;
  /** Dev/test: reset a player's currency to exactly `amount` spendable. */
  reset(userId: number, currency: string, amount: number): Promise<void>;
}


/** A debit's source bucket couldn't cover the amount. */
export class ErrInsufficientBalance extends Error {
  constructor() {
    super("insufficient balance");
    this.name = "ErrInsufficientBalance";
  }
}

export { PostgresBalance } from "./postgres";
export { TigerBeetleBalance } from "./tigerbeetle";

