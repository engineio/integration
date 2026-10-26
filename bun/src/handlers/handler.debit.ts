import type { FromSchema } from "json-schema-to-ts";
import { type Balance, type Transfer, ErrInsufficientBalance } from "../balance";
import { ErrFenced, ErrNotFound, ErrRoundClosed } from "../db/errors";
import { ErrBadRequest, ErrBetComplete, ErrInsufficientPlayerBalance, ErrInvalidSession } from "./errors";
import type { PendingDebit } from "../types";
import type { Handler, State } from "./routes";
import { BalanceResponseSchema, EngineCurrencySchema, TokenSchema, UuidSchema } from "./schema";

export const schema = {
  request: {
    type: "object",
    required: ["token", "round", "active", "mode", "debit", "ip"],
    // Lenient on unknown inbound fields for forward-compat with the RGS (see balance handler).
    additionalProperties: true,
    properties: {
      token: TokenSchema,
      round: { type: "number" },
      active: { type: "boolean" },
      mode: { type: "string" },
      ip: { type: "string" },
      debit: {
        type: "object",
        required: ["id", "amount", "currency"],
        additionalProperties: true,
        properties: {
          id: UuidSchema,
          // Integer micro-units, strictly positive — reject 0 / negative / fractional at
          // the boundary (ERR_BAD) rather than deep in the ledger.
          amount: { type: "integer", minimum: 1 },
          currency: EngineCurrencySchema,
        },
      },
      // Optional concurrent credit (e.g. buy-feature: stake and win settle together).
      credit: {
        oneOf: [
          {
            type: "object",
            required: ["id", "amount", "ref", "currency"],
            additionalProperties: true,
            properties: {
              id: UuidSchema,
              amount: { type: "integer", minimum: 0 },
              ref: UuidSchema,
              currency: EngineCurrencySchema,
            },
          },
          { type: "null" },
        ],
      },
    },
  },
  response: {
    type: "object",
    required: ["debit_id", "balance"],
    additionalProperties: false,
    properties: {
      debit_id: UuidSchema,
      credit_id: UuidSchema,
      balance: BalanceResponseSchema,
    },
  }
} as const;
type DebitRequest = FromSchema<typeof schema.request>;

/**
 * Open or add to a bet: record a debit on the bet ledger (as `pending`), take the stake (and
 * optionally settle a concurrent win) on the balance service, then confirm the debit.
 *
 * A bet is a CONTAINER for 1..N debits. The first debit opens the round; a debit with a NEW
 * transaction id on an already-open round simply ADDS another debit (the idempotency unit is the
 * debit's ext_id, not the round). A replayed ext_id returns the stored ids and moves no money.
 *
 * Bet-first ordering: the debit is recorded BEFORE any money moves, so the ledger can fence it —
 * a rollback that referenced this debit's ext_id before it arrived makes record_debit_v1 refuse it
 * (ErrFenced), and a debit on a closed round is refused (ErrRoundClosed), both before the
 * stake is touched. The transaction ids are the balance op keys (wallet-minted UUIDv7s), so the
 * balance owns its v7 invariant with no translation table. record/transfer/confirm are each
 * idempotent, so an RGS replay converges. If the stake can't be afforded the pending debit is
 * deleted (no money moved); any other uncertain outcome returns ERR_UE, and the RGS either re-sends
 * the debit or rolls it back — that rollback settles a still-pending debit the same way. We never
 * return success while the outcome is uncertain.
 */
export const debitHandler: Handler<State, DebitRequest> = async ({ body, state }) => {
  const { repo, balance } = state;

  const session = await repo.getSessionByToken(body.token).catch((err) => {
    if (err instanceof ErrNotFound) throw new ErrInvalidSession(body.token, err);
    throw err;
  });

  if (body.debit.currency !== session.currency) {
    throw new ErrBadRequest("debit currency must match session currency");
  }
  if (body.credit && body.credit.currency !== body.debit.currency) {
    throw new ErrBadRequest("debit and credit currency must match");
  }

  // 1. Record the debit (bet-first) as `pending`, BEFORE any money moves. record_debit_v1 fences a
  //    debit whose ext_id a rollback already cancelled, and refuses a debit on a closed round —
  //    both before the stake is touched. Idempotent on the debit's ext_id; the returned
  //    debit/credit ids are wallet-minted UUIDv7s, used directly as the balance op keys.
  const [, debit, credit] = await repo.recordDebit({
    id: body.round,
    sessionId: session.id,
    user: session.user,
    game: session.game,
    currency: session.currency,
    debit: { amount: body.debit.amount, extId: body.debit.id },
    credit: body.credit ? { amount: body.credit.amount, extId: body.credit.id } : undefined,
  }).catch((err) => {
    if (err instanceof ErrFenced) throw new ErrBadRequest("debit was rolled back before it arrived");
    if (err instanceof ErrRoundClosed) throw new ErrBetComplete("round is closed");
    throw err;
  });

  // 2. Settle it: move the money, then confirm the debit (the round opens, or closes for
  //    active=false) — or, if the stake can't be afforded, delete it: nothing moved (and the bet
  //    goes too, if this was its first debit). A rollback naming this debit settles it the same
  //    way under the same row lock, so if one got there first we just report what it decided.
  const settled = await repo.settleDebit(
    { round: body.round, debitExtId: body.debit.id, active: body.active },
    (d) => fundDebit(balance, d),
  );
  if (settled.status === "rejected") throw new ErrInsufficientPlayerBalance();

  return Response.json({
    debit_id: debit.id,
    credit_id: credit?.id,
    balance: { amount: settled.balance ?? (await balance.get(session.user, session.currency)), currency: session.currency },
  });
};

/**
 * Fund a pending debit, keyed by its own transaction ids so whoever settles it moves the money
 * once: the stake moves available -> engineBet and a single-shot's win enginePayout -> available.
 * transfer applies the stake first, so the win can't fund it. Returns the new balance, or null if
 * the stake can't be afforded (nothing moved).
 */
export function fundDebit(balance: Balance, d: PendingDebit): Promise<number | null> {
  const stake: Transfer = { userId: d.user, currency: d.currency, amount: d.amount, credit: "engineBet", debit: "available", opKey: d.id };
  const movements: [Transfer] | [Transfer, Transfer] = d.credit
    ? [stake, { userId: d.user, currency: d.currency, amount: d.credit.amount, credit: "available", debit: "enginePayout", opKey: d.credit.id }]
    : [stake];
  return balance.transfer(movements).catch((err) => {
    if (err instanceof ErrInsufficientBalance) return null;
    throw err;
  });
}
