-- Balance-ledger stored procedures. Each call is its own auto-committed statement — the
-- balance service is independent of the bet ledger, and they are NOT joined in one
-- transaction. Safety across the two comes from idempotency + the RGS's retries, not from
-- a shared commit (see the handlers). The currency/buckets come in as varchar (cast to the
-- enums here, so callers don't need them).
--
-- Custom SQLSTATE (mapped to ErrInsufficientBalance in balance/postgres.ts):
--   SEIPB  insufficient player balance (`available` would go negative)

-- Apply one double-entry movement, keyed by `p_op_key` for idempotency. The ledger row is
-- claimed first: if the key already exists this movement was already applied (a replay),
-- so we skip the account changes entirely and return. Otherwise we take the amount out of
-- the source bucket and put it into the destination. `available` is guarded against going
-- negative — that guard IS the insufficient-funds check (the available_non_negative CHECK
-- backs it up); the counter-accounts may go negative.
--
-- The source is a direct UPDATE (never an upsert): an upsert would propose a negative
-- candidate row that trips the CHECK before ON CONFLICT can merge it. Internal helper.
CREATE OR REPLACE FUNCTION balance._move(
    p_user     int4,
    p_currency balance.currency,
    p_debit    balance.bucket,
    p_credit   balance.bucket,
    p_amount   int8,
    p_op_key   uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    -- The op's partition key, derived from its UUIDv7 id. Deterministic: a replay of the
    -- same op_key produces the same op_ts, so it routes to the same partition and the
    -- (op_key, op_ts) primary key catches the duplicate.
    v_op_ts timestamptz := uuid_extract_timestamp(p_op_key);
BEGIN
    -- Idempotency claim. ON CONFLICT DO NOTHING leaves FOUND = false on a replay.
    -- If the op was already applied, a SEIPB raised below would roll the whole statement
    -- back anyway, so a failed (insufficient) attempt is never memoised — a later retry
    -- re-evaluates against the then-current balance.
    INSERT INTO balance.ledger (op_key, op_ts, user_id, currency, debit_type, credit_type, amount)
    VALUES (p_op_key, v_op_ts, p_user, p_currency, p_debit, p_credit, p_amount)
    ON CONFLICT (op_key, op_ts) DO NOTHING;
    IF NOT FOUND THEN
        RETURN; -- replay: this movement already happened, don't apply it again
    END IF;

    IF p_debit = 'available' THEN
        UPDATE balance.account SET amount = amount - p_amount
        WHERE user_id = p_user AND currency = p_currency AND type = 'available' AND amount >= p_amount;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'SEIPB';
        END IF;
    ELSE
        INSERT INTO balance.account (user_id, currency, type, amount)
        VALUES (p_user, p_currency, p_debit, -p_amount)
        ON CONFLICT (user_id, currency, type) DO UPDATE SET amount = balance.account.amount - p_amount;
    END IF;

    INSERT INTO balance.account (user_id, currency, type, amount)
    VALUES (p_user, p_currency, p_credit, p_amount)
    ON CONFLICT (user_id, currency, type) DO UPDATE SET amount = balance.account.amount + p_amount;
END;
$$;

-- Apply 1-2 movements for one player atomically (one statement) and return the new
-- `available` balance. Each movement carries its own op key. Movements that DEBIT
-- `available` are applied first (regardless of argument order), so a same-batch win can
-- never fund the stake (e.g. $5 balance, $10 stake, $20 win is rejected, not netted to
-- +$10). A full replay finds every op key already present and applies nothing.
CREATE OR REPLACE FUNCTION balance.transfer_v1(
    p_user     int4,
    p_currency varchar,
    m1_debit   varchar,
    m1_credit  varchar,
    m1_amount  int8,
    m1_op_key  uuid,
    m2_debit   varchar DEFAULT NULL,
    m2_credit  varchar DEFAULT NULL,
    m2_amount  int8    DEFAULT NULL,
    m2_op_key  uuid    DEFAULT NULL
)
RETURNS int8
LANGUAGE plpgsql
AS $$
DECLARE
    v_cur   balance.currency := p_currency::balance.currency;
    v_avail int8;
BEGIN
    -- Pass 1: available-debits. Pass 2: everything else.
    IF m1_debit = 'available' THEN
        PERFORM balance._move(p_user, v_cur, m1_debit::balance.bucket, m1_credit::balance.bucket, m1_amount, m1_op_key);
    END IF;
    IF m2_debit = 'available' THEN
        PERFORM balance._move(p_user, v_cur, m2_debit::balance.bucket, m2_credit::balance.bucket, m2_amount, m2_op_key);
    END IF;
    IF m1_debit <> 'available' THEN
        PERFORM balance._move(p_user, v_cur, m1_debit::balance.bucket, m1_credit::balance.bucket, m1_amount, m1_op_key);
    END IF;
    IF m2_debit IS NOT NULL AND m2_debit <> 'available' THEN
        PERFORM balance._move(p_user, v_cur, m2_debit::balance.bucket, m2_credit::balance.bucket, m2_amount, m2_op_key);
    END IF;

    SELECT amount INTO v_avail FROM balance.account
    WHERE user_id = p_user AND currency = v_cur AND type = 'available';
    RETURN COALESCE(v_avail, 0);
END;
$$;

-- Dev/test: reset a single player's currency to exactly p_amount `available`, drawn
-- from `testFunds` (so it stays balanced), clearing any escrow/payout left by prior
-- tests. Lets the conformance suite reuse one account instead of minting new ones.
CREATE OR REPLACE FUNCTION balance.reset_v1(
    p_user     int4,
    p_currency varchar,
    p_amount   int8
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_cur balance.currency := p_currency::balance.currency;
BEGIN
    DELETE FROM balance.account WHERE user_id = p_user AND currency = v_cur;
    INSERT INTO balance.account (user_id, currency, type, amount) VALUES
        (p_user, v_cur, 'available', p_amount),
        (p_user, v_cur, 'testFunds', -p_amount);
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Partition lifecycle for balance.ledger. The table is COMPOSITE-partitioned:
--   level 1: RANGE by op_ts, one partition per ISO week  (time locality + cheap retention)
--   level 2: HASH by op_key, 8 sub-partitions per week    (spreads the insert hot edge +
--            keeps each index ~1/8 size so it stays cache-resident)
--
-- Why the hash sub-level: op_key is UUIDv7 (time-ordered), so inserts pile onto the right
-- edge of the current week's index — one hot leaf page under concurrency. Hashing op_key
-- splits that into 8 edges and 8 smaller indexes. Lookups still prune to a single leaf:
-- op_ts picks the week, op_key picks the hash bucket. (op_key lookups are O(log n) and
-- fine even at hundreds of millions of rows/week; the hash level is about insert
-- throughput and cache residency, not lookup speed.)
--
-- Partitions are created AHEAD OF TIME, never on the hot money path: attaching a partition
-- takes an ACCESS EXCLUSIVE lock on the parent, so doing it inside _move would spike
-- latency at week boundaries under load and race concurrent writers. In production run
-- maintain_ledger_partitions from a scheduler (pg_cron, or an app cron) — it is idempotent
-- (CREATE TABLE IF NOT EXISTS), so re-running is free.
--
-- Naming: ledger_p<ISO-year><ISO-week>_h<bucket>, e.g. ledger_p202601_h3 = 2026 week 01,
-- hash bucket 3. ISO parts (IYYY/IW) must be used together — mixing the calendar year
-- (YYYY) with the ISO week misnames weeks that straddle New Year.
--
-- The hash modulus (8) is effectively fixed: changing it later means rebuilding/
-- redistributing every week, so it's chosen with headroom rather than tuned often.
--
-- Retention: a financial ledger usually cannot DROP old data (compliance). Detach the
-- oldest week (the whole subtree detaches with its parent) and archive it instead:
--     ALTER TABLE balance.ledger DETACH PARTITION balance.ledger_p202601;
-- Detach is near-instant (a catalog change), unlike a billion-row DELETE.
CREATE OR REPLACE FUNCTION balance.maintain_ledger_partitions(
    p_weeks_back   int DEFAULT 1,
    p_weeks_ahead  int DEFAULT 8,
    p_hash_buckets int DEFAULT 8
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    i    int;
    h    int;
    lo   date;
    hi   date;
    week text;
BEGIN
    FOR i IN -p_weeks_back .. p_weeks_ahead LOOP
        lo   := (date_trunc('week', now()) + make_interval(weeks => i))::date; -- ISO weeks start Monday
        hi   := (lo + interval '1 week')::date;
        week := format('ledger_p%s', to_char(lo, 'IYYYIW'));

        -- Level 1: the weekly range partition, itself hash-partitioned by op_key.
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS balance.%I PARTITION OF balance.ledger FOR VALUES FROM (%L) TO (%L) PARTITION BY HASH (op_key)',
            week, lo, hi
        );

        -- Level 2: the hash sub-partitions that actually hold rows.
        FOR h IN 0 .. p_hash_buckets - 1 LOOP
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS balance.%I PARTITION OF balance.%I FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
                week || '_h' || h, week, p_hash_buckets, h
            );
        END LOOP;
    END LOOP;
END;
$$;

-- Bootstrap a window of weeks so the wallet can serve immediately. The back-window is only
-- to absorb back-dated UUIDv7 ids in the example/tests (an op whose id was minted weeks
-- earlier); in production you'd pre-create forward weeks only.
SELECT balance.maintain_ledger_partitions(4, 3);
