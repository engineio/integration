import type { FromSchema } from "json-schema-to-ts";

/**
 * A UUID string. `format: "uuid"` validates the RFC-4122 shape (ANY version) — matching what the
 * bet ledger's `::uuid` columns accept — and rejects malformed ids at the request boundary with
 * ERR_BAD rather than a deep cast error. It deliberately does NOT pin a version: the RGS may send
 * any UUID version, and the wallet uses its own bet-ledger transaction ids (UUIDv7) as the balance key.
 * JSON Schema can't express "must be v7" via `format` anyway — that needs a `pattern` regex, which
 * we apply internally on the key we mint (the PostgresBalance guard), not on RGS-supplied input.
 */
export const UuidSchema = { type: "string", format: "uuid" } as const;

/** The session token: opaque on the wire, so it isn't shape-checked here — a token we never
 *  issued, whatever it looks like, is ERR_IS (a non-UUID one fails the lookup's cast). */
export const TokenSchema = { type: "string" } as const;

/**
 * Currencies this example supports — a subset of Engine's list. The RGS sends the
 * currency the session was launched with, so launch (and run the conformance suite)
 * only in these. Amounts are integer micro-units (1_000_000 = 1.00 of the currency).
 */
export const EngineCurrencySchema = {
  type: "string",
  enum: [
    "AED", "ARS", "BHD", "BAM", "BRL", "CAD", "CLP", "CNY", "CRC", "DKK",
    "EUR", "GHS", "IDR", "ILS", "INR", "ISK", "JOD", "JPY", "KES", "KRW",
    "KWD", "MAD", "MXN", "MYR", "NGN", "NOK", "OMR", "PEN", "PHP", "PLN",
    "QAR", "RUB", "SAR", "SGD", "TND", "TRY", "TWD", "USD", "VND", "NZD",
    "HUF", "KZT", "EGP", "THB", "KHR", "PKR", "BDT", "ZAR", "UZS", "XOF",
    "XAF", "MWK", "RWF", "TZS", "UGX", "ZMW", "BOB", "GTQ", "XSC", "XGC",
  ],
} as const;

export type EngineCurrency = FromSchema<typeof EngineCurrencySchema>;

/** The balance object returned in every wallet response. */
export const BalanceResponseSchema = {
  type: "object",
  required: ["amount", "currency"],
  additionalProperties: false,
  properties: {
    amount: { type: "number" },
    currency: EngineCurrencySchema,
  },
} as const;
