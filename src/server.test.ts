import { describe, it, expect, vi, type Mock } from "vitest";
import { pickBulkTier, getJson } from "./server.js";

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
