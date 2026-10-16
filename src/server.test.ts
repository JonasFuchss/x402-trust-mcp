import { describe, it, expect, vi, type Mock } from "vitest";
import { pickBulkTier, getJson, autoPayFailureHint } from "./server.js";

describe("autoPayFailureHint (P2-5)", () => {
  // MAX_USD defaults to 0.05 in tests (X402_MAX_USD unset).
  it("names the cap only when the quote strictly exceeds it", () => {
    expect(autoPayFailureHint(0.2, { error: "payment required; auto-pay disabled" })).toMatch(/exceeds your per-call cap/);
  });
  it("does NOT claim 'exceeds' when quote equals the cap", () => {
    // 0.05 == cap → not an over-cap; falls through to a non-cap reason.
    expect(autoPayFailureHint(0.05, { error: "insufficient_funds", payer: "0xabc" })).not.toMatch(/exceeds/);
  });
  it("detects insufficient funds and surfaces the payer", () => {
    const h = autoPayFailureHint(0.04, { errorReason: "insufficient_funds", payer: "0xdeadbeef" });
    expect(h).toMatch(/balance too low/);
    expect(h).toContain("0xdeadbeef");
  });
  it("names the local pre-check refusal (no payment attempted, top-up works immediately)", () => {
    const h = autoPayFailureHint(0.04, {
      error: "auto-pay blocked: the payer wallet 0xabc holds 0.004000 USDC ...",
      reason: "insufficient_funds_local",
    });
    expect(h).toMatch(/balance checked before signing/);
    expect(h).toMatch(/takes effect immediately/);
    // The marker embeds "insufficient_funds"; the hint must NOT degrade to
    // the generic settle-failure funds branch.
    expect(h).not.toMatch(/balance too low/);
  });
  it("warns reconcile-first on an uncertain settlement, never a blind retry", () => {
    const h = autoPayFailureHint(0.04, {
      error: "payment settlement outcome is uncertain: ...",
      reason: "settlement_uncertain",
      txHash: "0xabc",
    });
    expect(h).toMatch(/may have landed on-chain/);
    expect(h).toMatch(/Reconcile the transaction/);
    expect(h).toMatch(/can charge you twice/);
  });
  it("detects a session spend/call-count guard", () => {
    expect(autoPayFailureHint(0.04, { error: "cumulative spend cap reached ($0.04 + $0.04 > $0.05)" })).toMatch(/spend\/call-count guard/);
  });
  it("detects the asset/chain safety guard", () => {
    expect(autoPayFailureHint(0.04, { error: "unsafe payment quote: asset 0x.. is not canonical USDC" })).toMatch(/safety guard/);
  });
  it("falls back to a detail-pointer for unknown reasons", () => {
    expect(autoPayFailureHint(0.04, { error: "some novel error" })).toMatch(/See detail/);
  });
});

describe("pickBulkTier", () => {
  const cases: [number, number | undefined, number][] = [
    [1, undefined, 10],
    [10, undefined, 10],
    [11, undefined, 50],
    [50, undefined, 50],
    [51, undefined, 100],
    [100, undefined, 100],
    [101, undefined, 200],
    [200, undefined, 200],
    [201, undefined, 500],
    [500, undefined, 500],
    [5, 10, 10],
    [5, 50, 50],
    [100, 200, 200],
  ];
  for (const [count, requested, expectedMax] of cases) {
    it(`selects tier ${expectedMax} for count=${count} tier=${requested}`, () => {
      const tier = pickBulkTier(count, requested);
      expect(tier.max).toBe(expectedMax);
    });
  }

  it("rejects counts above the largest tier", () => {
    expect(() => pickBulkTier(501, undefined)).toThrow("too many resources");
  });

  it("rejects invalid fixed tiers", () => {
    expect(() => pickBulkTier(1, 123 as unknown as number)).toThrow("invalid tier");
  });

  it("rejects fixed tier when count exceeds its capacity", () => {
    expect(() => pickBulkTier(11, 10)).toThrow("tier 10 accepts at most 10 resources");
  });
});

describe("getJson", () => {
  it("passes custom headers and query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await getJson("/v1/watch/ABC/events", {
      headers: { Authorization: "Bearer secret" },
      params: { since: "event-42", page: 1 },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/watch/ABC/events");
    expect(url).toContain("since=event-42");
    expect(url).toContain("page=1");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret", accept: "application/json" });
  });

  it("omits empty params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    } as unknown as Response);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await getJson("/trust/stats", { params: { since: "" } });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("since");
  });
});
