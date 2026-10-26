import type { SQL } from "bun";
import type { EngineCurrency } from "../handlers/schema";
import { migrate } from "../database";
import { load } from "../migrate.macro" with { type: "macro" };
import type { Bet, Credit, Debit, Game, PendingDebit, Provider, Session } from "../types";
import { ErrNotFound, ErrSessionMismatch, intoRepoError } from "./errors";

// Bundled at build time (see migrate.macro.ts) so the binary is self-contained.
const migrations = load("./db/sql");

/**
 * The bet ledger. The mutations (record/confirm/close/rollback) each run as a single atomic
 * stored procedure call and commit immediately — there is no transaction held open across the
 * balance service. A bet is a container for 1..N debits plus 0..N credits (each accumulating
 * while the round is open; `active = false` closes it).
 * Idempotency is enforced by the schema: each transaction's ext_id is UNIQUE per round, so the
 * DEBIT (not the round) is the idempotency unit — a replayed ext_id reads back the stored ids, a
 * new ext_id on an open round appends another debit.
 *
 * Talks only to schema `repo`; it knows nothing about balances.
 */
export class Repository {
  constructor(private readonly sql: SQL) {}

  async migrate() {
    return migrate(this.sql, migrations, "repo._migrations");
  }

  // --- providers & games -------------------------------------------------

  async addProvider(params: { name: string }): Promise<Provider> {
    const [row] = await this.sql`
      INSERT INTO repo.provider (name, slug)
      VALUES (${params.name}, ${slugify(params.name)})
      RETURNING *
    `.catch(intoRepoError);
    return rowToProvider(row);
  }

  async addGame(params: { provider: number; name: string; edge: number }): Promise<Game> {
    const [row] = await this.sql`
      INSERT INTO repo.game (provider, name, slug, edge)
      VALUES (${params.provider}, ${params.name}, ${slugify(params.name)}, ${params.edge})
      RETURNING *
    `.catch(intoRepoError);
    return rowToGame(row);
  }

  async getGame(id: number): Promise<Game> {
    const [row] = await this.sql`SELECT * FROM repo.game WHERE id = ${id}`.catch(intoRepoError);
    if (!row) throw new ErrNotFound(`game:${id} not found`);
    return rowToGame(row);
  }

  /** Dev/test: find-or-create a single shared provider + game, returning the game id.
   *  Lets the dev session route reuse one game instead of minting a new one per call. */
  async ensureDevGame(): Promise<number> {
    const [provider] = await this.sql`
      INSERT INTO repo.provider (name, slug) VALUES ('Example Provider', 'example-provider')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `.catch(intoRepoError);
    const [game] = await this.sql`
      INSERT INTO repo.game (provider, name, slug, edge) VALUES (${Number(provider.id)}, 'Example Game', 'example-game', 0.05)
      ON CONFLICT (provider, slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `.catch(intoRepoError);
    return Number(game.id);
  }

  // --- sessions ----------------------------------------------------------

  async addSession(params: { user: number; game: number; currency: EngineCurrency }): Promise<Session> {
    const [row] = await this.sql`
      INSERT INTO repo.session (id, "user", game, currency)
      VALUES (${Bun.randomUUIDv7()}::uuid, ${params.user}, ${params.game}, ${params.currency}::repo.currency)
      RETURNING *
    `.catch(intoRepoError);
    return rowToSession(row);
  }

  async getSessionByToken(token: string): Promise<Session> {
    const [row] = await this.sql`
      SELECT id, "user", game, currency, created_at FROM repo.session WHERE id = ${token}::uuid
    `.catch(intoRepoError);
    if (!row) throw new ErrNotFound(`session:${token} not found`);
    return rowToSession(row);
  }

  // --- bet ledger (bet-first lifecycle) ----------------------------------

  /** Record a debit on a round, BEFORE any money moves. The first debit opens the bet `pending`;
   *  a later debit (a NEW ext_id) is APPENDED while the round is open. Atomic and committed on
   *  return. IDEMPOTENT on the debit's ext_id — record_debit_v1 returns the originally stored ids
   *  on a replay (the freshly minted ones below are used only on first record). Throws
   *  ErrFenced if a rollback already cancelled this debit (rollback-before-debit) and
   *  ErrRoundClosed if the round is already closed — both terminal 4xx in the handler. The returned
   *  debit / credit ids are wallet-minted UUIDv7s; the handler uses them directly as balance op keys. */
  async recordDebit(params: {
    id: number;
    sessionId: string;
    user: number;
    game: number;
    currency: EngineCurrency;
    debit: { amount: number; extId: string };
    credit?: { amount: number; extId: string };
  }): Promise<[Bet, Debit, Credit | undefined]> {
    const [row] = await this.sql`
      SELECT debit_id, credit_id, bet_created_at FROM repo.record_debit_v1(
        ${params.id}, ${params.sessionId}::uuid,
        ${params.user}, ${params.game}, ${params.currency}, ${params.debit.amount},
        ${Bun.randomUUIDv7()}::uuid, ${params.debit.extId}::uuid,
        ${params.credit?.amount ?? null}, ${params.credit ? Bun.randomUUIDv7() : null}::uuid, ${params.credit?.extId ?? null}::uuid
      )
    `.catch(intoRepoError);
    // Canonical ids from the proc: on a replay these are the originally stored ids.
    const debitId = row.debit_id as string;
    const creditId = row.credit_id as string | null;
    const createdAt = row.bet_created_at as Date;

    const bet: Bet = {
      id: params.id,
      session: params.sessionId,
      user: params.user,
      game: params.game,
      currency: params.currency,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    const debit: Debit = {
      id: debitId,
      betId: params.id,
      amount: params.debit.amount,
      extId: params.debit.extId,
      createdAt,
    };
    const credit: Credit | undefined =
      params.credit && creditId
        ? {
            id: creditId,
            betId: params.id,
            amount: params.credit.amount,
            extId: params.credit.extId,
            reference: params.debit.extId,
            createdAt,
          }
        : undefined;

    return [bet, debit, credit];
  }

  /** Settle a `pending` debit. Under the debit's row lock, `fund` moves its money (idempotent on
   *  the debit's own ids) and returns the new balance, or null if the stake can't be afforded; the
   *  debit is then confirmed (closing the round for `active = false`) or rejected — deleted, since
   *  nothing moved — in the same transaction. The debit's own request and a rollback naming it both
   *  settle through here, so whichever takes the lock first decides and the other finds it settled:
   *  the balance and the bet ledger can't disagree. `balance` is set only when this call funded it.
   *  "rejected" also covers a debit that no longer exists. With `session`, a debit whose bet belongs
   *  to another session throws ErrSessionMismatch before anything moves. */
  async settleDebit(
    params: { round: number; debitExtId: string; active: boolean; session?: string },
    fund: (debit: PendingDebit) => Promise<number | null>,
  ): Promise<{ status: "confirmed" | "rejected"; balance?: number }> {
    const { round, debitExtId, active, session } = params;
    return this.sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '1s'`;
      const [d] = await tx`
        SELECT d.id, d.amount, d.status, b.session, b."user", b.currency
        FROM repo.transaction d JOIN repo.bet b ON b.id = d.bet_id
        WHERE d.bet_id = ${round} AND d.type = 'debit' AND d.ext_id = ${debitExtId}::uuid
        FOR UPDATE OF d
      `;
      if (!d) return { status: "rejected" as const };
      if (d.status !== "pending") return { status: "confirmed" as const };
      if (session !== undefined && d.session !== session) throw new ErrSessionMismatch();

      const [c] = await tx`
        SELECT id, amount FROM repo.transaction
        WHERE bet_id = ${round} AND type = 'credit' AND reference = ${debitExtId}::uuid AND status = 'pending'
      `;
      const balance = await fund({
        id: d.id as string,
        amount: Number(d.amount),
        user: Number(d.user),
        currency: d.currency as EngineCurrency,
        credit: c ? { id: c.id as string, amount: Number(c.amount) } : undefined,
      });
      if (balance === null) {
        await tx`SELECT repo.reject_debit_v1(${round}, ${debitExtId}::uuid)`;
        return { status: "rejected" as const };
      }
      await tx`SELECT repo.confirm_debit_v1(${round}, ${debitExtId}::uuid, ${active})`;
      return { status: "confirmed" as const, balance };
    }).catch(intoRepoError);
  }

  /** Record a credit on a round and, unless `active`, close it. A round holds 0..N credits — each
   *  idempotent on its own ext_id, each accumulating while the round is open; `active = false` closes
   *  it. A NULL credit with `active = false` closes a losing/zero round. Atomic and committed on
   *  return. IDEMPOTENT on the credit ext_id — close_bet_v1 returns the stored credit on a replay
   *  rather than throwing; the returned credit_id is canonical (the freshly minted one below is used
   *  only on first record). Throws ErrConcurrent if the first debit is still `pending`, ErrNotClosable
   *  (SEBNC) if a NEW credit lands on an already-closed round, and ErrNotFound (SEBNF) for an unknown
   *  round. */
  async closeBet(params: {
    betId: number;
    credit?: { amount: number; extId: string; ref: string };
    active: boolean;
  }): Promise<[Bet, Credit | undefined]> {
    const [row] = await this.sql`
      SELECT * FROM repo.close_bet_v1(
        ${params.betId}, ${params.credit ? Bun.randomUUIDv7() : null}::uuid, ${params.credit?.amount ?? null},
        ${params.credit?.extId ?? null}::uuid, ${params.credit?.ref ?? null}::uuid, ${params.active}
      )
    `.catch(intoRepoError);

    const bet = rowToBet(row, "bet_");
    // Canonical credit id from the proc: the minted one on a fresh close, the stored one on a replay.
    const creditId = row.credit_id as string | null;
    const credit: Credit | undefined =
      params.credit && creditId
        ? {
            id: creditId,
            betId: bet.id,
            amount: params.credit.amount,
            extId: params.credit.extId,
            reference: params.credit.ref,
            createdAt: bet.updatedAt,
          }
        : undefined;

    return [bet, credit];
  }

  /** Reverse named debits or credits of an open round, per-ref, in one atomic batch. Each item
   *  names a transaction by `ref` (its RGS ext_id) and carries the RGS rollback id (`extId`); the
   *  wallet mints a rollback transaction id per reversal. Returns `{ id, amount, type }` per item,
   *  IN INPUT ORDER: `type` is what was reversed (a debit's stake to refund, a credit's win to claw
   *  back), or null with amount 0 for a tombstone (an orphan rollback that arrived before the
   *  transaction it names — the straggler is then fenced). Reversing a single-shot's debit also
   *  reverses the win it carried, returned as an extra row with `cascaded` set: its money moves,
   *  but it isn't one of the request's rollback ids. IDEMPOTENT on each ref (a replay returns the
   *  existing rollback). Throws ErrConcurrent if a referenced transaction is still `pending`
   *  (settle it first — see settleDebit), ErrNotClosable if the round is closed, and
   *  ErrSessionMismatch (SESMM) if the session doesn't match the bet's recorded session. The round
   *  is closed unless `active`.
   *  An orphan rollback creates the bet from the session so the tombstone has a home. */
  async rollback(params: {
    round: number;
    session: Session;
    items: { ref: string; extId: string }[];
    active: boolean;
  }): Promise<{ id: string; amount: number; type: "debit" | "credit" | null; cascaded: boolean }[]> {
    // The wallet mints a rollback transaction id per reversal; the whole batch is reversed in one
    // atomic proc call (a RAISE inside aborts it), then the round closes unless the RGS keeps it
    // open. The batch is passed as the raw JS array cast `::jsonb` — Bun encodes that to a real jsonb
    // array (whereas `${arr}::uuid[]` comma-joins to a malformed literal, and pre-`JSON.stringify`
    // double-encodes to a scalar — see the proc comment).
    const { round, session, items, active } = params;
    const batch = items.map((i) => ({ ref: i.ref, id: Bun.randomUUIDv7(), ext: i.extId, cid: Bun.randomUUIDv7() }));
    const rows = await this.sql`
      SELECT rollback_id, rollback_amount, reversed_type, cascaded FROM repo.rollback_v1(
        ${round}, ${session.id}::uuid, ${session.user}, ${session.game}, ${session.currency},
        ${batch}::jsonb, ${active}
      )
    `.catch(intoRepoError);
    return rows.map((r: Record<string, unknown>) => ({
      id: r.rollback_id as string,
      amount: Number(r.rollback_amount),
      type: r.reversed_type as "debit" | "credit" | null,
      cascaded: r.cascaded as boolean,
    }));
  }

  /** Read a bet. Throws ErrNotFound for an unknown round OR a round with no debit (an orphan rollback
   *  tombstone) — so a credit for such a round returns ERR_BNF. A round holds 0..N credits now, so
   *  this returns just the bet; callers that need the credits query them directly. */
  async getBet(id: number): Promise<Bet> {
    const [row] = await this.sql`SELECT * FROM repo.get_bet_v1(${id})`.catch(intoRepoError);
    if (!row) throw new ErrNotFound(`bet:${id} not found`);
    return rowToBet(row, "bet_");
  }
}

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function rowToProvider(row: Record<string, unknown>): Provider {
  return {
    id: Number(row.id),
    name: row.name as string,
    slug: row.slug as string,
  };
}

function rowToGame(row: Record<string, unknown>): Game {
  return {
    id: Number(row.id),
    provider: Number(row.provider),
    name: row.name as string,
    slug: row.slug as string,
    edge: Number(row.edge),
  };
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    user: Number(row.user),
    game: Number(row.game),
    currency: row.currency as EngineCurrency,
    createdAt: row.created_at as Date,
  };
}

/** Map the `bet_*`-prefixed columns the procs return into a Bet. */
function rowToBet(row: Record<string, unknown>, p: "bet_"): Bet {
  return {
    id: Number(row[`${p}id`]),
    session: row[`${p}session`] as string,
    user: Number(row[`${p}user`]),
    game: Number(row[`${p}game`]),
    currency: row[`${p}currency`] as EngineCurrency,
    status: row[`${p}status`] as Bet["status"],
    createdAt: row[`${p}created_at`] as Date,
    updatedAt: row[`${p}updated_at`] as Date,
  };
}
