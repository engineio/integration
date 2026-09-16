
CREATE SCHEMA IF NOT EXISTS repo;

CREATE TYPE repo.transaction_type AS ENUM ('debit', 'rollback', 'credit');

-- A bet is a CONTAINER for 1..N debits plus 0..N credits, recorded BEFORE money moves
-- (bet-first), so the round can be fenced before any stake moves.
--   pending — exists, but no debit has confirmed its stake yet (the first debit is mid-flight).
--             Deleted entirely if that first/only debit can't be afforded.
--   open    — at least one debit has confirmed; live and settleable. Further debits may be ADDED
--             (each with its own transaction id) while the bet is open.
--   closed  — settled by a credit, or closed by an active=false debit/rollback. Terminal:
--             nothing happens to a closed bet.
-- (There is no 'voided'. A rollback that arrives before its debit is fenced per-DEBIT by a
--  tombstone rollback transaction — see repo.transaction_status and rollback_debits_v1 in 002.)
CREATE TYPE repo.bet_status AS ENUM ('pending', 'open', 'closed');

-- A debit's stake can be mid-flight (it is recorded before the money moves), and a bet may already
-- be 'open' from earlier debits — so the in-flight state lives on the transaction, not the bet.
--   pending   — a debit recorded, stake not yet confirmed. Deleted if it can't be afforded.
--   confirmed — stake taken. Credits and rollbacks are always written 'confirmed' (no reject path).
CREATE TYPE repo.transaction_status AS ENUM ('pending', 'confirmed');

CREATE TYPE repo.currency AS ENUM (
    'AED', 'ARS', 'BHD', 'BAM', 'BRL', 'CAD', 'CLP', 'CNY', 'CRC', 'DKK',
    'EUR', 'GHS', 'IDR', 'ILS', 'INR', 'ISK', 'JOD', 'JPY', 'KES', 'KRW',
    'KWD', 'MAD', 'MXN', 'MYR', 'NGN', 'NOK', 'OMR', 'PEN', 'PHP', 'PLN',
    'QAR', 'RUB', 'SAR', 'SGD', 'TND', 'TRY', 'TWD', 'USD', 'VND', 'NZD',
    'HUF', 'KZT', 'EGP', 'THB', 'KHR', 'PKR', 'BDT', 'ZAR', 'UZS', 'XOF',
    'XAF', 'MWK', 'RWF', 'TZS', 'UGX', 'ZMW', 'BOB', 'GTQ', 'XSC', 'XGC'
);

CREATE TABLE repo.provider (
    id     int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name   text NOT NULL,
    slug   text NOT NULL UNIQUE
);

CREATE TABLE repo.game (
    id       int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider int4 NOT NULL REFERENCES repo.provider (id),
    name     text NOT NULL,
    slug     text NOT NULL,
    edge     float8 NOT NULL,
    UNIQUE (provider, slug)
);
CREATE INDEX idx_game_provider ON repo.game (provider);

-- Sessions are never time-expired by the wallet (the RGS enforces session lifetime — contract
-- §2, "Session lifetime"). Clean up a session only once it has no open bets left; this example
-- keeps them forever.
CREATE TABLE repo.session (
    id         uuid PRIMARY KEY, -- the session token the RGS sends
    "user"     int4 NOT NULL,
    game       int4 NOT NULL REFERENCES repo.game (id),
    currency   repo.currency NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_user ON repo.session ("user", created_at DESC);

-- The bet ledger is RANGE-partitioned on the round id, and so is repo.transaction (on its
-- bet_id), with identical bucket boundaries — so a round's bet and all its transactions
-- live in the same range partition (co-located). Why RANGE on the round, not on time:
-- every hot lookup is by round (getBet / close / rollback / get_bet_v1), so the round is
-- the only key that both prunes those lookups AND gives time-correlated retention. Round
-- ids are monotonically increasing; when they are also dense (the RGS controls id
-- allocation, so it can guarantee no gaps) a fixed id-width range holds a predictable
-- ~width rows — i.e. the partition WIDTH is the target row capacity, and maintenance stays
-- a trivial fixed-width loop. (Sparse ids stay correct — gaps just leave ranges lighter —
-- only less uniformly sized.) Detaching the low-id ranges drops the oldest rounds.
-- Partitions are managed by repo.maintain_bet_partitions (002_funcs.sql); a DEFAULT
-- partition catches ids beyond the pre-created ranges (keep it empty in steady state).
--
-- Partitioning forces the partition key into every unique key, so repo.transaction's PK is
-- (id, bet_id) and its RGS-id uniqueness is (ext_id, bet_id). Both id and ext_id are
-- globally unique by construction (UUIDv7 / RGS-supplied), so scoping the constraint to a
-- bet is not a practical weakening. The foreign keys that pointed AT partitioned tables
-- (transaction.bet_id -> bet, and the transaction self-reference) are dropped — a FK target
-- must carry the partition key, which would force every referrer to as well; the stored
-- procedures already enforce these relationships (open inserts the bet before its
-- transactions; rollback resolves the debit by ext_id). The FK to the small, un-partitioned
-- repo.game is kept (a FK to a non-partitioned table is unaffected).
CREATE TABLE repo.bet (
    id         int8 NOT NULL, -- the RGS "round" is the bet's id; RANGE partition key
    session    uuid NOT NULL,
    "user"     int4 NOT NULL,
    game       int4 NOT NULL REFERENCES repo.game (id),
    currency   repo.currency NOT NULL,
    status     repo.bet_status NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE INDEX idx_bet_session ON repo.bet (session);
CREATE TABLE repo.bet_default PARTITION OF repo.bet DEFAULT;

CREATE TABLE repo.transaction (
    id         uuid NOT NULL, -- the wallet's own transaction id (returned to the RGS, and used as
                              -- the balance service's idempotency key — see the handlers)
    type       repo.transaction_type NOT NULL,
    status     repo.transaction_status NOT NULL DEFAULT 'confirmed', -- pending only for in-flight debits
    bet_id     int8 NOT NULL, -- the round; RANGE partition key (co-located with repo.bet)
    ext_id     uuid NOT NULL, -- the RGS transaction id; UNIQUE per round, so each debit is its own
                              -- idempotency unit — a NEW ext_id on an open bet ADDS a debit, a
                              -- replayed ext_id returns the stored transaction.
    reference  uuid,          -- the debit a credit/rollback settles (enforced in the procs)
    amount     int8 NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, bet_id),
    UNIQUE (ext_id, bet_id)
) PARTITION BY RANGE (bet_id);
CREATE INDEX idx_transaction_bet ON repo.transaction (bet_id);
CREATE INDEX idx_transaction_reference ON repo.transaction (reference) WHERE type = 'rollback';
CREATE TABLE repo.transaction_default PARTITION OF repo.transaction DEFAULT;

-- A debit opens a bet (no reference); credits and rollbacks always settle a debit.
ALTER TABLE repo.transaction
    ADD CONSTRAINT transaction_reference_check CHECK (
        (type = 'debit' AND reference IS NULL) OR
        (type = 'credit' AND reference IS NOT NULL) OR
        (type = 'rollback' AND reference IS NOT NULL)
    );
