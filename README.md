[![x402-trust-mcp MCP server](https://glama.ai/mcp/servers/JonasFuchss/x402-trust-mcp/badges/card.svg)](https://glama.ai/mcp/servers/JonasFuchss/x402-trust-mcp)

# x402-trust-mcp

An [MCP](https://modelcontextprotocol.io) server that lets your agent check the
**trust & reliability of x402 endpoints before paying them**.

Backed by [x402-trust.com](https://x402-trust.com), which monitors the entire
x402 ecosystem on Base 24/7: uptime probes, 402-envelope spec compliance,
advertised-price history, and **real on-chain USDC settlement volume** per
endpoint.

## Why

Agents increasingly pay x402 endpoints autonomously. But ~⅔ of listed x402
endpoints are unreachable and ~⅓ of the reachable ones serve non-compliant
payment envelopes. Before your agent sends USDC to an unknown endpoint, ask:
*is it alive, compliant, and does anyone actually pay it?*

## Tools

| Tool | Cost | Description |
|---|---|---|
| `x402_ecosystem_stats` | free | Aggregate state of the x402 ecosystem (listings, reachability, compliance, 30d settlement volume). |
| `x402_trust_leaderboard` | free | Top-25 most trustworthy x402 endpoints. |
| `x402_trust_preview` | free | Showcase of what `x402_trust_score` returns — you don't choose the endpoint. Returns the **complete** paid-grade report (exact score, full breakdown, advertised price, on-chain settlement figures, all flags) for **three** endpoints: the best-scored, the median, and the worst-scored. See the full data shape across the quality range before you pay. To score *your own* endpoint, use `x402_trust_score` (paid). Takes no arguments. |
| `x402_trust_score` | paid | Trust score (0-100, grade A-F) for a specific endpoint, plus the provider-advertised `serviceName` and `description` (unverified provider claims, shown next to our independent metrics), provider verification fields (`providerVerified`, `providerName`, `providerContact`), a machine-readable pay/don't-pay verdict, the advertised price, a confidence band, and structured flags — everything to decide in one call. The call also refreshes the endpoint's free public snapshot (page, badge, card) immediately. |
| `x402_endpoint_history` | paid | Observation time-series for a specific endpoint (listings, price changes, probes). |
| `x402_find_alternatives` | paid | Find semantically-similar endpoints that OUT-SCORE a given one. Use this to route away from a mediocre/dead/expensive endpoint toward a more reliable, better-settled one serving the same function. Each alternative carries score, grade, similarity (0-1), price, and a free per-endpoint page. |
| `x402_semantic_search` | paid | Free-text semantic search across the whole monitored catalog. Describe the capability you need in plain words, get the up to 25 closest endpoints ranked deterministically: cosine similarity bucketed to whole percentage points first (80.3% and 80.5% tie), then trust score, then described-before-undescribed, then id; matches below a 0.5 similarity floor are dropped. Missing description: no fixed malus, only the tiebreak loss at equal bucket + score (fallback embedding via service name + URL path tokens usually lowers similarity). Each match has resource, score, grade, similarity, description, and a free per-endpoint page. Discovery only: no verdicts or flag details (that is `x402_trust_score`). |
| `x402_trust_bulk` | paid | Score up to 500 endpoints in a single paid call from cached full-density snapshots. Picks the cheapest tier that fits your list (10/50/100/200/500). Returns score, grade, recommendation, confidence, and `probed_at` per endpoint. Recomputed rows also refresh the endpoints' free public snapshots (page, badge, card). |
| `x402_watch_create` | paid | Start monitoring one endpoint for 30 days. Alerts on payTo change (takeover signal), price/asset/network change, spec regression, delisting, and liveness. Supports up to 5 webhook + 5 Slack/Discord URLs per watch, all connection-tested before payment. Returns a one-time bearer secret + poll/edit/cancel URLs + `next_steps`. |
| `x402_watch_events` | free | Poll the append-only event log of an active watch using the watch id and one-time secret. Use the `since` (endpoint events) and `watch_since` (lifecycle events) cursors to page forward; nothing between polls is lost. |
| `x402_watch_edit` | free | Change a watch's webhook/Slack URLs, liveness sensitivity, or subscribed events. Bearer-authed with the secret from `x402_watch_create`. |
| `x402_watch_cancel` | free | Soft-cancel a watch: drops the endpoint back to normal probe cadence immediately, but the event log stays readable via `x402_watch_events` until the original `expires_at`. |
| `x402_watch_renew` | paid | Extend an active watch by another 30 days. The secret stays the same. |

Paid tools cost from **$0.001** (a semantic search) or **$0.005** (a single
trust / similar lookup) up to **~$0.50** (500-endpoint bulk batch) or **~$0.20**
for a 30-day watch, charged over x402 (USDC on Base). If you set
`X402_PRIVATE_KEY`, the server **auto-pays** within your `X402_MAX_USD` limit;
otherwise it returns the price quote for your host to pay.

### Bulk scoring (`x402_trust_bulk`)

The bulk tool is the scale axis: score up to 500 endpoints in one call from the
same data that powers the leaderboard. It auto-selects the cheapest tier that
fits your request:

| Tier | Max endpoints | Approx. price |
|---|---|---|
| 10 | 10 | ~$0.045 |
| 50 | 50 | ~$0.20 |
| 100 | 100 | ~$0.325 |
| 200 | 200 | ~$0.40 |
| 500 | 500 | ~$0.50 |

Cached rows older than ~15 minutes are recomputed on-demand from the latest
stored probes and settlements (no live network re-probe), so bulk scores usually
reflect reality within minutes. Per-request recompute limits apply: at most **50
rows / 8 seconds** are recomputed; the response tells you via
`recompute_limit_hit` + `recompute_limit`. Each result carries `score`, `grade`,
`recommendation`, `confidence`, `probed_at`, `computed_at`, and `recomputed` so
you can see exactly which rows were freshly computed vs served from cache. URLs
not in the observation set return `found: false`; you still pay for the batch.

### Finding better alternatives (`x402_find_alternatives`)

Before paying an unknown endpoint, check whether a better-tested alternative
exists for the same purpose. `x402_find_alternatives` returns up to 25
endpoints (default 5) that are **semantically similar** to a given URL — matched
on advertised purpose via description embeddings — and that **out-score it**
on our deterministic trust score. Each alternative returns `score`, `grade`,
`recommendation`, cosine `similarity` (0-1), `amountUsd` price, and a free
`endpointPage` URL. Same-host siblings and `avoid`-flagged endpoints are
excluded; an empty `alternatives` array is a valid answer meaning nothing beats
the subject. Cost is ~$0.005 per call.

### Semantic search (`x402_semantic_search`)

Describe the capability you need in plain words and get the up to 25 closest
endpoints in the monitored catalog. Ranking is deterministic: cosine similarity
bucketed to whole percentage points first (80.3% and 80.5% are the same bucket),
then trust score, then described-before-undescribed, then endpoint id, with
matches below a 0.5 cosine-similarity floor dropped entirely (so a query can
return fewer than the requested limit, or none). Endpoints that advertise no
description are still matched via their service name and URL path tokens (host
name as a last resort). The exact effect of a missing description: no fixed
point deduction and no direct similarity malus; the only deterministic penalty
is the described-before-undescribed tiebreak (equal bucket AND equal score:
described wins). Beyond that it is purely indirect — the shorter fallback text
typically yields lower cosine similarity than a prose description, so such
endpoints tend to land in lower buckets, by a query-dependent amount. Each
match returns `id`, `resource`, `score`, `grade`, raw cosine `similarity` (0-1;
ranking buckets it), `description` (when advertised), and a free `endpointPage`
URL. This is discovery, not verdicts: `score`/`grade` are null for unscored
endpoints, and no recommendation or flag detail is included (use
`x402_trust_score` for that). Cost is ~$0.001 per call.

### Watch / alerting (`x402_watch_create`, `x402_watch_events`, `x402_watch_edit`, `x402_watch_cancel`, `x402_watch_renew`)

- **Create** (`x402_watch_create`, paid) buys 30 days of change monitoring for
  one endpoint. Pay over x402; receive a one-time bearer `secret`, a `poll_url`,
  a `renew_url`, and machine-readable `next_steps`.
- **Poll** (`x402_watch_events`, free) reads the append-only event log. It
  returns two streams: `events` (endpoint changes — payTo / price / asset /
  network / spec / delisting / liveness) and `watch_events` (lifecycle
  feedback — created / edited / cancelled / renewed / expiring / expired), each
  with their own cursor (`next_cursor` and `watch_events_cursor`). Page
  forward by passing the previous response's cursors as `since` /
  `watch_since`. Cursors/ids are global sequences shared across watches, so a
  watch's first event id may be >1 — always use the returned `next_cursor`,
  never assume events start at 1.
- **Edit** (`x402_watch_edit`, free) changes webhook/Slack URLs, liveness
  sensitivity, or subscribed events. Bearer-authed with the secret.
- **Cancel** (`x402_watch_cancel`, free) soft-cancels a watch: no new events
  accrue and probing drops back to normal cadence immediately, but the event
  log stays readable via `x402_watch_events` until the original `expires_at`.
  Cancel is **not** a delete.
- **Renew** (`x402_watch_renew`, paid) extends the watch before `expires_at`.
  The secret stays the same.

Optional push delivery to one or more signed HTTPS webhooks and/or Slack/Discord
incoming webhooks can be configured at creation time and updated via edit (up to
5 of each per watch). `webhook_url` and `slack_url` accept a single URL string
or an array of URLs. Any URL is **connection-tested before you are charged**:
the server POSTs a signed `connection_test` ping and, if it can't be delivered
(3 attempts), rejects the change with `notCharged: true` so you can retry with
a corrected URL. On success the response reports per-URL delivery under
`delivery.connection_test`.

If you use a webhook, verify the `x-signature` header equals `sha256=` +
HMAC-SHA256(body) **keyed by the SHA-256 hex digest of your secret** — i.e. the
HMAC key is `hex(sha256(secret))`, not the raw secret. (The delivery worker only
ever holds that hash, never the plaintext secret.)

### `x402_trust_score` result

A single call returns everything an agent needs to decide **whether** and at
**what price** to use an endpoint — no second round-trip, no raw-unit guessing:

| Field | Meaning |
|---|---|
| `score` / `grade` | 0-100 point score and its A-F grade. |
| `recommendation` | Machine verdict: `proceed` \| `caution` \| `avoid`. Already prices in data uncertainty — low confidence caps it at `caution` (a young endpoint is *unproven*, not *untrustworthy*); `avoid` is reserved for real negatives (error-severity flags, low score, recent payTo change). |
| `scoreRange` | `{ low, point, high }` — a confidence-adjusted band. Decide conservatively against `low`. |
| `confidence` / `confidenceDetail` | Overall confidence plus its parts: `observation` (data volume/age) vs `economic` (settlement coverage). |
| `gradeThresholds` | The score cutoffs for each grade, so the verdict is auditable. |
| `advertised` | The last observed 402 quote: `{ amount, amountUsd, asset, network, decimals, observedAtTs }`. Trust **and** cost in one call. |
| `serviceName` / `description` | The provider-advertised name and description (unverified claim from the 402 envelope). Shown next to our independent metrics so you can sanity-check what the provider says against what we've measured. |
| `providerVerified` / `providerName` / `providerContact` | Present when the provider of the endpoint's host completed verification (proved domain control with a public key in `/.well-known/x402-trust.txt` plus a confirmed contact email). Carries the provider's organization name and confirmed contact address; verified endpoints also carry the `provider-verified` info flag; verification never changes the score. |
| `flags` / `flagsDetailed` | Legacy string flags plus structured `{ code, severity, message }`. Rule of thumb: **any flag with `severity: "error"` ⇒ avoid.** |
| `breakdown` / `subscores` | The full deterministic math (uptime, compliance, latency, age, activity, stability → technical / spec / economic subscores). |
| `stats` | Observed evidence: probe counts, latency, payTo, `settledVolumeUsd30d`, distinct payers, and a `payToChanged*` hijack signal when the receiving wallet changed recently. |

Everything is computed deterministically (no LLM) from continuous on-chain and
probe observation, so the breakdown is fully auditable.

## x402 V2 Payment Flow

This MCP server uses the canonical x402 V2 payment flow:

1. **402 + `PAYMENT-REQUIRED`** — The server responds with HTTP 402 and a
   base64-encoded `PAYMENT-REQUIRED` header containing the payment requirements
   (accepts, network, asset, amount, payTo).
2. **Sign + retry with `PAYMENT-SIGNATURE`** — The MCP client signs an
   EIP-3009 `transferWithAuthorization` for the selected accept and re-POSTs
   with the `PAYMENT-SIGNATURE` header (base64-encoded payment payload).
3. **Settlement + `PAYMENT-RESPONSE`** — The server settles the payment and
   responds with the data plus a `PAYMENT-RESPONSE` header.

Legacy `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers are accepted as a fallback
during the V1→V2 transition period but are not the default.

**Accept selection:** When a 402 response offers multiple accepts (e.g. Solana
+ Base USDC), the client selects the best compatible one (canonical USDC on an
allow-listed chain) rather than blindly taking the first accept.

## Install

Add to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "x402-trust": {
      "command": "npx",
      "args": ["-y", "x402-trust-mcp"]
    }
  }
}
```

To enable autonomous payment for the paid tools, add a funded Base USDC wallet:

```json
{
  "mcpServers": {
    "x402-trust": {
      "command": "npx",
      "args": ["-y", "x402-trust-mcp"],
      "env": {
        "X402_PRIVATE_KEY": "0xYOUR_BASE_WALLET_KEY",
        "X402_MAX_USD": "0.05"
      }
    }
  }
}
```

## Configuration (env vars)

| Var | Default | Description |
|---|---|---|
| `X402_TRUST_API_BASE` | `https://x402-trust.com` | API base URL. |
| `X402_PRIVATE_KEY` | _(unset)_ | Base wallet private key. Enables auto-pay for paid tools. Accepted with or without the `0x` prefix (surrounding whitespace is trimmed); a set-but-malformed key logs a warning and leaves auto-pay off rather than failing silently. |
| `X402_MAX_USD` | `0.05` | Per-call auto-pay ceiling. 0 disables auto-pay. |
| `X402_MAX_TOTAL_USD` | `1.00` | Cumulative auto-pay cap per process. 0 = unlimited. |
| `X402_MAX_CALLS` | `1000` | Max paid calls per process. 0 = unlimited. |
| `X402_TIMEOUT_MS` | `20000` | Request timeout. |

The free tools work with no configuration at all.

## Security

`X402_PRIVATE_KEY` is a hot wallet — fund it with only what you're willing to
spend on trust lookups. The key never leaves your machine; it signs EIP-3009
payment authorizations locally.

**Policy checks enforced before signing:**
- Chain allow-list (Base mainnet by default)
- Canonical USDC contract verification (no arbitrary tokens)
- Optional payTo allow-list
- Per-call spend ceiling (`X402_MAX_USD`)
- Cumulative spend cap (`X402_MAX_TOTAL_USD`)
- Call-count cap (`X402_MAX_CALLS`)

## Verifying response signatures

Tool results are provider-signed: the `result` object of signed tools carries
a top-level `signature` block with an Ed25519 signature over the
JCS-canonicalized (RFC 8785) response without the `signature` field. This
proves the content was assembled by x402-trust and not modified afterwards.

To verify a result:

1. Take the `result` object and remove its `signature` field.
2. Canonicalize with JCS (RFC 8785): object keys sorted by UTF-16 code unit
   order, no whitespace, ECMAScript number formatting.
3. SHA-256 the canonical UTF-8 bytes; the hex must equal `signature.digest`.
4. Verify `signature.value` (base64url, no padding) against the public key
   that `signature.keyId` resolves to in your PINNED copy of the key document
   (see below).

**Trust anchor: pin, do not follow.** `signature.publicKeys` is a discovery
hint, never a trust source. A verifier that fetches the key URL from the
response it is checking verifies against a key chosen by the sender, which
proves nothing: a forged response would carry the attacker's own key URL and
still verify. Pin one of these in your client instead:

- the public key itself (strongest, works offline; add new keys on rotation),
  e.g. `{ "x402trust-2026-08": "i4jrHKvmZ98-IGgseDfMTjMV4lAaLAgk-EnBeRIJQ5Y" }`
  (current at the time of writing; the key document always carries the full
  list, retired keys included), or
- the key document URL
  `https://x402-trust.com/.well-known/x402-trust-keys.json`, fetched over
  HTTPS once at bootstrap and cached (rotation-friendly).

Retired keys stay published forever, so a response you froze as evidence
remains verifiable. A worked test vector and a 20-line reference verifier
live at https://x402-trust.com/schemas. Watch management responses
(`x402_watch_create`, `x402_watch_edit`, `x402_watch_cancel`,
`x402_watch_renew`) are unsigned by design: they carry capability secrets
that must never be forwarded as evidence.

## License

MIT
