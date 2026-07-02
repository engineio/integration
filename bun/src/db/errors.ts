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

/** Bet exists but a new transaction can't land on it — it's already closed (a new credit/rollback
 *  arrived after the round was closed). */
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

/** A debit arrived for an ext_id a rollback already fenced (rollback-before-debit). Terminal. */
export class ErrDebitFenced extends ErrDatabase {
  constructor(message = "debit fenced", cause?: unknown) {
    super(message, cause);
    this.name = "ErrDebitFenced";
  }
}

/** A debit (or credit) arrived for a round that is already closed. Terminal — nothing after closed. */
export class ErrRoundClosed extends ErrDatabase {
  constructor(message = "round closed", cause?: unknown) {
    super(message, cause);
    this.name = "ErrRoundClosed";
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
    case "SEBNC": // stored proc: round already closed (a new credit/rollback can't land on it)
      throw new ErrNotClosable("round already closed", error);
    case "SECRD": // stored proc: legacy "second credit" code — no longer raised (rounds hold 0..N credits)
      throw new ErrNotClosable("round already settled by a different credit", error);
    case "SEIPB": // stored proc: insufficient player balance
      throw new ErrInsufficientBalance("insufficient balance", error);
    case "SEFEN": // stored proc: this debit was fenced by a prior rollback (rollback-before-debit)
      throw new ErrDebitFenced("debit fenced", error);
    case "SECLO": // stored proc: round closed (nothing after closed)
      throw new ErrRoundClosed("round closed", error);
    default:
      throw error;
  }
}
