-- Multiple credits per round.
--
-- Supersedes the single-credit definitions of repo.close_bet_v1 and repo.record_debit_v1 from
-- 002_funcs.sql. The contract used to be: a round is 1..N debits + EXACTLY ONE credit. It is now
-- 1..N debits + 0..N credits. While a round is `open`, credits accumulate just like debits; an
-- `active = false` flag (on a debit OR a credit) closes the round. Each credit is idempotent on its
-- own ext_id — the schema's UNIQUE (ext_id, bet_id) already keys every transaction, so no table
-- change is needed; we only relax the proc-level "one credit" guards and teach close_bet_v1 the
-- `active` flag.
--
-- Why broaden it now: we don't own the operator wallet implementations. Tightening or extending the
-- contract after hundreds of operators have integrated means a fleet-wide, coordinated
-- re-implementation. The broadest viable interface up front is the cheaper path over the lifetime of
-- the integration (and lets future products plug straight into already-integrated operators).
--
-- SQLSTATE note: SECRD ("a different credit already settled this round") is no longer raised — a new
-- credit ext_id is simply appended. A credit naming a NEW ext_id on a CLOSED round is refused with
-- SEBNC (nothing happens to a closed round); a replay of an already-recorded credit ext_id returns
-- its stored id, even on a closed round.

-- close_bet_v1 gains p_active. Add a credit to the round (idempotent on its ext_id) and close the
-- round iff p_active is false. A NULL credit with p_active=false closes a losing/zero round; a NULL
-- credit with p_active=true is a no-op that just reports the bet. The 5-arg signature is replaced, so
-- drop it first (a new param list would otherwise create an overload the repo wouldn't call).
DROP FUNCTION IF EXISTS repo.close_bet_v1(int8, uuid, int8, uuid, uuid);

CREATE FUNCTION repo.close_bet_v1(
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
    v_bet       repo.bet%ROWTYPE;
    v_credit_id uuid;
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

    -- Record the credit, if one was sent. Idempotent on the credit's ext_id (UNIQUE per round): a
    -- replay returns the stored id and moves no money; a NEW ext_id appends another credit. A new
    -- credit on an already-closed round is refused (nothing happens to a closed round).
    IF p_credit_ext_id IS NOT NULL THEN
        SELECT c.id INTO v_credit_id
        FROM repo.transaction c
        WHERE c.bet_id = p_id AND c.type = 'credit' AND c.ext_id = p_credit_ext_id;

        IF v_credit_id IS NULL THEN
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

-- record_debit_v1: same signature as 002, but the optional concurrent credit no longer assumes the
-- round has zero credits. Drop the "a credit already exists → SECRD" guard so a debit's concurrent
-- credit (e.g. a buy-feature) composes with any credits already on an open round. Still idempotent on
-- the debit ext_id, still fences stragglers (SEFEN) and refuses a closed round (SECLO).
CREATE OR REPLACE FUNCTION repo.record_debit_v1(
    p_id            int8,
    p_session       uuid,
    p_user          integer,
    p_game          integer,
    p_currency      varchar,
    p_amount        int8,
    p_debit_id      uuid,
    p_debit_ext_id  uuid,
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

    -- 5. Optional concurrent credit (e.g. a buy-feature settling its win in the same call). Appended
    --    like any other credit; the round may already hold others. Idempotent on the credit ext_id.
    IF p_credit_id IS NOT NULL THEN
        INSERT INTO repo.transaction (id, bet_id, type, amount, ext_id, reference)
        VALUES (p_credit_id, p_id, 'credit', p_payout, p_credit_ext_id, p_debit_ext_id);
    END IF;

    RETURN QUERY SELECT p_debit_id, p_credit_id, v_bet_created_at;
END;
$$;

-- get_bet_v1 no longer returns "the" credit: a round now holds 0..N, so a LEFT JOIN on credits would
-- multiply the row. The credit handler only needs the bet (to validate session + currency + that the
-- round exists), so return just the bet. The EXISTS(debit) gate stays — a round with only a rollback
-- tombstone still reads as not-found so a credit for it returns ERR_BNF. Shape changes, so drop first.
DROP FUNCTION IF EXISTS repo.get_bet_v1(int8);

CREATE FUNCTION repo.get_bet_v1(p_id int8)
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
