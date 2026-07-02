-- The balance ledger, in its own schema — completely separate from the bet ledger
-- (schema `repo`). Double-entry: every transfer moves an amount from one bucket to
-- another and is recorded in `balance.ledger`. Amounts are integer micro-units.
--
-- `user_id` is the int4 player id (shared with the repo's session/bet).

CREATE SCHEMA IF NOT EXISTS balance;

-- Mirrors repo.currency, kept as its own type so the balance ledger stays
-- independent of the bet schema (the two migrate concurrently). Keep in sync.
CREATE TYPE balance.currency AS ENUM (
    'AED', 'ARS', 'BHD', 'BAM', 'BRL', 'CAD', 'CLP', 'CNY', 'CRC', 'DKK',
    'EUR', 'GHS', 'IDR', 'ILS', 'INR', 'ISK', 'JOD', 'JPY', 'KES', 'KRW',
    'KWD', 'MAD', 'MXN', 'MYR', 'NGN', 'NOK', 'OMR', 'PEN', 'PHP', 'PLN',
    'QAR', 'RUB', 'SAR', 'SGD', 'TND', 'TRY', 'TWD', 'USD', 'VND', 'NZD',
    'HUF', 'KZT', 'EGP', 'THB', 'KHR', 'PKR', 'BDT', 'ZAR', 'UZS', 'XOF',
    'XAF', 'MWK', 'RWF', 'TZS', 'UGX', 'ZMW', 'BOB', 'GTQ', 'XSC', 'XGC'
);

-- The buckets a player's money moves between. `available` is spendable; `engineBet`
-- and `enginePayout` are the internal counter-accounts a wager/win moves through;
-- `testFunds` is the dev/test source that deposits are drawn from.
CREATE TYPE balance.bucket AS ENUM ('available', 'engineBet', 'enginePayout', 'testFunds');

-- One row per (player, currency, bucket). `available` may never go negative — that
-- CHECK is the insufficient-funds guard (a debit that overdraws it fails the
-- constraint). The counter-accounts (engineBet/enginePayout/testFunds) are unconstrained.
--
-- HASH-partitioned by user_id into 8 partitions. The account row is read AND upserted on
-- every bet, so it's the hottest table; hashing on user_id keeps each partition's PK
-- index ~1/8 the size (better cache fit) and spreads write/index-lock contention across 8
-- relations. user_id is part of the PK, so the partition key is covered; every access
-- (get / _move upsert / reset) filters by user_id and prunes to one partition, and a
-- transfer only ever touches one player, so nothing fans across partitions.
--
-- 8 is a fixed choice — changing a HASH partition count later means a rebuild/redistribute,
-- so pick with headroom. (Hash spreads *users*; it won't relieve a single hyper-active
-- player whose rows all hash to one partition — fine for casino traffic, which is spread.)
CREATE TABLE balance.account (
    user_id  int4             NOT NULL,
    currency balance.currency NOT NULL,
    type     balance.bucket   NOT NULL,
    amount   int8             NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, currency, type),
    CONSTRAINT available_non_negative CHECK (type <> 'available' OR amount >= 0)
) PARTITION BY HASH (user_id);

CREATE TABLE balance.account_0 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE balance.account_1 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE balance.account_2 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE balance.account_3 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE balance.account_4 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE balance.account_5 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE balance.account_6 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE balance.account_7 PARTITION OF balance.account FOR VALUES WITH (MODULUS 8, REMAINDER 7);

-- Append-only trail: one row per movement (a single-shot debit writes two —
-- the stake and the win). Composite-partitioned (see 002_funcs.sql): RANGE by ISO week on
-- `op_ts`, then HASH by `op_key` into 8 sub-partitions per week. The week level gives time
-- locality and cheap retention (detach whole weeks); the hash level keeps each index small
-- and spreads the UUIDv7 right-edge insert hot spot. Lookups prune to one leaf (op_ts →
-- week, op_key → bucket). Managed by balance.maintain_ledger_partitions.
--
-- `op_key` is the idempotency key: the RGS transaction id behind the movement
-- (debit.id / credit.id / rollback.id). `op_ts` is its UUIDv7 timestamp — set by
-- balance._move as uuid_extract_timestamp(op_key), so it is a deterministic function of
-- op_key. That determinism is load-bearing: a replay derives the SAME op_ts, so it routes
-- to the SAME partition and the PRIMARY KEY (op_key, op_ts) catches it — at-most-once
-- holds even when a retry arrives in a different calendar month from the original.
--
-- Postgres requires the partition key in every unique key, hence PK (op_key, op_ts)
-- rather than a unique index on op_key alone. Because op_ts ≡ f(op_key), (op_key, op_ts)
-- is effectively unique on op_key.
CREATE TABLE balance.ledger (
    op_key      uuid             NOT NULL,
    op_ts       timestamptz      NOT NULL,
    user_id     int4             NOT NULL,
    currency    balance.currency NOT NULL,
    debit_type  balance.bucket   NOT NULL,
    credit_type balance.bucket   NOT NULL,
    amount      int8             NOT NULL,
    PRIMARY KEY (op_key, op_ts)
) PARTITION BY RANGE (op_ts);

-- Player movement history ("show me last week's movements") — prunes by time.
CREATE INDEX idx_balance_ledger_user ON balance.ledger (user_id, op_ts);
