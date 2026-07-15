# Part 2: Swapping my fake settlement layer for the real network

Part one was building the concepts from scratch with a pretend settlement service and pretend money. This part was the test of whether any of it survives contact with the real protocol.

Most of it did, and the mapping was cleaner than I expected.

## What I swapped

I took out my mock settlement service and put in the actual x402 stack. The official packages, the public test facilitator, and real USDC on Base Sepolia. Sepolia is a test network, so the money is free from a faucet and worth nothing, but the protocol and the contracts and the settlement are the real machinery. My transaction is on a public blockchain that anyone can look at.

The shop went from my hand written payment middleware to theirs. The agent went from my payment retry helper to theirs. About 60 lines of new code. Everything else I'd built sits above that layer and didn't need to change at all.

## The mapping

My fake settlement service maps to the real facilitator plus the chain. My Ed25519 payment authorization maps to something called EIP-3009, which is a way of signing "you may take this much USDC from me" without sending a transaction yourself. My integer cents map to USDC atomic units, which are the same idea with six decimal places. My nonces burned in SQLite map to nonces the facilitator tracks. My idempotency check maps to theirs.

Every single lesson from part one had a counterpart. Building the toy first meant the real thing read as familiar instead of magic. I already knew why each piece was there because I'd suffered its absence.

Two things I liked once I saw them live. The paying client never touches the blockchain and never pays gas, it only signs an authorization and the facilitator submits it. My mock had accidentally arrived at the same shape, because the alternative would mean every agent runs a blockchain node, which is absurd. And while I was debugging, strangers' payments were flowing through the same network in real time. Seeing the thing you're studying being used by other people is motivating in a way that documentation isn't.

## What broke

**The silent empty wallet.** My agent printed an empty response and nothing else. No error, no status code, no clue. The wallet had no USDC in it because the faucet step hadn't landed, and my code swallowed the failed payment without a word. Same lesson as part one, now a rule I follow: print the status and the raw body before you try to parse anything. Every silent failure this week turned loud the second I did that.

**Reading the wrong page.** Trying to check whether my faucet money had arrived, I ended up staring at the block explorer's global feed, which shows every transaction on the whole network. Hundreds of strangers' payments scrolling past while I looked for mine. You have to go to your own address page. Obvious afterwards.

**Sepolia is a surname.** Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Optimism Sepolia. Same name, completely separate networks. Tokens sent to the wrong one simply don't exist on the right one. The network dropdown on the faucet is where funding goes to die and I nearly died there.

**Servers wait, clients don't.** At one point I stopped my shop because I thought it was fighting the agent for a port. The agent is a client. It has no port. It calls the shop and exits. The shop has to be running the whole time. I knew all of this and did it wrong anyway, which I think is what fluency actually is. Not never making the mistake, just recognising it faster.

## The receipt

The run ends with the agent printing a link to its own settlement on a public block explorer. A transfer that happened because a piece of software hit an HTTP 402 response and decided to pay it. That status code was reserved in 1997 and sat unused for nearly thirty years waiting for a reason to exist.

Code for this part is in the x402-real folder. Test network only, pinned on purpose. The main network id is one digit away from the test one, and I'd suggest respecting that digit.

## Next

Now that settlement is real, the interesting work moves back up the stack. My identity and limits layer sitting in front of real payments is the part none of the protocol packages give you, and the part I built all of this to understand.
