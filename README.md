# agent-stack

A working prototype of **payment infrastructure for AI agents**, built from scratch to understand the problem: agents are starting to buy things on the internet, and every merchant's security stack treats them as bots.

Seven services and iterations later, this repo contains a small but *correct* verification and settlement stack:

```
┌──────────┐     RFC 9421 signed requests      ┌──────────────┐
│  AGENT    │ ────────────────────────────────▶ │   MERCHANT    │  (shop.js / panaderia.js)
│ agent.js  │ ◀──── 402 Payment Required ────── │  + open SDK   │  3-line integration
└──────────┘     retry with X-PAYMENT           └──────┬───────┘
      │                                                │
      │ registers identity                             │ /verify /commit /release
      ▼                                                ▼
┌────────────────┐                            ┌────────────────────┐
│  FACILITATOR    │ ◀──── /settle /refund ──── │  VERIFIER SERVICE   │
│ facilitator.js  │       (x402-style)         │ verifier-service.js │
│ settlement +    │                            │ identity, mandates, │
│ ledger          │                            │ holds, billing      │
└────────────────┘                            └────────────────────┘
```

## What it does

- **Agent identity** — agents are Ed25519 keypairs; every request is signed with **RFC 9421 HTTP Message Signatures** (+ RFC 9530 Content-Digest). Identity travels *inside* the signature, not in a spoofable header.
- **Know-your-agent registry** — merchants only accept agents registered with the verifier.
- **Spending mandates** — per-transaction and per-day limits enforced *across all merchants* (an agent can't reset its budget by shopping elsewhere).
- **Authorization holds** — verify places a hold; commit converts it to a spend; release/expiry frees it. Ten simultaneous purchases against an exhausted mandate: zero slip through.
- **x402-style settlement** — `402 Payment Required` → signed payment authorization → `X-PAYMENT` retry → facilitator settles. Money is integers (cents). Always.
- **Idempotency** — the same payment arriving twice is a retry, not a double charge. The nonce lives inside the signature, so this is safe.
- **Refunds + reconciliation** — the shop keeps its own books of what it delivered, and automatically refunds any settlement with no matching delivery. Kill the shop mid-purchase (`CRASH_AFTER_SETTLE=1`), restart it, and watch the money find its way home.

## What it deliberately is not

The facilitator moves fictional money in a SQLite ledger, not USDC on Base — the HTTP choreography is real x402 shape, the settlement rail is training wheels. Single region, no auth on admin endpoints, holds have a naive timezone story. This is a **learning artifact and reference implementation**, not a production system. Read [WRITEUP.md](WRITEUP.md) for everything that broke while building it — that's the valuable part.

## Quickstart

```bash
npm install
# five terminals, in this order:
node facilitator.js        # settlement ledger      :4001
node verifier-service.js   # identity + mandates    :4000
node shop.js               # merchant #1            :3000
node panaderia.js          # merchant #2            :3001
node agent.js              # the shopping agent
```

You'll see the agent top up its wallet, buy tools and pastries across both shops with one identity, hit its daily mandate mid-croissant, an unsigned bot get bounced, and two metered invoices accrue at the verifier (`GET :4000/billing`).

Reset between runs: kill all node processes and delete `*.db*` and `agent-key.json`.

## The interesting files

| file | what it teaches |
|---|---|
| `httpsig.js` | RFC 9421 signing/verification from scratch — the standard the payment industry's agent protocols build on |
| `verifier-service.js` | KYA registry, mandate holds (authorize/capture), metered billing |
| `x402.js` | both sides of the 402 payment handshake |
| `facilitator.js` | idempotent settlement, reversal, integer-cents ledger |
| `shop.js` | the 3-line merchant integration + self-healing reconciliation |
| `agent-ready-sdk.js` | the open SDK: no security logic client-side, fail-closed by design |

## License

MIT — see [LICENSE](LICENSE). Use it, learn from it, break it.
