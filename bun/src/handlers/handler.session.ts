import type { EngineCurrency } from "./schema";
import type { State } from "./routes";

// One reusable test player. The conformance suite runs sequentially and resets this
// account's balance on every mint, so reusing it keeps the DB from filling with a
// throwaway provider/game/player per session. (Balance is per (user, currency), so
// concurrent runs would share it — fine for the sequential suite.)
const DEV_USER = 1;

/**
 * Dev-only route: reset the shared test player to a known balance and hand back a
 * fresh session token. NOT signature-authenticated (it isn't wrapped by the router) —
 * gated behind `state.devEndpoints` (DEV_ENDPOINTS). When disabled it 404s and does
 * nothing, so it is inert in production. In a real integration the operator mints
 * sessions from its own game-launch flow.
 */
export function devSessionRoute(state: State) {
  return async (req: Bun.BunRequest): Promise<Response> => {
    if (!state.devEndpoints) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      currency?: EngineCurrency;
      // `startingBalance` is what the RGS wallet conformance suite sends;
      // `balance` is kept as an alias for manual/seed callers. Both are in
      // minor units (micro-units, 1_000_000 = 1.00).
      startingBalance?: number;
      balance?: number;
    };
    const currency: EngineCurrency = body.currency ?? "USD";
    const amount = body.startingBalance ?? body.balance ?? 1_000_000_000;

    const game = await state.repo.ensureDevGame();
    await state.balance.reset(DEV_USER, currency, amount);
    const session = await state.repo.addSession({ user: DEV_USER, game, currency });

    return Response.json({ token: session.id, player: DEV_USER, currency, balance: amount });
  };
}
