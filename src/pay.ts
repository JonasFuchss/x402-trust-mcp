/**
 * Minimal x402 client payer for the MCP server's paid tools.
 *
 * Flow (canonical x402 V2):
 *   1. POST the request with no payment → 402 + PAYMENT-REQUIRED header (or
 *      JSON body) describing accepts[0] = {network, asset, amount, payTo, extra}.
 *   2. Sign an EIP-3009 transferWithAuthorization over USDC for `amount` to
 *      `payTo`, valid for a short window.
 *   3. Re-POST with PAYMENT-SIGNATURE = base64(JSON payload). Server settles + responds.
 *
 * Legacy X-PAYMENT header is accepted as a fallback during the transition period.
 *
 * Auto-pay is OFF unless the agent operator provides X402_PRIVATE_KEY. Without
 * it, the paid tools return the quote so the agent's own wallet/host can pay.
 */
import { signTypedData } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Accept {
  scheme?: string;
  network: string; // CAIP-2, e.g. "eip155:8453"
  asset: Address;
  amount: string; // USDC base units
  payTo: Address;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

export interface PaymentQuote {
  amountUsd: number;
  accept: Accept;
}

function parseCaip2ChainId(slug: string): number | null {
  const m = /^eip155:(\d+)$/.exec(slug);
  return m && m[1] ? Number(m[1]) : null;
}

/** Canonical USDC contract per supported chain. The signed EIP-712
 * `verifyingContract` MUST be one of these — a malicious 402 cannot point us at
 * an arbitrary token. */
export const KNOWN_USDC: Record<number, Address> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

/** Chains we will sign payments on. Base mainnet only by default. */
export const ALLOWED_CHAIN_IDS: number[] = [8453];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface PaymentGuard {
  /** chain ids we'll sign on (default ALLOWED_CHAIN_IDS) */
  allowedChainIds?: number[];
  /** if set, payTo must be one of these addresses */
  allowedPayTo?: Address[];
}

/**
 * Validate a parsed 402 quote before signing anything. A 402 response is fully
 * attacker-controlled (it decides asset/payTo/chain/amount), so we refuse to
 * sign unless: the chain is allow-listed, the asset is the canonical USDC for
 * that chain, addresses are well-formed, and (optionally) payTo is allow-listed.
 * Returns null if safe, or a reason string to reject.
 */
export function validateAccept(accept: Accept, guard: PaymentGuard = {}): string | null {
  const chainId = parseCaip2ChainId(accept.network);
  if (chainId === null) return `unsupported (non-eip155) network: ${accept.network}`;
  const allowedChains = guard.allowedChainIds ?? ALLOWED_CHAIN_IDS;
  if (!allowedChains.includes(chainId)) {
    return `chain ${chainId} not in allow-list [${allowedChains.join(",")}]`;
  }
  if (!ADDRESS_RE.test(accept.asset)) return `asset is not a valid address: ${accept.asset}`;
  if (!ADDRESS_RE.test(accept.payTo)) return `payTo is not a valid address: ${accept.payTo}`;
  const expectedUsdc = KNOWN_USDC[chainId];
  if (!expectedUsdc || !eqAddr(accept.asset, expectedUsdc)) {
    return `asset ${accept.asset} is not canonical USDC for chain ${chainId}`;
  }
  if (guard.allowedPayTo && guard.allowedPayTo.length > 0) {
    if (!guard.allowedPayTo.some((p) => eqAddr(p, accept.payTo))) {
      return `payTo ${accept.payTo} not in allow-list`;
    }
  }
  if (!/^\d+$/.test(accept.amount)) return `amount is not an integer string: ${accept.amount}`;
  return null;
}

/** Default EIP-712 domain per chain (USDC). Overridable via accept.extra. */
function domainFor(chainId: number, extra?: { name?: string; version?: string }): { name: string; version: string } {
  if (extra?.name && extra.version) return { name: extra.name, version: extra.version };
  if (chainId === 8453) return { name: "USD Coin", version: "2" };
  if (chainId === 84532) return { name: "USDC", version: "2" };
  return { name: "USD Coin", version: "2" };
}

function freshNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** Extract all accepts from a 402 response (header preferred, body fallback).
 *  Returns the full list so the caller can select the best compatible one. */
export function parseAllAccepts(headerB64: string | null, body: unknown): Accept[] {
  const tryObj = (o: unknown): Accept[] => {
    if (!o || typeof o !== "object") return [];
    const accepts = (o as { accepts?: unknown }).accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) return [];
    const result: Accept[] = [];
    for (const a of accepts) {
      const r = a as Record<string, unknown>;
      const network = typeof r.network === "string" ? r.network : "";
      const asset = typeof r.asset === "string" ? r.asset : "";
      const amount = typeof r.amount === "string" ? r.amount : typeof r.maxAmountRequired === "string" ? r.maxAmountRequired : "";
      const payTo = typeof r.payTo === "string" ? r.payTo : "";
      if (!network || !asset || !amount || !payTo) continue;
      result.push({
        network,
        asset: asset as Address,
        amount,
        payTo: payTo as Address,
        ...(r.maxTimeoutSeconds && typeof r.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: r.maxTimeoutSeconds } : {}),
        ...(r.extra && typeof r.extra === "object" ? { extra: r.extra as { name?: string; version?: string } } : {}),
      });
    }
    return result;
  };
  if (headerB64) {
    try {
      const decoded = JSON.parse(Buffer.from(headerB64, "base64").toString("utf8"));
      const list = tryObj(decoded);
      if (list.length > 0) return list;
    } catch {
      /* fall through to body */
    }
  }
  return tryObj(body);
}

/** Select the best compatible accept from a list, preferring mainnet + lowest amount. */
export function selectBestAccept(accepts: Accept[]): Accept | null {
  if (accepts.length === 0) return null;
  // Filter to accepts that pass validation (allow-listed chain + canonical USDC)
  const compatible = accepts.filter((a) => validateAccept(a) === null);
  if (compatible.length === 0) return null;
  // Sort: prefer mainnet (8453) over testnet, then lowest amount
  compatible.sort((a, b) => {
    const aMainnet = a.network === "eip155:8453" ? 0 : 1;
    const bMainnet = b.network === "eip155:8453" ? 0 : 1;
    if (aMainnet !== bMainnet) return aMainnet - bMainnet;
    const aAmt = BigInt(a.amount);
    const bAmt = BigInt(b.amount);
    if (aAmt !== bAmt) return aAmt < bAmt ? -1 : 1;
    return 0;
  });
  return compatible[0]!;
}

/** Extract the best compatible accept from a 402 response (header preferred, body fallback).
 *  Replaces the old parse402 which only took the first accept. */
export function parse402(headerB64: string | null, body: unknown): Accept | null {
  const all = parseAllAccepts(headerB64, body);
  return selectBestAccept(all);
}

/** Build the base64 PAYMENT-SIGNATURE header by signing EIP-3009 for the accept.
 * Produces a canonical V2 payload with the `accepted` wrapper. */
export async function signPayment(privateKey: Hex, accept: Accept): Promise<string> {
  const chainId = parseCaip2ChainId(accept.network);
  if (chainId === null) throw new Error(`unsupported network: ${accept.network}`);
  const account = privateKeyToAccount(privateKey);
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: accept.payTo,
    value: accept.amount,
    validAfter: "0",
    validBefore: String(now + (accept.maxTimeoutSeconds ?? 60)),
    nonce: freshNonce(),
  };
  const domain = domainFor(chainId, accept.extra);
  const signature = await signTypedData({
    privateKey,
    domain: { name: domain.name, version: domain.version, chainId, verifyingContract: accept.asset },
    types: TRANSFER_WITH_AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to as Address,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: accept.scheme ?? "exact",
      network: accept.network,
      amount: accept.amount,
      asset: accept.asset,
      payTo: accept.payTo,
      ...(accept.maxTimeoutSeconds ? { maxTimeoutSeconds: accept.maxTimeoutSeconds } : {}),
      ...(accept.extra ? { extra: accept.extra } : {}),
    },
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export interface PaidCallResult {
  paid: boolean;
  status: number;
  data: unknown;
  quote?: PaymentQuote;
  paymentResponse?: unknown;
}

/**
 * Process-lifetime spend tracker. A per-call ceiling alone can't stop an agent
 * (or a compromised server) from draining a funded wallet $0.05 at a time over
 * unlimited calls, so we also enforce a cumulative cap and a call-count cap.
 */
export class SpendTracker {
  private spentUsd = 0;
  private calls = 0;
  constructor(
    private readonly maxTotalUsd: number,
    private readonly maxCalls: number,
  ) {}
  /** Returns a reason string if this charge would breach a cap, else null. */
  check(amountUsd: number): string | null {
    if (this.maxCalls > 0 && this.calls + 1 > this.maxCalls) {
      return `call cap reached (${this.maxCalls} paid calls this session)`;
    }
    if (this.maxTotalUsd > 0 && this.spentUsd + amountUsd > this.maxTotalUsd) {
      return `cumulative spend cap reached ($${this.spentUsd.toFixed(
        4,
      )} + $${amountUsd} > $${this.maxTotalUsd})`;
    }
    return null;
  }
  record(amountUsd: number): void {
    this.spentUsd += amountUsd;
    this.calls += 1;
  }
  get totalSpentUsd(): number {
    return this.spentUsd;
  }
}

/**
 * POST a paid endpoint, auto-paying if `privateKey` is set and the quote is
 * within `maxAmountUsd`. Returns the data on success, or the quote (paid:false)
 * when auto-pay is disabled or the price exceeds the ceiling.
 */
export async function paidPost(opts: {
  url: string;
  body: unknown;
  privateKey?: Hex;
  maxAmountUsd: number;
  timeoutMs: number;
  /** SSRF/asset/chain guard applied to the 402 quote before signing. */
  guard?: PaymentGuard;
  /** process-lifetime cumulative spend + call-count cap. */
  spendTracker?: SpendTracker;
}): Promise<PaidCallResult> {
  const doPost = (headers: Record<string, string>): Promise<Response> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    return fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(opts.body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
  };

  const first = await doPost({});
  if (first.status !== 402) {
    return { paid: false, status: first.status, data: await safeJson(first) };
  }

  const accept = parse402(first.headers.get("payment-required"), await safeJson(first));
  if (!accept) {
    return { paid: false, status: 402, data: { error: "could not parse 402 quote" } };
  }
  const amountUsd = Number(accept.amount) / 1_000_000;
  const quote: PaymentQuote = { amountUsd, accept };

  if (!opts.privateKey) {
    return { paid: false, status: 402, data: { error: "payment required; auto-pay disabled" }, quote };
  }
  if (amountUsd > opts.maxAmountUsd) {
    return {
      paid: false,
      status: 402,
      data: { error: `quote $${amountUsd} exceeds maxAmountUsd $${opts.maxAmountUsd}` },
      quote,
    };
  }

  // Refuse to sign a quote pointing at an unexpected asset/chain/recipient.
  const guardReason = validateAccept(accept, opts.guard);
  if (guardReason) {
    return { paid: false, status: 402, data: { error: `unsafe payment quote: ${guardReason}` }, quote };
  }

  // Enforce the process-lifetime cumulative + call-count caps.
  if (opts.spendTracker) {
    const capReason = opts.spendTracker.check(amountUsd);
    if (capReason) {
      return { paid: false, status: 402, data: { error: capReason }, quote };
    }
  }

  const xPayment = await signPayment(opts.privateKey, accept);
  const second = await doPost({ "PAYMENT-SIGNATURE": xPayment });
  let paymentResponse: unknown;
  const prHeader = second.headers.get("payment-response") ?? second.headers.get("x-payment-response");
  if (prHeader) {
    try {
      paymentResponse = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8"));
    } catch {
      /* ignore */
    }
  }
  // Count the spend only once the server actually accepted the payment.
  if (second.ok && opts.spendTracker) opts.spendTracker.record(amountUsd);

  return {
    paid: second.ok,
    status: second.status,
    data: await safeJson(second),
    quote,
    ...(paymentResponse ? { paymentResponse } : {}),
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { error: `non-JSON response (status ${res.status})` };
  }
}
