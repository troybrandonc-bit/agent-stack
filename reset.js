/**
 * reset.js — clear the demo's state without restarting anything.
 *
 *   node reset.js && node agent.js
 *
 * Every service here is deliberately persistent: budgets that survive a
 * restart are the entire point of a spending mandate. That makes the demo
 * a one-shot — the agent spends 147.20€ of its 150€ daily limit, so the
 * second run is correctly denied. Correct, and useless for demoing.
 *
 * This asks each service to forget, rather than deleting files underneath
 * a running process (which leaves open handles, WAL files, and a shop
 * holding a database that no longer exists).
 *
 * Requires ALLOW_DEV_RESET=1 in each service's terminal. If a service says
 * 404, that's the guard doing its job.
 */

const SERVICES = [
  { name: 'verifier',    url: 'http://localhost:4000/dev/reset' },
  { name: 'facilitator', url: 'http://localhost:4001/dev/reset' },
  { name: 'ferretería',  url: 'http://localhost:3000/dev/reset' },
];

(async () => {
  for (const s of SERVICES) {
    try {
      const r = await fetch(s.url, { method: 'POST' });
      if (r.ok) {
        console.log(`  ✔ ${s.name} cleared`);
      } else if (r.status === 404) {
        console.log(`  ✘ ${s.name}: no reset endpoint — start it with ALLOW_DEV_RESET=1`);
      } else {
        console.log(`  ✘ ${s.name}: HTTP ${r.status}`);
      }
    } catch {
      console.log(`  – ${s.name}: not running`);
    }
  }
  console.log('\nReady. Run: node agent.js');
})();
