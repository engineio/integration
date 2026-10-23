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

1. **The RGS retries.** Any request can be sent to you more than once - a network blip
   dropped your response, your process restarted mid-request, a load balancer
   double-delivered, or the RGS re-sent after a `5xx` or a timeout. How long it keeps going
   depends on the call. A **credit or rollback** that doesn't get a `2xx` is re-sent by the
   RGS's reconciler, byte-identical, on a widening backoff with no attempt cap - hours or days
   later if need be, each attempt timing out after **2 seconds**. A **debit** gets a few
   re-sends, seconds apart; if its outcome is still unknown after that, the RGS never sends it
   again and sends a `/v1/rollback` for it instead (§3, §7.2d). This is a feature: it means
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
   wasn't, or vice versa. When in doubt, return `ERR_UE` and let the RGS drive it (§3).
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
| `POST /v1/rollback` | **Reverse transactions on an open round**: refund a debit's stake or claw back a credit's win, and optionally close the round. |

> **A round is a container of 1..N debits plus 0..N credits.** Today the RGS sends one debit
> per round and closes it with that debit (`active:false`, an instant loss - §6.3), one credit,
> or one rollback, but the contract - and the conformance suite - allows several debits and
> credits on the same `round` (each with its own `debit.id` / `credit.id`), and they
> accumulate. While the round is **open**, debits, credits and rollbacks land; an
> **`active:false` flag on any of debit / credit / rollback closes the round**, and a closed
> round is final - nothing that moves money lands on it again (replays still return their
> stored result, §6.6). The identity of an individual stake or payout is its own transaction
> id, not the round (see idempotency, §4).

> **Base URL.** The RGS POSTs these paths to **your wallet ingress URL** — configured per
> integration on Engine's integration site (Settings → Ingress URL). They are the only calls it
> makes to your wallet. There is no separate authenticate endpoint: `/v1/balance` does double
> duty.

### Money representation

All amounts are **integer micro-units** of the player's currency: `1_000_000` = `1.00`.
There are no fractional micro-units; amounts are whole integers. Currency is an uppercase
three-letter code from Engine's fixed list (e.g. `USD`, `EUR`, `JPY`). The list is mostly
ISO-4217 but includes non-ISO codes such as `XGC` and `XSC`, so don't validate against an ISO
table.

> **Precision warning.** A language's default floating-point number type (e.g. JavaScript
> `number`) is exact only up to 2^53 micro-units - about 9 billion units of currency, which an
> IDR or VND balance can exceed. The protocol sets no maximum, so use a 64-bit integer /
> BigInt / decimal type end-to-end. Never do money math in floats.

### Identifiers in every request

- **`token`** - the player's session token. You issued this at game launch; it resolves to
  a player and a currency. It's opaque - the RGS hands back exactly what you passed at launch -
  so a token you never issued is `ERR_IS`, whatever it looks like. Session lifetime is the
  RGS's concern, not yours (see "Session lifetime" below).
- **`round`** - the RGS's round id. The round **groups** a bet's transactions; all calls for
  one round (its debits, then a credit or rollbacks) carry the same `round`. A round may hold
  more than one debit, so the round is *not* the identity of a single stake - `debit.id` is.
  Round ids are unique only **per operator**: each operator's rounds count up from 1, so a
  wallet serving several `x-operator` slugs sees the same `round` from each.
- **Transaction ids** - each money movement carries its own RGS-supplied id: `debit.id`,
  `credit.id`, `rollbacks[].id`. These are globally unique and **stable across retries**. They
  are your idempotency keys (§4) - a replayed `debit.id` is the *same* stake, while a new
  `debit.id` on the same round is an *additional* stake.
- **`ref`** - a credit's `ref` links the payout to the stake it settles; a rollback's `ref`
  names the debit or credit it reverses.
- **`currency`** - on `debit` and `credit` (rollback entries carry none); **must equal the
  session's currency**. Reject a mismatch as `ERR_BAD`.

### Identifier guarantees

The RGS guarantees that each transaction id is **globally unique and stable across retries** -
generated once per logical operation and re-sent *verbatim* on every retry. This is the
foundation of idempotency (§4): treat the ids as **opaque strings**, equal if they name the
same operation, and don't parse or derive meaning from their contents. That single guarantee is
all you need.

### Session lifetime

Your wallet never enforces a time-based session expiry. **Session lifetime is the RGS's
responsibility**: the RGS decides how long a session may keep betting. Currently it opens no
new bets more than **24 hours** after launch, but that is RGS policy and **subject to
change** - do not hard-code it into your wallet. Nothing else is age-limited: balance reads,
and the credits and rollbacks that settle a round, can arrive on a session of any age.

Operator-side, that leaves two rules:

- **Never refuse a wallet call because the session looks old.** While a round is active the
  RGS may still send debits, credits, or rollbacks for it - however long ago the session was
  launched. Refusing a late call with `ERR_IS` withholds a player's win or strands a stake
  the RGS already cancelled.
- **Validate credits and rollbacks by session-to-bet alignment.** Look up the round's bet in
  your database and verify the request's token resolves to the same session that opened the
  bet. The bet record is the anchor: a credit or rollback whose session doesn't match the
  bet's recorded session is refused with `ERR_IS`. Token age plays no part in the check;
  session-to-bet alignment always does.

**Cleaning up stale sessions.** A session may be removed (archived or deleted) only once it
has **no active bets** left - every round it opened is closed (settled, rolled back, or
closed by an `active:false`). While any round is open, the RGS can still send calls for it,
and those resolve through the session that opened the bet - remove it early and a late
credit or rollback comes back as a spurious `ERR_IS`, withholding a win or stranding a
cancelled stake. Age alone is never the trigger. In practice, since the RGS currently opens
no new bets after 24 hours, "past the RGS's betting window with no open rounds" is a sound
sweep condition - but the invariant is the absence of active bets, not the clock. Closing a
round doesn't quite end its traffic, though: if the RGS never recorded your `2xx` for the
closing credit or rollback, it re-sends that same request, original token included, at any
age (§1), and the replay must still get its stored result. A debit that closed its own round
can also be followed by a rollback for it, which must get `ERR_BC` (§6.3). So archive rather than
delete, or answer credits and rollbacks for closed rounds from the bet record rather than a live
session row.

### The wire shapes: every field, per endpoint

The full request/response reference (also on Engine's integration site). All amounts are
integer micro-units. **Required** on a nested field means "present whenever its parent is";
on a response it means "present on every `2xx`". The RGS decodes a `2xx` strictly: one it
can't decode (a missing required field, a non-integer amount, an unknown currency) counts as
an uncertain outcome, exactly like `ERR_UE` (§3). Every response carries the same `balance`
object:

| Field              | Type               | Required | Description |
| ------------------ | ------------------ | -------- | ----------- |
| `balance`          | object             | yes      | Wrapper for the post-operation balance. |
| `balance.amount`   | int64              | yes      | Player's balance after this operation, in micro-units. Negative only after a clawback the player couldn't cover (§6.5). |
| `balance.currency` | string             | yes      | Three-letter uppercase code — always the session's target currency. |

#### `POST /v1/balance`

| Field   | Type   | Required | Description |
| ------- | ------ | -------- | ----------- |
| `token` | string | yes      | Opaque session token the operator supplied at game launch. Identifies which player + currency this call is for. |

```json
{ "token": "01927b8e-0000-7000-8000-000000000001" }
```

Response is `{ "balance": { … } }` and nothing else. Errors: `ERR_IS` for a token you didn't
issue, `ERR_ATE` on a bad signature. No mutation, so no `ERR_IPB` / `ERR_BNF` here.

#### `POST /v1/debit`

| Field             | Type              | Required | Description |
| ----------------- | ----------------- | -------- | ----------- |
| `token`           | string            | yes      | Session token. Same value across every wallet call for this player session. |
| `round`           | uint64            | yes      | Round (bet) identifier — a **container**, not the idempotency key. Several debits can share one round; the same value is reused on `/v1/credit` and `/v1/rollback`. |
| `mode`            | string            | yes      | The bet mode the round was staked on, e.g. `BASE`, as the game client sent it — matched to the game's modes ignoring case, so its casing can vary. Treat it as an opaque, case-insensitive label, not an enum. May be empty. Useful for ledgering / RTP analytics. |
| `active`          | bool              | yes      | Whether the round stays open after this debit. `true` keeps it open; `false` closes it now (single-shot, or a loss known at debit time — §6.3/§6.4). |
| `ip`              | string            | yes      | Player's IP (v4 or v6) on the request that placed this bet. Always a valid IP literal, never empty — `0.0.0.0` when the address is unknown. Surface in your ledger for regulatory traceability. |
| `debit`           | object            | yes      | The amount being debited. |
| `debit.id`        | string (uuid)     | yes      | The RGS's transaction id for this debit — your idempotency key. |
| `debit.amount`    | uint64            | yes      | Stake in micro-units. Always > 0 — reject zero/negative with `ERR_BAD`. |
| `debit.currency`  | string            | yes      | Must match the session's currency. |
| `credit`          | object            | no       | Optional settling credit for an instant win/loss in the same call (§6.4). Omitted for normal bets that settle later via `/v1/credit` (the RGS never sends `null`, but tolerate it). |
| `credit.id`       | string (uuid)     | yes      | Transaction id for the concurrent credit — its idempotency key. |
| `credit.amount`   | uint64            | yes      | Win in micro-units. Zero is valid (a losing single-shot). |
| `credit.ref`      | string (uuid)     | yes      | References the `debit.id` being settled. |
| `credit.currency` | string            | yes      | Must equal `debit.currency`. |

```json
{
  "token": "01927b8e-0000-7000-8000-000000000001",
  "round": 4119983943,
  "mode": "BASE",
  "active": true,
  "ip": "203.0.113.5",
  "debit": { "id": "fd76b683-…", "amount": 100, "currency": "EUR" }
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
| `token`           | string            | yes      | Session token. Must be the session that opened the bet (verify against the stored bet record). |
| `round`           | uint64            | yes      | The round being credited. Must have at least one debit — otherwise `ERR_BNF` (credits never open or fence a round). |
| `active`          | bool              | yes      | `false` closes the round (the common settling case); `true` keeps it open for further credits/debits (staged payouts). |
| `ip`              | string            | yes      | Player's IP on the request that ended the round. Always a valid IP literal, never empty — `0.0.0.0` when unknown (e.g. a staff force-settle). A re-sent credit carries the first attempt's IP. |
| `credit`          | object            | no       | The win to pay. **Omitted + `active:false` closes a losing/zero round** paying nothing (§6.2); tolerate an explicit `null`. |
| `credit.id`       | string (uuid)     | yes      | Transaction id — the idempotency key for this credit. |
| `credit.amount`   | uint64            | yes      | Win in micro-units. Zero is valid. |
| `credit.ref`      | string (uuid)     | yes      | The `debit.id` this credit settles. Multiple credits may reference the same debit. |
| `credit.currency` | string            | yes      | Must match the bet's currency (recorded at debit time) — mismatch → `ERR_BAD`. |

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

Errors: `ERR_BNF` when the round was never debited (fenced or not). `ERR_BAD` on a currency
mismatch, or on a `credit.id` a prior rollback fenced (§7.2d). `ERR_BC` when a **new** credit
lands on a closed round (a replay of an existing `credit.id` returns its
stored result instead). `ERR_IS` on an unknown token, or on a token that doesn't match the
session recorded on the round's bet (§2, "Session lifetime").

#### `POST /v1/rollback`

| Field             | Type          | Required | Description |
| ----------------- | ------------- | -------- | ----------- |
| `token`           | string        | yes      | Session token. Must be the session that opened the bet (verify against the stored bet record). |
| `round`           | uint64        | yes      | The round whose transactions are being reversed. |
| `active`          | bool          | yes      | Always sent. `false` closes the round after the reversals; `true` keeps it open. |
| `rollbacks`       | array         | yes      | One entry per transaction to reverse. Returned in `rollback_ids` in this same order. |
| `rollbacks[].id`  | string (uuid) | yes      | Transaction id for **this rollback**. Note: idempotency is keyed on the `ref`, not this id — two different rollback ids for the same `ref` still reverse it once. |
| `rollbacks[].ref` | string (uuid) | yes      | The `debit.id` or `credit.id` being reversed. If no such transaction has arrived yet, it is **fenced** (tombstoned), not rejected (§7.2d). |

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

Errors: `ERR_BC` when the round is already closed (§6.6). A `ref` to a transaction that never
arrived, or to a debit still `pending`, is **not** an error (§7.2d), and neither is a clawback
the player can't cover - never answer one `ERR_IPB` (§6.5). `ERR_IS` when the token doesn't
match the session recorded on the round's bet (§2, "Session lifetime").

### Error response contract

Every error response uses the envelope `{ "code": "<ERR_CODE>", "message": "<human readable>" }`
with the HTTP status below. The RGS acts on the `code` - it picks the player-facing error from
it - and the `message` is only for your logs. Standard codes:

| Code      | HTTP  | Meaning |
| --------- | ----- | ------- |
| `ERR_ATE` | `401` | Failed request authentication — the `x-signature` header is missing or doesn't verify against the RGS public key (or, on a multi-operator wallet, `x-operator` names a slug you don't serve). |
| `ERR_IS`  | `400` | Invalid / unknown session token — or, on a credit/rollback, a token that doesn't match the session recorded on the round's bet (§2). |
| `ERR_IPB` | `400` | Insufficient player balance — the **debit alone** can't be covered (a win must not fund its own stake, §6.4). |
| `ERR_GLE` | `400` | Player's gambling / loss limit exceeded — distinct from `ERR_IPB`, which is about the balance. The RGS cancels the bet and forwards it to the player. **Debit only**; use it for your own responsible-gambling rejections. |
| `ERR_BAD` | `400` | Malformed request — zero/negative amount, currency mismatch, schema violation, or a debit or credit fenced by a prior rollback (§7.2d). NOT closed-round (that's `ERR_BC`). |
| `ERR_BNF` | `404` | Bet (round) not found — a **credit** for a round that was never debited. Credit-only: a rollback naming an unknown round or transaction fences it instead (tombstone, `200` — §6.5, §7.2d). (A token that doesn't match a *known* round's session is `ERR_IS`, not `ERR_BNF`.) |
| `ERR_BC`  | `400` | Bet already complete — a new debit, credit or reversal after the round closed (§6.6). A replay of an existing transaction id returns its stored result instead of this error. On a rollback the RGS takes it to mean the bet is complete: it stops re-sending and records the bet as settled. |
| `ERR_GE`  | `500` | Failed definitively, **no money moved**. On a debit the RGS treats it like any other definite rejection: it cancels the bet and sends **no compensating rollback**. Only when you can prove nothing moved. |
| `ERR_UE`  | `500` | **Outcome uncertain — money may have moved.** On a debit the RGS reverses it with a `/v1/rollback`. Anything that isn't a readable answer is treated the same: a non-`2xx` without an envelope or with an unknown `code`, a timeout or dropped connection, a `2xx` it can't decode. **When in doubt, this one.** |

What the RGS does after an error depends on the call as well as the code - see §3, the most
important part of this contract.

### Authentication

Every wallet request is signed. Verify the signature **before parsing the body**, and reject
any failure with `401` `ERR_ATE`:

| Header        | Required | Description |
| ------------- | -------- | ----------- |
| `x-operator`  | yes      | Your operator slug, on every wallet call. A wallet serving several operators routes on it and rejects a slug it doesn't serve with `401` `ERR_ATE`; a single-operator wallet can ignore it. |
| `x-signature` | yes      | Base64 **Ed25519** signature over the **raw request body bytes** (RFC 8032, no pre-hash), signed with the RGS's private key. Standard base64 **with padding** (not URL-safe) — a 64-byte signature, 88 base64 characters. Verify against the RGS Ed25519 public key (PEM, `BEGIN PUBLIC KEY`) from the integration site (API Reference → Engine public key). |
| `Content-Type`| yes      | `application/json; charset=utf-8` in production; the conformance suite sends a bare `application/json` — accept both. |

(`x-operator` is not authentication, and the signature doesn't cover it: one Engine key signs
every operator's calls, so the signature proves the caller is the RGS, not which operator the
call is for. Cross-check it against the operator the signed `token` resolves to. Your calls to
Engine carry `X-Operator` + `X-Signature` the same way, below.)

- Verify against the **exact bytes** you received, then parse *those same bytes* as JSON. Do
  not re-serialize the parsed object and verify against that - key ordering and whitespace
  will differ and the signature will fail.
- Signatures prove origin, **not freshness**. A captured request can be replayed at the
  network layer. That is fine *only because* your idempotency keys (§4) make replays
  harmless. Do not rely on the signature for replay protection.

### The other direction: calls you make to Engine

The wallet endpoints above are Engine calling **you**. There is also a `/v1` API **you
call**, at base URL `https://operator.engine.io` — keep it in configuration rather than as a
constant. The auth direction reverses: sign each request body with **your** Ed25519 private
key (same scheme — base64 Ed25519 over the raw body) and send `X-Operator` + `X-Signature` on
every call, plus `Content-Type: application/json` on POSTs; Engine verifies with the public key
you uploaded on the integration site. For GETs, sign the empty body (zero bytes). Generate the
keypair with `openssl genpkey -algorithm ed25519` and upload the public key as PEM
(`openssl pkey -pubout`, a `BEGIN PUBLIC KEY` block). Up to 10 keys can be registered at once
and any of them verifies, so rotation is add-new → deploy → delete-old; Engine caches an
integration's key set for up to 15 minutes, so register a key before pointing traffic at it.
Integrations created before the key migration may still sign with legacy RSA keys — the
ingress verifies both — but register Ed25519 keys.

Errors on this direction carry **no JSON envelope** — route on the status code alone: `401`
signature or slug problem, `400` broken JSON, a bad query parameter or an empty required
string, `404` unknown or unapproved game / unknown product, `415` a POST without
`Content-Type: application/json`, `422` a body that parses but breaks the schema (missing
field, unknown currency, value outside an enum), `424` demo play disabled platform-wide (demo
route only), `5xx` retry.

Games are addressed by **product + publisher + game slugs**, not a single id: a *product* is a
wire contract on Engine (from `GET /v1/product`), a *publisher* is the studio behind the game,
and the two ride with the game slug on every launch call.

#### `GET /v1/product` — the products available to you

No request body (still sign the empty body). Response is a top-level array; use the `product`
id in the product-scoped fields and routes below:

```json
[ { "product": "studio", "name": "Studio" } ]
```

#### `POST /v1/game/url` — start a real-money session

Call when a logged-in player clicks Play. The `token` you supply here is what comes back to
your wallet as the `token` field on every subsequent `/v1/*` wallet call — this is where
sessions are born. Store it server-side keyed to the player.

| Field       | Type              | Required | Description |
| ----------- | ----------------- | -------- | ----------- |
| `product`   | string            | yes      | From `GET /v1/product`. `404` if unknown or not enabled for you. |
| `publisher` | string            | yes      | Publisher slug, from the game list. |
| `game`      | string            | yes      | Game slug, from the game list — addressed *with* its publisher. |
| `user`      | string            | yes      | Your operator-side user id. Treated as opaque; never shown to the player. |
| `token`     | string            | yes      | Your one-time session token. Opaque to Engine, but the call is **not idempotent**: every call mints a new session, so mint a fresh token per launch and don't re-POST after a timeout expecting the same session back. |
| `currency`  | string            | yes      | Uppercase code from Engine's currency list (§2); there is no per-operator list. |
| `language`  | string (BCP-47)   | no       | Game UI language, e.g. `en`, `pt-br`. Defaults `en`. |
| `device`    | string            | no       | `desktop` (default), `mobile`, or `tablet`. |
| `tag`       | string (enum)     | no       | Player classification: `real` (default), `affiliate`, `streamer`, `employee`, `qa`. Use `real` for paying customers; the rest are excluded from production accounting. |

Response: `{ "url": …, "fair": … }` — a launch `url` (string) to redirect the player to, and
`fair` (bool), whether this session's rounds are provably fair (`true` only when the game
supports it *and* fair draws are enabled on your operator). The URL is **opaque**: its host
belongs to the game's front end, not a fixed Engine domain — redirect or iframe it verbatim,
never rebuild, allowlist or parse it, and don't log it (it carries the player's Engine
session). `404` covers both an unknown (publisher, game) pair and a game with no approved,
active version for your operator — Engine does not distinguish them.

#### `POST /v1/game/url/demo` — start a demo session

Same addressing, pinned to demo balances (try-before-signup, QA). Demo sessions never touch
your wallet — they settle against Engine's internal demo wallet, so no `/v1`
debit/credit/rollback traffic reaches your ingress for demo play.

| Field       | Type              | Required | Description |
| ----------- | ----------------- | -------- | ----------- |
| `product`   | string            | yes      | As above. |
| `publisher` | string            | yes      | As above. |
| `game`      | string            | yes      | As above. |
| `currency`  | string            | no       | Demo-balance currency. Defaults `USD` (`XGC` on sweepstake deployments — a deployment-wide property that does not follow your jurisdiction, so send it explicitly if you care which you get). |
| `token`     | string (uuid)     | no       | Session token — must be a UUID here (unlike `/v1/game/url`, where it's opaque); omit it and Engine mints one. It also stands in for the user id, which is why there is no `user` field. |
| `device`    | string            | no       | `desktop` (default), `mobile`, `tablet`. |
| `language`  | string (BCP-47)   | no       | Defaults `en`. |
| `balance`   | uint64            | no       | Starting demo balance in micro-units; omit for the default. |

Response: `{ "url": … }` only — no `fair`.

#### `GET /v1/{product}/game` — enabled games

The games approved for your operator, per product — e.g. `GET /v1/studio/game`. No request
body (sign the empty body). Cache it and sync incrementally: pass `?after=<unix ms>` echoing
the top-level `updated` you last saw (the boundary instant is re-delivered, so dedup by
publisher + game). `?after=` never delivers a removal, and a game newly enabled for you keeps
its original update time, so also re-fetch the full list (no `after`) periodically and
reconcile. Response is an **object envelope**:

| Field               | Type            | Required | Description |
| ------------------- | --------------- | -------- | ----------- |
| `updated`           | int64 (unix ms) | yes      | Newest update across the whole catalog, computed before `?after=` filtering — feed back as `?after=` on the next sync. |
| `games[].product`   | string          | yes      | The product this game runs on. |
| `games[].publisher` | string          | yes      | Publisher (studio) slug — pair with `game` on `POST /v1/game/url`. |
| `games[].game`      | string          | yes      | Game slug. |
| `games[].name`      | string          | yes      | Display name for your lobby. |
| `games[].image`     | string (URL)    | no       | Cover art. Key **absent** (not null) when none published. |
| `games[].updated`   | int64 (unix ms) | yes      | When this game last changed — the clock `?after=` filters on. |
| `games[].rtp`       | float64         | yes      | Target return-to-player as a fraction — ×100 for the percentage. Passed through from the game's math with no ceiling. |

The full reference for this direction — including `GET /v1/bet/{id}` (bet lookup) and the
provably-fair `/v1/fair/*` endpoints — lives on the integration site's API page.

## 3. Status codes are your safety mechanism

The RGS acts on your answer - a `2xx`, or else the `code` in your error envelope - so
classifying responses correctly is not cosmetic: it is the core of correctness. The HTTP status
matters for one thing only: a `5xx`, `408` or `429` (like a timeout or a dropped connection) is
re-sent up to 3 more times, seconds apart, before the RGS acts on it. There are exactly three
buckets:

1. **Definitely done → `2xx`.** The money movement is durably committed, *or* this is a
   replay of an operation you can prove already completed. Return the result.

2. **Definitely not done, and never will be → `4xx` (or `ERR_GE`).** A business answer that
   will not change on retry: insufficient funds (`ERR_IPB`), invalid session (`ERR_IS`), bad
   request (`ERR_BAD`), bet not found (`ERR_BNF`). Safe to return because **no money moved**. What
   happens next depends on the call:
   - **Debit** - final. The RGS cancels the bet and never sends that debit again.
   - **Credit or rollback** - nothing is final: it is re-sent until it gets a `2xx` (§1). A
     refusal here must be deterministic and genuinely right; a wrong one parks a win or a
     refund until you change your answer. Two exceptions, both on a rollback: `ERR_BC` ends
     it - the RGS records the bet as complete (§6.6) - and `ERR_BNF` is dropped after its
     second re-send, so never `404` a rollback; fence it (§7.2d).

3. **Unknown → `ERR_UE` (`5xx`).** You could not determine the outcome: a downstream
   balance call timed out, a connection dropped, you crashed mid-flight, a lock could not be
   acquired in time. Return `ERR_UE` - it says "the outcome is uncertain". On a debit the RGS
   then reverses it with a compensating `/v1/rollback`; a credit or rollback is re-sent until
   it lands. Never `ERR_GE` here: `ERR_GE` asserts *nothing moved, definitively*, so the RGS
   cancels the bet and sends no rollback - on an uncertain outcome that strands the stake.

**The trap that loses money: misclassifying bucket 3 as bucket 2.** If a *transient* failure
(lock contention, timeout, a node restarting) on a debit gets any code but `ERR_UE`, the RGS
takes it as final and cancels the bet with no rollback - stranding the stake if it moved. So:

- A "row is locked by another transaction" / "couldn't get the lock in time" condition is
  **transient → `ERR_UE`**, never a definite code.
- A timeout talking to your own balance store is **transient → `ERR_UE`**.
- Only return a definite code when you have a *definite, durable* answer.

Equally: **never return `2xx` when the outcome is uncertain.** If you have committed a bet
locally but are unsure whether the balance moved, that is bucket 3, not bucket 1.

## 4. Idempotency: no duplicate bets, no duplicate transactions

The RGS will replay calls. Your wallet must produce the **same effect and the same response**
whether a call arrives once or five times. Enforce this in the database with constraints, not
in application logic - constraints cannot be forgotten under a race.

### What to key on

- **The bet (round).** Round ids are unique per operator (§2), so key the bet on
  (`x-operator`, `round`) - or `round` alone if you serve one operator. Make it the actual
  `PRIMARY KEY` of your bet/round table so the round is created exactly once even under racing
  first debits
  (insert with `ON CONFLICT DO NOTHING`, or catch the unique violation and use the existing
  row). The round is a **container**, not an idempotency key: a debit with a *new* `debit.id`
  on an existing open round ADDS a stake (§2, §6.6) - only the transaction id decides replay
  vs. new.
- **Each transaction.** Each money movement's RGS id (`debit.id`, `credit.id`, `rollbacks[].id`)
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

- `available` - spendable balance. Guard every debit of it against going negative; that guard
  *is* your insufficient-funds check. The one exception is clawing back a reversed win
  (§6.5), which must land even if it takes `available` below zero.
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
  it. A **losing/zero close** is a credit with **no payout** (no `credit` object) and
  `active:false` - it closes the round moving no money.
- A credit for a round that does not exist → `ERR_BNF`. A credit whose `token` does not match
  the bet's session → `ERR_IS`. A **new** credit on an already-closed round → `ERR_BC` (only a
  *replay* of an existing credit id returns its stored result).

### 6.2 Losing close: a credit that closes the round with no payout

Not every round resolves at placement. A round is opened by an ordinary debit (§6.1), the game
plays out, and the player *loses* - so the closing call pays nothing. The RGS expresses this as a
**`/credit` with `active:false` and no `credit` field**: it settles the round as a loss, moving
no money.

```
RGS                              Wallet
 │  POST /debit (round R)          │
 │ ──────────────────────────────► │  open bet R, take the stake
 │ ◄────────────────────────────── │  { debit_id, balance }
 │                                 │
 │  ... game plays out, player loses ...
 │                                 │
 │  POST /credit (round R,         │
 │   no credit, active:false)      │  close bet R, pay nothing
 │ ──────────────────────────────► │
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
 │ ──────────────────────────────► │    • open bet R and close it as a loss
 │                                 │    • take stake (available → escrow)
 │ ◄────────────────────────────── │  { debit_id, balance }
```

Like the standard debit it takes the stake and can be rejected with `ERR_IPB`; the only
difference is the round never reopens. That includes rollbacks: if the RGS couldn't confirm
this debit - a timeout, `ERR_UE`, a `2xx` it can't decode, or its own failure after your
`2xx` - it sends `/v1/rollback` for it. If your debit committed and closed the round, answer
`ERR_BC`; the RGS takes that to mean the debit landed and records the bet as a completed loss.
If it is still `pending` (you never confirmed it), the round never closed: the rollback settles
and reverses it (§7.2d). The winning instant-resolution case - stake *and* win in one call - is
single-shot (§6.4).

### 6.4 Single-shot: debit that also pays a win

A **`/debit` carrying a concurrent `credit`** takes the stake *and* pays the win in one atomic
operation - for rounds that resolve the moment they're placed. Today's RGS doesn't send one (it
pays a win with a separate `/credit`), but the contract allows it and the conformance suite
sends it, so support it.

A single-shot normally carries `active:false` - the debit opens the round and closes it at
once, with no later credit to close it. Don't reject one with `active:true`, though: apply it
and leave the round open.

```
RGS                                          Wallet
 │  POST /debit (round R, debit + credit)      │
 │ ──────────────────────────────────────────► │  in ONE atomic unit (active:false):
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
money-moving step of the debit flow (§7.2), between recording the bet and confirming it. The same
unit holds in reverse: a rollback of the debit reverses the win it carried too (§6.5).

### 6.5 Rollback: reverse debits or credits on an open round

A rollback reverses **specific transactions** of an open round - debits, credits, or both - so
the request carries a **list**, each entry naming one transaction by `ref`:

```jsonc
{
  "round": R,
  "active": false,              // false closes the round after reversing; true keeps it open
  "rollbacks": [
    { "id": "<rollback-id>", "ref": "<debit-id>" },   // refund this stake
    { "id": "<rollback-id>", "ref": "<credit-id>" },  // claw back this win
    ...                                               // …all of them atomically
  ]
}
```

Reversing a **debit** refunds its stake (escrow → available) - and if it was a single-shot
(§6.4), claws back the win it carried as well, since the two were one call; that extra reversal
isn't one of the `rollback_ids`. Reversing a **credit** claws its win back (available → payout
account), and that clawback must land even if the player has spent the win: it can take
`available` below zero. What to do about a negative balance -
block play until it's topped up, recover it from the next deposit, write it off - is the
operator's business decision; the contract only requires that you never refuse the clawback
(no `ERR_IPB` on a rollback). Each reversal records a rollback transaction (keyed by its `id`,
referencing the reversed transaction via `ref`); the response returns the minted ids in order:
`{ "rollback_ids": [...], "balance": {...} }`. **`active` is the same flag debit/credit
carry** - it decides whether the *round* closes afterwards. Reverse one transaction with
`active: true` to keep the round live; list everything with `active: false` to abandon the
round in one atomic request.

```
RGS                          Wallet
 │  POST /rollback (round R)   │
 │ ──────────────────────────► │  refund each named debit, claw back each named credit; close if !active
 │ ◄───────────────────────────│  { rollback_ids, balance }
```

**Watch out for this subtle bug:** "the bet is not in an open/reversible state" can mean
several *different* things, and they must not be conflated:

- The transaction was **already rolled back** → this is a **replay** → return the *existing*
  rollback id (`2xx`). Idempotent on the ref - also guards a stray double-rollback.
- The round is **closed** - by a credit, a rollback, or the debit's own `active:false` (§6.3)
  → a closed round is final: return `ERR_BC`. Do **not** silently return success with a
  fabricated rollback id and no reversal.
- There is **no such transaction** - the rollback arrived *before* it → **fence** that id
  (record a tombstone) rather than returning `404`, so the straggler debit or credit is
  refused and can't move money the RGS already cancelled. This is the out-of-order case; see
  §7.2(d).

Rollback is idempotent on each ref: replaying it returns the same rollback id(s) without
reversing twice.

### 6.6 Putting it together: multi-debit / multi-credit / rollback rounds

The four calls above compose. A round is a **container of 1..N debits, 0..N credits, and any
rollbacks**, in any interleaving the contract allows. Rather than enumerate every ordering,
internalize the handful of rules that make *any* sequence well-defined - then the permutations
below all fall out of them:

1. **The round has one lifecycle: `pending → open → closed`.** The first debit opens it; it is
   `pending` until that debit's stake confirms, then `open`. **An `active:false` on *any* call -
   debit, credit, or rollback - closes it.**
2. **The idempotency unit is the transaction id, never the round.** A *new* `debit.id` /
   `credit.id` adds a stake / win; a *replayed* id returns the stored result and moves no money.
   A rollback is idempotent on the **ref** it reverses.
3. **While `open`, debits and credits accumulate;** each is its own transaction. Order doesn't
   matter - two debits then two credits, or interleaved, reach the same state.
4. **After `closed`, only replays succeed.** A closed round is final, whatever closed it: a
   *new* debit, credit, or reversal on it is refused with `ERR_BC`, and the RGS takes `ERR_BC`
   on a rollback to mean the bet is complete. A replay of any transaction already on the round
   still returns its stored result, and a rollback naming a transaction you never saw is still
   a `200` tombstone - it moves nothing.
5. **A transaction and a rollback naming it are mutually exclusive** - whichever the ledger
   records first wins. A rollback naming a debit or credit it hasn't seen **fences** it
   (§7.2d): the straggler is later refused with `ERR_BAD`.

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
⇒ after close: a new c4 → ERR_BC; replaying c1/c2/c3 → their stored ids. A credit call with
  no credit and active:false would instead close the round paying nothing (a losing/zero
  settlement).
```

**(E) A staged credit reversed, then the round closed.** A win paid in error is clawed back
while the round is still open.

```
POST /debit    (R, d1, active:true)                       → open R, take the stake
POST /credit   (R, c1, ref:d1, active:true)               → pay win 1; round stays open
POST /rollback (R, active:true, rollbacks:[{rb1, ref:c1}]) → claw win 1 back (may go negative)
POST /credit   (R, c2, ref:d1, active:false)              → pay the corrected win, close R
⇒ after close, reversing c2 or d1 → ERR_BC; replaying rb1 → rb1, nothing clawed twice
```

The full outcome matrix, for auditing any other ordering:

| Incoming call                         | Round not yet seen        | `open`                                   | `closed`                       |
| ------------------------------------- | ------------------------- | ---------------------------------------- | ------------------------------ |
| **debit**, new id                     | opens the round           | adds a stake                             | refused `ERR_BC`               |
| **debit**, replayed id                | -                         | stored ids, no money                     | stored ids, no money           |
| **debit** whose id a rollback fenced  | refused `ERR_BAD`         | refused `ERR_BAD`                        | refused `ERR_BAD`              |
| **credit**, new id                    | `ERR_BNF` (§7.2d)         | pays the win; closes if `active:false`   | refused `ERR_BC`               |
| **credit**, replayed id               | -                         | stored id, no money                      | stored id, no money            |
| **credit** whose id a rollback fenced | `ERR_BNF` (no stake)      | refused `ERR_BAD`                        | refused `ERR_BAD`              |
| **rollback** of a funded debit        | *(debit unseen ⇒ fence)*  | refunds the stake; closes if `!active`  | refused `ERR_BC`               |
| **rollback** of a credit              | -                         | claws back the win (may go negative); closes if `!active` | refused `ERR_BC`  |
| **rollback**, already reversed        | -                         | existing rollback id (idempotent)        | existing rollback id           |
| **rollback** of an unseen ref         | tombstone; move nothing   | tombstone (fence); move nothing          | tombstone; move nothing†       |
| **rollback** of a mid-flight debit    | -                         | resolves the debit, then reverses or fences it (§7.2d) | -                              |

† Fencing an unseen ref is idempotent and harmless even after the round has closed - if that
straggler ever lands it is refused regardless (closed round *and* fenced). `ERR_BC` applies
to reversing a transaction that **did** land.

A credit that meets a `pending` debit - the round's first, or any of its debits when the
credit would close the round - gets `ERR_UE` (rare: the RGS credits only after its debits'
`2xx`). Closing a round under a mid-flight debit would leave that debit's rollback unable to
refund it. A rollback that meets one resolves it (§7.2d).
Insufficient funds on any debit is always `ERR_IPB` (terminal), and leaves no trace of that
debit (§7.2b).

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
between the two writes always heals - on the RGS's retry, or for a debit whose re-sends ran
out, on the rollback that follows it (d) - so ordering is *not* about crash-safety.
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
          • timeout / unknown  → ERR_UE (5xx, retryable; DO NOT return 2xx)
    4. confirm the debit; on the first confirm R goes pending → open (or closed for active=false)
    5. return { debit_id, [credit_id], balance }
  ```
  This records the debit before knowing the stake is affordable - but insufficient funds is the
  one deterministic rejection, and it means **no money moved**, so deleting the `pending` debit
  is a true rollback (not a compensation): no junk row, no poison-loop. (If it was the round's
  only debit, delete the empty bet too.) Guard the delete on the debit still being `pending` -
  you must **never** delete a debit whose stake already moved. That is the
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
  and a debit whose stake moved must never be deleted or re-marked - only a rollback may
  refund it.

- **Credit → record the credit, pay the win, and close the round if `active:false`**
  (idempotent on the credit's transaction id; a round holds 0..N credits). Each credit records
  its `ref` and pays on the round being `open` (only the round is checked: one with no debit is
  `ERR_BNF`); a **new** credit on an already-closed round is refused (a *replay* of an existing
  credit id returns its stored result).

- **Rollback → reverse each named transaction, then move the money, and close if `!active`**
  (idempotent on each ref) - or, if a named transaction doesn't exist, **fence** it, and if a
  named debit is still `pending`, resolve it first (see (d)). Read each amount from the bet
  ledger (rollback entries carry none): a debit's stake is refunded, a credit's win clawed
  back, even into a negative balance (§6.5).

Why bet-first and not "lead with whichever ledger owns the gate" (which would put the debit
balance-first, since its gate is funds): moving money first means the round doesn't exist when a
too-early rollback arrives, so you can't fence it without an unavoidable cross-store race.
Recording the debit first makes the fence a plain lookup (does a rollback already reference this
debit id?), makes the debit's id the balance key (no key-translation table), and turns the
"money moved but bet not recorded" window into an explicit `pending` state you can reason about
(d). The price is the `pending`/`confirm` lifecycle and the delete-on-reject above.

**(c) You do NOT need your own reconciler.** The RGS already drives every operation to
completion (§1). A background sweep on your side would just race those calls redundantly. The combination *idempotent operations + honest status
codes + the RGS's retries* is the reconciliation loop. Your only job is to never return `2xx`
while an outcome is unconfirmed, so the RGS keeps driving.

Bet-first does carry a minimal **`pending → open`** lifecycle - a debit is recorded before its
stake is confirmed - but that is a single status column, not a saga: `balance.apply` is still
idempotent and re-driven on every call (including replays). The `pending` state exists to fence
a debit (d) and to let an unaffordable one be cleanly deleted, not to track "did I finish".

**(d) A rollback can arrive before its debit - fence that debit.** Requests are independent HTTP
calls; under retries and in-flight buffering they can be reordered, and at volume a debit can
even arrive *after* the RGS gave up on it and sent a rollback. So a rollback may name a debit you
have **never seen**. Don't `404` it and hope the debit shows up - if it never does, you've
correctly done nothing; but if a *straggler* debit then lands, it would take a stake the RGS
already cancelled, stranding the player's money. Instead:

- **Rollback naming an unknown debit → record a tombstone for that debit id** (idempotent;
  refund nothing - no stake was ever taken) and acknowledge it, so the RGS stops re-driving.
  With multiple debits this is **per-debit**, not a whole-round void: the other debits on the
  round are untouched.
- **A debit whose id was tombstoned is refused** (the record step in (b) checks for a rollback
  referencing this debit id first, before any money moves). The straggler takes no stake.
- **Credits are fenced the same way.** A rollback can also name a credit you haven't seen; the
  tombstone then refuses the straggler credit with `ERR_BAD`, so it can't pay a win the RGS
  already cancelled.

Because the debit is bet-first, this fence is exact and race-free in the common case: the
tombstone and the debit contend on the round, and recording checks for the fence *before*
moving money. The one residual window - a rollback naming a debit that is **mid-flight**
(`pending`, stake not yet confirmed) - is an explicit state, not an invisible race, and the
rollback must resolve it: the RGS sends a rollback only once it has stopped sending that debit,
so nothing else ever will. Under the debit's row lock (its own request may still be running),
re-drive its idempotent `balance.apply` on the same key - that either reports the stake that
already moved or takes it now - confirm it without applying its own `active:false` (the round
must stay open for the reversal), then reverse it. If the stake can't be afforded,
nothing moved: delete the `pending` debit and tombstone it, as for an unseen one. Only an
*uncertain* `balance.apply` here is `ERR_UE`; answering a `pending` debit with a bare retryable
error just makes the RGS re-send the rollback forever. A credit for a round with no debit is a
different case: the RGS credits a round only after its debit returned `2xx`, so a credit can't
overtake its debit; `ERR_BNF` on a credit means you lost a debit you acknowledged, and the RGS
keeps re-sending that credit until you return `2xx`.

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
and keeping the *hot* index small (new operations only ever probe recent weeks). The **hash**
level is what addresses write scaling: UUIDv7 is time-ordered, so without it every insert piles onto the right edge of one index (a single hot
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
a giant `DELETE`. One caveat: a failed credit or rollback is re-sent with no time limit (§1), so
a re-send can still need an archived period's idempotency keys - keep detached periods
queryable on a miss, not only in cold storage.

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
and the join prunes. Within one operator, round ids are monotonic and near-dense (a failed open
can skip one), so low ranges are the oldest rounds - detach them to archive - and a fixed
id-width range holds a predictable row count, so the width *is* your per-partition capacity and
maintenance is a trivial loop. Serving several operators, partition by operator first. The
conformance suite sends random rounds anywhere up to 2^32, and a row parked in a `DEFAULT`
partition blocks creating the range that covers it - so on a database the suite runs against,
pre-create ranges over that whole span (or don't range-partition there).

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
your `2xx` never reached the RGS. RGS retries the debit. Your unique constraint on `debit.id`
fires → you detect the replay → you read back the stored `debit_id` and
current balance → return the *same* `2xx`. **One stake taken.** ✔

**Scenario B - crash between moving money and confirming the debit (separate balance, §7.2
ordering).** The debit is recorded `pending` and `balance.apply` committed; you crashed before
`confirm`. If the RGS's re-send reaches you, `balance.apply` replays idempotently (returns the
same balance, moves nothing), the debit confirms → `2xx`. If you're still down when its
re-sends run out, the `/v1/rollback` that follows re-drives the same `balance.apply`, confirms
the debit and reverses it (§7.2d). **One stake taken (or taken and refunded), ledgers
agree.** ✔

**Scenario C - balance call times out (outcome unknown).** You don't know if the stake moved.
You return `ERR_UE` (`5xx`), *not* `2xx`. RGS retries → `balance.apply` is keyed by the debit's
id, so whether or not the first attempt landed, the retry converges to exactly one application
and returns the real balance - or, if the store is still down when the re-sends run out, the
rollback that follows settles it (§7.2d). ✔  *(The bug to avoid: returning `2xx` with a
guessed balance here. That stops the RGS and freezes the inconsistency.)*

**Scenario D - duplicate single-shot (debit+credit).** A single-shot debit is replayed. Both
`debit.id` and `credit.id` are unique-keyed and were applied together the first time; the replay
detects both and returns the original `debit_id`/`credit_id`/balance. **No double stake, no
double win.** ✔

**Scenario E - rollback replay vs. settled round.** RGS retries a rollback. If the round was
already rolled back → return the existing `rollback_id` (`2xx`). If the round has closed since
→ return `ERR_BC`, never a fake success. (See §6.5.) ✔

## 9. Pitfalls checklist

Things that have bitten real integrations. Audit your implementation against each.

- [ ] **Returning `2xx` on an uncertain outcome.** The cardinal sin. Uncertain → `ERR_UE`.
      (§3)
- [ ] **Replay path that short-circuits instead of completing.** A replay that returns a
      looked-up balance + `2xx` without confirming the money actually moved will mask a
      half-done operation forever. (§4, §8-C)
- [ ] **Regenerating your own transaction ids on replay.** Persist once, read back on replay.
      (§4)
- [ ] **Answering a transient failure with a definite code.** Lock contention, timeouts, a
      restarting node → `ERR_UE`. Only durable business answers get any other code; on a
      debit, anything else cancels the bet with no rollback. (§3)
- [ ] **A win funding an unaffordable stake in single-shot.** Apply the stake against the
      current balance first; reject with `ERR_IPB` if it doesn't clear, regardless of the win.
      (§6.4)
- [ ] **Reversing anything on a closed round.** Distinguish "already rolled back" (idempotent
      success) from "the round has closed" (`ERR_BC`, never a fake success) - whatever closed
      it, including the debit's own `active:false`. (§6.5)
- [ ] **Refusing a clawback the player can't cover.** Reversing a credit must land even if it
      takes the balance negative; never answer it `ERR_IPB`. What to do about the negative
      balance is your business decision. (§6.5)
- [ ] **Answering a rollback of a `pending` debit with a retryable error.** The RGS never
      re-sends that debit, so the rollback must resolve it; a bare `5xx` loops forever. (§7.2d)
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
- [ ] **Deleting a bet whose stake already moved.** Only the `pending`
      (never-funded) bet may be deleted (on insufficient funds - no money moved). Once the stake
      has moved, the bet's id is the idempotency anchor; removing it lets a re-drive
      double-apply. (§7.2b)
- [ ] **Partitioning by `now()` instead of an operation-derived timestamp.** Breaks
      at-most-once: a retry crossing a partition boundary won't see the original and will
      double-apply. Derive the partition key from the UUIDv7 you mint
      (`uuid_extract_timestamp`). (§7.3)
- [ ] **Time-expiring sessions in your wallet.** Session lifetime is the RGS's to enforce (it
      currently opens no new bets 24 hours after launch — subject to change). A wallet-side TTL —
      rejecting calls on an old session, or deleting session rows on age — withholds wins and
      strands cancelled stakes when a late debit, credit, or rollback arrives for an active
      round. Validate credits/rollbacks against the **stored bet** (the token must resolve to
      the same session that opened the round), and clean up a session only once it has **no
      active bets** left. (§2, "Session lifetime")
- [ ] **Money in floating point.** Integer micro-units end-to-end; 64-bit/decimal types. (§2)
- [ ] **Currency mismatch not rejected.** The debit's and credit's currency must equal the
      session currency → `ERR_BAD` otherwise. (§2)
- [ ] **Non-positive or non-integer amounts accepted.** Validate `amount` as a positive integer
      at the boundary; reject as `ERR_BAD` (a `4xx`), not as an internal `5xx`.
- [ ] **Verifying the signature against re-serialized JSON.** Verify against the raw received
      bytes, then parse those same bytes. (§2)
- [ ] **Dev/test endpoints exposed in production.** Any helper that mints sessions or sets
      balances must be *off by default* and gated behind an explicit flag - and
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
6. Insufficient funds returns `ERR_IPB` (`4xx`); a simulated downstream timeout returns
   `ERR_UE` (`5xx`), and the subsequent retry converges to a single correct application.
7. A rollback replays idempotently; a rollback against a closed round - whatever closed it - is
   refused `ERR_BC` and moves no money; a rollback of a staged credit on an open round claws the
   win back exactly once, even into a negative balance.
8. **Out-of-order:** a rollback that names a debit or credit you haven't seen fences it and
   succeeds (moving nothing); the subsequent straggler for that id is refused and the balance
   never moves. A rollback that names a debit still `pending` resolves it rather than asking
   for a retry. (The hardest cases - see §7.2d.)
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
contract — the replay, out-of-order, multi-debit, single-shot and signature cases above
included. It runs from Engine's infrastructure against a staging or development integration's
ingress URL (never production), once per currency you select, and a staging or development
integration goes live only after a passing (or explicitly skipped) run. It grades strictly: a
success must be exactly `200`, every rejection a `4xx` with the expected `code`, and 20
back-to-back `/v1/balance` calls must have a p50 under 500 ms. Each request times out after
10 s and the whole run after 5 minutes. Two edge cases above aren't in the suite - the
rollback of a `pending` debit (item 8) and a clawback into a negative balance (item 7) - so
test those yourself.

To run it you implement one extra, **dev-only** endpoint the suite uses to set up each test:
`POST <your ingress URL>/v1/dev/session` (the portal derives that path; you can't move it). The
suite signs it like a wallet call and sends `{ "currency", "balance" }`, with `balance` in
micro-units (possibly `0`). Fund a test player with exactly that balance and answer `200` with
`{ "token": "…" }`, a fresh session (see the bun example's `/v1/dev/session`). Keep it off by
default and gated behind an explicit flag — it mints sessions and resets balances, so it must
never be reachable in production (see the pitfalls checklist, §9).
