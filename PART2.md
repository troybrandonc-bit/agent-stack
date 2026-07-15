# Part 2: Connecting the prototype to the real x402 network

Part one ([WRITEUP.md](WRITEUP.md)) was building agent-payment infrastructure from scratch to understand it: mock facilitator, fictional money, real architecture. Part two is the payoff test: **does any of it survive contact with the real protocol?**

Answer: almost all of it, and the mapping was cleaner than I expected.

## The swap

I replaced my mock settlement layer with the actual x402 v2 stack: the official `@x402` packages, the public testnet facilitator at x402.org, and real USDC on Base Sepolia (a test network — the money is free from a faucet and worthless, but the protocol, contracts and settlement are the real machinery).

The shop went from my hand-rolled `paymentRequired` middleware to `@x402/express`. The agent went from my `payingFetch` to `@x402/fetch`. Total new code: about 60 lines. Everything else I'd built — the identity thinking, the mandate model, the reconciliation logic — sits *above* this layer and didn't need to change conceptually at all.

## The mapping that made it easy

|my prototype|real x402|
|-|-|
|facilitator.js (SQLite ledger)|x402.org facilitator + Base Sepolia chain|
|Ed25519-signed payment authorization|EIP-3009 `transferWithAuthorization` over USDC|
|my `paymentRequired` middleware|`@x402/express` paymentMiddleware|
|my `payingFetch` 402-retry helper|`@x402/fetch` wrapFetchWithPayment|
|integer cents|USDC atomic units (6 decimals)|
|nonces burned in SQLite|nonces tracked by the facilitator|
|my `/settle` idempotency|same concept, their infrastructure|

Every hard-won lesson from part one had a direct counterpart. Building the toy first meant the real thing read as *recognizable* instead of magical — I already knew why every piece exists, because I'd suffered its absence.

Two details I appreciated once I saw them live:

* The paying client **never touches the blockchain**: it only signs an authorization; the facilitator submits the transaction and pays the gas. My mock had accidentally landed on the same shape (agents sign, facilitator settles) because the alternative doesn't work — agents can't all be blockchain nodes.
* `Transfer With Authorization` transactions from total strangers were flowing through the network the whole time I was debugging. Infrastructure you're studying being visibly alive is motivating in a way documentation isn't.

## What broke this time

Shorter list than part one, but educational:

1. **The empty-wallet silent failure.** My agent printed `Response: {}` and nothing else. No error, no status. Cause: the wallet had no USDC — the faucet step hadn't landed — and my code swallowed the failed payment leg. Lesson repeated from part one, now upgraded to a rule: *print the status code and raw body before you parse anything.* Every silent failure this week became loud the moment I did.
2. **The block-explorer firehose.** Debugging "did my faucet deposit arrive," I ended up staring at the network-wide transaction feed thinking it was my wallet. Addresses matter; always navigate to `/address/0xYOURS`, not the global feed.
3. **Sepolia is a surname, not an address.** Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Optimism Sepolia — same name, unconnected networks. Tokens sent on the wrong one are invisible on the right one. The network dropdown is where funding goes to die.
4. **Client/server confusion never fully dies.** I stopped my shop because I thought it "conflicted" with the agent's port. The agent has no port; it's a client. Servers wait forever, clients run once. I knew this. I still did it. Fluency is doing it wrong less often, not never.

## The receipt

The run ends with the agent printing a link to its settlement transaction on a public block explorer — an on-chain `Transfer With Authorization` executed because software caught an HTTP 402 and decided to pay. HTTP status 402 was reserved in 1997 for exactly this and waited nearly three decades for a reason to exist.

Code for this part is in [`x402-real/`](x402-real/). Same disclaimer as everything here: testnet, learning artifact, pinned to Base Sepolia on purpose — the mainnet network ID is one digit away and I'd encourage you to respect that digit.

## What's next

Now that the settlement layer is real, the interesting work moves back up the stack: my verifier's identity/mandate layer sitting *in front of* real x402 payments — the part none of the protocol packages provide, and the part I originally built all this to understand.

