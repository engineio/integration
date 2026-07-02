import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { type Transfer } from "../index";
import { PostgresBalance } from "../postgres";

describe("PostgresBalance", () => {
  // The Postgres ledger derives op_ts = uuid_extract_timestamp(op_key), so it requires UUIDv7
  // op keys. transfer() asserts this before touching the DB, so the guard needs no database —
  // a valid-but-non-v7 UUID (here a v4) is rejected up front.
  test("transfer rejects a non-v7 op key", async () => {
    const bal = new PostgresBalance({} as unknown as SQL);
    const movement: Transfer = {
      userId: 1, currency: "USD", amount: 1_000, debit: "available", credit: "engineBet",
      opKey: crypto.randomUUID(), // UUIDv4
    };
    await expect(bal.transfer([movement])).rejects.toThrow(/UUIDv7/);
  });
});
