# Everything that broke while building agent-payment infrastructure

*(Draft — personalize before publishing. Written to be posted as the repo's companion piece and adapted for a blog/forum post.)*

I spent a week building a prototype of payment infrastructure for AI agents: cryptographic agent identity, spending mandates, x402-style settlement, the works. The code is in this repo. This document is about what actually happened — every bug, every wrong assumption, every hour lost to something stupid — because that turned out to be where all the learning was.

Context: I'm a self-taught developer, this was my first time touching payments infrastructure, HTTP signatures, or distributed systems. I built it with an AI assistant as pair programmer, breaking and fixing each layer until I understood it.

## The problem

AI agents are starting to buy things. Every merchant's security stack — CAPTCHAs, fraud models, bot detection — is built on the assumption that a purchase has a human behind it. When the buyer is software, merchants face two failure modes at once: legitimate agents blocked as bots, and malicious bots waved through as agents. Someone has to answer three questions for every incoming request: *who is this agent, is this request really from it right now, and is it allowed to do this?*

I built a stack that answers all three, then made it move (fictional) money.

## What broke, in order

### 1. The stale server
Edited the code, nothing changed, everything mysteriously broken. A running Node process is a snapshot of the code from when it started. Obvious in retrospect. Cost me an hour anyway.

### 2. Signature mismatch hell
Client and server each compute a "signature base" — the exact string that gets signed. If they disagree by one byte (a missing nonce, a different field order), verification fails with a useless generic error. The fix that works every time: print both sides' signature base and diff them. This is also exactly how you debug any hash-chain system.

### 3. The double-spend I shipped
My replay protection was a 30-second timestamp window. Which means the *same signed request* could be sent five times in 29 seconds and charge the customer five times. Fix: a nonce inside the signed material, burned after first use. Two design details that matter: the nonce must be *inside* the signature (or an attacker swaps in fresh ones), and it must be burned *after* full verification (or an attacker spams garbage nonces to lock out legitimate requests). Order of security checks is itself a security property.

### 4. Floats are not money
My mandate check rejected a purchase with: `147.20000000000002€ + 7.8€ > 150€`. Nobody typed those extra digits — binary floating point can't represent most decimal fractions, and the error compounds silently until a limit check passes that shouldn't. Every real payment system stores money as integer smallest-units (cents). Mine does now, and the API rejects non-integer amounts outright: don't just fix the bug, make it unrepresentable.

### 5. The double-counted purchase (authorize vs capture)
The x402 flow means every purchase is TWO requests: an unpaid attempt that gets `402 Payment Required`, then a retry carrying payment. My verifier recorded the spend at *verification* time — so every purchase counted twice and agents denied their own retries. The fix is fifty years old: separate **authorization** (may this happen? place a hold) from **capture** (it happened; commit the spend). Holds expire or get released on failure. This also closed a race: before holds, N simultaneous requests could all pass the same mandate check together.

### 6. The hold leak in the happy path
After adding holds, purchases started failing *again*: the unpaid first attempt's hold lingered while the paid retry placed a second hold — 179.80€ held against a 150€ mandate, by one honest purchase. Releasing holds on every non-completing exit isn't cleanup; it's what makes the payment flow work at all.

### 7. The crash window
The nightmare scenario: settlement succeeds, then the merchant crashes before serving the goods. Money moved, customer got nothing, nobody knows. Three layered fixes:
- **Idempotency**: the same payment arriving twice is a retry, not fraud (the nonce is inside the signature, so "same nonce + valid signature" *proves* it's the same request). Replay the original outcome, charge nothing.
- **Reversal**: refunds that are themselves idempotent, and a refunded payment can't be re-settled.
- **Reconciliation**: the merchant keeps its own books of deliveries, periodically compares them against the facilitator's settlements, and auto-refunds anything unmatched. I tested it by making the shop `process.exit(1)` right after settlement: restart, ~20 seconds, `↩️ REFUNDED`. The system heals itself.

### 8. Windows ate my port
The facilitator printed its startup line and exited, code 0, no error. Hours of theories later: `netsh interface ipv4 show excludedportrange` — Windows had port 5000 reserved at the OS level (thanks, Hyper-V). The isolation test that cracked it: a one-line server on a different port. Minimal reproductions solve half of all debugging.

### 9. Schema drift
`CREATE TABLE IF NOT EXISTS` does not alter existing tables. Old database + new code = `no such column: tx_id`. In dev you delete the DB; in production that database has customers' money in it, which is why real systems ship versioned migrations. Noted for the future.

## What I'd tell someone starting the same build

- Make every defense prove itself. A security check you've never seen reject anything is a check you can't trust. My test agent attacks its own gateway seven different ways on every run.
- Derive state, don't duplicate it. "Spent today" is a SUM over the orders table, not a counter — so it can't desync, and it survives restarts by construction.
- Design your error messages for 2am-you. My mandate denials print the full accounting: `147.20€ committed + 0.00€ held + 7.80€ > 150.00€`. That `0.00€ held` instantly proves no holds leaked.
- The standards are readable. RFC 9421 looked terrifying and turned out to be ~150 lines to implement usefully. The payment giants' agent protocols build on primitives you can genuinely understand.

## What's next

Pointing this at real protocol traffic (x402's testnet), and hardening the joints I know are weak (hold timezone semantics, admin auth, migrations). If you're working on agentic commerce infrastructure, I'd genuinely like to hear what I got wrong.
