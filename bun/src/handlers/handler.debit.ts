import type { FromSchema } from "json-schema-to-ts";
import { type Transfer, ErrInsufficientBalance } from "../balance";
import { ErrDebitFenced, ErrNotFound, ErrRoundClosed } from "../db/errors";
import { ErrBadRequest, ErrBetComplete, ErrInsufficientPlayerBalance, ErrInvalidSession } from "./errors";
import type { Handler, State } from "./routes";
import { BalanceResponseSchema, EngineCurrencySchema, UuidSchema } from "./schema";

export const schema = {
  request: {
    type: "object",
    required: ["token", "round", "active", "mode", "debit", "ip"],
    // Lenient on unknown inbound fields for forward-compat with the RGS (see balance handler).
    additionalProperties: true,
    properties: {
      token: UuidSchema,
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
 * (ErrDebitFenced), and a debit on a closed round is refused (ErrRoundClosed), both before the
 * stake is touched. The transaction ids are the balance op keys (wallet-minted UUIDv7s), so the
 * balance owns its v7 invariant with no translation table. record/transfer/confirm are each
 * idempotent, so an RGS replay converges. If the stake can't be afforded the pending debit is
 * deleted (no money moved); any other uncertain outcome returns a retryable error so the RGS
 * re-drives. We never return success while the outcome is uncertain.
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
    if (err instanceof ErrDebitFenced) throw new ErrBadRequest("debit was rolled back before it arrived");
    if (err instanceof ErrRoundClosed) throw new ErrBetComplete("round is closed");
    throw err;
  });

  // 2. Move money, keyed by this debit's own transaction ids. Stake moves available -> engineBet; a
  //    concurrent win moves enginePayout -> available. transfer applies the available-debit
  //    (stake) first, so the win can't fund the stake. If the stake can't be afforded, the
  //    pending debit is deleted — nothing moved (and the bet too, if this was its first debit).
  const stake: Transfer = { userId: session.user, currency: session.currency, amount: body.debit.amount, credit: "engineBet", debit: "available", opKey: debit.id };
  const movements: [Transfer] | [Transfer, Transfer] = credit
    ? [stake, { userId: session.user, currency: session.currency, amount: credit.amount, credit: "available", debit: "enginePayout", opKey: credit.id }]
    : [stake];
  const newBalance = await balance.transfer(movements).catch(async err => {
    if (err instanceof ErrInsufficientBalance) {
      await repo.rejectDebit(body.round, body.debit.id);
      throw new ErrInsufficientPlayerBalance(err);
    }
    throw err;
  });


  // 3. Funds confirmed → this debit becomes confirmed; the round opens (or closes for active=false).
  await repo.confirmDebit(body.round, body.debit.id, body.active);

  return Response.json({
    debit_id: debit.id,
    credit_id: credit?.id,
    balance: { amount: newBalance, currency: session.currency },
  });
};
