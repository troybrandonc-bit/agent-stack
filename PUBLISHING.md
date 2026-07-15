# How to publish this (one-time, ~20 minutes)

1. Create a GitHub account if you don't have one (username = your dev
   identity; "adipoblue" works, it's already your brand).
2. New repository → name: agent-stack → public → no template.
3. On your machine, in the project folder:
     git init
     git add README.md WRITEUP.md LICENSE .gitignore package.json *.js
     git commit -m "agent payment infrastructure prototype: identity, mandates, x402-style settlement, reconciliation"
     git branch -M main
     git remote add origin https://github.com/YOUR_USERNAME/agent-stack.git
     git push -u origin main
   (Install git from git-scm.com if missing. GitHub will ask you to
   authenticate in the browser the first time.)
4. Check the repo page: README renders as the front page, WRITEUP.md is
   linked from it. Fix anything that reads wrong. Your voice > my draft.
5. Where to show it (in order of fit):
   - Hacker News "Show HN": title like "Show HN: I built agent-payment
     infrastructure to learn how it works — here's everything that broke"
   - r/programming or r/node (the write-up angle, not the product angle)
   - X/Twitter: thread version of WRITEUP.md, one bug per post, link at
     the end. Tag nothing, sell nothing — just the story.

## Before you post — read this part

- PERSONALIZE THE WRITE-UP. It's a draft in roughly your voice; make it
  actually yours. Delete anything you wouldn't say.
- Decide deliberately how much personal info to attach. Your age makes
  the story travel further, but it also tells strangers on the internet
  you're a minor: expect DMs, some great, some not. Reasonable setup:
  first name or handle only, no city/school, and tell your parents
  you're publishing before you do it — not for permission theater, but
  so someone in the room knows if a weird contact shows up.
- Being honest that you built it with an AI assistant (the write-up
  already says so) is a strength, not a weakness — hiding it and being
  found out later would be the weakness.
- Expect criticism. Some will be lazy ("toy project"), some will be
  gold (a payments engineer telling you what's wrong). Thank the second
  kind and fix what they find — publicly. That's how reputations start.
