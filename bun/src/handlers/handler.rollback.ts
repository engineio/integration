import type { FromSchema } from "json-schema-to-ts";
import { ErrNotClosable, ErrNotFound, ErrSessionMismatch } from "../db/errors";
import { ErrBetComplete, ErrInvalidSession } from "./errors";
import { fundDebit } from "./handler.debit";
import type { Handler, State } from "./routes";
import { BalanceResponseSchema, TokenSchema, UuidSchema } from "./schema";

export const schema = {
  request: {
    type: "object",
    required: ["token", "round", "rollbacks"],
    additionalProperties: true,
    properties: {
      token: TokenSchema,
      round: { type: "number" },
      // Whether the round stays open afterwards. Absent/false closes it once the reversals are
      // applied; true reverses only the listed transactions and leaves the round open.
      active: { type: "boolean" },
      // One entry per debit or credit to reverse — one ({id,ref}) for a single reversal, all of a
      // round's debits to abandon it.
      rollbacks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["id", "ref"],
          additionalProperties: true,
          properties: {
            id: UuidSchema,
            ref: UuidSchema,
          },
        },
      },
    },
  },
  response: {
    type: "object",
    required: ["rollback_ids", "balance"],
    additionalProperties: false,
    properties: {
      rollback_ids: { type: "array", items: UuidSchema },
      balance: BalanceResponseSchema,
    },
  }
} as const;

type RollbackRequest = FromSchema<typeof schema.request>;

/**
 * Reverse named debits or credits of an open round, per-ref. `rollbacks[]` names each transaction
 * to reverse (`{ id, ref }`); `active` controls whether the round then closes (absent/false closes
 * it, true keeps it open). The whole batch is atomic.
 *
 * A debit still `pending` (its request died mid-flight, and the RGS never re-sends it) is settled
 * first as its own request would have — funded and confirmed, or deleted if the stake can't be
 * afforded — except that the round is kept open so the reversal can land. Then the bet ledger decides each reversal:
 *   - a confirmed debit is reversed and its stake refunded (a single-shot's win with it); a credit
 *     is reversed and its win clawed back, even into a negative balance — what to do about that is
 *     the operator's call;
 *   - an already-reversed ref replays the existing rollback (idempotent on the ref);
 *   - a ref that never arrived (or a debit just deleted as unaffordable) is tombstoned so its
 *     straggler is later fenced — nothing moves;
 *   - a closed round is final, whatever closed it (ErrNotClosable → ERR_BC);
 *   - a round opened by a DIFFERENT session is refused (ErrSessionMismatch → ERR_IS) — the bet's
 *     recorded session is what authorizes a rollback.
 * Each movement is idempotent on the reversal's own minted id, so re-driving the batch converges.
 */
export const rollbackHandler: Handler<State, RollbackRequest> = async ({ body, state }) => {
  const { repo, balance } = state;

  // The session resolves the token and supplies the user/currency to record an orphan tombstone
  // and to report the balance; the proc authorizes the rollback against the bet's recorded
  // session below.
  const session = await repo.getSessionByToken(body.token).catch((err) => {
    if (err instanceof ErrNotFound) throw new ErrInvalidSession(body.token, err);
    throw err;
  });

  // Settle any named debit still `pending` (funded → confirmed, or unaffordable → deleted), each
  // under its row lock, so its own late request can't decide differently. Settled and unknown
  // debits pass through untouched.
  for (const r of body.rollbacks) {
    await repo.settleDebit({ round: body.round, debitExtId: r.ref, active: true, session: session.id }, (d) => fundDebit(balance, d))
      .catch((err) => {
        if (err instanceof ErrSessionMismatch) throw new ErrInvalidSession(body.token, err);
        throw err;
      });
  }

  // Reverse the named transactions atomically. close iff !active.
  const reversed = await repo.rollback({
    round: body.round,
    session,
    items: body.rollbacks.map((r: { id: string; ref: string }) => ({ ref: r.ref, extId: r.id })),
    active: body.active ?? false,
  }).catch((err) => {
    if (err instanceof ErrNotClosable) throw new ErrBetComplete("round is closed");
    if (err instanceof ErrSessionMismatch) throw new ErrInvalidSession(body.token, err);
    throw err; // ErrConcurrent (a debit went pending since we settled) propagates as ERR_UE
  });

  // Refund each reversed stake (engineBet -> available) and claw back each reversed win
  // (available -> enginePayout, allowed to overdraw), keyed by the reversal's own minted id, so
  // re-driving the whole batch is a no-op on each key. A tombstone moves nothing; if no money moved
  // at all, just report the current balance.
  let amount: number | undefined;
  for (const r of reversed) {
    if (r.amount === 0 || r.type === null) continue;
    amount = await balance.transfer([
      r.type === "debit"
        ? { userId: session.user, currency: session.currency, amount: r.amount, credit: "available", debit: "engineBet", opKey: r.id }
        : { userId: session.user, currency: session.currency, amount: r.amount, credit: "enginePayout", debit: "available", opKey: r.id, overdraw: true },
    ]);
  }
  if (amount === undefined) amount = await balance.get(session.user, session.currency);

  return Response.json({
    rollback_ids: reversed.filter((r) => !r.cascaded).map((r) => r.id),
    balance: { amount, currency: session.currency },
  });
};
