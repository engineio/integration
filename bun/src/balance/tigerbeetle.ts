import { randomUUIDv7 } from "bun";
import {
  AccountFlags,
  type Account,
  type Client,
  CreateAccountStatus,
  CreateTransferStatus,
  type Transfer as TbTransfer,
  TransferFlags,
} from "tigerbeetle-node";
import { type Balance, type BalanceBucket, ErrInsufficientBalance, type Transfer } from "./index";

// The interface's buckets plus `owed`, the TigerBeetle-only account that carries a clawback's
// shortfall (see the class doc).
type Bucket = BalanceBucket | "owed";

// One transfer in a movement's chain: the movement itself, or its borrow/repay leg.
interface Leg {
  id: bigint;
  debit: Bucket;
  credit: Bucket;
  amount: bigint;
  flags: TransferFlags;
}

/**
 * TigerBeetle-backed balance ledger — a second, drop-in implementation of the same `Balance`
 * interface as the Postgres `PostgresBalance`. The two are interchangeable behind the
 * interface (see main.ts's BALANCE_BACKEND switch); the wallet handlers can't tell which is
 * wired in. This file is a worked example of mapping the casino balance model onto
 * TigerBeetle's accounting primitives, alongside the hand-rolled Postgres version.
 *
 * The mapping, term-for-term with the Postgres schema (balance/sql/001_init.sql):
 *
 *   Postgres                              TigerBeetle
 *   ──────────────────────────────────   ──────────────────────────────────────────────
 *   balance.currency (enum)              one ledger per currency (see LEDGER)
 *   balance.bucket  (enum)               account `code` (BUCKET_CODE)
 *   account row (user, currency, bucket) one account, id = pack(user, ledger, bucket)
 *   _move's guard on debits of available AccountFlags.debits_must_not_exceed_credits
 *   overdraw: available below zero       debt on the player's `owed` account (below)
 *   op_key + ledger PK idempotency       transfer `id` uniqueness (resubmit → `exists`)
 *   balance.ledger append-only trail     the transfers themselves (immutable by design)
 *   1–2 movement batch, debits-first     a linked transfer chain, available-debit first
 *
 * What disappears versus Postgres: no migrations, no partitioning, no idempotency-claim
 * dance, no hand-written affordability guard — those are all native here. What costs more: a
 * transfer doesn't return a balance, so we follow with a lookup; a clawback needs extra legs
 * (below); and TigerBeetle is append-only, so the dev-only `reset` rebalances with
 * compensating transfers rather than DELETE-ing rows.
 *
 * Clawbacks (`overdraw`). The flag on `available` is the atomic affordability guard and can't
 * be waived per transfer, so `available` itself never goes below zero. The shortfall becomes
 * debt on a per-player `owed` account instead, and the balance is available − owed. A
 * clawback is a linked chain: borrow its amount from `owed` into `available`, make the
 * movement, then repay as much as `available` still holds. Every movement that credits
 * `available` is followed by the same repay, so a win or refund pays the debt down before any
 * of it is spendable, and `owed > 0` implies `available == 0` — the flag then refuses every
 * stake, as Postgres's guard refuses a debit of a negative balance.
 *
 * One deliberate behavioural difference from Postgres, worth knowing: TigerBeetle treats an
 * insufficient-funds failure (`exceeds_credits`) as *recorded* — replaying that exact
 * transfer id returns `id_already_failed`, not a fresh re-evaluation against a now-higher
 * balance. The Postgres `_move` leaves no row on a failed attempt, so a same-key retry there
 * *can* succeed later. For the RGS flow this is moot (insufficient funds is a terminal "no",
 * not something the RGS re-drives hoping it clears), and TigerBeetle's behaviour is arguably
 * stricter/more deterministic. We map both `exceeds_credits` and `id_already_failed` to
 * `ErrInsufficientBalance` so the handler sees one consistent outcome either way.
 */
export class TigerBeetleBalance implements Balance {
  // currency → TigerBeetle ledger id (one ledger per currency). Like BUCKET_CODE, these are
  // explicit, stable wire identifiers baked into every account id forever: a currency's number
  // must NEVER change. Add new currencies with the next free number; never reorder or renumber
  // an existing one — that would silently re-map live accounts onto the wrong currency. Must
  // cover every value of the balance.currency enum in balance/sql/001_init.sql. The numbers
  // happen to match that enum's original 1-based order, but it's the map — not the order — that
  // defines them, so the source can be reordered freely.
  private static readonly LEDGER: Record<string, number> = {
    AED: 1, ARS: 2, BHD: 3, BAM: 4, BRL: 5, CAD: 6, CLP: 7, CNY: 8, CRC: 9, DKK: 10,
    EUR: 11, GHS: 12, IDR: 13, ILS: 14, INR: 15, ISK: 16, JOD: 17, JPY: 18, KES: 19, KRW: 20,
    KWD: 21, MAD: 22, MXN: 23, MYR: 24, NGN: 25, NOK: 26, OMR: 27, PEN: 28, PHP: 29, PLN: 30,
    QAR: 31, RUB: 32, SAR: 33, SGD: 34, TND: 35, TRY: 36, TWD: 37, USD: 38, VND: 39, NZD: 40,
    HUF: 41, KZT: 42, EGP: 43, THB: 44, KHR: 45, PKR: 46, BDT: 47, ZAR: 48, UZS: 49, XOF: 50,
    XAF: 51, MWK: 52, RWF: 53, TZS: 54, UGX: 55, ZMW: 56, BOB: 57, GTQ: 58, XSC: 59, XGC: 60,
  };

  // The bucket → account `code`. Non-zero (TigerBeetle reserves code 0), so it also guarantees
  // a packed account id is never the reserved 0 id.
  private static readonly BUCKET_CODE: Record<Bucket, number> = {
    available: 1,
    engineBet: 2,
    enginePayout: 3,
    testFunds: 4,
    owed: 5,
  };

  // A borrow/repay leg's id is its movement's id with the UUID version nibble swapped for one
  // of these unassigned versions (see legId).
  private static readonly BORROW = 0xbn;
  private static readonly REPAY = 0xdn;

  constructor(private readonly client: Client) { }

  async get(userId: number, currency: string): Promise<number> {
    // available − owed is the two accounts' nets summed (owed's net is minus the debt). Either
    // may not exist yet; lookupAccounts just omits it.
    const accounts = await this.client.lookupAccounts([
      TigerBeetleBalance.accountId(userId, currency, "available"),
      TigerBeetleBalance.accountId(userId, currency, "owed"),
    ]);
    return Number(accounts.reduce((sum, acc) => sum + TigerBeetleBalance.net(acc), 0n));
  }

  /**
   * Apply 1–2 movements as a single linked transfer chain and return the new available
   * balance. Available-debits are ordered first so a same-batch win can never fund the stake:
   * if the stake overdraws `available` the whole chain is rejected (an unaffordable stake
   * fails even if stake+win nets positive). Idempotent per movement `opKey` — the borrow/repay
   * legs derive their ids from it too, so a full replay finds every id already present
   * (`exists`) and applies nothing.
   */
  async transfer(movements: [Transfer] | [Transfer, Transfer]): Promise<number> {
    const [m1, m2] = movements;
    const { userId, currency } = m1;
    if (m2 && (m2.userId !== userId || m2.currency !== currency)) {
      throw new Error("both movements must be for the same player and currency");
    }

    // Available-debits first (stable sort). With ≤2 movements this just floats the stake
    // ahead of a concurrent win, mirroring transfer_v1's two-pass ordering.
    const ordered = [...movements].sort(
      (a, b) => (a.debit === "available" ? 0 : 1) - (b.debit === "available" ? 0 : 1),
    );

    const legs = ordered.flatMap((m): Leg[] => {
      const id = TigerBeetleBalance.opKeyToId(m.opKey);
      const amount = BigInt(m.amount);
      const move: Leg = { id, debit: m.debit, credit: m.credit, amount, flags: TransferFlags.none };
      // Pay down any debt from what `available` now holds: TigerBeetle shrinks a balancing
      // transfer to min(amount, available's net, owed's debt), and 0 is a valid result.
      const repay: Leg = {
        id: TigerBeetleBalance.legId(id, TigerBeetleBalance.REPAY), debit: "available", credit: "owed", amount,
        flags: TransferFlags.balancing_debit | TransferFlags.balancing_credit,
      };
      if (m.overdraw && m.debit === "available") {
        const borrow: Leg = {
          id: TigerBeetleBalance.legId(id, TigerBeetleBalance.BORROW), debit: "owed", credit: "available", amount,
          flags: TransferFlags.none,
        };
        return [borrow, move, repay];
      }
      return m.credit === "available" ? [move, repay] : [move];
    });

    await this.ensureAccounts(userId, currency, legs.flatMap((l) => [l.debit, l.credit]));

    const ledger = TigerBeetleBalance.ledgerOf(currency);
    const transfers: TbTransfer[] = legs.map((l, i) =>
      TigerBeetleBalance.buildTransfer(l.id, userId, currency, ledger, l.debit, l.credit, l.amount,
        // Link all but the last, so the batch is all-or-nothing.
        i < legs.length - 1 ? l.flags | TransferFlags.linked : l.flags,
      ),
    );

    const results = await this.client.createTransfers(transfers);
    let insufficient = false;
    const rejected: string[] = [];
    for (const r of results) {
      switch (r.status) {
        case CreateTransferStatus.created:
        case CreateTransferStatus.exists: // idempotent replay of an already-applied movement
          break;
        case CreateTransferStatus.exceeds_credits: // the stake overdraws `available`
        case CreateTransferStatus.id_already_failed: // a prior attempt for this id failed insufficient
          insufficient = true;
          break;
        case CreateTransferStatus.linked_event_failed:
          // A sibling in the chain decided the outcome; its own status carries the real cause,
          // so we let that one set the flags above.
          break;
        default:
          rejected.push(CreateTransferStatus[r.status]);
      }
    }
    if (insufficient) throw new ErrInsufficientBalance();
    if (rejected.length) throw new Error(`tigerbeetle transfer rejected: ${rejected.join(", ")}`);

    return this.get(userId, currency);
  }

  /**
   * Dev/test: reset a player's currency to exactly `amount` available, zeroing the escrow and
   * payout counter-accounts and any debt left by prior tests so one account can be reused.
   * TigerBeetle is append-only — there is no DELETE like the Postgres reset — so we instead
   * post compensating transfers against `testFunds` (the unconstrained sink/source) to drive
   * each bucket to its target net balance.
   */
  async reset(userId: number, currency: string, amount: number): Promise<void> {
    const buckets = ["available", "engineBet", "enginePayout", "testFunds", "owed"] as const;
    await this.ensureAccounts(userId, currency, [...buckets]);

    const accounts = await this.client.lookupAccounts(buckets.map((b) => TigerBeetleBalance.accountId(userId, currency, b)));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const netOf = (bucket: Bucket): bigint => {
      const acc = byId.get(TigerBeetleBalance.accountId(userId, currency, bucket));
      return acc ? TigerBeetleBalance.net(acc) : 0n;
    };

    const ledger = TigerBeetleBalance.ledgerOf(currency);
    const transfers: TbTransfer[] = [];
    // Drive each bucket to its target by moving the signed delta to/from testFunds.
    const targets: [Bucket, bigint][] = [
      ["available", BigInt(amount)],
      ["engineBet", 0n],
      ["enginePayout", 0n],
      ["owed", 0n],
    ];
    for (const [bucket, target] of targets) {
      const delta = target - netOf(bucket);
      if (delta === 0n) continue;
      const [debit, credit, amt] =
        delta > 0n
          ? (["testFunds", bucket, delta] as const) // credit the bucket up to target
          : ([bucket, "testFunds", -delta] as const); // debit the surplus back out
      transfers.push(
        TigerBeetleBalance.buildTransfer(TigerBeetleBalance.opKeyToId(randomUUIDv7()), userId, currency, ledger, debit, credit, amt, TransferFlags.none),
      );
    }
    if (transfers.length === 0) return;

    const results = await this.client.createTransfers(transfers);
    const rejected = results
      .filter((r) => r.status !== CreateTransferStatus.created && r.status !== CreateTransferStatus.exists)
      .map((r) => CreateTransferStatus[r.status]);
    if (rejected.length) throw new Error(`tigerbeetle reset rejected: ${rejected.join(", ")}`);
  }

  /**
   * Ensure the accounts a transfer will touch exist, creating any that don't. createAccounts
   * is idempotent (`exists` counts as success), so this is safe to call unconditionally before
   * every transfer.
   *
   * We create up front rather than firing the transfer and reacting to a
   * `*_account_not_found` error: TigerBeetle classifies account-not-found as a *transient*
   * failure, which burns the transfer id. A retry with the same id (our `opKey`) then returns
   * `id_already_failed` — indistinguishable from insufficient funds — even once the account
   * exists. So the accounts must exist before the transfer's first attempt; there is no safe
   * create-and-retry. (No per-process cache either: across a pod fleet a player rarely recurs
   * on the same pod, so a cache would mostly miss and `createAccounts` would run anyway.)
   */
  private async ensureAccounts(userId: number, currency: string, buckets: Bucket[]): Promise<void> {
    const ledger = TigerBeetleBalance.ledgerOf(currency);
    const toCreate: Account[] = [...new Set(buckets)].map((b) =>
      TigerBeetleBalance.newAccount(TigerBeetleBalance.accountId(userId, currency, b), ledger, b),
    );
    if (toCreate.length === 0) return;

    const results = await this.client.createAccounts(toCreate);
    results.forEach((r, i) => {
      if (r.status !== CreateAccountStatus.created && r.status !== CreateAccountStatus.exists) {
        throw new Error(`tigerbeetle createAccounts failed: ${CreateAccountStatus[r.status]} for ${toCreate[i]!.id}`);
      }
    });
  }

  private static ledgerOf(currency: string): number {
    const ledger = TigerBeetleBalance.LEDGER[currency];
    if (ledger === undefined) throw new Error(`unknown currency ${currency}`);
    return ledger;
  }

  /**
   * Deterministic account id for a (user, currency, bucket), packed into the 128-bit id as
   * three byte-aligned fields:
   *
   *   user_id (8 bytes) | ledger (4 bytes) | bucket code (4 bytes)
   *
   * We have 16 bytes and need a fraction of them, so the fields are byte-aligned with room to
   * spare rather than packed tight: 64 bits of user id, 32 bits for the ledger (currency), 32
   * bits for the bucket. `bucket` is a small, fixed set of account *types* (where money sits:
   * available / escrow / payout / test / debt) — it won't grow much, so 4 bytes is just for a
   * clean layout, not capacity. (The *kind* of movement — stake / win / rollback — is a
   * separate axis carried in the transfer `code`, not here. And the values live in
   * TigerBeetle's u32 `ledger` and u16 `code` fields on the account; the id merely has
   * headroom.)
   *
   * Account ids must be unique across the whole cluster, not just within a ledger, so the
   * ledger is part of the id even though the account also carries it. Always non-zero because
   * the bucket code is ≥ 1.
   */
  private static accountId(userId: number, currency: string, bucket: Bucket): bigint {
    return (BigInt(userId) << 64n) | (BigInt(TigerBeetleBalance.ledgerOf(currency)) << 32n) | BigInt(TigerBeetleBalance.BUCKET_CODE[bucket]);
  }

  /**
   * The RGS transaction id (a UUIDv7) becomes the transfer id verbatim — 128 bits map 1:1, and
   * resubmitting the same id is TigerBeetle's built-in idempotency. This is the exact analogue
   * of using op_key as the Postgres ledger primary key.
   */
  private static opKeyToId(opKey: string): bigint {
    return BigInt("0x" + opKey.replaceAll("-", ""));
  }

  /**
   * A movement's borrow/repay leg id: the movement's id with its UUID version nibble (bits
   * 76–79) swapped for `tag`, an unassigned version. Deterministic, so a replay rebuilds the
   * same chain and finds it `exists`; it can't collide with any opKey (a real UUID) or with the
   * other leg; and it keeps the id's time-ordered prefix, which TigerBeetle's LSM favours.
   */
  private static legId(movementId: bigint, tag: bigint): bigint {
    return (movementId & ~(0xfn << 76n)) | (tag << 76n);
  }

  // An account's net, credits in minus debits out. We never use pending (two-phase)
  // transfers, so posted is the whole story.
  private static net(acc: Account): bigint {
    return acc.credits_posted - acc.debits_posted;
  }

  private static newAccount(id: bigint, ledger: number, bucket: Bucket): Account {
    return {
      id,
      debits_pending: 0n,
      debits_posted: 0n,
      credits_pending: 0n,
      credits_posted: 0n,
      user_data_128: 0n,
      user_data_64: 0n,
      user_data_32: 0,
      reserved: 0,
      ledger,
      code: TigerBeetleBalance.BUCKET_CODE[bucket],
      // `available` may never overdraw: bets (debits) may never exceed deposits+wins (credits).
      // This one flag IS the insufficient-funds guard — the counterpart of the guard in the
      // Postgres _move. `owed` is its mirror: it only ever holds debt, so it can't be repaid
      // past what was borrowed. The counter-accounts are unflagged and may carry either sign
      // (enginePayout in particular runs debit-heavy as it funds wins).
      flags:
        bucket === "available" ? AccountFlags.debits_must_not_exceed_credits
          : bucket === "owed" ? AccountFlags.credits_must_not_exceed_debits
            : AccountFlags.none,
      timestamp: 0n,
    };
  }

  private static buildTransfer(
    id: bigint,
    userId: number,
    currency: string,
    ledger: number,
    debit: Bucket,
    credit: Bucket,
    amount: bigint,
    flags: TransferFlags,
  ): TbTransfer {
    return {
      id,
      debit_account_id: TigerBeetleBalance.accountId(userId, currency, debit),
      credit_account_id: TigerBeetleBalance.accountId(userId, currency, credit),
      amount,
      pending_id: 0n,
      user_data_128: 0n,
      user_data_64: 0n,
      user_data_32: 0,
      timeout: 0,
      ledger,
      // Categorise the movement by its (debit, credit) bucket pair, packed into the u16 `code`
      // field as debit << 8 | credit. Byte-per-bucket is collision-free for bucket codes up to
      // 255 each (the `* 10` scheme would alias once a code reached double digits — e.g. debit 1
      // + credit 12 and debit 2 + credit 2 both give 22). E.g. available(1) -> engineBet(2) =
      // 0x0102 = 258 (stake).
      code: (TigerBeetleBalance.BUCKET_CODE[debit] << 8) | TigerBeetleBalance.BUCKET_CODE[credit],
      flags,
      timestamp: 0n,
    };
  }
}
