Agent Stack

Cryptographic identity and spending limits for AI agents at checkout, built
from scratch to understand the problem. Agents sign their requests, a hosted
verifier proves who they are and enforces the budget their owner set, and
payment settles over x402.

Read this first: this project is not a business, and the section at the
bottom explains why in detail. It's a working, reviewed implementation of an
architecture that Visa, Cloudflare, AWS and Coinbase are shipping with far
more behind them. It's worth reading for the failure modes, not as something
to adopt.

What's here


verifier-service.js (:4000), the core. Agent registry (KYA), RFC 9421
signature verification, replay protection, spending mandates enforced with
holds, idempotent capture, and exposure rebuilt from settled network events
rather than trusted from a local counter.
facilitator.js (:4001), the settlement layer. Holds balances, settles
payments, issues refunds, and answers "what settled for this payer" by ref
so a crashed merchant can recover.
agent-ready-sdk.js, the thin open half a merchant installs. No security
logic; it forwards signature material to the verifier and obeys the verdict.
Fails closed by default.
shop.js (:3000), a merchant (ferretería). Writes an intent row before
settling and runs its own reconciler that refunds settlements with no
delivery and commits deliveries that were never captured.
panaderia.js (:3001), a second merchant on the same verifier, to show
the cross-merchant budget in action.
agent.js, an AI agent buying supplies for a building job.
x402.js / httpsig.js — the payment handshake and the RFC 9421 signing.
reset.js, clears demo state between runs (see below).


Run (four terminals, in order)

npm install
node facilitator.js
node verifier-service.js
node shop.js
node panaderia.js
node agent.js        # in a sixth terminal, or reuse one

The agent buys at both shops on one identity. Watch the daily mandate deplete
across merchants, the unsigned bot get bounced, and /billing meter each
verification.

Re-running the demo

Every service is deliberately persistent — budgets that survive a restart are
the whole point of a spending mandate. That makes the demo a one-shot: the
agent spends most of its daily limit, so a second run is correctly denied.

To run again without restarting, start facilitator, verifier and shop with
ALLOW_DEV_RESET=1 set, then:

node reset.js && node agent.js

Never set that flag anywhere real, it exposes an endpoint that wipes the
ledger.

Testing the hard parts

The interesting behaviour is in the crash and retry seams. Two switches expose
them:


BREAK_RELEASE=1 node shop.js, disables the release-on-402 path, so the
retry has to supersede its own stale hold by intent id. Purchase should still
land at the right total.
CRASH_AFTER_SETTLE=1 node shop.js, kills the shop after settling, before
delivering. Within ~10s the verifier counts the orphaned spend from the
network and the shop refunds the undelivered goods. Two reconcilers in
different services, correcting off the same network record.


What this got right, and what it got wrong

This was built without knowing Visa's Trusted Agent Protocol existed, and
independently arrived at the same design: RFC 9421 signatures, a public-key
directory, merchant-side verification. That convergence says the reasoning was
sound.

But the central bet, that spending limits have to be enforced in the middle,
merchant-side, because no single merchant sees an agent's total spend — turned
out to be wrong. Visa, AWS and xpay all enforce the budget at the source: the
agent's runtime, proxy, or credential. Source-side enforcement is
cross-merchant by construction; it covers every shop, including ones that never
enrolled. Merchant-side enforcement only covers merchants who signed up.

So the architecture is correct and the market position isn't. See THESIS.md for
the full argument and COMPETITORS.md for what each incumbent actually ships.

Credit

The crash and retry handling exists because engineers on r/AI_Agents reviewed
the first version and pointed out where it broke. The correlation id, the
intent-before-settle pattern, and rebuilding exposure from network events are
all theirs.it, break it.
