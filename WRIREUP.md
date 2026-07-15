# Part 1: I built agent payment infrastructure to find out how it works

I spent about a week building a prototype of the plumbing that lets AI agents buy things safely. Cryptographic agent identity, spending limits, settlement, the lot. The code is in this repo. This file is about what went wrong while I built it, because that's where I actually learned anything.

I'm self taught and this was my first time touching payments, HTTP signatures or distributed systems. I used an AI assistant as a pair programmer and broke each layer until I understood it.

## Why this problem

People are starting to tell AI assistants to order things for them. Book the flight, reorder the coffee, renew the hosting. When that happens, software shows up at a checkout that was designed for a human with eyes and a credit card. CAPTCHAs, bot detection, fraud models, all of it assumes a person is behind the request.

So merchants end up in a bad spot. Block everything that looks automated and you lose real customers. Allow it and you have no idea who is spending what. What's missing is a way to answer three questions on every request: who is this agent, is this request really from it right now, and is it allowed to do this.

I built something that answers all three, then made it move money.

## What broke

**The server that wouldn't update.** I edited a file, ran it again, nothing changed. Everything I tried made it worse. Node had loaded the old code when the process started and was never going to look at my file again. Restart the process. An hour gone on that one.

**Signature hell.** Both sides of a signed request build a string from the request's parts and sign that. If the client and the server disagree about that string by a single byte, verification fails with a useless error. Missing nonce, wrong field order, whatever. What finally worked was printing both strings and comparing them by eye. That trick has now solved every signature problem I've hit, including in a completely unrelated project.

**I shipped a double spend.** My replay protection was a 30 second window on the timestamp. Which means the exact same signed request works five times in 29 seconds and charges the customer five times. I tested it and watched it happen. The fix is a nonce, a random one time value the server remembers and refuses twice. Two details matter and both are easy to get wrong. The nonce has to be inside the signed material, otherwise an attacker just swaps in a fresh one. And you burn it after the signature checks out, not before, or someone spams junk nonces and locks out real requests. The order you do your security checks in is itself a security decision.

**Floats aren't money.** My spending check printed this at me: 147.20000000000002 plus 7.8 is more than 150. Nobody typed those digits. Computers store decimals in binary and most decimals don't fit exactly, so tiny errors pile up quietly until a limit check goes the wrong way or an invoice is off by a cent and someone asks why. Every real payment system stores money as a whole number of the smallest unit. 89.90 euros is 8990. Mine does that now, and the API rejects anything that isn't a whole number, because fixing a bug is worse than making it impossible.

**Counting the same purchase twice.** The payment flow means each purchase is two HTTP requests. One arrives without payment and gets told to pay, then it comes back with the payment attached. I was recording the spend when I verified the request, so every purchase counted twice against the limit and agents ended up rejecting their own retries. The answer is fifty years old and comes from card networks: authorize first, capture later. Authorization asks "is this allowed" and places a hold. Capture says "it happened" and commits the spend. Holds expire or get released when the purchase dies. Adding holds also closed a race I hadn't thought about, where ten simultaneous requests all passed the same limit check together because none of them could see the others.

**Then holds broke the happy path.** After adding them, purchases started failing again. The unpaid first attempt placed a hold, got told to pay, and its hold just sat there while the paid retry placed a second one. One honest 89.90 purchase was now holding 179.80 against a 150 limit. So releasing a hold when a request doesn't complete isn't tidiness, it's the thing that makes the flow work at all.

**The crash window.** Worst case in payments: the money settles, then the shop crashes before it hands over the goods. Money moved, customer got nothing, nobody knows. I fixed it three ways. Idempotency, so the same payment arriving twice is understood as a retry and returns the original result instead of charging again. Reversal, so refunds exist and refunding twice does nothing. And reconciliation, where the shop keeps its own record of what it delivered, periodically asks the settlement layer what it settled, and refunds anything that doesn't match. I tested it by making the shop kill itself right after settlement. Restart it, wait twenty seconds, and it refunds the money on its own. Watching a program notice its own mistake and fix it without me was the best moment of the week.

**Windows ate my port.** The settlement service printed its startup message and then exited. Code 0, no error, nothing. I lost hours to it. Turned out Windows reserves port 5000 at the OS level. There's a command that lists the reserved ranges and there it was. What actually cracked it was a one line test server on a different port, which told me my environment was fine and the problem was specific. Minimal reproductions solve half of everything.

**Old database, new code.** Create table if not exists does exactly what it says. It does not alter a table that's already there. So my old database sat there missing a column my new code needed, and the errors were confusing until I realised nothing had migrated. In development you delete the database. In production that database has customers' money in it, which is why migrations exist. Noted for later.

## Things I'd tell someone starting this

Make every defence prove itself. A check you've never seen reject anything is a check you don't know works. My test agent attacks its own gateway seven ways on every run, and two of those attacks found real bugs.

Don't store what you can derive. "Spent today" is a sum over the purchases table, not a counter I keep updated. Counters drift and disagree with reality. A sum can't.

Write error messages for yourself at 2am. When my limit check rejects something it prints how much is committed, how much is on hold, and how much was asked for. That "0.00 held" number told me instantly that no holds were leaking, which I'd otherwise have had to go digging for.

The specs aren't scary. RFC 9421 looked like a wall of text and turned out to be about 150 lines of code to implement usefully. The big payment companies are building their agent protocols on primitives that a beginner can read and understand.

## What's next

Part two is pointing this at the real x402 network instead of my fake one. Part three is the bit I actually care about, putting my identity and limits layer in front of real settlement.

If you do payments for a living and something in here is wrong, I'd like to know. That's why it's public.
