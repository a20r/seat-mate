// server.js — SeatMate API + static host.
// One shared in-memory state (persisted to disk) that every rater talks to, so
// multiple people can swipe at the same time and feed the same affinity model.

import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { loadGuests, saveGuests, loadState, saveState, flush, loadConfig, saveConfig } from './lib/store.js';
import {
  applyVote,
  getPair,
  neighborScore,
  pickEgo,
  pickCandidate,
  shouldSwitchEgo,
  bestMultiTableArrangement,
  rankedPairs,
} from './lib/affinity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

let guests = loadGuests();
const state = loadState();
let config = loadConfig();

// Older saved states predate constraints — make sure the shape is always there.
if (!state.constraints) state.constraints = { adjacent: [], groups: [] };
state.constraints.adjacent = state.constraints.adjacent || [];
state.constraints.groups = state.constraints.groups || [];

const akey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const ACTIVE_MS = 60 * 1000; // a rater is "active" if seen in the last minute
const now = () => Date.now();

function publicGuest(id) {
  return guests.find((g) => g.id === id) || null;
}

// Resolve a free-typed name to a guest: exact match, then prefix, then substring.
function resolveGuestByName(name, excludeId) {
  if (!name) return null;
  const q = name.toString().trim().toLowerCase();
  if (!q) return null;
  const pool = guests.filter((g) => g.id !== excludeId);
  return (
    pool.find((g) => g.name.toLowerCase() === q) ||
    pool.find((g) => g.name.toLowerCase().startsWith(q)) ||
    pool.find((g) => g.name.toLowerCase().includes(q)) ||
    null
  );
}

// Record a "must sit directly next to" rule (couples), de-duplicated.
function addAdjacent(a, b) {
  const arr = state.constraints.adjacent;
  if (!arr.some(([x, y]) => akey(x, y) === akey(a, b))) arr.push([a, b]);
}

// Record a "must share a table" rule (families), merging overlapping groups.
function addGroup(a, b) {
  const groups = state.constraints.groups;
  const ga = groups.find((g) => g.includes(a));
  const gb = groups.find((g) => g.includes(b));
  if (ga && gb && ga !== gb) {
    for (const x of gb) if (!ga.includes(x)) ga.push(x);
    state.constraints.groups = groups.filter((g) => g !== gb);
  } else if (ga) {
    if (!ga.includes(b)) ga.push(b);
  } else if (gb) {
    if (!gb.includes(a)) gb.push(a);
  } else {
    groups.push([a, b]);
  }
}

// Name-resolved view of the current constraints, for the client.
function constraintsView() {
  const byId = new Map(guests.map((g) => [g.id, g]));
  const nm = (id) => byId.get(id)?.name || '—';
  const adjacent = state.constraints.adjacent
    .filter(([a, b]) => byId.has(a) && byId.has(b))
    .map(([a, b]) => ({ a, b, nameA: nm(a), nameB: nm(b) }));
  const groups = state.constraints.groups
    .map((g, index) => ({ index, members: g.filter((id) => byId.has(id)).map((id) => ({ id, name: nm(id) })) }))
    .filter((g) => g.members.length > 0);
  return { adjacent, groups };
}

// Egos / candidates currently in front of *other* active raters, so we can
// spread parallel raters across the guest list instead of doubling up.
function activeAssignments(exceptRaterId) {
  const egos = new Set();
  const candidatesByEgo = new Map();
  for (const [rid, r] of Object.entries(state.raters)) {
    if (rid === exceptRaterId) continue;
    if (now() - (r.lastSeen || 0) > ACTIVE_MS) continue;
    if (r.egoId) {
      egos.add(r.egoId);
      if (r.currentCandidate) {
        if (!candidatesByEgo.has(r.egoId)) candidatesByEgo.set(r.egoId, new Set());
        candidatesByEgo.get(r.egoId).add(r.currentCandidate);
      }
    }
  }
  return { egos, candidatesByEgo };
}

function progress() {
  const n = guests.length;
  const totalPairs = (n * (n - 1)) / 2;
  let totalVotes = 0;
  let pairsSeen = 0;
  for (const p of Object.values(state.pairs)) {
    totalVotes += p.votes;
    if (p.votes > 0) pairsSeen += 1;
  }
  return {
    totalVotes,
    pairsSeen,
    totalPairs,
    coverage: totalPairs ? pairsSeen / totalPairs : 0,
    guests: n,
  };
}

// Choose the next card for a rater: maybe rotate the ego, then pick the most
// informative candidate to pair them against.
function nextCard(raterId) {
  if (guests.length < 2) return { needGuests: true };
  const rater = state.raters[raterId];
  if (!rater) return { error: 'unknown rater' };

  const { egos, candidatesByEgo } = activeAssignments(raterId);

  if (!rater.egoId || shouldSwitchEgo(state.pairs, guests, rater.egoId, rater.cardsThisSession || 0)) {
    rater.egoId = pickEgo(state.pairs, guests, { exclude: egos });
    rater.cardsThisSession = 0;
  }

  const avoid = new Set();
  if (rater.lastCandidate) avoid.add(rater.lastCandidate);
  const others = candidatesByEgo.get(rater.egoId);
  if (others) for (const c of others) avoid.add(c);

  const candidateId = pickCandidate(state.pairs, guests, rater.egoId, { avoid });
  rater.cardsThisSession = (rater.cardsThisSession || 0) + 1;
  rater.currentCandidate = candidateId;
  rater.lastCandidate = candidateId;
  rater.lastSeen = now();
  saveState(state);

  const pair = getPair(state.pairs, rater.egoId, candidateId);
  return {
    ego: publicGuest(rater.egoId),
    candidate: publicGuest(candidateId),
    pair: { votes: pair.votes, score: neighborScore(pair) },
    progress: progress(),
  };
}

// ---- routes -----------------------------------------------------------------
app.post('/api/raters', (req, res) => {
  const name = (req.body?.name || '').toString().trim().slice(0, 40) || 'Anonymous';
  const raterId = randomUUID();
  state.raters[raterId] = { name, votes: 0, cardsThisSession: 0, lastSeen: now() };
  saveState(state);
  res.json({ raterId, name });
});

app.get('/api/card', (req, res) => {
  const raterId = req.query.raterId;
  if (!raterId || !state.raters[raterId]) return res.status(400).json({ error: 'unknown rater' });
  res.json(nextCard(raterId));
});

app.post('/api/vote', (req, res) => {
  const { raterId, egoId, candidateId, direction } = req.body || {};
  const rater = state.raters[raterId];
  if (!rater) return res.status(400).json({ error: 'unknown rater' });
  if (!publicGuest(egoId) || !publicGuest(candidateId)) return res.status(400).json({ error: 'unknown guest' });
  if (direction !== 'left' && direction !== 'right') return res.status(400).json({ error: 'bad direction' });

  applyVote(state.pairs, egoId, candidateId, direction);
  rater.votes = (rater.votes || 0) + 1;
  rater.lastSeen = now();
  state.voteLog.push({ t: now(), by: rater.name, egoId, candidateId, direction });
  if (state.voteLog.length > 500) state.voteLog.splice(0, state.voteLog.length - 500);
  saveState(state);

  res.json({ ok: true, next: nextCard(raterId) });
});

app.get('/api/results', (_req, res) => {
  const { tables, score } = bestMultiTableArrangement(
    state.pairs, guests, config.numTables, config.seatsPerTable, state.constraints,
  );
  const ranked = rankedPairs(state.pairs, guests);
  res.json({
    tables,
    score,
    config,
    constraints: constraintsView(),
    progress: progress(),
    topPairs: ranked.slice(0, 8),
    avoidPairs: ranked.slice(-8).reverse(),
    raters: Object.values(state.raters).map((r) => ({ name: r.name, votes: r.votes || 0 })),
  });
});

// ---- seating constraints (couples / families) -------------------------------
app.get('/api/constraints', (_req, res) => res.json(constraintsView()));

app.post('/api/constraints', (req, res) => {
  const { type, egoId, otherId, name } = req.body || {};
  if (!publicGuest(egoId)) return res.status(400).json({ error: 'unknown ego' });
  const other = otherId && publicGuest(otherId) ? publicGuest(otherId) : resolveGuestByName(name, egoId);
  if (!other) return res.status(404).json({ error: 'no guest matches', query: name });
  if (other.id === egoId) return res.status(400).json({ error: 'cannot pair someone with themselves' });
  if (type === 'adjacent') addAdjacent(egoId, other.id);
  else if (type === 'group') addGroup(egoId, other.id);
  else return res.status(400).json({ error: 'bad type' });
  saveState(state);
  res.json({ ok: true, matched: { id: other.id, name: other.name }, constraints: constraintsView() });
});

app.delete('/api/constraints', (req, res) => {
  const { type, a, b, index } = req.body || {};
  if (type === 'adjacent') {
    state.constraints.adjacent = state.constraints.adjacent.filter(([x, y]) => akey(x, y) !== akey(a, b));
  } else if (type === 'group') {
    if (Number.isInteger(index)) state.constraints.groups.splice(index, 1);
    else return res.status(400).json({ error: 'group index required' });
  } else {
    return res.status(400).json({ error: 'bad type' });
  }
  saveState(state);
  res.json({ ok: true, constraints: constraintsView() });
});

app.get('/api/config', (_req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  const { numTables, seatsPerTable } = req.body || {};
  if (Number.isInteger(numTables) && numTables >= 1 && numTables <= 50) config.numTables = numTables;
  if (Number.isInteger(seatsPerTable) && seatsPerTable >= 2 && seatsPerTable <= 100) {
    config.seatsPerTable = seatsPerTable % 2 === 0 ? seatsPerTable : seatsPerTable + 1;
  }
  saveConfig(config);
  res.json(config);
});

app.get('/api/guests', (_req, res) => res.json({ guests }));

app.post('/api/guests', (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').toString().trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'name required' });
  const guest = {
    id: randomUUID().slice(0, 8),
    name,
    side: (b.side || '').toString().slice(0, 40),
    relationship: (b.relationship || '').toString().slice(0, 60),
    notes: (b.notes || '').toString().slice(0, 280),
    funFact: (b.funFact || '').toString().slice(0, 280),
  };
  guests.push(guest);
  saveGuests(guests);
  res.json({ guest });
});

// Live affinity matrix for the heatmap.
app.get('/api/matrix', (_req, res) => {
  const ids = guests.map((g) => g.id);
  const matrix = ids.map((a) =>
    ids.map((b) => (a === b ? null : { score: neighborScore(getPair(state.pairs, a, b)), votes: getPair(state.pairs, a, b).votes })),
  );
  res.json({ guests: guests.map((g) => ({ id: g.id, name: g.name })), matrix });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🪑  SeatMate running:  http://localhost:${PORT}\n`);
  console.log(`  Loaded ${guests.length} guests. Open the URL on your iPhone (same Wi-Fi) to start swiping.\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
