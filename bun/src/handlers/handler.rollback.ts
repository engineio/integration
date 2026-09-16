import type { FromSchema } from "json-schema-to-ts";
import { ErrNotClosable, ErrNotFound, ErrSessionMismatch } from "../db/errors";
import { ErrBetComplete, ErrInvalidSession } from "./errors";
import type { Handler, State } from "./routes";
import { BalanceResponseSchema, UuidSchema } from "./schema";

export const schema = {
  request: {
    type: "object",
    required: ["token", "round", "rollbacks"],
    additionalProperties: true,
    properties: {
      token: UuidSchema,
      round: { type: "number" },
      // Whether the round stays open afterwards. Absent/false closes it once the reversals are
      // applied; true reverses only the listed debits and leaves the round open for its others.
      active: { type: "boolean" },
      // One entry per debit to reverse. A round can hold many debits, so the RGS names exactly
      // which to reverse — one ({id,ref}) for a single reversal, all of them to abandon the round.
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
 * Reverse one or more of a round's debits — per-debit. A bet is a container for 1..N debits, so the
 * RGS names exactly which to reverse in `rollbacks[]` (each `{ id, ref }` reversing the debit named
 * by `ref`); `active` controls whether the round then closes (absent/false closes it, true keeps it
 * open for its remaining debits). The whole batch is atomic.
 *
 * The bet ledger decides each reversal:
 *   - a funded (confirmed) debit is reversed and its stake refunded;
 *   - an already-rolled-back debit replays the existing rollback (idempotent on the debit);
 *   - a debit that never arrived is tombstoned (rollback-before-debit) so its straggler debit is
 *     later fenced — nothing is refunded;
 *   - a round still mid-debit (a referenced debit is `pending`) is retryable (ErrConcurrent → 5xx);
 *   - a round already settled by a credit is terminal (ErrNotClosable → 4xx);
 *   - a round opened by a DIFFERENT session is refused (ErrSessionMismatch → ERR_IS) — the bet's
 *     recorded session is what authorizes a rollback.
 * Each refund is idempotent on the reversal's own minted id, so re-driving the batch converges.
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

  // Reverse the named debits atomically. close iff !active.
  const reversed = await repo.rollbackDebits({
    round: body.round,
    session,
    items: body.rollbacks.map((r: { id: string; ref: string }) => ({ ref: r.ref, extId: r.id })),
    active: body.active ?? false,
  }).catch((err) => {
    if (err instanceof ErrNotClosable) throw new ErrBetComplete("round is not reversible (already settled)");
    if (err instanceof ErrSessionMismatch) throw new ErrInvalidSession(body.token, err);
    throw err; // ErrConcurrent (a referenced debit mid-flight) propagates as a retryable 5xx
  });

  // Refund each reversed stake (engineBet -> available), keyed by the reversal's own minted id, so
  // re-driving the whole batch is a no-op on each key. A tombstone (amount 0) moves nothing; if no
  // money moved at all, just report the current balance.
  let amount: number | undefined;
  for (const r of reversed) {
    if (r.amount > 0) {
      amount = await balance.transfer([
        { userId: session.user, currency: session.currency, amount: r.amount, credit: "available", debit: "engineBet", opKey: r.id },
      ]);
    }
  }
  if (amount === undefined) amount = await balance.get(session.user, session.currency);

  return Response.json({
    rollback_ids: reversed.map((r) => r.id),
    balance: { amount, currency: session.currency },
  });
};
