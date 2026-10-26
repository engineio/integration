/**
 * Repository-level errors. `intoRepoError` maps raw Postgres SQLSTATE codes (and the
 * custom `SExxx` codes raised by our stored procedures) into typed errors the
 * handlers can branch on. Anything unrecognised is rethrown untouched.
 */

export class ErrDatabase extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ErrDatabase";
  }
}

export class ErrNotFound extends ErrDatabase {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ErrNotFound";
  }
}

export class ErrDuplicate extends ErrDatabase {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ErrDuplicate";
  }
}

export class ErrForeignKeyViolation extends ErrDatabase {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ErrForeignKeyViolation";
  }
}

/** A new credit or a reversal on a closed round. */
export class ErrNotClosable extends ErrDatabase {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ErrNotClosable";
  }
}

/** Another transaction held the bet row past lock_timeout (55P03). Transient — retryable. */
export class ErrConcurrent extends ErrDatabase {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ErrConcurrent";
  }
}

/** Player balance can't cover the debit (raised by the balance ledger's transfer_v1). */
export class ErrInsufficientBalance extends ErrDatabase {
  constructor(message = "insufficient balance", cause?: unknown) {
    super(message, cause);
    this.name = "ErrInsufficientBalance";
  }
}

/** A debit or credit arrived for an ext_id a rollback already fenced (rollback-before-it). Terminal. */
export class ErrFenced extends ErrDatabase {
  constructor(message = "fenced", cause?: unknown) {
    super(message, cause);
    this.name = "ErrFenced";
  }
}

/** A new debit arrived for a round that is already closed. */
export class ErrRoundClosed extends ErrDatabase {
  constructor(message = "round closed", cause?: unknown) {
    super(message, cause);
    this.name = "ErrRoundClosed";
  }
}

/** The request's session doesn't match the session recorded on the round's bet. Terminal — the
 *  bet record is the authority for credits/rollbacks, so a mismatched token must never settle
 *  or reverse another session's round. */
export class ErrSessionMismatch extends ErrDatabase {
  constructor(message = "session mismatch", cause?: unknown) {
    super(message, cause);
    this.name = "ErrSessionMismatch";
  }
}

export function intoRepoError(error: unknown): never {
  // Bun's SQL client surfaces a generic string in `.code` (e.g.
  // "ERR_POSTGRES_SERVER_ERROR") and the real Postgres SQLSTATE in `.errno`.
  const sqlState = (error as { errno?: unknown } | null)?.errno;
  if (typeof sqlState !== "string") {
    throw error;
  }

  switch (sqlState) {
    case "23505": // unique_violation
      throw new ErrDuplicate("duplicate entry", error);
    case "23503": // foreign_key_violation
      throw new ErrForeignKeyViolation("referenced record not found", error);
    case "22P02": // invalid_text_representation (e.g. token isn't a uuid)
      throw new ErrNotFound("not found", error);
    case "55P03": // lock_not_available
      throw new ErrConcurrent("bet locked", error);
    case "SEBNF": // stored proc: bet not found
      throw new ErrNotFound("bet not found", error);
    case "SEBNC": // stored proc: new credit or reversal on a closed round
      throw new ErrNotClosable("round already closed", error);
    case "SEIPB": // stored proc: insufficient player balance
      throw new ErrInsufficientBalance("insufficient balance", error);
    case "SEFEN": // stored proc: this debit or credit was fenced by a prior rollback
      throw new ErrFenced("fenced", error);
    case "SECLO": // stored proc: new debit on a closed round
      throw new ErrRoundClosed("round closed", error);
    case "SESMM": // stored proc: session doesn't match the bet's recorded session
      throw new ErrSessionMismatch("session mismatch", error);
    default:
      throw error;
  }
}
