import { randomUUIDv7 as uuid } from "bun";
import { describe, expect } from "bun:test";
import { createSign } from "node:crypto";
import { walletTest } from "./harness";
import { signed, testPrivateKey } from "./helpers";

// Cross-cutting behaviour of the router/wrapper itself (signature auth, body validation,
// health, unknown routes) rather than any one handler.

describe("auth", () => {
  walletTest("rejects a missing signature", async ({ call }) => {
    const { status, body } = await call("/v1/balance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: uuid() }),
    });
    expect(status).toBe(401);
    expect(body.code).toBe("ERR_ATE");
  });

  walletTest("rejects an invalid signature", async ({ call }) => {
    const { status, body } = await call("/v1/balance", {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": "bogus" },
      body: JSON.stringify({ token: uuid() }),
    });
    expect(status).toBe(401);
    expect(body.code).toBe("ERR_ATE");
  });
});

describe("request validation", () => {
  walletTest("ERR_BAD when the body fails schema validation", async ({ call }) => {
    const { status, body } = await call("/v1/balance", signed({})); // missing `token`
    expect(status).toBe(400);
    expect(body.code).toBe("ERR_BAD");
  });

  walletTest("ERR_BAD when an id field isn't a UUID (format: uuid)", async ({ call }) => {
    const { status, body } = await call("/v1/balance", signed({ token: "not-a-uuid" }));
    expect(status).toBe(400);
    expect(body.code).toBe("ERR_BAD");
  });

  walletTest("ERR_BAD on a (validly signed) non-JSON body", async ({ base }) => {
    const raw = "not json";
    const signature = createSign("RSA-SHA256").update(raw).sign(testPrivateKey, "base64");
    const res = await fetch(`${base}/v1/balance`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": signature },
      body: raw,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("ERR_BAD");
  });

  walletTest("unknown route returns 404", async ({ base }) => {
    const res = await fetch(`${base}/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("health", () => {
  walletTest("GET /health returns ok", async ({ base }) => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
