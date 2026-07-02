import { describe, expect } from "bun:test";
import { walletTest } from "./harness";
import { signed } from "./helpers";

describe("dev session", () => {
  walletTest("mints a funded session the wallet accepts", async ({ call }) => {
    const minted = await call("/v1/dev/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currency: "USD", balance: 250_000_000 }),
    });
    expect(minted.status).toBe(200);
    expect(minted.body.balance).toBe(250_000_000);
    expect(typeof minted.body.token).toBe("string");

    const bal = await call("/v1/balance", signed({ token: minted.body.token }));
    expect(bal.status).toBe(200);
    expect(bal.body.balance).toEqual({ amount: 250_000_000, currency: "USD" });
  });
});
