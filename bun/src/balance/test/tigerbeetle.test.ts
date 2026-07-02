import { randomUUIDv7 as uuid } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { type Client } from "tigerbeetle-node";
import { ErrInsufficientBalance, type Transfer } from "../index";
import { TigerBeetleBalance } from "../tigerbeetle";
import { sharedTigerBeetle } from "./container";

// These exercise the TigerBeetle balance store directly (no HTTP, no bet ledger). Tests share
// one cluster, isolated by minting a unique user id per test — TigerBeetle is append-only, so
// there is no per-test teardown; distinct users simply never collide.
describe("TigerBeetleBalance", () => {
  let client: Client;
  beforeAll(async () => {
    client = await sharedTigerBeetle();
  }, 120_000);

  // int4-range, unique per call, so concurrent tests don't share accounts.
  let seq = 0;
  const nextUser = () => 100_000 + seq++ * 1000 + Math.floor(Math.random() * 900);

  const stake = (userId: number, amount: number, opKey = uuid()): Transfer =>
    ({ userId, currency: "USD", amount, debit: "available", credit: "engineBet", opKey });
  const win = (userId: number, amount: number, opKey = uuid()): Transfer =>
    ({ userId, currency: "USD", amount, debit: "enginePayout", credit: "available", opKey });

  test("reset funds the player and get reads it back", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    expect(await bal.get(u, "USD")).toBe(0);
    await bal.reset(u, "USD", 500_000_000);
    expect(await bal.get(u, "USD")).toBe(500_000_000);
  });

  test("a stake debits available and returns the new balance", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 100_000_000);
    const after = await bal.transfer([stake(u, 30_000_000)]);
    expect(after).toBe(70_000_000);
    expect(await bal.get(u, "USD")).toBe(70_000_000);
  });

  test("an unaffordable stake throws and moves nothing", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 10_000_000);
    await expect(bal.transfer([stake(u, 20_000_000)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
    expect(await bal.get(u, "USD")).toBe(10_000_000);
  });

  test("replaying the same op key applies the movement exactly once", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 100_000_000);
    const s = stake(u, 25_000_000);
    expect(await bal.transfer([s])).toBe(75_000_000);
    // Same opKey again → `exists`, a no-op. Balance unchanged.
    expect(await bal.transfer([s])).toBe(75_000_000);
    expect(await bal.get(u, "USD")).toBe(75_000_000);
  });

  test("a same-batch win cannot fund the stake (linked chain, debits first)", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 5_000_000);
    // Stake 10 with a concurrent win 20: nets +10, but the stake alone overdraws the 5 balance.
    // The whole chain must be rejected — neither the stake nor the win may apply.
    await expect(
      bal.transfer([stake(u, 10_000_000), win(u, 20_000_000)]),
    ).rejects.toBeInstanceOf(ErrInsufficientBalance);
    expect(await bal.get(u, "USD")).toBe(5_000_000);
  });

  test("an affordable stake+win batch applies both atomically", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 50_000_000);
    const after = await bal.transfer([stake(u, 10_000_000), win(u, 4_000_000)]);
    // 50 - 10 (stake) + 4 (win) = 44
    expect(after).toBe(44_000_000);
  });

  test("a stake refund (rollback) credits available back", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 100_000_000);
    await bal.transfer([stake(u, 40_000_000)]);
    const refunded = await bal.transfer([
      { userId: u, currency: "USD", amount: 40_000_000, debit: "engineBet", credit: "available", opKey: uuid() },
    ]);
    expect(refunded).toBe(100_000_000);
  });

  test("a zero-amount win is accepted and is a no-op on the balance", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 20_000_000);
    const after = await bal.transfer([win(u, 0)]);
    expect(after).toBe(20_000_000);
  });

  test("reset sets available exactly and clears the escrow/payout buckets", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = nextUser();
    await bal.reset(u, "USD", 80_000_000);
    await bal.transfer([stake(u, 30_000_000)]); // available 50, engineBet +30
    await bal.transfer([win(u, 10_000_000)]); // available 60, enginePayout -10

    await bal.reset(u, "USD", 1_000_000);
    expect(await bal.get(u, "USD")).toBe(1_000_000);

    // After reset the player can be reused: a fresh stake draws against exactly the reset
    // amount, proving the counter-accounts were zeroed rather than left dirty.
    expect(await bal.transfer([stake(u, 1_000_000)])).toBe(0);
    await expect(bal.transfer([stake(u, 1)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
  });
});
