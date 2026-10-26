import type { EngineCurrency } from "./handlers/schema";

/**
 * Domain types for the bet ledger (the repo). Money amounts are integer micro-units
 * of the player's currency (1_000_000 = 1.00). Internal surrogate ids are numbers;
 * `extId` fields and the session token / transaction ids are RGS-supplied.
 */

export interface Provider {
  id: number;
  name: string;
  slug: string;
}

export interface Game {
  id: number;
  provider: number;
  name: string;
  slug: string;
  edge: number;
}

export interface Session {
  /** Session token (the RGS sends this as `token`). */
  id: string;
  user: number;
  game: number;
  currency: EngineCurrency;
  createdAt: Date;
}

/** A bet's lifecycle (see repo.bet_status in db/sql/001_init.sql). A bet is a container for 1..N
 *  debits plus 0..N credits. */
export type BetStatus = "pending" | "open" | "closed";

/** A debit transaction's lifecycle (see repo.transaction_status). Only an in-flight debit (and a
 *  single-shot's concurrent credit, with it) is `pending`; other credits/rollbacks are `confirmed`. */
export type TransactionStatus = "pending" | "confirmed";

/** A `pending` debit as Repository.settleDebit hands it to the funding step: its own ids (the
 *  balance op keys), the stake, and the win a single-shot carries. */
export interface PendingDebit {
  id: string;
  amount: number;
  user: number;
  currency: EngineCurrency;
  credit?: { id: string; amount: number };
}

export interface Bet {
  /** The RGS "round" number — also the bet's primary key. */
  id: number;
  session: string;
  user: number;
  game: number;
  currency: EngineCurrency;
  status: BetStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Debit {
  id: string;
  betId: number;
  amount: number;
  extId: string;
  createdAt: Date;
}

export interface Credit {
  id: string;
  betId: number;
  amount: number;
  extId: string;
  reference: string;
  createdAt: Date;
}

export interface Rollback {
  id: string;
  betId: number;
  amount: number;
  extId: string;
  reference: string;
  createdAt: Date;
}
