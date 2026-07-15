# Part two: real x402 on Base Sepolia testnet

The prototype's concepts, running against the real protocol: the official
@x402 v2 packages, the public testnet facilitator, and on-chain USDC
settlement you can look up on a block explorer.

No real money is involved anywhere: Base Sepolia is a test network and
its USDC comes free from a faucet.

## Setup (once)
1. npm install
2. npm run wallet          → creates .env with a keypair, prints an address
3. Fund it: https://faucet.circle.com → network "Base Sepolia" → paste
   the address → request USDC (free, ~10 test-USDC)
4. Wait ~1 min, then optionally check the balance at
   https://sepolia.basescan.org/address/YOUR_ADDRESS

## Run
Terminal 1:  npm run shop
Terminal 2:  npm run agent

The agent hits the paid endpoint, gets 402, signs a USDC authorization
(EIP-3009 — it never sends a transaction or pays gas; the facilitator
does), retries, and the shop serves the goods after ON-CHAIN settlement.
The agent prints a link to your transaction on sepolia.basescan.org —
that hash is a real record on a public blockchain, made by your agent.

## Mapping to the prototype you built
| prototype (agent-stack)         | real x402                          |
|---------------------------------|------------------------------------|
| facilitator.js (SQLite ledger)  | x402.org/facilitator + Base Sepolia|
| Ed25519 payment auth            | EIP-3009 transferWithAuthorization |
| x402.js middleware              | @x402/express paymentMiddleware    |
| payingFetch                     | @x402/fetch wrapFetchWithPayment   |
| integer cents                   | USDC atomic units (6 decimals)     |
| nonce burned in SQLite          | nonce tracked by facilitator       |

Everything you learned transfers one-to-one. That's what building the toy
version buys you: the real thing is recognizable instead of magical.

## Safety rails
- .env holds a PRIVATE KEY. Never commit it, never share it (there is a
  .gitignore for this — check `git status` before any push).
- Network is pinned to eip155:84532 (Base Sepolia TESTNET). 8453 is Base
  mainnet = real money. Don't change it.
- This wallet should only ever hold testnet tokens.
