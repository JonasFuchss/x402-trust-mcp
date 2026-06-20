import { describe, it, expect } from "vitest";
import { parse402, signPayment, validateAccept, SpendTracker, type Accept } from "./pay.js";

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

describe("parse402 multi-accept selection", () => {
  it("chooses the compatible Base USDC accept, not the first (Solana) accept", () => {
    const body = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          amount: "1000",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          payTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA3Xa9EGQx",
        },
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "5000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xbBECBE90F28632a9d52ed67b33b43767b8c89285",
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const a = parse402(null, body);
    expect(a).not.toBeNull();
    expect(a!.network).toBe("eip155:8453");
    expect(a!.amount).toBe("5000");
  });

  it("returns null when no accept is compatible with the client", () => {
    const body = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:137",
          amount: "1000",
          asset: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
          payTo: "0x1234567890123456789012345678901234567890",
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const a = parse402(null, body);
    // Polygon is not in the default allow-list → no compatible accept
    expect(a).toBeNull();
  });

  it("prefers mainnet over testnet when both are compatible", () => {
    const body = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "1000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0xbBECBE90F28632a9d52ed67b33b43767b8c89285",
          extra: { name: "USDC", version: "2" },
        },
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "5000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0xbBECBE90F28632a9d52ed67b33b43767b8c89285",
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const a = parse402(null, body);
    expect(a).not.toBeNull();
    expect(a!.network).toBe("eip155:8453");
  });
});

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
    // Canonical V2: scheme/network live inside `accepted`, not at root
    expect(decoded.accepted).toBeDefined();
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.accepted.network).toBe("eip155:8453");
    expect(decoded.accepted.amount).toBe("5000");
    expect(decoded.accepted.asset).toBe(accept.asset);
    expect(decoded.accepted.payTo).toBe(accept.payTo);
    expect(decoded.accepted.extra).toEqual({ name: "USD Coin", version: "2" });
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

describe("validateAccept", () => {
  const good: Accept = {
    network: "eip155:8453",
    amount: "5000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xbBECBE90F28632a9d52ed67b33b43767b8c89285",
  };

  it("accepts canonical Base USDC on an allow-listed chain", () => {
    expect(validateAccept(good)).toBeNull();
  });

  it("rejects a non-canonical asset (fake token)", () => {
    const r = validateAccept({ ...good, asset: "0x1111111111111111111111111111111111111111" });
    expect(r).toMatch(/not canonical USDC/);
  });

  it("rejects a non-allow-listed chain", () => {
    const r = validateAccept({ ...good, network: "eip155:1" });
    expect(r).toMatch(/not in allow-list/);
  });

  it("rejects a malformed payTo / asset", () => {
    expect(validateAccept({ ...good, payTo: "0xdeadbeef" as `0x${string}` })).toMatch(/payTo/);
    expect(validateAccept({ ...good, asset: "nope" as `0x${string}` })).toMatch(/asset/);
  });

  it("enforces an explicit payTo allow-list when provided", () => {
    expect(
      validateAccept(good, { allowedPayTo: ["0x0000000000000000000000000000000000000001"] }),
    ).toMatch(/not in allow-list/);
    expect(validateAccept(good, { allowedPayTo: [good.payTo] })).toBeNull();
  });

  it("can allow Base Sepolia via guard override with its USDC", () => {
    const sep: Accept = {
      ...good,
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    };
    expect(validateAccept(sep, { allowedChainIds: [84532] })).toBeNull();
  });
});

describe("SpendTracker", () => {
  it("enforces a cumulative spend cap", () => {
    const t = new SpendTracker(0.1, 0);
    expect(t.check(0.05)).toBeNull();
    t.record(0.05);
    expect(t.check(0.05)).toBeNull();
    t.record(0.05);
    expect(t.check(0.01)).toMatch(/cumulative spend cap/);
    expect(t.totalSpentUsd).toBeCloseTo(0.1);
  });

  it("enforces a call-count cap", () => {
    const t = new SpendTracker(0, 2);
    expect(t.check(1)).toBeNull();
    t.record(1);
    t.record(1);
    expect(t.check(1)).toMatch(/call cap/);
  });

  it("treats 0 caps as unlimited", () => {
    const t = new SpendTracker(0, 0);
    for (let i = 0; i < 100; i++) t.record(1000);
    expect(t.check(1_000_000)).toBeNull();
  });
});
