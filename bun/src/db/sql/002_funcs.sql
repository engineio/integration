-- Bet-ledger stored procedures. These touch ONLY repo.bet / repo.transaction — the balance lives
-- in a separate schema and is moved separately by the handler (the two stores are reconciled by
-- idempotency + RGS retries, not a shared transaction). Each proc is a single atomic statement
-- that commits on its own. The one exception is settling a `pending` debit (funding it, then
-- confirming or rejecting it), which Repository.settleDebit does under the debit's row lock so a
-- debit and its rollback can't both decide it. Every proc that writes a round's transactions
-- locks its bet row first, so a debit, the rollback fencing it, and a closing credit serialize.
--
-- The flow is BET-FIRST: a debit records the bet (and its debit transaction, as `pending`) BEFORE
-- moving money, then `confirm`s the debit once the stake is taken (or `reject`s — deletes — it if
-- the stake can't be afforded). A bet is a CONTAINER: it holds 1..N debits plus 0..N credits, each
-- its own transaction, idempotent on its ext_id. The idempotency unit is the TRANSACTION, not the
-- round — a NEW ext_id on an open bet ADDS a debit/credit; a replayed ext_id returns the stored
-- one. An `active = false` flag (on a debit, credit, or rollback) closes the round. Every handler
-- keys the balance on its own bet-ledger transaction id, so there is no separate
-- idempotency-key table.
--
-- The wallet never time-expires sessions — session lifetime is the RGS's to enforce — and a late
-- credit or rollback can arrive long after launch (contract §2, "Session lifetime"). What
-- authorizes them is ALIGNMENT: the request's session must be the session recorded on the
-- round's bet. The credit handler enforces this against get_bet_v1; rollback_v1 enforces
-- it inline (SESMM), which also covers a tombstone-only bet that get_bet_v1 deliberately reports
-- as not-found.
--
-- `lock_timeout` is a small finite value (NOT 0 — Postgres treats 0 as "wait forever"). On a
-- contended row the statement aborts with SQLSTATE 55P03, which db/errors.ts maps to ErrConcurrent
-- and the handler surfaces as a retryable 5xx so the RGS retries.
--
-- Custom SQLSTATE codes (mapped to typed errors in db/errors.ts):
--   SEBAD  bad request (non-positive amount) — defense-in-depth only: the handlers' schema
--          validation rejects these first, so it has no db/errors.ts mapping (an unexpected
--          hit surfaces as a generic 500)
--   SEBNF  bet not found
--   SEBNC  round closed — refuse a new credit or a reversal (a closed round is final)
--   SECLO  round closed — refuse a new debit
--   SEFEN  this debit or credit was fenced — a rollback referenced it before it arrived; refuse
--          the straggler
--   SESMM  session mismatch — the request's session isn't the one recorded on the bet (→ ERR_IS)
--   55P03  (also raised deliberately) a debit is mid-flight (`pending`): its bet's first debit
--          has not confirmed yet, or a credit would close a round with one — retry

-- Record a debit on a round, returning the canonical transaction ids. The round's bet is a
-- container: the FIRST debit opens it `pending`; later debits (a NEW ext_id) are APPENDED while it
-- is open. IDEMPOTENT on the debit's ext_id: a replay returns the originally stored ids and moves
-- no money. Refuses a debit whose ext_id a rollback already fenced (SEFEN — the straggler case) and
-- a debit on a `closed` round (SECLO). An optional concurrent credit (e.g. a buy-feature settling
-- its win in the same call) is appended like any other credit — the round may already hold others.
-- Runs before any money moves.
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

    -- 1. Ensure the bet exists (the first debit opens it `pending` — no confirmed stake yet), and
    --    lock it, so a rollback fencing this debit can't slip in between the checks and the insert.
    INSERT INTO repo.bet (id, session, "user", game, currency, status)
    VALUES (p_id, p_session, p_user, p_game, p_currency::repo.currency, 'pending')
    ON CONFLICT (id) DO NOTHING;
    SELECT status, created_at INTO v_status, v_bet_created_at FROM repo.bet WHERE id = p_id FOR UPDATE;

    -- 2. Replay of THIS debit (same ext_id)? Return the stored ids — the balance is keyed on them
    --    and is itself idempotent, so no money moves on a replay.
    SELECT d.id INTO v_existing_debit
    FROM repo.transaction d
    WHERE d.bet_id = p_id AND d.type = 'debit' AND d.ext_id = p_debit_ext_id;
    IF v_existing_debit IS NOT NULL THEN
        RETURN QUERY
        SELECT v_existing_debit,
               (SELECT c.id FROM repo.transaction c
                WHERE c.bet_id = p_id AND c.type = 'credit' AND c.ext_id = p_credit_ext_id),
               v_bet_created_at;
        RETURN;
    END IF;

    -- 3. Fenced straggler? A rollback already references this debit's ext_id but the debit never
    --    landed (a tombstone). The round cancelled this debit before it arrived — refuse it.
    IF EXISTS (
        SELECT 1 FROM repo.transaction r
        WHERE r.bet_id = p_id AND r.type = 'rollback' AND r.reference = p_debit_ext_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = 'SEFEN';
    END IF;

    -- No new debit on a closed round; on a `pending`/`open` one we append another.
    IF v_status = 'closed' THEN
        RAISE EXCEPTION USING ERRCODE = 'SECLO';
    END IF;

    -- 4. Append the debit (pending until the stake is confirmed).
    INSERT INTO repo.transaction (id, bet_id, type, status, amount, ext_id, reference)
    VALUES (p_debit_id, p_id, 'debit', 'pending', p_amount, p_debit_ext_id, NULL);

    -- 5. Optional concurrent credit, appended like any other; idempotent on the credit ext_id.
    --    Pending with its debit, so it is confirmed or deleted along with it.
    IF p_credit_id IS NOT NULL THEN
        INSERT INTO repo.transaction (id, bet_id, type, status, concurrent, amount, ext_id, reference)
        VALUES (p_credit_id, p_id, 'credit', 'pending', true, p_payout, p_credit_ext_id, p_debit_ext_id);
    END IF;

    RETURN QUERY SELECT p_debit_id, p_credit_id, v_bet_created_at;
END;
$$;

-- Confirm a debit once its stake has been taken. The debit (and a single-shot's concurrent credit)
-- goes pending -> confirmed; the bet is promoted pending -> open on the FIRST confirm
-- (active=true), or closed (active=false closes the round after this debit). Idempotent — a
-- re-drive after confirmation matches nothing.
CREATE OR REPLACE FUNCTION repo.confirm_debit_v1(p_id int8, p_debit_ext_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    SET LOCAL lock_timeout = '1s';
    UPDATE repo.transaction
    SET status = 'confirmed'
    WHERE bet_id = p_id AND status = 'pending'
      AND ((type = 'debit' AND ext_id = p_debit_ext_id) OR (type = 'credit' AND reference = p_debit_ext_id));

    IF p_active THEN
        UPDATE repo.bet SET status = 'open', updated_at = now()
        WHERE id = p_id AND status = 'pending';
    ELSE
        -- Don't close the round under another debit still mid-flight (see close_bet_v1). Retry.
        IF EXISTS (
            SELECT 1 FROM repo.transaction d
            WHERE d.bet_id = p_id AND d.type = 'debit' AND d.status = 'pending' AND d.ext_id <> p_debit_ext_id
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '55P03';
        END IF;
        UPDATE repo.bet SET status = 'closed', updated_at = now()
        WHERE id = p_id AND status IN ('pending', 'open');
    END IF;
END;
$$;

-- Reject a debit whose stake couldn't be afforded: delete that pending debit (and a single-shot's
-- concurrent credit with it). If the bet now has no transactions at all (an unaffordable FIRST
-- debit), delete the empty bet too — leaving no record, the clean rejection. A later debit's
-- rejection just removes that one row; the bet (and its other, confirmed debits) stand. Safe
-- because no money moved (the balance refused the stake).
CREATE OR REPLACE FUNCTION repo.reject_debit_v1(p_id int8, p_debit_ext_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    SET LOCAL lock_timeout = '1s';
    DELETE FROM repo.transaction
    WHERE bet_id = p_id AND status = 'pending'
      AND ((type = 'debit' AND ext_id = p_debit_ext_id) OR (type = 'credit' AND reference = p_debit_ext_id));

    DELETE FROM repo.bet b
    WHERE b.id = p_id AND NOT EXISTS (SELECT 1 FROM repo.transaction t WHERE t.bet_id = p_id);
END;
$$;

-- Add a credit to the round (idempotent on its ext_id) and close the round iff p_active is false.
-- A NULL credit with p_active=false closes a losing/zero round; a NULL credit with p_active=true is
-- a no-op that just reports the bet. A round holds 0..N credits: a NEW ext_id appends another while
-- the round is open; a replay returns the stored id (even on a closed round). A credit whose
-- ext_id a rollback already fenced is refused (SEFEN), and a NEW credit on an already-closed round
-- is refused (SEBNC). A round whose first debit is still `pending` raises 55P03 (retry). SEBNF for
-- an unknown round.
CREATE OR REPLACE FUNCTION repo.close_bet_v1(
    p_id            int8,
    p_credit_id     uuid,
    p_credit_amount int8,
    p_credit_ext_id uuid,
    p_credit_ref    uuid,
    p_active        boolean
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
    v_bet           repo.bet%ROWTYPE;
    v_credit_id     uuid;
    v_credit_status repo.transaction_status;
BEGIN
    SET LOCAL lock_timeout = '1s';

    SELECT * INTO v_bet FROM repo.bet WHERE id = p_id FOR UPDATE;
    IF v_bet.id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'SEBNF';
    END IF;
    -- The first debit hasn't confirmed yet — there is nothing settled to credit. Retry.
    IF v_bet.status = 'pending' THEN
        RAISE EXCEPTION USING ERRCODE = '55P03';
    END IF;
    -- Don't close a round while one of its debits is mid-flight: that debit's rollback must still
    -- be able to reverse it, which it can't once the round is closed. Retry.
    IF NOT p_active AND v_bet.status = 'open' AND EXISTS (
        SELECT 1 FROM repo.transaction d WHERE d.bet_id = p_id AND d.type = 'debit' AND d.status = 'pending'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55P03';
    END IF;

    -- Record the credit, if one was sent. Idempotent on the credit's ext_id (UNIQUE per round): a
    -- replay returns the stored id and moves no money; a NEW ext_id appends another credit. A
    -- straggler a rollback fenced, or a new credit on an already-closed round, is refused.
    IF p_credit_ext_id IS NOT NULL THEN
        SELECT c.id, c.status INTO v_credit_id, v_credit_status
        FROM repo.transaction c
        WHERE c.bet_id = p_id AND c.type = 'credit' AND c.ext_id = p_credit_ext_id;
        -- A single-shot's win whose debit is still mid-flight: not paid yet, so not a replay. Retry.
        IF v_credit_status = 'pending' THEN
            RAISE EXCEPTION USING ERRCODE = '55P03';
        END IF;

        IF v_credit_id IS NULL THEN
            IF EXISTS (
                SELECT 1 FROM repo.transaction r
                WHERE r.bet_id = p_id AND r.type = 'rollback' AND r.reference = p_credit_ext_id
            ) THEN
                RAISE EXCEPTION USING ERRCODE = 'SEFEN';
            END IF;
            IF v_bet.status = 'closed' THEN
                RAISE EXCEPTION USING ERRCODE = 'SEBNC';
            END IF;
            INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
            VALUES (p_credit_id, p_id, 'credit', COALESCE(p_credit_amount, 0), p_credit_ext_id, p_credit_ref);
            v_credit_id := p_credit_id;
        END IF;
    END IF;

    -- Close the round unless the RGS is keeping it open for more debits/credits (idempotent — a
    -- re-drive over an already-closed round flips nothing).
    IF NOT p_active THEN
        UPDATE repo.bet b SET status = 'closed', updated_at = now()
        WHERE b.id = p_id AND b.status = 'open'
        RETURNING * INTO v_bet;
        IF NOT FOUND THEN
            SELECT * INTO v_bet FROM repo.bet WHERE id = p_id;
        END IF;
    END IF;

    RETURN QUERY SELECT
        v_credit_id,
        v_bet.id, v_bet.session, v_bet.status, v_bet."user", v_bet.game, v_bet.currency,
        v_bet.created_at, v_bet.updated_at;
END;
$$;

-- Reverse named transactions of an OPEN round, per-ref, in one atomic statement. p_items is a jsonb
-- array (passed straight from the handler as the raw value cast `::jsonb` — do NOT pre-stringify,
-- which Bun double-encodes into a scalar; a plain JS array cast `::jsonb` binds correctly). Each
-- item { ref, id, ext } reverses the debit or credit named by `ref`, returning the canonical
-- rollback id, the amount, and the reversed type (debit → refund the stake, credit → claw back the
-- win; NULL for a tombstone) IN INPUT ORDER. A single-shot closes its round, so its debit is only
-- reversible while it was still pending (the handler settles it with the round kept open): that
-- reversal also reverses the win it carried — the two were one call that never answered —
-- returned as an extra `cascaded` row (moved, but not one of the request's rollback_ids). Per item:
--   * the session doesn't match the bet's recorded session → RAISE SESMM before anything moves
--     (alignment, not token liveness, authorizes a rollback — see the file header)
--   * already reversed (replay, or a prior tombstone)  → return the existing rollback (idempotent
--     on the ref — also guards a double-rollback)
--   * the referenced transaction never arrived         → write a 0-amount TOMBSTONE referencing it,
--     so the straggler debit or credit is fenced when it lands (the rollback-before-it case)
--   * the referenced transaction is still `pending`    → RAISE 55P03 (the handler settles pending
--     debits first, so this only fires if one appeared since — retry the batch)
--   * the round is closed                              → RAISE SEBNC: a closed round is final,
--     whatever closed it
--   * otherwise                                        → reverse it
-- The round is then closed UNLESS p_active is true — and not while another debit is mid-flight
-- (55P03, as in close_bet_v1). An orphan rollback (no bet yet) creates the bet `pending` from the
-- session so the tombstone has a home — alignment is then true by construction. With p_active=true
-- a different debit can still open that round; with p_active=false it is closed, and closed is
-- final.
CREATE OR REPLACE FUNCTION repo.rollback_v1(
    p_id       int8,
    p_session  uuid,
    p_user     integer,
    p_game     integer,
    p_currency varchar,
    p_items    jsonb,  -- [{ "ref": <debit or credit ext_id>, "id": <minted rollback id>, "ext": <RGS rollback id>,
                       --    "cid": <minted id for a cascaded single-shot win> }, ...]
    p_active   boolean
)
RETURNS TABLE (
    rollback_id     uuid,
    rollback_amount int8,
    reversed_type   repo.transaction_type,
    cascaded        boolean
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_bet_status   repo.bet_status;
    v_bet_session  uuid;
    v_item         jsonb;
    v_ref          uuid;
    v_rb_id        uuid;
    v_rb_ext       uuid;
    v_existing_id  uuid;
    v_existing_amt int8;
    v_type         repo.transaction_type;
    v_amount       int8;
    v_status       repo.transaction_status;
    v_cc_id        uuid;
    v_cc_ext       uuid;
    v_cc_amt       int8;
BEGIN
    SET LOCAL lock_timeout = '1s';

    -- Ensure the bet exists so a tombstone (orphan rollback) has somewhere to live. No-op otherwise.
    INSERT INTO repo.bet (id, session, "user", game, currency, status)
    VALUES (p_id, p_session, p_user, p_game, p_currency::repo.currency, 'pending')
    ON CONFLICT (id) DO NOTHING;

    SELECT status, session INTO v_bet_status, v_bet_session FROM repo.bet WHERE id = p_id FOR UPDATE;

    -- Every call for a round carries the session that opened it. A rollback whose session doesn't
    -- match the bet's recorded session is refused BEFORE anything is reversed (SESMM → ERR_IS).
    IF v_bet_session <> p_session THEN
        RAISE EXCEPTION USING ERRCODE = 'SESMM';
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
        v_ref    := (v_item->>'ref')::uuid;
        v_rb_id  := (v_item->>'id')::uuid;
        v_rb_ext := (v_item->>'ext')::uuid;

        SELECT t.type, t.amount, t.status INTO v_type, v_amount, v_status
        FROM repo.transaction t
        WHERE t.bet_id = p_id AND t.type IN ('debit', 'credit') AND t.ext_id = v_ref;

        -- Already reversed? Idempotent on the ref (covers a replay and a double-rollback).
        SELECT r.id, r.amount INTO v_existing_id, v_existing_amt
        FROM repo.transaction r
        WHERE r.bet_id = p_id AND r.type = 'rollback' AND r.reference = v_ref;
        IF v_existing_id IS NOT NULL THEN
            rollback_id := v_existing_id; rollback_amount := v_existing_amt;
            reversed_type := CASE WHEN v_existing_amt > 0 THEN v_type END; cascaded := false;
            RETURN NEXT;
            -- A replayed single-shot reversal re-drives its cascaded win too (idempotent on its key).
            IF v_type = 'debit' THEN
                SELECT r.id, r.amount INTO v_cc_id, v_cc_amt
                FROM repo.transaction c
                JOIN repo.transaction r ON r.bet_id = c.bet_id AND r.type = 'rollback' AND r.reference = c.ext_id
                WHERE c.bet_id = p_id AND c.type = 'credit' AND c.concurrent AND c.reference = v_ref;
                IF FOUND THEN
                    rollback_id := v_cc_id; rollback_amount := v_cc_amt; reversed_type := 'credit'; cascaded := true;
                    RETURN NEXT;
                END IF;
            END IF;
            CONTINUE;
        END IF;

        IF v_type IS NULL THEN
            -- Orphan: the rollback arrived before the transaction it names. Tombstone it (move
            -- nothing); the straggler debit or credit is fenced when it lands.
            INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
            VALUES (v_rb_id, p_id, 'rollback', 0, v_rb_ext, v_ref);
            rollback_id := v_rb_id; rollback_amount := 0; reversed_type := NULL; cascaded := false;
            RETURN NEXT; CONTINUE;
        END IF;

        IF v_status = 'pending' THEN
            RAISE EXCEPTION USING ERRCODE = '55P03';  -- mid-flight → retry the batch
        END IF;
        IF v_bet_status = 'closed' THEN
            RAISE EXCEPTION USING ERRCODE = 'SEBNC';  -- a closed round is final
        END IF;

        INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
        VALUES (v_rb_id, p_id, 'rollback', v_amount, v_rb_ext, v_ref);
        rollback_id := v_rb_id; rollback_amount := v_amount; reversed_type := v_type; cascaded := false;
        RETURN NEXT;

        -- Reversing a (once pending) single-shot's debit reverses the win it carried too, unless that
        -- win was already reversed by name.
        IF v_type = 'debit' THEN
            SELECT c.ext_id, c.amount INTO v_cc_ext, v_cc_amt
            FROM repo.transaction c
            WHERE c.bet_id = p_id AND c.type = 'credit' AND c.concurrent AND c.reference = v_ref
              AND NOT EXISTS (
                  SELECT 1 FROM repo.transaction r WHERE r.bet_id = p_id AND r.type = 'rollback' AND r.reference = c.ext_id
              );
            IF v_cc_ext IS NOT NULL THEN
                v_cc_id := (v_item->>'cid')::uuid;
                INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
                VALUES (v_cc_id, p_id, 'rollback', v_cc_amt, v_cc_id, v_cc_ext);
                rollback_id := v_cc_id; rollback_amount := v_cc_amt; reversed_type := 'credit'; cascaded := true;
                RETURN NEXT;
            END IF;
        END IF;
    END LOOP;

    -- Close the round unless the RGS is keeping it open — and not under a debit still mid-flight:
    -- its rollback must still be able to reverse it. The named ones were settled first. Retry.
    IF NOT p_active AND EXISTS (
        SELECT 1 FROM repo.transaction d WHERE d.bet_id = p_id AND d.type = 'debit' AND d.status = 'pending'
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '55P03';
    END IF;
    IF NOT p_active THEN
        UPDATE repo.bet SET status = 'closed', updated_at = now()
        WHERE id = p_id AND status IN ('pending', 'open');
    END IF;
END;
$$;

-- Read a bet. A round holds 0..N credits, so this returns just the bet — the credit handler only
-- needs it to validate session + currency + that the round exists. Gated on EXISTS(debit): a round
-- with no debit — only a rollback tombstone (orphan) — reads back as not-found, so a credit for it
-- returns ERR_BNF (credits never fence a round; only a rollback does).
CREATE OR REPLACE FUNCTION repo.get_bet_v1(p_id int8)
RETURNS TABLE (
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
BEGIN
    RETURN QUERY
    SELECT b.id, b.session, b.status, b."user", b.game, b.currency, b.created_at, b.updated_at
    FROM repo.bet b
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
