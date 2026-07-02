
/**
 * The wire error contract expected by the Engine RGS. Every error response is exactly
 * `{ code: ErrorCode, message: string }` — the code drives the player-facing message, `message`
 * is human-readable for logs. These codes are part of the integration spec.
 */
export type ErrorCode =
  | "ERR_BAD" // bad request (malformed input, or a debit fenced by a prior rollback)
  | "ERR_IPB" // insufficient player balance
  | "ERR_IS" // invalid session token
  | "ERR_ATE" // failed request authentication (bad/missing signature)
  | "ERR_BNF" // bet not found
  | "ERR_BC" // bet already complete — the round is closed/settled
  | "ERR_GE" // general error
  | "ERR_UE"; // general error during rollback

export abstract class WalletError extends Error {
  declare cause: unknown;

  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    if (cause !== undefined) this.cause = cause;
    this.name = this.constructor.name;
  }

  toResponse(): Response {
    return Response.json({ code: this.code, message: this.message }, { status: this.statusCode });
  }
}

export class ErrInvalidSession extends WalletError {
  constructor(token: string, cause?: unknown) {
    super(400, "ERR_IS", `Invalid Session ${token}`, cause);
  }
}

export class ErrBadRequest extends WalletError {
  constructor(msg = "Bad Request", cause?: unknown) {
    super(400, "ERR_BAD", msg, cause);
  }
}

export class ErrBadAuth extends WalletError {
  constructor(msg = "Authentication failed", cause?: unknown) {
    super(401, "ERR_ATE", msg, cause);
  }
}

export class ErrBetNotFound extends WalletError {
  constructor(betId: number, cause?: unknown) {
    super(404, "ERR_BNF", `bet:${betId} not found`, cause);
  }
}

/** The round is closed/settled — a new debit/credit/rollback can't land on it. */
export class ErrBetComplete extends WalletError {
  constructor(msg = "bet already complete", cause?: unknown) {
    super(400, "ERR_BC", msg, cause);
  }
}

export class ErrInsufficientPlayerBalance extends WalletError {
  constructor(cause?: unknown) {
    super(400, "ERR_IPB", "insufficient balance", cause);
  }
}

export class ErrGeneralError extends WalletError {
  constructor(cause?: unknown) {
    super(500, "ERR_GE", "Internal Server Error", cause);
  }
}


/**
 * Map any thrown value to a wallet error Response. Known WalletErrors keep their code;
 * anything else is logged and becomes a generic ERR_GE so internals never leak.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof WalletError) {
    return err.toResponse();
  }

  return new ErrGeneralError(err).toResponse();
}
