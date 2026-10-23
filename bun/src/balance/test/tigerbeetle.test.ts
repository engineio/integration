import { randomUUIDv7 as uuid } from "bun";
import { beforeAll, describe, expect, test } from "bun:test";
import { type Client } from "tigerbeetle-node";
import { type Transfer } from "../index";
import { TigerBeetleBalance } from "../tigerbeetle";
import { sharedTigerBeetle } from "./container";

// TigerBeetle-specific checks; the behaviour both stores share is in balance.test.ts. The
// `owed` account is internal to TigerBeetleBalance, so these read the raw accounts.
describe("TigerBeetleBalance", () => {
  let client: Client;
  beforeAll(async () => {
    client = await sharedTigerBeetle();
  }, 120_000);

  const newUser = () => 1 + Math.floor(Math.random() * 2_147_483_646);

  // Mirrors TigerBeetleBalance.accountId: user << 64 | ledger << 32 | code, with USD on ledger
  // 38 and `available`/`owed` as codes 1/5.
  const accountId = (userId: number, code: bigint) => (BigInt(userId) << 64n) | (38n << 32n) | code;
  const raw = async (userId: number) => {
    const [available, owed] = [accountId(userId, 1n), accountId(userId, 5n)];
    const accounts = await client.lookupAccounts([available, owed]);
    const net = (id: bigint) => {
      const a = accounts.find((acc) => acc.id === id)!;
      return a.credits_posted - a.debits_posted;
    };
    return { available: net(available), owed: -net(owed) };
  };

  const win = (userId: number, amount: number): Transfer =>
    ({ userId, currency: "USD", amount, debit: "enginePayout", credit: "available", opKey: uuid() });
  const clawback = (userId: number, amount: number, opKey = uuid()): Transfer =>
    ({ userId, currency: "USD", amount, debit: "available", credit: "enginePayout", opKey, overdraw: true });

  test("a clawback's shortfall is debt on `owed`, repaid before available refills", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = newUser();
    await bal.reset(u, "USD", 10_000_000);

    const c = clawback(u, 25_000_000);
    await bal.transfer([c]);
    expect(await raw(u)).toEqual({ available: 0n, owed: 15_000_000n });
    await bal.transfer([c]); // the replay finds every leg `exists`
    expect(await raw(u)).toEqual({ available: 0n, owed: 15_000_000n });

    await bal.transfer([win(u, 5_000_000)]);
    expect(await raw(u)).toEqual({ available: 0n, owed: 10_000_000n });
    await bal.transfer([win(u, 12_000_000)]);
    expect(await raw(u)).toEqual({ available: 2_000_000n, owed: 0n });
  });

  test("a covered clawback borrows nothing net", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = newUser();
    await bal.reset(u, "USD", 100_000_000);
    await bal.transfer([clawback(u, 30_000_000)]);
    expect(await raw(u)).toEqual({ available: 70_000_000n, owed: 0n });
  });

  test("reset zeroes the debt", async () => {
    const bal = new TigerBeetleBalance(client);
    const u = newUser();
    await bal.reset(u, "USD", 10_000_000);
    await bal.transfer([clawback(u, 25_000_000)]);
    await bal.reset(u, "USD", 5_000_000);
    expect(await raw(u)).toEqual({ available: 5_000_000n, owed: 0n });
  });
});
