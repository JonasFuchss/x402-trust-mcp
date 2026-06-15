/**
 * Minimal x402 client payer for the MCP server's paid tools.
 *
 * Flow (matches our reseller + the verified Venice v2 wire format):
 *   1. POST the request with no payment → 402 + PAYMENT-REQUIRED header (or
 *      JSON body) describing accepts[0] = {network, asset, amount, payTo, extra}.
 *   2. Sign an EIP-3009 transferWithAuthorization over USDC for `amount` to
 *      `payTo`, valid for a short window.
 *   3. Re-POST with X-PAYMENT = base64(JSON payload). Server settles + responds.
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

/** Extract the first accept from a 402 response (header preferred, body fallback). */
export function parse402(headerB64: string | null, body: unknown): Accept | null {
  const tryObj = (o: unknown): Accept | null => {
    if (!o || typeof o !== "object") return null;
    const accepts = (o as { accepts?: unknown }).accepts;
    if (!Array.isArray(accepts) || accepts.length === 0) return null;
    const a = accepts[0] as Record<string, unknown>;
    const network = typeof a.network === "string" ? a.network : "";
    const asset = typeof a.asset === "string" ? a.asset : "";
    const amount = typeof a.amount === "string" ? a.amount : typeof a.maxAmountRequired === "string" ? a.maxAmountRequired : "";
    const payTo = typeof a.payTo === "string" ? a.payTo : "";
    if (!network || !asset || !amount || !payTo) return null;
    return {
      network,
      asset: asset as Address,
      amount,
      payTo: payTo as Address,
      ...(a.extra && typeof a.extra === "object" ? { extra: a.extra as { name?: string; version?: string } } : {}),
    };
  };
  if (headerB64) {
    try {
      const decoded = JSON.parse(Buffer.from(headerB64, "base64").toString("utf8"));
      const a = tryObj(decoded);
      if (a) return a;
    } catch {
      /* fall through to body */
    }
  }
  return tryObj(body);
}

/** Build the base64 X-PAYMENT header by signing EIP-3009 for the accept. */
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
    scheme: "exact",
    network: accept.network,
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

  const xPayment = await signPayment(opts.privateKey, accept);
  const second = await doPost({ "X-PAYMENT": xPayment });
  let paymentResponse: unknown;
  const prHeader = second.headers.get("x-payment-response");
  if (prHeader) {
    try {
      paymentResponse = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8"));
    } catch {
      /* ignore */
    }
  }
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
