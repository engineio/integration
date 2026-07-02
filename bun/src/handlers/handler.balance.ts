import type { FromSchema } from "json-schema-to-ts";
import { ErrNotFound } from "../db/errors";
import { ErrInvalidSession } from "./errors";
import type { Handler, State } from "./routes";
import { BalanceResponseSchema, UuidSchema } from "./schema";

export const schema = {
  request: {
    type: "object",
    required: ["token"],
    // Ignore unknown inbound fields: the RGS may add request fields over time, and a
    // strict wallet would 400 the day it does. Responses (below / elsewhere) stay strict.
    additionalProperties: true,
    properties: { token: UuidSchema },
  },
  response: {
    type: "object",
    required: ["balance"],
    additionalProperties: false,
    properties: { balance: BalanceResponseSchema },
  }
} as const;

type BalanceRequest = FromSchema<typeof schema.request>;

/** Resolve the session token and report the player's spendable balance. */
export const balanceHandler: Handler<State, BalanceRequest> = async ({ body, state }) => {
  const session = await state.repo.getSessionByToken(body.token).catch((err) => {
    if (err instanceof ErrNotFound) throw new ErrInvalidSession(body.token, err);
    throw err;
  });

  const amount = await state.balance.get(session.user, session.currency);
  return Response.json({ balance: { amount, currency: session.currency } });
};
