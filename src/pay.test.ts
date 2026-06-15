import { describe, it, expect } from "vitest";
import { parse402, signPayment, type Accept } from "./pay.js";

const ACCEPT_BODY = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "5000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xbBECBE90F28632a9d52ed67b33b43767b8c89285",
      maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o), "utf8").toString("base64");
}

describe("parse402", () => {
  it("parses from the PAYMENT-REQUIRED header", () => {
    const a = parse402(b64(ACCEPT_BODY), null);
    expect(a).not.toBeNull();
    expect(a!.amount).toBe("5000");
    expect(a!.payTo).toBe("0xbBECBE90F28632a9d52ed67b33b43767b8c89285");
    expect(a!.extra?.name).toBe("USD Coin");
  });

  it("falls back to the JSON body when no header", () => {
    const a = parse402(null, ACCEPT_BODY);
    expect(a?.amount).toBe("5000");
  });

  it("accepts the v1 maxAmountRequired field name", () => {
    const v1 = { accepts: [{ ...ACCEPT_BODY.accepts[0], amount: undefined, maxAmountRequired: "12500" }] };
    const a = parse402(null, v1);
    expect(a?.amount).toBe("12500");
  });

  it("returns null on a malformed envelope", () => {
    expect(parse402(null, { nope: true })).toBeNull();
    expect(parse402("%%%", { accepts: [] })).toBeNull();
  });
});

describe("signPayment", () => {
  // Throwaway test key (well-known anvil key #0 — never funded in prod).
  const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;

  it("produces a valid base64 x402 v2 payload", async () => {
    const accept: Accept = {
      network: "eip155:8453",
      amount: "5000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0xbBECBE90F28632a9d52ed67b33b43767b8c89285",
      extra: { name: "USD Coin", version: "2" },
    };
    const header = await signPayment(KEY, accept);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("eip155:8453");
    expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
    const auth = decoded.payload.authorization;
    expect(auth.to).toBe(accept.payTo);
    expect(auth.value).toBe("5000");
    expect(auth.from).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"); // anvil #0 address
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a non-EVM network", async () => {
    await expect(
      signPayment(KEY, {
        network: "solana:xyz",
        amount: "1",
        asset: "0x0" as `0x${string}`,
        payTo: "0x0" as `0x${string}`,
      }),
    ).rejects.toThrow(/unsupported network/);
  });
});
