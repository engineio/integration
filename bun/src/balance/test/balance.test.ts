import { randomUUIDv7 as uuid } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { type Balance, ErrInsufficientBalance, type Transfer } from "../index";
import { TigerBeetleBalance } from "../tigerbeetle";
import { sharedPostgresBalance, sharedTigerBeetle } from "./container";

// The two stores must be interchangeable behind `Balance`, so every case here runs against both
// (no HTTP, no bet ledger). Each backend is one shared store, and tests stay apart by minting a
// random user id — TigerBeetle is append-only, so there is no per-test teardown.
const BACKENDS: { name: string; make: () => Promise<Balance> }[] = [
  { name: "postgres", make: sharedPostgresBalance },
  { name: "tigerbeetle", make: async () => new TigerBeetleBalance(await sharedTigerBeetle()) },
];

const newUser = () => 1 + Math.floor(Math.random() * 2_147_483_646);

const stake = (userId: number, amount: number, opKey = uuid()): Transfer =>
  ({ userId, currency: "USD", amount, debit: "available", credit: "engineBet", opKey });
const win = (userId: number, amount: number, opKey = uuid()): Transfer =>
  ({ userId, currency: "USD", amount, debit: "enginePayout", credit: "available", opKey });
const refund = (userId: number, amount: number, opKey = uuid()): Transfer =>
  ({ userId, currency: "USD", amount, debit: "engineBet", credit: "available", opKey });
// A reversed win, as the rollback handler sends it.
const clawback = (userId: number, amount: number, opKey = uuid()): Transfer =>
  ({ userId, currency: "USD", amount, debit: "available", credit: "enginePayout", opKey, overdraw: true });

for (const { name, make } of BACKENDS) {
  describe(`Balance [${name}]`, () => {
    let bal: Balance;
    beforeAll(async () => {
      bal = await make();
    }, 120_000);

    test("reset funds the player and get reads it back", async () => {
      const u = newUser();
      expect(await bal.get(u, "USD")).toBe(0);
      await bal.reset(u, "USD", 500_000_000);
      expect(await bal.get(u, "USD")).toBe(500_000_000);
    });

    test("a stake debits available and returns the new balance", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 100_000_000);
      expect(await bal.transfer([stake(u, 30_000_000)])).toBe(70_000_000);
      expect(await bal.get(u, "USD")).toBe(70_000_000);
    });

    test("an unaffordable stake throws and moves nothing", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 10_000_000);
      await expect(bal.transfer([stake(u, 20_000_000)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
      expect(await bal.get(u, "USD")).toBe(10_000_000);
    });

    test("replaying the same op key applies the movement exactly once", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 100_000_000);
      const s = stake(u, 25_000_000);
      expect(await bal.transfer([s])).toBe(75_000_000);
      expect(await bal.transfer([s])).toBe(75_000_000);
      expect(await bal.get(u, "USD")).toBe(75_000_000);
    });

    test("a same-batch win cannot fund the stake, whatever the argument order", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 5_000_000);
      // Stake 10 with a win of 20 nets +10, but the stake alone overdraws the 5 balance, so
      // neither may apply.
      await expect(bal.transfer([stake(u, 10_000_000), win(u, 20_000_000)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
      await expect(bal.transfer([win(u, 20_000_000), stake(u, 10_000_000)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
      expect(await bal.get(u, "USD")).toBe(5_000_000);
    });

    test("an affordable stake+win batch applies both atomically", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 50_000_000);
      const pair: [Transfer, Transfer] = [stake(u, 10_000_000), win(u, 4_000_000)];
      expect(await bal.transfer(pair)).toBe(44_000_000);
      expect(await bal.transfer(pair)).toBe(44_000_000);
    });

    test("a stake refund (rollback) credits available back", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 100_000_000);
      await bal.transfer([stake(u, 40_000_000)]);
      expect(await bal.transfer([refund(u, 40_000_000)])).toBe(100_000_000);
    });

    test("a zero-amount win is accepted and is a no-op on the balance", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 20_000_000);
      expect(await bal.transfer([win(u, 0)])).toBe(20_000_000);
    });

    test("reset sets available exactly and clears the escrow/payout buckets", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 80_000_000);
      await bal.transfer([stake(u, 30_000_000)]);
      await bal.transfer([win(u, 10_000_000)]);

      await bal.reset(u, "USD", 1_000_000);
      expect(await bal.get(u, "USD")).toBe(1_000_000);
      // A fresh stake draws against exactly the reset amount.
      expect(await bal.transfer([stake(u, 1_000_000)])).toBe(0);
      await expect(bal.transfer([stake(u, 1)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
    });

    // --- clawbacks (overdraw) ---------------------------------------------------------------

    test("a clawback the balance covers debits it like a stake", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 100_000_000);
      const c = clawback(u, 30_000_000);
      expect(await bal.transfer([c])).toBe(70_000_000);
      expect(await bal.transfer([c])).toBe(70_000_000);
      // No hidden debt: all of what's left is spendable.
      expect(await bal.transfer([stake(u, 70_000_000)])).toBe(0);
      await expect(bal.transfer([stake(u, 1)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
    });

    test("a clawback beyond the balance takes it negative", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 10_000_000);
      const c = clawback(u, 25_000_000);
      expect(await bal.transfer([c])).toBe(-15_000_000);
      expect(await bal.transfer([c])).toBe(-15_000_000);
      expect(await bal.get(u, "USD")).toBe(-15_000_000);
      // Another lands on top of the debt.
      expect(await bal.transfer([clawback(u, 5_000_000)])).toBe(-20_000_000);
    });

    test("a stake is refused while the balance is negative and moves nothing", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 10_000_000);
      await bal.transfer([clawback(u, 15_000_000)]);
      await expect(bal.transfer([stake(u, 1)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
      // Nor can a same-batch win fund it, even one that would clear the debt.
      await expect(bal.transfer([stake(u, 1_000_000), win(u, 50_000_000)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
      expect(await bal.get(u, "USD")).toBe(-5_000_000);
    });

    test("credits pay the debt down before any of it is spendable", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 10_000_000);
      await bal.transfer([clawback(u, 25_000_000)]);

      const w = win(u, 5_000_000);
      expect(await bal.transfer([w])).toBe(-10_000_000);
      expect(await bal.transfer([w])).toBe(-10_000_000);
      await expect(bal.transfer([stake(u, 1)])).rejects.toBeInstanceOf(ErrInsufficientBalance);

      const r = refund(u, 12_000_000);
      expect(await bal.transfer([r])).toBe(2_000_000);
      expect(await bal.transfer([r])).toBe(2_000_000);
      // Exactly what's left above the debt is spendable.
      await expect(bal.transfer([stake(u, 2_000_001)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
      expect(await bal.transfer([stake(u, 2_000_000)])).toBe(0);
    });

    test("reset clears a negative balance", async () => {
      const u = newUser();
      await bal.reset(u, "USD", 10_000_000);
      await bal.transfer([clawback(u, 25_000_000)]);

      await bal.reset(u, "USD", 50_000_000);
      expect(await bal.get(u, "USD")).toBe(50_000_000);
      expect(await bal.transfer([stake(u, 50_000_000)])).toBe(0);
      await expect(bal.transfer([stake(u, 1)])).rejects.toBeInstanceOf(ErrInsufficientBalance);
    });
  });
}
