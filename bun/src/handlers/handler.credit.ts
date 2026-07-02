import type { FromSchema } from "json-schema-to-ts";
import { ErrNotClosable, ErrNotFound } from "../db/errors";
import { ErrBadRequest, ErrBetComplete, ErrBetNotFound, ErrInvalidSession } from "./errors";
import type { Handler, State } from "./routes";
import { BalanceResponseSchema, EngineCurrencySchema, UuidSchema } from "./schema";

export const schema = {
  request: {
    type: "object",
    required: ["token", "round", "active", "ip"],
    additionalProperties: true,
    properties: {
      token: UuidSchema,
      round: { type: "number" },
      active: { type: "boolean" },
      ip: { type: "string" },
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
    // credit_id is present only when a win was paid; a losing/zero round omits it.
    required: ["balance"],
    additionalProperties: false,
    properties: {
      credit_id: UuidSchema,
      balance: BalanceResponseSchema,
    },
  }
} as const;

type CreditRequest = FromSchema<typeof schema.request>;

/**
 * Record a credit on a round and, when `active` is false, close it. A round holds 0..N credits:
 * while it is open each `/credit` appends another payout (idempotent on the credit's RGS id) and
 * `active = false` finally closes it. A missing `credit` is a losing/zero settlement — with
 * `active = false` it closes the round paying nothing.
 *
 * Bet-first ordering: the bet ledger owns "can a credit land here", records the credit (validating
 * its `ref`, a FK to the settled debit), and only then does the win move enginePayout -> available
 * on the balance service, keyed by the credit's id. Replaying a credit returns the stored result;
 * each win is paid at most once across retries. A new credit on an already-closed round is refused.
 */
export const creditHandler: Handler<State, CreditRequest> = async ({ body, state }) => {
  const { repo, balance } = state;

  const bet = await repo.getBet(body.round).catch((err) => {
    if (err instanceof ErrNotFound) throw new ErrBetNotFound(body.round, err);
    throw err;
  });

  if (bet.session !== body.token) {
    throw new ErrInvalidSession(body.token);
  }
  if (body.credit && body.credit.currency !== bet.currency) {
    throw new ErrBadRequest("credit currency must match bet currency");
  }

  // 1. Record the credit on the bet ledger and, unless `active`, close the round. close_bet_v1 is
  //    idempotent on the credit's ext_id: a replay returns the stored credit instead of erroring, so
  //    there's no "already settled" branch here — the returned credit id is canonical either way. A
  //    round holds 0..N credits while open; `active = false` closes it (a null credit + active=false
  //    closes a losing/zero round). A NEW credit on an already-closed round is refused
  //    (ErrNotClosable). A round whose first debit is still mid-flight raises ErrConcurrent → 5xx.
  const [, credit] = await repo.closeBet({
    betId: body.round,
    credit: body.credit
      ? { amount: body.credit.amount, extId: body.credit.id, ref: body.credit.ref }
      : undefined,
    active: body.active,
  }).catch((err) => {
    if (err instanceof ErrNotClosable) throw new ErrBetComplete("round already closed");
    throw err;
  });

  // 2. Pay the win on the balance service, keyed by the credit transaction's own UUIDv7
  //    (creditId, minted by closeBet) — like every handler, the balance op key is the bet
  //    ledger's transaction id, so it's a wallet-owned, replay-stable v7. A losing round moves
  //    no money; just report the current balance.
  const amount = body.credit
    ? await balance.transfer([
      { userId: bet.user, currency: bet.currency, amount: body.credit.amount, credit: "available", debit: "enginePayout", opKey: credit?.id! },
    ])
    : await balance.get(bet.user, bet.currency);

  return Response.json({
    credit_id: credit?.id,
    balance: { amount, currency: bet.currency },
  });
};
