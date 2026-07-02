import { randomUUIDv7 as uuid } from "bun";
import { describe, expect } from "bun:test";
import { walletTest } from "./harness";
import { signed } from "./helpers";

describe("credit", () => {
  walletTest("closes the bet and pays the win", async ({ call, session }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", signed({ token: s.token, round: 10, active: true, mode: "base", ip: "1.1.1.1", debit: { id: debitId, amount: 10_000_000, currency: "USD" } }));
    const { status, body } = await call(
      "/v1/credit",
      signed({ token: s.token, round: 10, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 30_000_000, ref: debitId, currency: "USD" } }),
    );
    expect(status).toBe(200);
    // 100 - 10 + 30 = 120
    expect(body.balance.amount).toBe(120_000_000);
  });

  walletTest("closes a losing round (no win), stake not returned", async ({ call, session }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", signed({ token: s.token, round: 12, active: true, mode: "base", ip: "1.1.1.1", debit: { id: debitId, amount: 10_000_000, currency: "USD" } }));
    const { status, body } = await call("/v1/credit", signed({ token: s.token, round: 12, active: false, ip: "1.1.1.1" }));
    expect(status).toBe(200);
    // A losing round pays no win, so no credit_id is returned.
    expect(body.credit_id).toBeUndefined();
    expect(body.balance.amount).toBe(90_000_000);
  });

  walletTest("is idempotent on replay", async ({ call, session }) => {
    const s = await session(100_000_000);
    const debitId = uuid();
    await call("/v1/debit", signed({ token: s.token, round: 11, active: true, mode: "base", ip: "1.1.1.1", debit: { id: debitId, amount: 10_000_000, currency: "USD" } }));
    const credit = { token: s.token, round: 11, active: false, ip: "1.1.1.1", credit: { id: uuid(), amount: 30_000_000, ref: debitId, currency: "USD" } };
    const first = (await call("/v1/credit", signed(credit))).body;
    const second = (await call("/v1/credit", signed(credit))).body;
    expect(second.balance.amount).toBe(120_000_000);
    expect(second.credit_id).toBe(first.credit_id);
  });

  walletTest("ERR_BNF for an unknown round", async ({ call, session }) => {
    const s = await session();
    const { status, body } = await call("/v1/credit", signed({ token: s.token, round: 99_999, active: false, ip: "1.1.1.1" }));
    expect(status).toBe(404);
    expect(body.code).toBe("ERR_BNF");
  });
});
