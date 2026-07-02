# Engine - wallet integration examples

This repository is a collection of **reference implementations of the operator side of an
Engine wallet integration**. Each example is self-contained and meant to be read end
to end, then used as the starting point for a real integration.

The **contract every example implements is the same** - it's described in full below, once,
because it does not depend on language or stack. Each example's own readme then covers only
what is specific to it: how to run it, what it's built on, and where in its code each rule
below lives.

## What an Engine integration is

Two systems split the work of running a real-money game:

- The **RGS** (Remote Gaming Server) runs the game itself - it decides outcomes.
- The **operator wallet** (what you build) is the **system of record for player money**.

As a player bets, the RGS sends your wallet signed HTTP requests to move money: take a
stake, pay a win, reverse a stake. Your wallet is the authority on balances; the RGS is the
authority on game outcomes. Real money flows through these calls, so the whole job is
**staying correct under failures and retries**.

## Examples

| Example        | Stack                                                                 |
| -------------- | --------------------------------------------------------------------- |
| [`bun/`](bun/readme.md) | TypeScript on [Bun](https://bun.sh); Postgres bet ledger, with a Postgres or [TigerBeetle](https://tigerbeetle.com) balance ledger. |

More examples (other languages and stacks) may be added over time. They all implement the
contract below; they differ only in how they store data and wire up the HTTP layer.

**Where to start:** read this contract first, then open the example closest to your stack.
Each example is written for a first-time reader - it starts with what it is and how to run
it, then maps each rule below onto its own code. These are **reference examples, not a
drop-in library** - copy the parts you need and adapt them to your own infrastructure.

---

# The integration contract and failure model

**Audience:** an engineer (or an AI assistant working on their behalf) building the
*operator side* of an Engine wallet integration, in any language or stack. This part is
self-contained and assumes no prior context. Read it before writing code, and keep it open
while you do.

> **What you are building.** The RGS runs the game. Your wallet is the system of record for
> **player money**. As players bet, the RGS sends your wallet signed HTTP requests to move
> money: take a stake, pay a win, reverse a stake. Your wallet is the authority on balances;
> the RGS is the authority on game outcomes. Real money flows through these calls, so
> correctness under failure and retries is the entire job.

## 1. The mental model that prevents every serious bug

Internalize these three facts before anything else. Almost every money bug is a violation
of one of them.

1. **The RGS retries. Forever, effectively.** Any request can be sent to you more than
   once - because the RGS timed out waiting for you, a network blip dropped your response,
   your process restarted mid-request, or a load balancer double-delivered. The RGS keeps
   re-sending a request until it gets a **definitive** answer. This is a feature: it means
   *the RGS is your reconciliation engine*. You do not need to build a background job to
   "finish" half-done operations - you need to make every operation safe to replay, and let
   the RGS drive it to completion.

2. **A replay must never create a second bet or a second money movement.** Two identical
   debits for the same round must result in *one* stake taken, not two. This is
   **idempotency**, and it is mandatory, not optional. The RGS gives you stable unique ids
   for exactly this purpose (see §4).

3. **Never return a success status code unless the money is *durably* correct.** A `2xx` is
   a promise to the RGS: "this is done, stop asking." If you return `2xx` while the outcome
   is actually unknown (a downstream call timed out, you crashed before committing), the RGS
   stops retrying and you are left permanently inconsistent - money taken that you think
   wasn't, or vice versa. When in doubt, return a retryable error and let the RGS try again.
   Because every operation is idempotent (fact 2), retrying is always safe.

These three compose into one sentence: **be idempotent, and tell the truth about status,
and the RGS's retries will make the system converge.**

## 2. The contract

### Endpoints

The RGS sends `POST` requests with JSON bodies to four endpoints:

| Endpoint        | Meaning                                                              |
| --------------- | ------------------------------------------------------------------- |
| `POST /v1/balance`  | Report the player's current spendable balance. Doubles as the auth check — the RGS calls it on session start, before showing any UI. Pure read: must not mutate state. |
| `POST /v1/debit`    | **Open or add to a round**: take a stake. May optionally pay a win at the same time (single-shot - see §6). A round can hold **multiple debits** (see below). |
| `POST /v1/credit`   | **Pay a win and/or close a round**: each credit pays a win; `active:false` closes the round (a credit with no payout + `active:false` settles a losing round). A round can hold **multiple credits** (see below). |
| `POST /v1/rollback` | **Reverse one or more of a round's debits**: refund each named debit, and optionally close the round. |

> **A round is a container of 1..N debits plus 0..N credits.** Most rounds have a single
> debit and a single credit, but the RGS may send several of each for the same `round` (each
> with its own `debit.id` / `credit.id`) - they accumulate. While the round is **open**, both
> debits and credits land; an **`active:false` flag on any of debit / credit / rollback closes
> the round**, after which nothing new lands (replays still return their stored result). The
> identity of an individual stake or payout is its own transaction id, not the round (see
> idempotency, §4).

> **Base URL.** The RGS POSTs these paths to **your wallet ingress URL** — configured per
> integration on Engine's integration site (Settings → Ingress). There is no separate
> authenticate endpoint: `/v1/balance` does double duty.

Alongside the four money endpoints, expose an unauthenticated **healthcheck** (e.g.
`GET /health`). Only the **HTTP status code** matters — any `2xx` means healthy; the body is
ignored. No signature required. It's used to drop dead wallets from rotation, so keep it cheap
and dependency-light.

### Money representation

All amounts are **integer micro-units** of the player's currency: `1_000_000` = `1.00`.
There are no fractional micro-units; amounts are whole integers. Currency is an ISO-style
code from a fixed enum (e.g. `USD`, `EUR`, `JPY`).

> **Precision warning.** If you parse amounts into a language's default floating-point
> number type (e.g. JavaScript `number`), you are safe only up to 2^53. Balances and stakes
> are well within that, but if you ever sum many movements or handle very large values, use
> a 64-bit integer / BigInt / decimal type end-to-end. Never do money math in floats.

### Identifiers in every request

- **`token`** - the player's session token. You issued this at game launch; it resolves to
  a player and a currency. Treat an unknown/garbled token as `ERR_IS` (invalid session).
- **`round`** - the RGS's round id. The round **groups** a bet's transactions; all calls for
  one round (its debits, then a credit or rollbacks) carry the same `round`. A round may hold
  more than one debit, so the round is *not* the identity of a single stake - `debit.id` is.
- **Transaction ids** - each money movement carries its own RGS-supplied id: `debit.id`,
  `credit.id`, `rollback.id`. These are globally unique and **stable across retries**. They
  are your idempotency keys (§4) - a replayed `debit.id` is the *same* stake, while a new
  `debit.id` on the same round is an *additional* stake.
- **`ref`** - on a credit or rollback, the id of the debit it settles/reverses. A rollback's
  `ref` names the specific debit to reverse; a credit's `ref` links the payout to a stake.
- **`currency`** - present on each money sub-object; **must equal the session's currency**.
  Reject a mismatch as `ERR_BAD`.

### Identifier guarantees

The RGS guarantees that each transaction id is **globally unique and stable across retries** -
generated once per logical operation and re-sent *verbatim* on every retry. This is the
foundation of idempotency (§4): treat the ids as **opaque strings**, equal if they name the
same operation, and don't parse or derive meaning from their contents. That single guarantee is
all you need.

### The wire shapes: every field, per endpoint

The full request/response reference (also on Engine's integration site). All amounts are
integer micro-units; **required** on a response means "present on a 200". Every response carries
the same `balance` object:

| Field              | Type               | Required | Description |
| ------------------ | ------------------ | -------- | ----------- |
| `balance`          | object             | yes      | Wrapper for the post-operation balance. |
| `balance.amount`   | int64              | yes      | Player's balance after this operation, in micro-units. Always non-negative. |
| `balance.currency` | string (ISO-4217)  | yes      | Three-letter uppercase code — always the session's target currency. |

#### `POST /v1/balance`

| Field   | Type   | Required | Description |
| ------- | ------ | -------- | ----------- |
| `token` | string | yes      | Opaque session token the operator supplied at game launch. Identifies which player + currency this call is for. |

```json
{ "token": "01927b8e-0000-7000-8000-000000000001" }
```

Response is the `balance` object alone. Errors: `ERR_IS` for an unknown/expired token,
`ERR_ATE` on a bad signature. No mutation, so no `ERR_IPB` / `ERR_BNF` here.

#### `POST /v1/debit`

| Field             | Type              | Required | Description |
| ----------------- | ----------------- | -------- | ----------- |
| `token`           | string            | yes      | Session token. Same value across every wallet call for this player session. |
| `round`           | uint64            | yes      | Round (bet) identifier — a **container**, not the idempotency key. Several debits can share one round; the same value is reused on `/v1/credit` and `/v1/rollback`. |
| `mode`            | string            | yes      | Game mode for this round, e.g. `BASE`, `FREE`, `BONUS_BUY`. Always present; may be an empty string for games with no mode concept. Useful for ledgering / RTP analytics. |
| `active`          | bool              | yes      | Whether the round stays open after this debit. `true` keeps it open; `false` closes it now (single-shot, or a loss known at debit time — §6.3/§6.4). |
| `ip`              | string            | yes      | Player's IP at game launch. Always sent; may be empty. Surface in your ledger for regulatory traceability. |
| `debit`           | object            | yes      | The amount being debited. |
| `debit.id`        | string (uuid)     | yes      | The RGS's transaction id for this debit — your idempotency key. |
| `debit.amount`    | uint64            | yes      | Stake in micro-units. Always > 0 — reject zero/negative with `ERR_BAD`. |
| `debit.currency`  | string (ISO-4217) | yes      | Must match the session's currency. |
| `credit`          | object \| null    | no       | Optional settling credit for an instant win/loss in the same call (§6.4). `null` (or omitted) for normal bets that settle later via `/v1/credit`. |
| `credit.id`       | string (uuid)     | no       | Transaction id for the concurrent credit — its idempotency key. |
| `credit.amount`   | uint64            | no       | Win in micro-units. Zero is valid (a losing single-shot). |
| `credit.ref`      | string            | no       | References the `debit.id` being settled. |
| `credit.currency` | string (ISO-4217) | no       | Must equal `debit.currency`. |

```json
{
  "token": "01927b8e-0000-7000-8000-000000000001",
  "round": 4119983943,
  "mode": "BASE",
  "active": true,
  "ip": "203.0.113.5",
  "debit": { "id": "fd76b683-…", "amount": 100, "currency": "EUR" },
  "credit": null
}
```

| Response field | Type   | Required | Description |
| -------------- | ------ | -------- | ----------- |
| `debit_id`     | string | yes      | **Your** internal id for this debit (uuid recommended). Echo the same value on replays. |
| `credit_id`    | string | no       | Your internal id for the settling credit — present **only** when the request carried a `credit`. Omit it (or send `null`) otherwise; don't invent a placeholder. |
| `balance`      | object | yes      | The shared balance object. |

Errors: `ERR_IPB` when the stake can't be covered (validate the **debit alone** — a concurrent
credit must not fund it, §6.4). `ERR_BAD` on a zero/negative amount, currency mismatch, schema
violation, or a fenced debit (§7.2d). `ERR_BC` if the round is already closed. `ERR_IS` on an
unknown token.

#### `POST /v1/credit`

| Field             | Type              | Required | Description |
| ----------------- | ----------------- | -------- | ----------- |
| `token`           | string            | yes      | Session token. Must be the session that opened the bet. |
| `round`           | uint64            | yes      | The round being credited. Must have at least one debit — otherwise `ERR_BNF` (credits never open or fence a round). |
| `active`          | bool              | yes      | `false` closes the round (the common settling case); `true` keeps it open for further credits/debits (staged payouts). |
| `ip`              | string            | yes      | Player's IP at credit time. Always sent; may be empty. |
| `credit`          | object \| null    | no       | The win to pay. **Omit (or `null`) + `active:false` to close a losing/zero round** paying nothing (§6.2). |
| `credit.id`       | string (uuid)     | no       | Transaction id — the idempotency key for this credit. |
| `credit.amount`   | uint64            | no       | Win in micro-units. Zero is valid. |
| `credit.ref`      | string            | no       | The `debit.id` this credit settles. Multiple credits may reference the same debit. |
| `credit.currency` | string (ISO-4217) | no       | Must match the bet's currency (recorded at debit time) — mismatch → `ERR_BAD`. |

```json
{
  "token": "01927b8e-0000-7000-8000-000000000001",
  "round": 4119983943,
  "active": false,
  "ip": "203.0.113.5",
  "credit": { "id": "084b0e7e-…", "amount": 200, "ref": "fd76b683-…", "currency": "EUR" }
}
```

| Response field | Type   | Required | Description |
| -------------- | ------ | -------- | ----------- |
| `credit_id`    | string | no       | Your internal id for this credit. Echo on replays. **Omitted on a no-payout (losing) close** — there's no credit to identify. |
| `balance`      | object | yes      | The shared balance object. |

Errors: `ERR_BNF` when the round was never debited. `ERR_BAD` on a currency mismatch. `ERR_BC`
when a **new** credit lands on a closed round (a replay of an existing `credit.id` returns its
stored result instead). `ERR_IS` on an unknown token.

#### `POST /v1/rollback`

| Field             | Type          | Required | Description |
| ----------------- | ------------- | -------- | ----------- |
| `token`           | string        | yes      | Session token. |
| `round`           | uint64        | yes      | The round whose debits are being reversed. |
| `active`          | bool          | no       | `false` (or omit) closes the round after the reversals; `true` keeps it open for its remaining debits. |
| `rollbacks`       | array         | yes      | One entry per debit to reverse. Refunds are returned in `rollback_ids` in this same order. |
| `rollbacks[].id`  | string (uuid) | yes      | Transaction id for **this rollback**. Note: idempotency is keyed on the debit `ref`, not this id — two different rollback ids for the same `ref` still refund once. |
| `rollbacks[].ref` | string        | yes      | The `debit.id` being reversed. If no such debit has arrived yet, it is **fenced** (tombstoned), not rejected (§7.2d). |

```json
{
  "token": "01927b8e-0000-7000-8000-000000000001",
  "round": 4119983943,
  "active": false,
  "rollbacks": [ { "id": "3617edba-…", "ref": "fd76b683-…" } ]
}
```

| Response field | Type           | Required | Description |
| -------------- | -------------- | -------- | ----------- |
| `rollback_ids` | array (string) | yes      | Your internal rollback ids — one per `rollbacks` entry, **in input order**. Echo the same ids on replays. |
| `balance`      | object         | yes      | The shared balance object. |

Errors: `ERR_BC` when the round is already closed or settled (a credited round can't be
reversed). A `ref` to a debit that never arrived is **not** an error — it's fenced (tombstone,
`200`, refunds nothing). A referenced debit still mid-flight (`pending`) → retryable `5xx`.

### Error response contract

Every error response uses the envelope `{ "code": "<ERR_CODE>", "message": "<human readable>" }`
with the matching HTTP status — the code drives the player-facing message the RGS renders.
Standard codes:

| Code      | HTTP  | Meaning                                     | Terminal or retryable? |
| --------- | ----- | ------------------------------------------- | ---------------------- |
| `ERR_ATE` | `401` | Failed request authentication — the `x-signature` header is missing or doesn't verify against the RGS public key. | **Terminal** |
| `ERR_IS`  | `400` | Invalid / unknown session token             | **Terminal** |
| `ERR_IPB` | `400` | Insufficient player balance — the **debit alone** can't be covered (a win must not fund its own stake, §6.4). | **Terminal** |
| `ERR_BAD` | `400` | Malformed request — zero/negative amount, currency mismatch, schema violation, or a debit fenced by a prior rollback (§7.2d). NOT closed-round (that's `ERR_BC`). | **Terminal** |
| `ERR_BNF` | `404` | Bet (round) not found — a credit/rollback for a round with no debit on this session. | **Terminal** |
| `ERR_BC`  | `400` | Bet already complete — a new debit/credit/rollback after the round closed. A replay of an existing transaction id returns its stored result instead of this error. | **Terminal** |
| `ERR_GE`  | `500` | General / unexpected error, or any outcome you can't yet decide. The RGS retries until it resolves. | **Retryable** |
| `ERR_UE`  | `500` | Unhandled error during a **rollback** specifically. Same retry semantics as `ERR_GE`. | **Retryable** |

The terminal/retryable column is the most important part of this table - see §3.

### Authentication

Every wallet request is signed. Verify the signature **before parsing the body**, and reject
any failure with `401` `ERR_ATE`:

| Header        | Required | Description |
| ------------- | -------- | ----------- |
| `x-signature` | yes      | Base64 **RSA PKCS#1 v1.5 + SHA-256** signature over the **raw request body bytes**, signed with the RGS's private key. Standard base64 (not URL-safe, not PSS). Verify against the RGS public key from the integration site (Settings → Public key). |
| `Content-Type`| yes      | Always `application/json; charset=utf-8`. |

(There is no operator-identifying header on inbound wallet calls — there are many wallets but
only one RGS, so the signature alone proves who's calling. The identification requirement runs
the other way: *your* calls to Engine carry `X-Operator`, below.)

- Verify against the **exact bytes** you received, then parse *those same bytes* as JSON. Do
  not re-serialize the parsed object and verify against that - key ordering and whitespace
  will differ and the signature will fail.
- Signatures prove origin, **not freshness**. A captured request can be replayed at the
  network layer. That is fine *only because* your idempotency keys (§4) make replays
  harmless. Do not rely on the signature for replay protection.

### The other direction: calls you make to Engine

The wallet endpoints above are Engine calling **you**. There are also three
operator-initiated endpoints **you call**, at base URL `https://operator.stake-engine.com`. The
auth direction reverses: sign each request body with **your** private key (same scheme — base64
RSA PKCS#1 v1.5 + SHA-256 over the raw body) and send `X-Operator` + `X-Signature` on every
call; Engine verifies with the public key you uploaded on the integration site. For GETs,
sign the empty body (zero bytes).

#### `POST /game/url` — start a real-money session

Call when a logged-in player clicks Play. The `token` you supply here is what comes back to
your wallet as the `token` field on every subsequent `/v1/*` call — this is where sessions are
born. Store it server-side keyed to the player.

| Field      | Type              | Required | Description |
| ---------- | ----------------- | -------- | ----------- |
| `game`     | string            | yes      | Game identifier, `{teamId}_{gameSlug}` — use the `id` from `GET /game/list` verbatim. |
| `user`     | string            | yes      | Your operator-side user id. Treated as opaque; never shown to the player. |
| `token`    | string            | yes      | Your one-time session token, unique per session. Handed back on every wallet call for this session. |
| `currency` | string (ISO-4217) | yes      | Uppercase; must be a currency configured on your operator. |
| `language` | string (BCP-47)   | yes      | Game UI language, e.g. `en`, `pt-br`. Falls back to English. |
| `device`   | string            | yes      | `desktop`, `mobile`, or `tablet`. |
| `tag`      | string (enum)     | yes      | Player classification: `real`, `affiliate`, `streamer`, `employee`, `qa`. Use `real` for paying customers; the rest are excluded from production accounting. |

Response: `{ "url": …, "fair": … }` — a single-use, pre-signed launch `url` (string) to redirect
the player to, and `fair` (bool), whether the game supports provably-fair verification. `404` if
the game id doesn't exist / isn't approved for you; `400` if no approved versions exist. The
launch URL embeds the session token — don't log it.

#### `POST /game/url/demo` — start a demo session

Same shape pinned to demo balances (try-before-signup, QA). Every field is optional except
`game`; note this endpoint uses `deviceType` (camelCase) where `/game/url` uses `device`.

| Field        | Type              | Required | Description |
| ------------ | ----------------- | -------- | ----------- |
| `game`       | string            | yes      | Game identifier, as above. |
| `currency`   | string (ISO-4217) | no       | Demo-balance currency. Defaults `USD` (`XGC` for social-casino operators). |
| `token`      | string            | no       | Session token; auto-generated if omitted. |
| `deviceType` | string            | no       | `desktop` (default), `mobile`, `tablet`. |
| `language`   | string (BCP-47)   | no       | Defaults `en`. |
| `math`       | uint32            | no       | Pin a specific math-model version; omit for latest approved. |
| `front`      | uint32            | no       | Pin a specific frontend version; omit for latest approved. |

Response: `{ "url": … }` only — no `tag` field and no `fair` in the response; demo sessions are
employee-tagged internally.

#### `GET /game/list` — list enabled games

The games approved for your operator. No request body — still sign the empty body for
`X-Signature`. Cache it; the catalog changes on the order of days (typically <200 games, not
paginated). Response is a **top-level JSON array**, no envelope:

| Field                | Type           | Required | Description |
| -------------------- | -------------- | -------- | ----------- |
| `[].id`              | string         | yes      | `{teamId}_{gameSlug}` — pass verbatim as `game` on `POST /game/url`. |
| `[].name`            | string         | yes      | Display name for your lobby. |
| `[].image`           | string (URL)   | no       | Cover art. **Omitted** (not null) when none published. |
| `[].rtp`             | float64        | yes      | Target return-to-player as a fraction in `[0.0, 0.977]` — ×100 for the percentage. |
| `[].publisher`       | object         | yes      | The studio behind the game. |
| `[].publisher.id`    | int            | yes      | Publisher (team) id — the `{teamId}` in `id`. |
| `[].publisher.name`  | string         | yes      | Publisher display name. |
| `[].publisher.image` | string (URL)   | no       | Publisher logo. Omitted when none uploaded. |

## 3. Status codes are your safety mechanism

Because the RGS decides whether to retry based on your status code, classifying responses
correctly is not cosmetic - it is the core of correctness. There are exactly three buckets:

1. **Definitely done → `2xx`.** The money movement is durably committed, *or* this is a
   replay of an operation you can prove already completed. Return the result.

2. **Definitely not done, and never will be → `4xx` (terminal).** A business answer that
   will not change on retry: insufficient funds (`ERR_IPB`), invalid session (`ERR_IS`), bad
   request (`ERR_BAD`), bet not found (`ERR_BNF`). Safe to return because **no money moved**
   and the RGS will stop asking. The state is known.

3. **Unknown → `5xx` (retryable).** You could not determine the outcome: a downstream
   balance call timed out, a connection dropped, you crashed mid-flight, a lock could not be
   acquired in time. Return `ERR_GE` and let the RGS retry.

**The trap that loses money: misclassifying bucket 3 as bucket 2.** If a *transient* failure
(lock contention, timeout, a node restarting) is mapped to a `4xx`, the RGS takes it as final
and stops retrying - stranding a half-finished operation forever. So:

- A "row is locked by another transaction" / "couldn't get the lock in time" condition is
  **transient → `5xx`**, never `4xx`.
- A timeout talking to your own balance store is **transient → `5xx`**.
- Only return `4xx` when you have a *definite, durable* answer.

Equally: **never return `2xx` when the outcome is uncertain.** If you have committed a bet
locally but are unsure whether the balance moved, that is bucket 3, not bucket 1.

## 4. Idempotency: no duplicate bets, no duplicate transactions

The RGS will replay calls. Your wallet must produce the **same effect and the same response**
whether a call arrives once or five times. Enforce this in the database with constraints, not
in application logic - constraints cannot be forgotten under a race.

### What to key on

- **The bet (round).** `round` is the bet's primary key. Make it the actual `PRIMARY KEY` of
  your bet/round table. A second debit for the same round then fails with a unique violation,
  which you catch and turn into the idempotent-replay path - not a second bet.
- **Each transaction.** Each money movement's RGS id (`debit.id`, `credit.id`, `rollback.id`)
  gets a `UNIQUE` constraint in your transaction table. A replayed movement hits the unique
  violation; you return the originally stored result.

### The golden rule of ids: persist, never regenerate

Your wallet returns its *own* transaction ids to the RGS (e.g. `debit_id`). Generate that id
**once**, on first processing, and **persist it**. On a replay, **read the stored id back and
return it** - do not mint a fresh one. If you regenerate ids on replay, the RGS sees a
different `debit_id` for the same operation and your two systems disagree about what happened.

### What a replay must do

A replay must **complete or confirm the operation, then return its original result** - it
must *not* short-circuit to "success" without verifying the money is actually in the right
state. The most common idempotency bug is a replay path that returns a cached/looked-up
balance and a `2xx` *without* re-driving the part that may not have finished. See the worked
failure scenarios in §8.

### Retention

The RGS may retry much later, not just milliseconds later. Your idempotency keys must be
retained at least as long as the RGS might ever retry. An append-only transaction ledger
keyed by the RGS ids retains them permanently, which is the simplest correct choice - do not
put a short TTL on dedupe state.

## 5. Modeling money: bets vs. balances (and why to split them)

Two distinct concerns:

- **The bet ledger** - the record of rounds and their debit/credit/rollback transactions.
  This is your audit trail and your idempotency enforcement point.
- **The balance** - how much spendable money each player has, per currency.

Many operators run the balance/account system as a **separate service** from the wallet
integration (often it already exists and serves the rest of the casino). This guide supports
that design explicitly - see §7 for how to make a wallet-plus-separate-balance arrangement
safe. If your balance lives in the *same* database as your bet ledger, you can get strict
atomicity trivially (§7.1); if it is a separate service, you rely on idempotency and honest
status codes (§7.2).

There are many valid ways to model balances - a single mutable number, an append-only event
log, an existing external account service, and so on. **One approach the reference
implementations happen to use is double-entry:** model a player's money as buckets and move
money *between* buckets rather than mutating a single number. For example:

- `available` - spendable balance. Guard it with a non-negative `CHECK` constraint; that
  constraint *is* your insufficient-funds check.
- `escrow` / counter-accounts - where a stake sits while a round is open, and where wins flow
  from. These may be unconstrained.

Each movement debits one bucket and credits another and writes an append-only ledger row,
which makes balances auditable and turns "insufficient funds" into a database guarantee rather
than a read-modify-write race. Pick whatever fits your existing systems - the rest of this
contract doesn't depend on the choice, only on the balance store being idempotent (§7.2a).

## 6. The flows in detail

### 6.1 Standard round: open then close

```
RGS                         Wallet
 │  POST /debit (round R)     │
 │ ─────────────────────────► │  open bet R, take stake from `available`
 │ ◄───────────────────────── │  { debit_id, balance }
 │                            │
 │  ... game plays out ...    │
 │                            │
 │  POST /credit (round R)    │
 │ ─────────────────────────► │  close bet R, pay win to `available` (or no win)
 │ ◄───────────────────────── │  { credit_id, balance }
```

- **Debit (open):** validate session + currency, take the stake. If `available` cannot cover
  the stake → `ERR_IPB` (terminal). Record the bet (keyed by `round`) and the debit
  transaction (keyed by `debit.id`).
- **Credit (pay / close):** pay the win and, when `active:false`, close the round. A round may
  receive **several credits** while it is open (`active:true`) - each its own `credit.id`,
  each idempotent on that id, all accumulating - and a final credit with `active:false` closes
  it. A **losing/zero close** is a credit with **no payout** (a null/absent `credit` object)
  and `active:false` - it closes the round moving no money.
- A credit for a round that does not exist → `ERR_BNF`. A credit whose `token` does not match
  the bet's session → `ERR_IS`. A **new** credit on an already-closed round → `ERR_BC` (a
  closed round is terminal; only a *replay* of an existing credit id returns its stored
  result).

### 6.2 Losing close: a credit that closes the round with no payout

Not every round resolves at placement. A round is opened by an ordinary debit (§6.1), the game
plays out, and the player *loses* - so the closing call pays nothing. The RGS expresses this as a
**`/credit` with `active:false` and no `credit` field** (a null/absent credit): it settles the
round as a loss, moving no money.

```
RGS                              Wallet
 │  POST /debit (round R)          │
 │ ──────────────────────────────►│  open bet R, take the stake
 │ ◄────────────────────────────── │  { debit_id, balance }
 │                                 │
 │  ... game plays out, player loses ...
 │                                 │
 │  POST /credit (round R,         │
 │   credit:null, active:false)    │  close bet R, pay nothing
 │ ──────────────────────────────►│
 │ ◄────────────────────────────── │  { balance }        (no credit_id - nothing was paid)
```

This is the loss counterpart of the standard win-close in §6.1: same shape, but the `credit`
object is absent and no payout moves. Because nothing is paid, the response carries **no
`credit_id`** - just the (unchanged) balance. It is still a normal close: `active:false` moves the
round to `closed`, after which a new credit or debit is refused with `ERR_BC` (a replay of this
same closing credit returns its stored - empty - result).

Contrast the two loss shapes: this §6.2 is a **credit** that closes a round some *other* call
already opened (the outcome is known later); §6.3 is a **debit** that opens *and* closes in one
step (the outcome is known at placement). A round settles as a loss through whichever one fits the
game.

### 6.3 Instant loss: a debit that closes the round with no win

A common flow is a **`/debit` with `active:false` and no credit**: take the stake and close the
round in the same step. This is for bets already known to be **lost at placement time** - there
is no win to pay and no later credit is coming, so the round settles immediately as a loss.

```
RGS                              Wallet
 │  POST /debit (round R,          │
 │   active:false)                 │  in ONE step (active:false):
 │ ──────────────────────────────►│    • open bet R and close it as a loss
 │                                 │    • take stake (available → escrow)
 │ ◄────────────────────────────── │  { debit_id, balance }
```

Like the standard debit it takes the stake and can be rejected with `ERR_IPB`; the only
difference is the round never reopens for a credit. The winning instant-resolution case - stake
*and* win in one call - is single-shot (§6.4).

### 6.4 Single-shot: debit that also pays a win

Some rounds resolve immediately - there's no meaningful compute or animation time between the
stake and the outcome, so the two happen in the same step. Think a dice roll or a Plinko ball:
the player commits the stake and the result is known at once. (A "buy feature" is one case of
this, but the common one is simply any instant-resolution game.) The RGS expresses this as a
**`/debit` carrying an optional concurrent `credit`**: take the stake *and* pay the win in one
atomic operation.

Folding the stake and the win into a single call is a real optimization for everyone: it halves
the round trips (one signed request instead of a debit followed by a credit), so the RGS,
operator, and player all see lower latency and less load. That matters most for **very
high-throughput, high-bet-count games** - a Plinko where a player fires hundreds of balls in
quick succession would otherwise double the request volume.

Because the round opens and settles in the same step, **a single-shot's `active` is always
`false`** - the debit opens the round and closes it at once. There is no later credit to close
it; the round is terminal the moment this call succeeds.

```
RGS                                          Wallet
 │  POST /debit (round R, debit + credit)      │
 │ ──────────────────────────────────────────►│  in ONE atomic unit (active:false):
 │                                             │    • open bet R and close it
 │                                             │    • take stake   (available → escrow)
 │                                             │    • pay win      (payout  → available)
 │ ◄────────────────────────────────────────── │  { debit_id, credit_id, balance }
```

Critical rule for single-shot - **the stake is applied before the win, and the win must never
fund the stake:**

> If the player has `5.00` available, a single-shot with a `10.00` stake and a `20.00` win
> must be **rejected with `ERR_IPB`**. It must *not* net to `+15.00`. The stake is checked
> against the *current* available balance first; only if it clears does the win get paid.

Enforce this ordering inside whatever applies the movements (apply available-debits before
available-credits, regardless of the order they arrive in the request). A win that silently
funds an unaffordable stake is a real-money exploit.

The response carries **both** `debit_id` and `credit_id`. Both must be idempotent on replay
(each keyed by its own wallet transaction id). "Together" means the **two balance
movements** - the stake and the win - apply atomically as one unit (one idempotent balance
call): if either fails, neither applies. With a separate balance service that single call is the
money-moving step of the debit flow (§7.2), between recording the bet and confirming it.

### 6.5 Rollback: reverse one or more debits

A rollback reverses **specific debits** of a round - a round may have several, so the request
carries a **list**, each entry naming one debit by `ref`:

```jsonc
{
  "round": R,
  "active": false,              // false (or absent) closes the round after reversing; true keeps it open
  "rollbacks": [
    { "id": "<rollback-id>", "ref": "<debit-id>" },   // reverse this debit
    ...                                               // …and any others, atomically
  ]
}
```

Each reversal refunds that debit's stake (escrow → available) and records a rollback
transaction (keyed by its `id`, referencing the debit via `ref`); the response returns the
minted ids in order: `{ "rollback_ids": [...], "balance": {...} }`. **`active` is the same flag
debit/credit carry** - it decides whether the *round* closes afterwards, independent of which
debits you reversed. Reverse one debit with `active: true` to keep the round live for its
others; list them all with `active: false` to abandon the round in one atomic request.

```
RGS                          Wallet
 │  POST /rollback (round R)   │
 │ ──────────────────────────► │  reverse each named debit, refund to `available`; close if !active
 │ ◄───────────────────────────│  { rollback_ids, balance }
```

**Watch out for this subtle bug:** "the bet is not in an open/reversible state" can mean
several *different* things, and they must not be conflated:

- The debit was **already rolled back** → this is a **replay** → return the *existing*
  rollback id (`2xx`). Idempotent on the debit ref - also guards a stray double-rollback.
- The round was **already closed by a credit** (the player won and it was settled) → this is a
  genuine "cannot roll back a settled round" condition. Do **not** silently return success
  with a fabricated rollback id and no reversal. Return the appropriate error (or follow the
  RGS's defined semantics for this case), but never report a reversal that did not happen.
- There is **no such debit** - the rollback arrived *before* its debit → **fence** that debit
  (record a tombstone) rather than returning `404`, so the straggler debit is refused and
  can't strand a stake. This is the out-of-order case; see §7.2(d).

Rollback is idempotent on each debit ref: replaying it returns the same rollback id(s) without
refunding twice.

### 6.6 Putting it together: multi-debit / multi-credit / rollback rounds

The four calls above compose. A round is a **container of 1..N debits, 0..N credits, and any
rollbacks**, and the RGS may interleave them in one round. Rather than enumerate every ordering,
internalize the handful of rules that make *any* sequence well-defined - then the permutations
below all fall out of them:

1. **The round has one lifecycle: `pending → open → closed`.** The first debit opens it; it is
   `pending` until that debit's stake confirms, then `open`. **An `active:false` on *any* call -
   debit, credit, or rollback - closes it.** `closed` is terminal.
2. **The idempotency unit is the transaction id, never the round.** A *new* `debit.id` /
   `credit.id` adds a stake / win; a *replayed* id returns the stored result and moves no money.
   A rollback is idempotent on the **debit ref** it reverses.
3. **While `open`, debits and credits accumulate;** each is its own transaction. Order doesn't
   matter - two debits then two credits, or interleaved, reach the same state.
4. **After `closed`, only replays succeed.** A *new* debit, credit, or rollback on a closed round
   is refused with `ERR_BC` (terminal). A replay of any transaction already on the round still
   returns its stored result.
5. **A debit and a rollback for the *same* debit are mutually exclusive** - whichever the ledger
   records first wins. A rollback naming a debit it hasn't seen **fences** it (§7.2d): the
   straggler debit is later refused with `ERR_BAD`.

The requested permutations, each a valid sequence under those rules:

**(A) Multiple debits, then one credit that closes.** Several stakes on one round (e.g. multiple
lines), settled by a single closing credit.

```
POST /debit    (R, debit d1, active:true)   → open R, take stake 1
POST /debit    (R, debit d2, active:true)   → take stake 2   (new debit.id ⇒ an ADDITIONAL stake)
POST /credit   (R, credit c1, active:false) → pay the win, close R
⇒ after close: a new d3/c2 → ERR_BC; replaying d1/d2/c1 → their stored ids, no money moves
```

**(B) Multiple debits, all rolled back.** The round is abandoned; every stake is refunded.

```
POST /debit    (R, d1, active:true)   → open R, take stake 1
POST /debit    (R, d2, active:true)   → take stake 2
POST /rollback (R, active:false, rollbacks:[{rb1, ref:d1}, {rb2, ref:d2}])
               → refund BOTH stakes in one atomic batch, close R
⇒ replaying the batch → the same rollback_ids, no double refund (idempotent per ref)
```
(Equivalently, reverse them one request at a time with `active:true`, then a final `active:false`
to close - same end state.)

**(C) Multiple debits, roll back some, then credit and close.** `active:true` on the rollback is
what keeps the round alive for its surviving debits.

```
POST /debit    (R, d1, active:true)   → open R, take stake 1
POST /debit    (R, d2, active:true)   → take stake 2
POST /rollback (R, active:true, rollbacks:[{rb1, ref:d1}])  → refund stake 1; round STAYS open
POST /credit   (R, c1, ref:d2, active:false)                → pay the win on d2, close R
⇒ after close, reversing d2 → ERR_BC; replaying rb1 → rb1. Reverse with active:false instead and
  the round would have closed at the rollback, refusing the later credit with ERR_BC.
```

**(D) One debit, multiple credits, then close.** A single stake that pays out in installments
(several win events), the last one closing the round.

```
POST /debit  (R, d1, active:true)             → open R, take the stake
POST /credit (R, c1, ref:d1, active:true)     → pay win 1; round stays open
POST /credit (R, c2, ref:d1, active:true)     → pay win 2  (new credit.id ⇒ ACCUMULATES)
POST /credit (R, c3, ref:d1, active:false)    → pay win 3, close R
⇒ after close: a new c4 → ERR_BC; replaying c1/c2/c3 → their stored ids. A null credit with
  active:false would instead close the round paying nothing (a losing/zero settlement).
```

The full outcome matrix, for auditing any other ordering:

| Incoming call                         | Round not yet seen        | `open`                                   | `closed`                       |
| ------------------------------------- | ------------------------- | ---------------------------------------- | ------------------------------ |
| **debit**, new id                     | opens the round           | adds a stake                             | refused `ERR_BC`               |
| **debit**, replayed id                | -                         | stored ids, no money                     | stored ids, no money           |
| **debit** whose id a rollback fenced  | refused `ERR_BAD`         | refused `ERR_BAD`                        | refused `ERR_BAD`              |
| **credit**, new id                    | `ERR_BNF` (no stake yet)  | pays the win; closes if `active:false`   | refused `ERR_BC`               |
| **credit**, replayed id               | -                         | stored id, no money                      | stored id, no money            |
| **rollback** of a funded debit        | *(debit unseen ⇒ fence)*  | refunds the stake; closes if `!active`  | refused `ERR_BC`               |
| **rollback**, debit already reversed  | -                         | existing rollback id (idempotent)        | existing rollback id           |
| **rollback** of an unseen debit       | tombstone; refund nothing | tombstone (fence); refund nothing        | tombstone; refund nothing†     |
| **rollback** of a mid-flight debit    | -                         | retryable `5xx` (RGS re-drives)          | -                              |

† Fencing an unseen debit is idempotent and harmless even after the round has closed - if that
straggler debit ever lands it is refused regardless (closed round *and* fenced). Refusal with
`ERR_BC` on a closed round applies to reversing a debit that **did** land (a real refund).

A round whose first debit is still `pending` (its stake not yet confirmed) isn't yet settleable:
a credit or rollback against it returns a **retryable `5xx`**, and the RGS re-drives until the
debit resolves. Insufficient funds on any debit is always `ERR_IPB` (terminal), and leaves no
trace of that debit (§7.2b).

## 7. Making a separated balance service safe

### 7.1 If balance and bets share one database

Wrap the bet write and the balance movement in **one local transaction** on one connection.
They commit or roll back together - true atomicity, no special protocol needed. This is the
simplest correct design; prefer it if you can. Idempotency constraints (§4) still apply so
replays don't double-insert.

### 7.2 If balance is a separate service (the realistic case)

You now have two systems that cannot share a transaction, so you **cannot make the two writes
atomic**. Do not fake it with "commit A, then commit B" - there is always a window where A
committed and B did not, and a naive replay then returns a wrong balance. Instead, make the
system *converge* using three ingredients you already have:

**(a) The balance service must be idempotent, keyed by a stable id you control.** Its "apply
movement" operation takes an idempotency key and guarantees *apply-at-most-once,
return-the-same-result-on-replay*. Use the **bet's own transaction id** (which you mint), not
the RGS id directly: you then own the key's format. Implement idempotency
atomically *inside the balance service*: in one transaction, insert the key (with a `UNIQUE`
constraint), and on conflict return the previously stored result without re-applying. That
single unique constraint is what makes an unreliable network safe. Because every mutation
records the bet ledger **before** it moves money (bet-first, below), that id always exists
when the balance is keyed on it - no separate idempotency-key table is needed.

**(b) Record the bet ledger FIRST (bet-first), then move money.** With idempotent steps a crash
between the two writes always heals on the RGS's retry, so ordering is *not* about crash-safety.
It's about two things: not leaving a junk row when an operation is *rejected*, and not
*poison-looping* (a second step that fails deterministically - same input, same failure - after
the first step already moved money, so every retry repeats it forever with the money stuck).

Record the bet ledger first for **all three** operations, because the bet ledger is the single
source of truth for a round's state - and only a store that has already recorded the round can
*fence* it (see (d)). Each handler decides/writes the bet ledger, then moves money keyed by the
bet's own transaction id.

- **Debit → record the debit `pending`, move the stake, then `confirm`.** A round holds 1..N
  debits: the first opens it, a debit with a new `debit.id` appends another (a replayed
  `debit.id` is idempotent). Recording the debit first means:
    - a **rollback that referenced this debit's id before it arrived** has fenced it (a
      tombstone), and recording is **refused** - the straggler takes no stake (see (d)); a
      debit on a **closed** round is likewise refused;
    - the debit's own transaction id is the balance idempotency key - no separate key table, and
      you mint it as a UUIDv7 yourself (a) rather than trusting the RGS id's format.

  ```
  on debit(round R, debit, [credit]):
    1. resolve session; validate currency             (terminal ERR_* on failure)
    2. record the debit on R (open R `pending` on the   ← refuse if fenced (ERR_BAD) or if
       first debit; append on later ones)                 R is closed (ERR_BC) - both terminal
    3. balance.apply(key=debit_txn_id, movements)      ← gate: funds. idempotent; money moves here
          • insufficient funds → DELETE this pending debit, then ERR_IPB (4xx; nothing moved)
          • timeout / unknown  → ERR_GE (5xx, retryable; DO NOT return 2xx)
    4. confirm the debit; on the first confirm R goes pending → open (or closed for active=false)
    5. return { debit_id, [credit_id], balance }
  ```
  This records the debit before knowing the stake is affordable - but insufficient funds is the
  one deterministic rejection, and it means **no money moved**, so deleting the `pending` debit
  is a true rollback (not a compensation): no junk row, no poison-loop. (If it was the round's
  only debit, delete the empty bet too.) Guard the delete on the debit still being `pending` -
  you must **never** delete or reverse a debit whose stake already moved. That is the
  double-spend trap: once money has moved, the debit's id is the stable idempotency key, and
  removing it lets a re-drive mint a fresh id and apply the stake twice.

  Deleting is one way to clear the never-funded row; **marking it is another.** Instead of a
  `DELETE`, you can leave the row in place and flag it terminally failed (e.g. `active:false` with
  a failure reason) and let an out-of-band cleanup/archival job sweep such rows later. Both are
  correct because no money moved - it's a trade-off: deletion keeps the ledger clean; marking
  keeps a full audit trail of the attempt (and can be friendlier to append-only or partitioned
  stores where deletes are awkward). This is *not* the reconciler §(c) says you don't need - it
  moves no money and settles no outcome; it's housekeeping over rows that are already terminal.
  The one invariant is unchanged either way: only a `pending`, never-funded debit may be cleared,
  and a debit whose stake moved must never be deleted, reversed, *or* re-marked.

- **Credit → record the credit, pay the win, and close the round if `active:false`**
  (idempotent on the credit's transaction id; a round holds 0..N credits). Each credit
  validates its `ref` and pays on the round being `open`; a `pending` round (first debit not yet
  confirmed) is not closable (retryable); a **new** credit on an already-closed round is refused
  (a *replay* of an existing credit id returns its stored result).

- **Rollback → reverse each named debit, then refund, and close if `!active`** (idempotent on
  each debit ref) - or, if a named debit doesn't exist, **fence** it (see (d)). Read each refund
  amount from the bet ledger *before* refunding, so you never refund a debit settled by a win.

Why bet-first and not "lead with whichever ledger owns the gate" (which would put the debit
balance-first, since its gate is funds): moving money first means the round doesn't exist when a
too-early rollback arrives, so you can't fence it without an unavoidable cross-store race.
Recording the debit first makes the fence a plain lookup (does a rollback already reference this
debit id?), makes the debit's id the balance key (no key-translation table), and turns the
"money moved but bet not recorded" window into an explicit `pending` state you can reason about
(d). The price is the `pending`/`confirm` lifecycle and the delete-on-reject above.

**(c) You do NOT need your own reconciler.** The RGS already drives every operation to
completion by retrying until it gets a definitive answer. A background sweep on your side would
just race the RGS's retries redundantly. The combination *idempotent operations + honest status
codes + the RGS's retries* is the reconciliation loop. Your only job is to never return `2xx`
while an outcome is unconfirmed, so the RGS keeps driving.

Bet-first does carry a minimal **`pending → open`** lifecycle - a debit is recorded before its
stake is confirmed - but that is a single status column, not a saga: `balance.apply` is still
idempotent and re-driven on every call (including replays). The `pending` state exists to fence
a debit (d) and to let an unaffordable one be cleanly deleted, not to track "did I finish".

**(d) A rollback can arrive before its debit - fence that debit.** Requests are independent HTTP
calls; under retries and in-flight buffering they can be reordered, and at volume a debit can
even arrive *after* the RGS timed it out and sent a rollback. So a rollback may name a debit you
have **never seen**. Don't `404` it and hope the debit shows up - if it never does, you've
correctly done nothing; but if a *straggler* debit then lands, it would take a stake the RGS
already cancelled, stranding the player's money. Instead:

- **Rollback naming an unknown debit → record a tombstone for that debit id** (idempotent;
  refund nothing - no stake was ever taken) and acknowledge it, so the RGS stops re-driving.
  With multiple debits this is **per-debit**, not a whole-round void: the other debits on the
  round are untouched.
- **A debit whose id was tombstoned is refused** (the record step in (b) checks for a rollback
  referencing this debit id first, before any money moves). The straggler takes no stake.

Because the debit is bet-first, this fence is exact and race-free in the common case: the
tombstone and the debit contend on the round, and recording checks for the fence *before*
moving money. The one residual window - a rollback naming a debit that is **mid-flight**
(`pending`, stake not yet confirmed) - is an explicit state, not an invisible race: the rollback
returns a **retryable** error, and the RGS re-drives it until that debit resolves (then reverse
it) or is rejected (then there is nothing to reverse). Note the asymmetry: a **credit** for an
unknown round is *not* fenced - a credit means "the player won," which is meaningless before a
stake, so it's a transient `ERR_BNF` the RGS retries until the debit lands.

This is the single hardest case to get right in a separated wallet, and the one most worth a
dedicated conformance test (rollback → straggler-debit): assert the rollback succeeds, the debit
is refused, and the balance never moved.

### 7.3 Scaling the ledger: partitioning a table that never stops growing

The ledger and transaction tables grow forever - they are the slowest part of most
integrations at scale, and a wallet that degrades as it fills degrades *every* bet. Three
properties must hold at once, and they normally fight each other: **at-most-once** under
retries, **bounded index size + append-mostly writes**, and **cheap retention**. The
timestamp embedded in the UUIDv7 you mint for each operation (§7.2a) is what lets all three
hold.

**Partition by a deterministic, operation-derived timestamp - never by `now()`.** PostgreSQL
requires the partition key to be part of every unique key. So if you RANGE-partition the
ledger by time, your idempotency key becomes `(op_key, op_ts)`, and **`op_ts` must be a pure
function of the operation**, not the wall-clock insert time. Set it from the id: `op_ts =
uuid_extract_timestamp(op_key)`. Then:

- A replay derives the **same** `op_ts`, routes to the **same** partition, and the `(op_key,
  op_ts)` key catches the duplicate - at-most-once holds even when a retry arrives in a
  different calendar month from the original. (Partitioning by `created_at = now()` would break
  this: a retry across a month boundary would not see the original and would double-apply.)
- Lookups carry `op_ts`, so they prune to one partition instead of scanning all of them.
- Writes are append-mostly (UUIDv7 is time-ordered), so index pages don't fragment the way
  random UUIDv4 inserts do.

A **composite** scheme goes one step further: RANGE-partition the ledger by time (e.g. one
partition per ISO week) and, within each period, HASH-partition on `op_key` into N
sub-partitions, with `PRIMARY KEY (op_key, op_ts)` covering both levels. Why both levels: a
point lookup on `op_key` is O(log n) and stays fast even at hundreds of millions of rows per
week - so the time level is *not* about lookup speed. It's about retention (detach whole weeks)
and keeping the *hot* index small (only recent weeks are ever probed for idempotency - the RGS
won't retry ancient ops). The **hash** level is what addresses write scaling: UUIDv7 is
time-ordered, so without it every insert piles onto the right edge of one index (a single hot
leaf page under concurrency); hashing `op_key` splits that into N edges and N smaller,
cache-resident indexes. Lookups still prune to one leaf (`op_ts` → week, `op_key` → bucket), so
none of this costs read performance. Pick the hash modulus with headroom - changing it later
means rebuilding every week.

**Create partitions ahead of time, off the hot path.** Attaching a partition takes an `ACCESS
EXCLUSIVE` lock on the parent - never do it inside the money path, where it would spike latency
at period boundaries under load. Run a maintenance function from a scheduler (pg_cron / app
cron) that pre-creates the next N periods; it's idempotent, so re-running is free. A `DEFAULT`
partition can be a belt-and-suspenders against a missed window, but keep it empty in steady
state (adding a real partition later scans the default under a lock).

**Retention = detach + archive, not DELETE.** A money ledger usually can't drop old data
(compliance). `ALTER TABLE ... DETACH PARTITION` is a near-instant catalog change; archive the
detached period to cold storage. This is the headline operational win of time partitioning over
a giant `DELETE`.

**If you don't want to couple to the id encoding, hash-partition instead.** `PARTITION BY HASH
(op_key)` keeps `UNIQUE (op_key)` valid as-is (op_key *is* the partition key), prunes
idempotency lookups to one partition, and bounds per-partition index size - with zero
dependency on the timestamp. What it gives up: cheap time-based retention and time locality.
Choose date-partitioning when retention/archival matters; hash when you mainly need bounded
indexes at huge scale and can't drop old data anyway. Composite (RANGE of period, HASH
sub-partitions) gives both at the cost of complexity - reach for it only once you've measured
the need.

**The current-balance table is different - hash-partition it, don't range it.** The append-only
*trail* wants time ranges; the *current balance* (one row per player×currency×bucket) is read
and upserted on every bet and has no time dimension. Hash it on `user_id` - every operation
filters by `user_id` so it prunes to one partition, a transfer only ever touches one player (no
cross-partition writes), and each partition's index stays a fraction of the size. Pick the count
with headroom - changing a hash partition count later is a rebuild - and note hashing spreads
*users*, not a single hyper-active player.

**The bet/transaction tables partition differently - by the round, not by time.** Partition by
what you *look up by*: the balance ledger is fetched by `op_key` (time-derivable), but the bet
ledger is always fetched by **round** (open/close/rollback/getBet), so the round is the only key
that prunes the hot path. Range-partition `bet` on the round id and `transaction` on `bet_id`
with identical boundaries, so a round's bet and all its transactions co-locate in one partition
and the join prunes. Because round ids are monotonic, low ranges are the oldest rounds - detach
them to archive. And if the RGS keeps round ids **dense** (it controls allocation), a fixed
id-width range holds a predictable row count, so the width *is* your per-partition capacity and
maintenance is a trivial loop.

Partitioning forces the partition key into every unique key, so `transaction`'s PK becomes `(id,
bet_id)` and its RGS-id uniqueness `(ext_id, bet_id)` - harmless, since both ids are globally
unique anyway. The foreign keys that pointed *at* partitioned tables (`transaction.bet_id → bet`
and the `credit/rollback → debit` self-reference) are dropped: a FK target must carry the
partition key, which would force every referrer to as well, and the stored procedures already
enforce these relationships (open inserts the bet first; rollback resolves the debit by
`ext_id`). A FK *to* a small, un-partitioned table is unaffected.

## 8. Worked replay scenarios

Walk these to convince yourself a design is safe. "RGS retries" means an identical request
arrives again.

**Scenario A - response lost after a successful debit.** You took the stake and committed, but
your `2xx` never reached the RGS. RGS retries the debit. Your unique constraint on `round`
(and/or `debit.id`) fires → you detect the replay → you read back the stored `debit_id` and
current balance → return the *same* `2xx`. **One stake taken.** ✔

**Scenario B - crash between moving money and recording the bet (separate balance, §7.2
ordering).** `balance.apply` committed; you crashed before writing the local bet. RGS retries →
`balance.apply` replays idempotently (returns the same balance, moves nothing) → the local bet
records this time → `2xx`. **One stake taken, ledgers agree.** ✔

**Scenario C - balance call times out (outcome unknown).** You don't know if the stake moved.
You return `ERR_GE` (`5xx`), *not* `2xx`. RGS retries → `balance.apply` is keyed by `debit.id`,
so whether or not the first attempt landed, the retry converges to exactly one application and
returns the real balance. ✔  *(The bug to avoid: returning `2xx` with a guessed balance here.
That stops the RGS and freezes the inconsistency.)*

**Scenario D - duplicate single-shot (debit+credit).** RGS retries a buy-feature debit. Both
`debit.id` and `credit.id` are unique-keyed and were applied together the first time; the replay
detects both and returns the original `debit_id`/`credit_id`/balance. **No double stake, no
double win.** ✔

**Scenario E - rollback replay vs. settled round.** RGS retries a rollback. If the round was
already rolled back → return the existing `rollback_id` (`2xx`). If the round was closed by a
credit → return the genuine error, never a fake success. (See §6.5.) ✔

## 9. Pitfalls checklist

Things that have bitten real integrations. Audit your implementation against each.

- [ ] **Returning `2xx` on an uncertain outcome.** The cardinal sin. Uncertain → retryable
      `5xx`. (§3)
- [ ] **Replay path that short-circuits instead of completing.** A replay that returns a
      looked-up balance + `2xx` without confirming the money actually moved will mask a
      half-done operation forever. (§4, §8-C)
- [ ] **Regenerating your own transaction ids on replay.** Persist once, read back on replay.
      (§4)
- [ ] **Classifying a transient failure as terminal `4xx`.** Lock contention, timeouts, a
      restarting node → `5xx`. Only durable business answers are `4xx`. (§3)
- [ ] **A win funding an unaffordable stake in single-shot.** Apply the stake against the
      current balance first; reject with `ERR_IPB` if it doesn't clear, regardless of the win.
      (§6.4)
- [ ] **Rolling back a settled round and reporting success.** Distinguish "already rolled back"
      (idempotent success) from "already closed by credit" (genuine error). (§6.5)
- [ ] **Faking atomicity across two stores with sequential commits.** Use one transaction if
      same DB; if separate, use idempotency + bet-first ordering (record the bet ledger first;
      move money keyed by the bet's own transaction id) + honest status. (§7)
- [ ] **A straggler debit taking a stake for a cancelled round.** A rollback that names a debit
      you haven't seen must **fence** that debit (a tombstone, not `404`), and a straggler debit
      whose id was fenced must be refused *before* any money moves. With multiple debits this is
      per-debit - the round's other debits are unaffected. (§7.2d)
- [ ] **Treating a new debit id on an open round as a replay.** A round holds 1..N debits: a
      fresh `debit.id` ADDS a stake; only a *replayed* `debit.id` is idempotent. Keying
      idempotency on the round instead of the debit id either drops legitimate extra debits or
      double-charges replays. (§2, §4)
- [ ] **Deleting or reversing a bet whose stake already moved.** Only the `pending`
      (never-funded) bet may be deleted (on insufficient funds - no money moved). Once the stake
      has moved, the bet's id is the idempotency anchor; removing it lets a re-drive
      double-apply. (§7.2b)
- [ ] **Partitioning by `now()` instead of an operation-derived timestamp.** Breaks
      at-most-once: a retry crossing a partition boundary won't see the original and will
      double-apply. Derive the partition key from the id (`uuid_extract_timestamp`). (§7.3)
- [ ] **Money in floating point.** Integer micro-units end-to-end; 64-bit/decimal types. (§2)
- [ ] **Currency mismatch not rejected.** Each money sub-object's currency must equal the
      session currency → `ERR_BAD` otherwise. (§2)
- [ ] **Non-positive or non-integer amounts accepted.** Validate `amount` as a positive integer
      at the boundary; reject as `ERR_BAD` (a `4xx`), not as an internal `5xx`.
- [ ] **Verifying the signature against re-serialized JSON.** Verify against the raw received
      bytes, then parse those same bytes. (§2)
- [ ] **Dev/test endpoints exposed in production.** Any unauthenticated helper that mints
      sessions or sets balances must be *off by default* and gated behind an explicit flag - and
      never reachable in production. Confirm the flag is actually wired, not just read.
- [ ] **Booting with failed migrations.** If schema setup fails at startup, **fail fast and exit
      non-zero.** Do not start serving against a half-migrated schema (don't swallow migration
      errors with "settle all and continue").

## 10. Minimal acceptance criteria

Before going live, prove each of these with an automated test:

1. A debit, replayed N times, takes exactly one stake and returns the same `debit_id` and
   balance every time.
2. A credit, replayed N times, pays exactly one win and returns the same `credit_id`.
3. A single-shot debit+credit, replayed, applies the stake and win exactly once each.
4. A single-shot where the stake alone exceeds the balance is rejected `ERR_IPB`, and the
   balance is **unchanged** (neither stake nor win applied), even when stake+win nets positive.
5. A debit whose stake can't be afforded is rejected `ERR_IPB` and leaves **no** bet behind (the
   `pending` bet is deleted) - a subsequent credit for that round returns `ERR_BNF`.
6. Insufficient funds returns `ERR_IPB` (`4xx`); a simulated downstream timeout returns a
   retryable `5xx`, and the subsequent retry converges to a single correct application.
7. A rollback replays idempotently; a rollback against a credited/settled round does not report
   a phantom reversal.
8. **Out-of-order:** a rollback that names a debit you haven't seen fences it and succeeds
   (refunding nothing); the subsequent straggler debit for that id is refused and the balance
   never moves. (The hardest case - see §7.2d.)
9. **Multiple debits:** two debits with different ids on one round take *both* stakes (a fresh
   `debit.id` is not a replay); reversing one (`active: true`) leaves the others standing and the
   round open; one rollback request reversing *all* of them (`active: false`) refunds each
   exactly once and closes the round, after which a further debit is refused.
10. An unsigned or wrongly-signed request is rejected `ERR_ATE` before any state changes.

If all ten hold, your wallet honors the contract and survives the RGS's retries without
duplicating bets, duplicating transactions, or losing money in a failure window.

### The conformance suite

You don't have to write these tests from scratch: **an automated conformance suite is available
on Engine's integration site**, and it drives a running wallet over HTTP, exercising the
contract — the replay, out-of-order, multi-debit, and signature cases above included. To run it
against your wallet you only need to implement one extra, **dev-only** endpoint the suite uses
to set up each test: a session-mint helper that takes `{ currency, startingBalance }`, funds a
test player with that balance, and returns a fresh session `token` (see the bun example's
`/v1/dev/session`). Keep it off by default and gated behind an explicit flag — it is
unauthenticated and resets balances, so it must never be reachable in production (see the
pitfalls checklist, §9).
