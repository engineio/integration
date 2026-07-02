-- Bet-ledger stored procedures. These touch ONLY repo.bet / repo.transaction — the balance lives
-- in a separate schema and is moved separately by the handler (the two stores are reconciled by
-- idempotency + RGS retries, not a shared transaction). Each proc is a single atomic statement
-- that commits on its own.
--
-- The flow is BET-FIRST: a debit records the bet (and its debit transaction, as `pending`) BEFORE
-- moving money, then `confirm`s the debit once the stake is taken (or `reject`s — deletes — it if
-- the stake can't be afforded). A bet is a CONTAINER: it holds 1..N debits (each its own
-- transaction, idempotent on its ext_id) plus an optional single credit. The idempotency unit is
-- the DEBIT, not the round — a NEW ext_id on an open bet ADDS a debit; a replayed ext_id returns
-- the stored one. Every handler keys the balance on its own bet-ledger transaction id, so there is
-- no separate idempotency-key table.
--
-- `lock_timeout` is a small finite value (NOT 0 — Postgres treats 0 as "wait forever"). On a
-- contended row the statement aborts with SQLSTATE 55P03, which db/errors.ts maps to ErrConcurrent
-- and the handler surfaces as a retryable 5xx so the RGS retries.
--
-- Custom SQLSTATE codes (mapped to typed errors in db/errors.ts):
--   SEBAD  bad request (non-positive amount)
--   SEBNF  bet not found
--   SEBNC  bet not closable / not reversible (already settled by a credit)
--   SECLO  round closed — nothing happens to a closed bet (refuse a debit)
--   SECRD  a different credit already settled this round (only one credit per round)
--   SEFEN  this debit was fenced — a rollback referenced it before it arrived; refuse the straggler
--   55P03  (also raised deliberately) a debit is mid-flight (`pending`), or the bet's first debit
--          has not confirmed yet — retry

-- Record a debit on a round, returning the canonical transaction ids. The round's bet is a
-- container: the FIRST debit opens it `pending`; later debits (a NEW ext_id) are APPENDED while it
-- is open. IDEMPOTENT on the debit's ext_id: a replay returns the originally stored ids and moves
-- no money. Refuses a debit whose ext_id a rollback already fenced (SEFEN — the straggler case) and
-- a debit on a `closed` round (SECLO). An optional concurrent credit becomes the round's single
-- credit (a second one raises SECRD). Runs before any money moves.
CREATE OR REPLACE FUNCTION repo.record_debit_v1(
    p_id            int8,
    p_session       uuid,
    p_user          integer,
    p_game          integer,
    p_currency      varchar,
    p_amount        int8,
    p_debit_id      uuid,
    p_debit_ext_id  uuid,
    -- optional concurrent credit (e.g. buy-feature: stake and win settle together)
    p_payout        int8,
    p_credit_id     uuid,
    p_credit_ext_id uuid
)
RETURNS TABLE (
    debit_id       uuid,
    credit_id      uuid,
    bet_created_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_bet_created_at timestamptz;
    v_status         repo.bet_status;
    v_existing_debit uuid;
BEGIN
    SET LOCAL lock_timeout = '1s';

    IF p_amount <= 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'SEBAD';
    END IF;

    -- 1. Replay of THIS debit (same ext_id)? Return the stored ids — the balance is keyed on them
    --    and is itself idempotent, so no money moves on a replay.
    SELECT d.id INTO v_existing_debit
    FROM repo.transaction d
    WHERE d.bet_id = p_id AND d.type = 'debit' AND d.ext_id = p_debit_ext_id;
    IF v_existing_debit IS NOT NULL THEN
        SELECT created_at INTO v_bet_created_at FROM repo.bet WHERE id = p_id;
        RETURN QUERY
        SELECT v_existing_debit,
               (SELECT c.id FROM repo.transaction c
                WHERE c.bet_id = p_id AND c.type = 'credit' AND c.ext_id = p_credit_ext_id),
               v_bet_created_at;
        RETURN;
    END IF;

    -- 2. Fenced straggler? A rollback already references this debit's ext_id but the debit never
    --    landed (a tombstone). The round cancelled this debit before it arrived — refuse it.
    IF EXISTS (
        SELECT 1 FROM repo.transaction r
        WHERE r.bet_id = p_id AND r.type = 'rollback' AND r.reference = p_debit_ext_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'SEFEN';
    END IF;

    -- 3. Ensure the bet exists. The first debit opens it `pending` (no confirmed stake yet).
    INSERT INTO repo.bet (id, session, "user", game, currency, status)
    VALUES (p_id, p_session, p_user, p_game, p_currency::repo.currency, 'pending')
    ON CONFLICT (id) DO NOTHING
    RETURNING created_at INTO v_bet_created_at;

    IF NOT FOUND THEN
        -- Bet already exists. `closed` is terminal — nothing happens to a closed bet. Otherwise
        -- (`pending`/`open`) we append another debit.
        SELECT status, created_at INTO v_status, v_bet_created_at FROM repo.bet WHERE id = p_id;
        IF v_status = 'closed' THEN
            RAISE EXCEPTION USING ERRCODE = 'SECLO';
        END IF;
    END IF;

    -- 4. Append the debit (pending until the stake is confirmed).
    INSERT INTO repo.transaction (id, bet_id, type, status, amount, ext_id, reference)
    VALUES (p_debit_id, p_id, 'debit', 'pending', p_amount, p_debit_ext_id, NULL);

    -- 5. Optional concurrent credit — the round's single credit. A second credit is refused.
    IF p_credit_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM repo.transaction c WHERE c.bet_id = p_id AND c.type = 'credit') THEN
            RAISE EXCEPTION USING ERRCODE = 'SECRD';
        END IF;
        INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
        VALUES (p_credit_id, p_id, 'credit', p_payout, p_credit_ext_id, p_debit_ext_id);
    END IF;

    RETURN QUERY SELECT p_debit_id, p_credit_id, v_bet_created_at;
END;
$$;

-- Confirm a debit once its stake has been taken. The debit goes pending -> confirmed; the bet is
-- promoted pending -> open on the FIRST confirm (active=true), or closed (active=false closes the
-- round after this debit). Idempotent — a re-drive after confirmation matches nothing.
CREATE OR REPLACE FUNCTION repo.confirm_debit_v1(p_id int8, p_debit_ext_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    SET LOCAL lock_timeout = '1s';
    UPDATE repo.transaction
    SET status = 'confirmed'
    WHERE bet_id = p_id AND type = 'debit' AND ext_id = p_debit_ext_id AND status = 'pending';

    IF p_active THEN
        UPDATE repo.bet SET status = 'open', updated_at = now()
        WHERE id = p_id AND status = 'pending';
    ELSE
        UPDATE repo.bet SET status = 'closed', updated_at = now()
        WHERE id = p_id AND status IN ('pending', 'open');
    END IF;
END;
$$;

-- Reject a debit whose stake couldn't be afforded: delete that pending debit. If the bet now has no
-- transactions at all (an unaffordable FIRST debit), delete the empty bet too — leaving no record,
-- the clean rejection. A later debit's rejection just removes that one row; the bet (and its other,
-- confirmed debits) stand. Safe because no money moved (the balance refused the stake).
CREATE OR REPLACE FUNCTION repo.reject_debit_v1(p_id int8, p_debit_ext_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    SET LOCAL lock_timeout = '1s';
    DELETE FROM repo.transaction
    WHERE bet_id = p_id AND type = 'debit' AND ext_id = p_debit_ext_id AND status = 'pending';

    DELETE FROM repo.bet b
    WHERE b.id = p_id AND NOT EXISTS (SELECT 1 FROM repo.transaction t WHERE t.bet_id = p_id);
END;
$$;

-- Close a round and record its single win credit (a NULL credit is a losing/zero round), returning
-- the canonical credit id. IDEMPOTENT on the round: a replay reads back the settled credit. A round
-- whose first debit is still `pending` raises 55P03 (retry). A second, DIFFERENT credit raises
-- SECRD (only one credit per round). SEBNF for an unknown round.
CREATE OR REPLACE FUNCTION repo.close_bet_v1(
    p_id            int8,
    p_credit_id     uuid,
    p_credit_amount int8,
    p_credit_ext_id uuid,
    p_credit_ref    uuid
)
RETURNS TABLE (
    credit_id      uuid,
    bet_id         int8,
    bet_session    uuid,
    bet_status     repo.bet_status,
    bet_user       integer,
    bet_game       integer,
    bet_currency   repo.currency,
    bet_created_at timestamptz,
    bet_updated_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_bet          repo.bet%ROWTYPE;
    v_credit_id    uuid;
    v_existing_ext uuid;
BEGIN
    SET LOCAL lock_timeout = '1s';

    SELECT * INTO v_bet FROM repo.bet WHERE id = p_id;
    IF v_bet.id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'SEBNF';
    END IF;
    -- The first debit hasn't confirmed yet — there is nothing settled to credit. Retry.
    IF v_bet.status = 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = '55P03';
    END IF;

    -- Existing credit? Enforces both idempotency (same ext_id → replay) and the single-credit rule
    -- (different ext_id → refuse).
    SELECT c.id, c.ext_id INTO v_credit_id, v_existing_ext
    FROM repo.transaction c WHERE c.bet_id = p_id AND c.type = 'credit';

    IF v_credit_id IS NOT NULL THEN
        IF p_credit_ext_id IS NOT NULL AND p_credit_ext_id <> v_existing_ext THEN
            RAISE EXCEPTION USING ERRCODE = 'SECRD';
        END IF;
        -- else: replay — return the stored credit id.
    ELSIF p_credit_ext_id IS NOT NULL THEN
        INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
        VALUES (p_credit_id, p_id, 'credit', COALESCE(p_credit_amount, 0), p_credit_ext_id, p_credit_ref);
        v_credit_id := p_credit_id;
    END IF;

    -- Close if still open (idempotent — a re-drive over an already-closed round flips nothing).
    UPDATE repo.bet b SET status = 'closed', updated_at = now()
    WHERE b.id = p_id AND b.status = 'open'
    RETURNING * INTO v_bet;
    IF NOT FOUND THEN
        SELECT * INTO v_bet FROM repo.bet WHERE id = p_id;
    END IF;

    RETURN QUERY SELECT
        v_credit_id,
        v_bet.id, v_bet.session, v_bet.status, v_bet."user", v_bet.game, v_bet.currency,
        v_bet.created_at, v_bet.updated_at;
END;
$$;

-- Reverse one or more of a round's debits, per-debit, in one atomic statement. p_items is a jsonb
-- array (passed straight from the handler as the raw value cast `::jsonb` — do NOT pre-stringify,
-- which Bun double-encodes into a scalar; a plain JS array cast `::jsonb` binds correctly). Each
-- item { ref, id, ext } reverses the debit named by `ref`, returning the canonical rollback id and
-- refunded amount IN INPUT ORDER. Per item:
--   * already reversed (replay, or a prior tombstone)  → return the existing rollback (idempotent
--     on the debit ref — also guards a double-rollback)
--   * the referenced debit never arrived               → write a 0-amount TOMBSTONE referencing it,
--     so record_debit_v1 later fences the straggler (the rollback-before-debit case)
--   * the referenced debit is still `pending`          → RAISE 55P03 (mid-flight → retry the batch)
--   * the round is already `closed`                    → RAISE SEBNC (nothing after closed)
--   * otherwise                                        → reverse it (refund the debit's amount)
-- The round is then closed UNLESS p_active is true (the RGS keeping it open for its other debits).
-- An orphan rollback (no bet yet) creates the bet `pending` from the session so the tombstone has a
-- home; a different debit can still open the round normally.
CREATE OR REPLACE FUNCTION repo.rollback_debits_v1(
    p_id       int8,
    p_session  uuid,
    p_user     integer,
    p_game     integer,
    p_currency varchar,
    p_items    jsonb,  -- [{ "ref": <debit ext_id>, "id": <minted rollback id>, "ext": <RGS rollback id> }, ...]
    p_active   boolean
)
RETURNS TABLE (
    rollback_id     uuid,
    rollback_amount int8
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_bet_status   repo.bet_status;
    v_item         jsonb;
    v_ref          uuid;
    v_rb_id        uuid;
    v_rb_ext       uuid;
    v_existing_id  uuid;
    v_existing_amt int8;
    v_debit_amt    int8;
    v_debit_status repo.transaction_status;
BEGIN
    SET LOCAL lock_timeout = '1s';

    -- Ensure the bet exists so a tombstone (orphan rollback) has somewhere to live. No-op otherwise.
    INSERT INTO repo.bet (id, session, "user", game, currency, status)
    VALUES (p_id, p_session, p_user, p_game, p_currency::repo.currency, 'pending')
    ON CONFLICT (id) DO NOTHING;

    SELECT status INTO v_bet_status FROM repo.bet WHERE id = p_id;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
        v_ref    := (v_item->>'ref')::uuid;
        v_rb_id  := (v_item->>'id')::uuid;
        v_rb_ext := (v_item->>'ext')::uuid;

        -- Already reversed? Idempotent on the debit ref (covers a replay and a double-rollback).
        SELECT r.id, r.amount INTO v_existing_id, v_existing_amt
        FROM repo.transaction r
        WHERE r.bet_id = p_id AND r.type = 'rollback' AND r.reference = v_ref;
        IF v_existing_id IS NOT NULL THEN
            rollback_id := v_existing_id; rollback_amount := v_existing_amt;
            RETURN NEXT; CONTINUE;
        END IF;

        SELECT d.amount, d.status INTO v_debit_amt, v_debit_status
        FROM repo.transaction d
        WHERE d.bet_id = p_id AND d.type = 'debit' AND d.ext_id = v_ref;

        IF NOT FOUND THEN
            -- Orphan: the rollback arrived before its debit. Tombstone it (refund nothing); the
            -- straggler debit is fenced when it lands.
            INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
            VALUES (v_rb_id, p_id, 'rollback', 0, v_rb_ext, v_ref);
            rollback_id := v_rb_id; rollback_amount := 0;
            RETURN NEXT; CONTINUE;
        END IF;

        IF v_debit_status = 'pending' THEN
            RAISE EXCEPTION USING ERRCODE = '55P03';  -- this debit is mid-flight → retry the batch
        END IF;
        IF v_bet_status = 'closed' THEN
            RAISE EXCEPTION USING ERRCODE = 'SEBNC';  -- nothing after closed
        END IF;

        INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
        VALUES (v_rb_id, p_id, 'rollback', v_debit_amt, v_rb_ext, v_ref);
        rollback_id := v_rb_id; rollback_amount := v_debit_amt;
        RETURN NEXT;
    END LOOP;

    -- Close the round unless the RGS is keeping it open for its other debits.
    IF NOT p_active THEN
        UPDATE repo.bet SET status = 'closed', updated_at = now()
        WHERE id = p_id AND status IN ('pending', 'open');
    END IF;
END;
$$;

-- Read a bet and its single credit (if any). Gated on EXISTS(debit): a round with no debit — only a
-- rollback tombstone (orphan) — reads back as not-found, so a credit for it returns ERR_BNF (credits
-- never fence a round; only a rollback does). Returns one row regardless of how many debits the bet
-- holds.
CREATE OR REPLACE FUNCTION repo.get_bet_v1(p_id int8)
RETURNS TABLE (
    bet_id            int8,
    bet_session       uuid,
    bet_status        repo.bet_status,
    bet_user          integer,
    bet_game          integer,
    bet_currency      repo.currency,
    bet_created_at    timestamptz,
    bet_updated_at    timestamptz,
    credit_id         uuid,
    credit_amount     int8,
    credit_ext_id     uuid,
    credit_reference  uuid,
    credit_created_at timestamptz
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.id, b.session, b.status, b."user", b.game, b.currency, b.created_at, b.updated_at,
        c.id, c.amount, c.ext_id, c.reference, c.created_at
    FROM repo.bet b
    LEFT JOIN repo.transaction c ON c.bet_id = b.id AND c.type = 'credit'
    WHERE b.id = p_id
      AND EXISTS (SELECT 1 FROM repo.transaction d WHERE d.bet_id = b.id AND d.type = 'debit');
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Partition lifecycle for the bet ledger. repo.bet is RANGE-partitioned by round id and
-- repo.transaction by bet_id, with IDENTICAL boundaries (fixed width p_range), so a round's bet
-- and transactions land in the same range partition (bet_rN / transaction_rN).
--
-- Partitions are sized by id WIDTH (p_range). With dense round ids that width is also the
-- per-partition row capacity (~p_range rows); with sparse ids a range just holds fewer rows
-- (harmless, only less uniform). Like the balance partitions this runs OFF the hot path
-- (attaching a partition takes ACCESS EXCLUSIVE on the parent); in production drive it from
-- a scheduler off the current max(round) plus headroom. Idempotent (CREATE TABLE IF NOT EXISTS).
-- Anything past the highest pre-created range falls into the DEFAULT partition (created in
-- 001) rather than erroring — keep DEFAULT empty in steady state by maintaining ahead.
--
-- Retention: detach the oldest ranges (lowest round ids = oldest rounds) and archive:
--     ALTER TABLE repo.bet DETACH PARTITION repo.bet_r0;
--     ALTER TABLE repo.transaction DETACH PARTITION repo.transaction_r0;
CREATE OR REPLACE FUNCTION repo.maintain_bet_partitions(
    p_up_to_round int8,
    p_range       int8 DEFAULT 1000000
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    lo int8 := 0;
    hi int8;
    n  int8;
BEGIN
    WHILE lo <= p_up_to_round LOOP
        hi := lo + p_range;
        n  := lo / p_range; -- 0,1,2,... partition index
        EXECUTE format('CREATE TABLE IF NOT EXISTS repo.bet_r%s PARTITION OF repo.bet FOR VALUES FROM (%s) TO (%s)', n, lo, hi);
        EXECUTE format('CREATE TABLE IF NOT EXISTS repo.transaction_r%s PARTITION OF repo.transaction FOR VALUES FROM (%s) TO (%s)', n, lo, hi);
        lo := hi;
    END LOOP;
END;
$$;

-- Bootstrap a window of round ranges so the wallet serves immediately (covers the example's
-- round ids); in production pre-create ahead of the current max round.
SELECT repo.maintain_bet_partitions(3000000);
