# Engine operator wallet - TypeScript / Bun example

A minimal, self-contained reference implementation of the **operator side** of an Engine
wallet integration. The RGS (Remote Gaming Server) runs the game and sends this
wallet signed requests as players bet; the wallet is the system of record for player money.

**Read [the repository readme](../readme.md) first.** It describes the full integration
contract and failure model - endpoints, error codes, idempotency, status-code rules,
rollback/tombstone handling, pitfalls, acceptance criteria - and it is the same for every
example. This document covers only what is specific to *this* example: what it's built on,
how to run it, and where in the code each rule from that contract lives.

It is deliberately small - one service, one Postgres database, no message bus - so you can
read it end to end and use it as the base for a real integration.

## What it's built on

This example is written in TypeScript on [Bun](https://bun.sh) - that's **one option, not a
requirement**; the contract is stack-agnostic and any language can implement it. The choices
here favour a small dependency footprint so the code stays readable:

- **[Bun](https://bun.sh)** - the JavaScript/TypeScript runtime. The HTTP server is Bun's
  built-in `Bun.serve` (its `routes` object maps paths to handlers), so there's no separate
  web framework to learn - the request lifecycle is written out explicitly in
  [routes.ts](src/handlers/routes.ts).
- **Bun's built-in `SQL` client** talks to Postgres directly (no ORM); queries and stored
  procedures live in plain `.sql` files.
- **[AJV](https://ajv.js.org)** validates request and response bodies against JSON Schema.
- **Structured logs** are plain `console.log(JSON.stringify(...))` - no logging library.

The only runtime dependencies are AJV and (optionally) the TigerBeetle client; everything
else is Bun's standard library.

## Running

### One command: Docker Compose

The quickest way to see the whole thing run — the wallet (built from [Dockerfile](Dockerfile)),
Postgres for the bet ledger, and a 3-replica TigerBeetle cluster for the balance ledger:

```sh
docker compose up --build
```

The first run generates an Ed25519 keypair into `./keys/` (the RGS would normally hold the
private key — here you use it to sign test requests; an old RSA pair from a previous run is
regenerated automatically). The wallet comes up on `:3000` with
`DEV_ENDPOINTS=true`, so the [Making a request](#making-a-request) steps below work as-is
(sign with `keys/private.key`). See the header comment in
[docker-compose.yml](docker-compose.yml) for the details.

### Locally with Bun

Alternatively, run the wallet directly (you provide Postgres):

```sh
bun install

# Generate an Ed25519 keypair for local testing (the RGS would normally hold the private key):
openssl genpkey -algorithm ed25519 -out private.key
openssl pkey -in private.key -pubout -out public.key

export DATABASE_URL='postgres://postgres:postgres@localhost:5432/operator'
export RGS_PUBLIC_KEY="$(base64 < public.key)"
export DEV_ENDPOINTS=true

bun run dev
```

The wallet listens on `PORT` (default `3000`) and exposes a `GET /health` check.

### Optional: TigerBeetle balance backend

By default the balance ledger is Postgres. The balance store sits behind an interface (see
[Two ledgers](#two-ledgers)), so it can instead be backed by
[TigerBeetle](https://tigerbeetle.com), a purpose-built accounting database - again, an
option, not a requirement. To run against it, start a single-replica dev cluster and point
the wallet at it (the bet ledger still needs `DATABASE_URL`):

```sh
# Format + start a dev TigerBeetle on :3000. --development relaxes prod I/O requirements;
# seccomp=unconfined lets it use io_uring inside Docker.
docker run -d --name tb -p 3033:3000 --security-opt seccomp=unconfined \
  --entrypoint /bin/sh ghcr.io/tigerbeetle/tigerbeetle:0.17.7 -c \
  '/tigerbeetle format --cluster=0 --replica=0 --replica-count=1 /tmp/0.tigerbeetle && \
   exec /tigerbeetle start --development --addresses=0.0.0.0:3000 /tmp/0.tigerbeetle'

export BALANCE_BACKEND=tigerbeetle
export TB_ADDRESS=127.0.0.1:3033   # numeric IP:port (the client rejects hostnames)
export TB_CLUSTER_ID=0
bun run dev
```

### Making a request

With `DEV_ENDPOINTS=true`, mint a session to test against (implementing this endpoint is also
what enables the automated test suite on Engine's integration site, which uses it to set
up each test — see the [conformance suite note](../readme.md#the-conformance-suite)):

```sh
curl -s localhost:3000/v1/dev/session \
  -H 'content-type: application/json' \
  -d '{"currency":"USD","startingBalance":1000000000}'
# => { "token": "...", "player": ..., "currency": "USD", "balance": 1000000000 }
```

Then sign a request body with the private key and call the wallet, e.g. the balance
endpoint (Ed25519 signs one-shot, so openssl needs the body in a file):

```sh
BODY='{"token":"<token>"}'
printf '%s' "$BODY" > /tmp/body.json
SIG=$(openssl pkeyutl -sign -inkey private.key -rawin -in /tmp/body.json | base64 -w0)
curl -s localhost:3000/v1/balance \
  -H 'content-type: application/json' \
  -H "x-signature: $SIG" \
  -d "$BODY"
```

The signature is over the **exact bytes** of the body, so sign and send the same string.

### Tests

```sh
bun test
```

The handler tests spin up a real Postgres (and TigerBeetle) via testcontainers, and the
money handlers run against **both** balance backends to prove they're interchangeable. The
suite exercises the [acceptance criteria](../readme.md#10-minimal-acceptance-criteria) from
the contract; see [How this example implements the contract](#how-this-example-implements-the-contract).

## Environment

| Var             | Required | Default      | Notes                                                    |
| --------------- | -------- | ------------ | -------------------------------------------------------- |
| `DATABASE_URL`  | yes      | -            | Postgres connection string (the bet ledger; also the Postgres balance ledger). |
| `RGS_PUBLIC_KEY`| yes      | -            | base64 of the RGS public-key PEM.                        |
| `PORT`          | no       | `3000`       | Wallet HTTP port.                                        |
| `DB_POOL_MAX`   | no       | `10`         | Max Postgres connections.                                |
| `DEV_ENDPOINTS` | no       | `false`      | `true` exposes `POST /v1/dev/session` (no auth).         |
| `BALANCE_BACKEND` | no     | `postgres`   | `postgres` or `tigerbeetle`.                             |
| `TB_ADDRESS`    | no       | `3000`       | TigerBeetle address (numeric `IP:port`); used when `BALANCE_BACKEND=tigerbeetle`. |
| `TB_CLUSTER_ID` | no       | `0`          | TigerBeetle cluster id.                                  |
| `NODE_ENV`      | no       | -            | `production` makes response-validation failures log-and-pass instead of 500. |

## Project layout

```
Dockerfile             two-stage build: bundle+minify, slim runtime (see its header comment)
local.Dockerfile       dev image with hot reload (bind-mount the source; see its header)
docker-compose.yml     full local stack: wallet + Postgres + 3-replica TigerBeetle + keygen
src/
  main.ts              boot: env, db connection(s), migrate (fail-fast), build routes, Bun.serve
  env.ts               tiny env reader + shutdown-signal helper
  database.ts          shared plumbing: the migration runner
  migrate.macro.ts     build-time macro: inline *.sql into the binary
  types.ts             bet-ledger domain types
  handlers/
    routes.ts          createRouter(state): verify-sig → validate → handle → validate → log
    errors.ts          WalletError codes + toErrorResponse()
    schema.ts          currency enum + shared balance sub-schema
    handler.balance.ts   POST /v1/balance
    handler.debit.ts     POST /v1/debit   (bet-first: open pending → stake → confirm)
    handler.credit.ts    POST /v1/credit  (settle an open round)
    handler.rollback.ts  POST /v1/rollback (reverse named debits; tombstone an orphan; close iff !active)
    handler.session.ts   DEV-only: seed/fund a player + mint a session (gated)
    test/                handler tests (testcontainers Postgres + TigerBeetle)
  db/                  the bet ledger (schema `repo`)
    repo.ts            providers/games/sessions + the bet procs
    errors.ts          Postgres/SQLSTATE → typed errors
    sql/
      001_init.sql       repo schema + tables (bet [status lifecycle] / transaction)
      002_funcs.sql      record_debit/confirm/reject/close/rollback_debits/get_bet_v1 + maintain_bet_partitions
  balance/             the balance ledger - stands in for a separate account service
    index.ts           Balance interface + Transfer types + ErrInsufficientBalance
    postgres.ts        PostgresBalance: idempotent double-entry transfer() (Postgres)
    tigerbeetle.ts     TigerBeetleBalance: the same Balance interface on TigerBeetle
    sql/               (Postgres backend)
      001_init.sql       balance schema + tables (ledger keyed by op_key)
      002_funcs.sql      _move / transfer_v1 / reset_v1 / maintain_ledger_partitions
    test/
      container.ts        shared TigerBeetle testcontainer (format + start)
      postgres.test.ts    standalone PostgresBalance tests (op-key guard, partition maintenance)
      tigerbeetle.test.ts standalone TigerBeetleBalance tests
```

## The HTTP pipeline

`Bun.serve`'s `routes` map dispatches each path to a handler.
[routes.ts](src/handlers/routes.ts) wraps every money endpoint in one explicit
higher-order function: `createRouter(state)` is called once at startup and returns
`route(schema, handler)`, which compiles the AJV validators once and returns the
per-request hot path:

```
verify x-signature  →  parse + validate body  →  handler  →  validate response  →  log
```

The handler owns the money logic; the wrapper does not. Response validation **hard-fails
(500) outside production** to catch contract drift, but in **production it logs and passes
the response through** - a debit/credit may already be committed, so 500-ing would invite a
retry and risk a double-spend. (Production is detected via `NODE_ENV=production`.)

## Two ledgers

The wallet keeps **two independent ledgers** in separate Postgres schemas, each reached
through its own path - the balance ledger stands in for a separate account service, exactly
as a real integrator usually splits them (the contract's
[§5](../readme.md#5-modeling-money-bets-vs-balances-and-why-to-split-them) explains why):

- **Bet ledger** (schema `repo`) - providers, games, sessions, bets and their
  debit/credit/rollback transactions. Mutations go through the `*_v1` stored procs.
- **Balance ledger** (schema `balance`) - players' money across buckets
  (`available` / `engineBet` / `enginePayout` / `testFunds`) with a double-entry movement log.

Balance is reached through an **interface** (`src/balance` - `Balance.get()` /
`Balance.transfer()`), so it can be swapped for a remote balance service or a mock without
touching the handlers. Two implementations ship side by side, selected by `BALANCE_BACKEND`:

- **`postgres`** (default) - `PostgresBalance`, the double-entry ledger in schema `balance`.
- **`tigerbeetle`** - `TigerBeetleBalance`, the same model on
  [TigerBeetle](https://tigerbeetle.com). It maps almost 1:1 (one ledger per currency, an
  account per bucket, the `op_key` UUID as the transfer id for idempotency, a
  `debits_must_not_exceed_credits` flag for the overdraw guard, linked transfers for the
  atomic stake+win batch) - so most of the Postgres ledger's hand-rolled machinery
  (partitioning, the idempotency claim, the negative-balance `CHECK`) becomes native. See
  the file's header comment for the full mapping and the one behavioural difference around
  failed-transfer replays.

The two stores are **never joined and share no transaction**. Because that is exactly the
"separate balance service" case, the handlers are written the safe way even when both
ledgers happen to be the same Postgres - see below.

## How this example implements the contract

Everything below points at the [contract in the repository readme](../readme.md#the-integration-contract-and-failure-model)
and shows where in this code each rule is enforced. Read the contract for the *why*; this is
the *where*.

| Contract rule | Where it lives here |
| ------------- | ------------------- |
| **Signature check before parsing** ([§2 Authentication](../readme.md#authentication)) | [routes.ts](src/handlers/routes.ts) verifies `x-signature` over the raw body bytes as the first step, before `JSON.parse`. |
| **Error codes → HTTP status, terminal vs retryable** ([§2](../readme.md#error-response-contract), [§3](../readme.md#3-status-codes-are-your-safety-mechanism)) | [handlers/errors.ts](src/handlers/errors.ts) - `WalletError` codes and `toErrorResponse()`. |
| **Request validation lenient, response validation strict** (hardening practice: unknown inbound fields are ignored for forward-compat; own responses are strictly checked) | AJV schemas per handler; response validation hard-fails only outside production ([routes.ts](src/handlers/routes.ts)). |
| **Idempotency enforced by DB constraints** ([§4](../readme.md#4-idempotency-no-duplicate-bets-no-duplicate-transactions)) | [db/sql/001_init.sql](src/db/sql/001_init.sql): round is the bet's `PRIMARY KEY`, transaction ids are `UNIQUE`. The `*_v1` procs return the canonical stored ids on replay. |
| **Session lifetime is the RGS's to enforce; wallet auth is session-to-bet alignment** ([§2 Session lifetime](../readme.md#session-lifetime)) | No handler checks token age. [handler.credit.ts](src/handlers/handler.credit.ts) and `rollback_debits_v1` ([db/sql/002_funcs.sql](src/db/sql/002_funcs.sql)) verify the token against the bet's recorded session (`ERR_IS` on mismatch); sessions are cleaned up only once no active bets remain (this example keeps them forever — see [001_init.sql](src/db/sql/001_init.sql)). |
| **Balance idempotency keyed by a UUIDv7 you mint** ([§7.2a](../readme.md#72-if-balance-is-a-separate-service-the-realistic-case)) | Balance movements key on `op_key` (the `PRIMARY KEY (op_key, op_ts)` in `src/balance/sql`) - the wallet's own bet-ledger transaction id, minted as a UUIDv7, *not* the RGS id. |
| **Bet-first ordering: record `pending` → move money → `confirm`** ([§7.2b](../readme.md#72-if-balance-is-a-separate-service-the-realistic-case)) | [handler.debit.ts](src/handlers/handler.debit.ts) (debit), [handler.credit.ts](src/handlers/handler.credit.ts) (settle), [handler.rollback.ts](src/handlers/handler.rollback.ts) (reverse), over the `repo` procs in [db/sql/002_funcs.sql](src/db/sql/002_funcs.sql). |
| **Delete only a never-funded `pending` bet** ([§7.2b](../readme.md#72-if-balance-is-a-separate-service-the-realistic-case)) | The debit handler deletes the `pending` debit (and empty bet) only on insufficient funds, guarded on the debit still being `pending`. |
| **Fence a rollback that names an unseen debit (tombstone)** ([§7.2d](../readme.md#72-if-balance-is-a-separate-service-the-realistic-case), [§6.5](../readme.md#65-rollback-reverse-one-or-more-debits)) | The rollback proc records a tombstone; `record_debit` refuses a fenced debit before any money moves. Exercised in [handler.ordering.test.ts](src/handlers/test/handler.ordering.test.ts). |
| **Double-entry balance with a non-negative guard** ([§5](../readme.md#5-modeling-money-bets-vs-balances-and-why-to-split-them)) | `PostgresBalance` moves between buckets with a negative-balance `CHECK`; `TigerBeetleBalance` uses `debits_must_not_exceed_credits`. |
| **Ledger partitioning that never stops growing** ([§7.3](../readme.md#73-scaling-the-ledger-partitioning-a-table-that-never-stops-growing)) | `balance.ledger` is `PARTITION BY RANGE (op_ts)` per ISO week, each week `PARTITION BY HASH (op_key)` × 8, `PK (op_key, op_ts)`; `balance._move` derives `op_ts` from the id; `balance.maintain_ledger_partitions` pre-creates the subtree. `balance.account` is `PARTITION BY HASH (user_id)` × 8. The bet ledger range-partitions by round (`repo.maintain_bet_partitions`). |
| **Fail-fast on bad migrations** ([§9 pitfalls](../readme.md#9-pitfalls-checklist)) | [main.ts](src/main.ts) migrates before serving and exits non-zero on failure. |
| **Dev endpoints off by default, gated, never in prod** ([§9 pitfalls](../readme.md#9-pitfalls-checklist)) | [handler.session.ts](src/handlers/handler.session.ts) 404s unless `DEV_ENDPOINTS` is set. |
| **Acceptance criteria proven by tests** ([§10](../readme.md#10-minimal-acceptance-criteria)) | `src/**/test/` - including [handler.ordering.test.ts](src/handlers/test/handler.ordering.test.ts) for the out-of-order rollback/straggler case - run against both balance backends. |
