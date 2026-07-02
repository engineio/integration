import Ajv from "ajv";
import { createVerify, type KeyObject } from "node:crypto";
import type { Balance } from "../balance";
import type { Repository } from "../db/repo";
import { ErrBadAuth, ErrBadRequest, ErrGeneralError, toErrorResponse } from "./errors";
import { balanceHandler, schema as balanceSchema } from "./handler.balance";
import { creditHandler, schema as creditSchema } from "./handler.credit";
import { debitHandler, schema as debitSchema } from "./handler.debit";
import { rollbackHandler, schema as rollbackSchema } from "./handler.rollback";
import { devSessionRoute } from "./handler.session";


// One AJV instance; route() compiles each schema once at startup.
const ajv = new Ajv({ allErrors: true });
// AJV ships no formats by default; register just `uuid` (any version) so the `format: "uuid"` in
// our request schemas (UuidSchema) validates id/token fields. We don't pin UUIDv7 here — the RGS
// isn't required to send v7; that invariant is enforced internally on the key we mint.
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export type Handler<State, B> = (ctx: {
  req: Bun.BunRequest;
  body: B;
  state: State;
}) => Promise<Response> | Response;

export interface Schema {
  request: object;
  response?: object;
}

export interface State {
  repo: Repository;
  balance: Balance;
  rgsPublicKey: KeyObject;
  /** When true, mount the unauthenticated dev helper routes (e.g. /v1/dev/session).
   *  Must be false in production — these mint sessions and reset balances. */
  devEndpoints: boolean;
  log: (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown>) => void,
}

/**
 * `createRouter(state)` is called once at startup and returns `route(opts, handler)`.
 * `route` compiles the validators once and returns the per-request hot path:
 *
 *   verify signature -> parse + validate body -> handler -> validate response -> log
 *
 * The handler owns the DB transaction(s) and money logic; the wrapper does not.
 */
function createRouter<S extends State>(state: S) {
  return function route<B>(schema: Schema, handler: Handler<State, B>) {
    const validateRequest = ajv.compile<B>(schema.request);
    const validateResponse = schema.response ? ajv.compile(schema.response) : null;

    return async (req: Bun.BunRequest): Promise<Response> => {
      const start = performance.now();
      const path = new URL(req.url).pathname;
      let status = 500;

      try {
        // Check the header before touching the body, so unsigned requests cost nothing.
        const signature = req.headers.get("x-signature");
        if (!signature) throw new ErrBadAuth("Missing signature");

        // Buffer (an ArrayBufferView) so createVerify().update() accepts it and we can
        // decode the same bytes for JSON.parse — the signature is over these raw bytes.
        const rawBody = Buffer.from(await req.arrayBuffer());
        const verified = createVerify("RSA-SHA256")
          .update(rawBody)
          .verify(state.rgsPublicKey, signature, "base64");
        if (!verified) {
          throw new ErrBadAuth("Invalid signature");
        }

        let body: B;
        try {
          body = JSON.parse(rawBody.toString()) as B;
        } catch {
          throw new ErrBadRequest("Invalid JSON");
        }
        if (!validateRequest(body)) {
          throw new ErrBadRequest("Bad Request");
        }

        const res = await handler({ req, body, state });
        status = res.status;

        if (validateResponse) {
          const payload = await res.clone().json().catch(() => null);
          if (payload && !validateResponse(payload)) {
            state.log("error", "response schema mismatch", { path, errors: validateResponse.errors });
            // Dev: hard-fail to catch contract drift. Prod: log and pass through —
            // a debit/credit may already be committed, so 500-ing would invite a
            // retry and risk a double-spend.
            if (process.env.NODE_ENV !== "production") {
              status = 500;
              return new ErrGeneralError("response validation failed").toResponse();
            }
          }
        }

        return res;
      } catch (err) {
        const res = toErrorResponse(err);
        status = res.status;
        state.log("error", "request", {
          method: req.method,
          path,
          status,
          duration_ms: Math.round(performance.now() - start),
          error: err
        });

        return res;
      } finally {

      }
    };
  };
}

export function routes(state: State) {
  const route = createRouter(state);

  return {
    "/v1/balance": { POST: route(balanceSchema, balanceHandler) },
    "/v1/debit": { POST: route(debitSchema, debitHandler) },
    "/v1/credit": { POST: route(creditSchema, creditHandler) },
    "/v1/rollback": { POST: route(rollbackSchema, rollbackHandler) },
    // Unauthenticated dev helper. The handler itself 404s unless state.devEndpoints is set,
    // so it does nothing (mints no session, resets no balance) in production.
    "/v1/dev/session": { POST: devSessionRoute(state) },
    "/health": new Response("ok"),
  };
}