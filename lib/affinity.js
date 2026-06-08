// affinity.js — the brains of SeatMate.
//
// We collect Tinder-style swipes on guest *pairs* ("would these two be good
// neighbors at a long table?") and turn them into a single shared affinity
// score per pair using an ELO-like update with a decaying K-factor. Those
// affinities then drive (a) which pair to ask about next (active learning),
// (b) which "ego" guest to anchor the next batch of cards on, and (c) the
// final optimal seating arrangement across one or more tables — maximising a
// weighted sum of adjacency, across-table, and diagonal (group) affinities.

// ---- tunables ---------------------------------------------------------------
export const K0 = 1.0; // initial learning rate for a brand-new pair
export const TAU = 4; // votes-scale over which the K-factor decays
const EGO_CARDS_PER_SESSION = 7; // soft cap on cards before we switch ego
const EGO_NEED_FLOOR = 0.45; // switch ego once its remaining uncertainty
// drops below this fraction of the global max

// ---- seating weights --------------------------------------------------------
// Sitting next to someone (adjacent, same side) is the strongest bond.
// Sitting across is medium — you can talk but it's not as intimate.
// The diagonal pair in each 2×2 quad captures "group neighbor" affinity:
// the four people in a conversational cluster around the table corner.
const WADJ = 1.0;    // next to (adjacent, same side)
const WACROSS = 0.5; // directly across the table
const WDIAG = 0.25;  // diagonal within a 2×2 quad (group neighbor affinity)

// ---- small math helpers -----------------------------------------------------
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// A fresh, never-voted pair sits at neutral affinity 0 (= 50% neighbor score).
function freshPair() {
  return { votes: 0, sumRight: 0, affinity: 0 };
}

export function getPair(pairs, a, b) {
  return pairs[pairKey(a, b)] || freshPair();
}

// ELO-like update. `direction` is 'right' (good neighbors -> outcome 1) or
// 'left' (bad neighbors -> outcome 0). The expected outcome is the current
// sigmoid of the affinity, so confident pairs barely move. K shrinks as the
// pair accumulates votes, exactly like an ELO player's K-factor settling down
// once they've played many games — this is what makes the system converge even
// while many raters vote in parallel on the same shared score.
export function applyVote(pairs, a, b, direction) {
  const key = pairKey(a, b);
  const p = pairs[key] || freshPair();
  const outcome = direction === 'right' ? 1 : 0;
  const expected = sigmoid(p.affinity);
  const k = K0 / (1 + p.votes / TAU);
  const next = {
    votes: p.votes + 1,
    sumRight: p.sumRight + outcome,
    affinity: p.affinity + k * (outcome - expected),
  };
  pairs[key] = next;
  return next;
}

// Neighbor score people see on a card: probability this pair is a good pairing.
export function neighborScore(pair) {
  return sigmoid(pair.affinity);
}

// How much would another vote on this pair teach us? Unseen pairs dominate;
// after that we favor pairs that are *undecided* (p near 0.5 => high Bernoulli
// variance) and lightly-voted. This is uncertainty sampling.
export function queryValue(pair) {
  if (pair.votes === 0) return 10; // always grab at least one observation
  const p = sigmoid(pair.affinity);
  const variance = p * (1 - p); // 0..0.25, peaks at total disagreement
  return (0.15 + variance) / (1 + pair.votes);
}

// Remaining uncertainty around a single guest = summed query value of every
// pair that touches them. As a guest's neighborhood gets explored this falls,
// which is what lets us *automatically* move the ego on to whoever we know
// least about.
export function egoNeed(pairs, guests, egoId) {
  let total = 0;
  for (const g of guests) {
    if (g.id === egoId) continue;
    total += queryValue(getPair(pairs, egoId, g.id));
  }
  return total;
}

// Pick the guest with the most uncertainty left in their neighborhood,
// skipping any egos currently held by other active raters when possible so
// parallel raters spread out instead of all rating the same person.
export function pickEgo(pairs, guests, { exclude = new Set() } = {}) {
  let best = null;
  let bestNeed = -Infinity;
  let bestAny = null;
  let bestAnyNeed = -Infinity;
  for (const g of guests) {
    const need = egoNeed(pairs, guests, g.id) + Math.random() * 1e-6;
    if (need > bestAnyNeed) {
      bestAnyNeed = need;
      bestAny = g.id;
    }
    if (exclude.has(g.id)) continue;
    if (need > bestNeed) {
      bestNeed = need;
      best = g.id;
    }
  }
  return best ?? bestAny;
}

// Should we keep this ego, or has it taught us enough for now? We move on once
// the rater has seen a batch of cards or this ego's remaining uncertainty has
// fallen well below the most-uncertain guest still out there.
export function shouldSwitchEgo(pairs, guests, egoId, cardsThisSession) {
  if (cardsThisSession >= EGO_CARDS_PER_SESSION) return true;
  const need = egoNeed(pairs, guests, egoId);
  let globalMax = 0;
  for (const g of guests) {
    if (g.id === egoId) continue;
    globalMax = Math.max(globalMax, egoNeed(pairs, guests, g.id));
  }
  if (globalMax <= 0) return false;
  return need < EGO_NEED_FLOOR * globalMax;
}

// Best candidate card to show for a fixed ego: the most informative neighbor
// we haven't just shown. `avoid` lets us skip a card another rater is on right
// now (best-effort de-duplication for parallel raters).
export function pickCandidate(pairs, guests, egoId, { avoid = new Set() } = {}) {
  let best = null;
  let bestVal = -Infinity;
  let fallback = null;
  let fallbackVal = -Infinity;
  for (const g of guests) {
    if (g.id === egoId) continue;
    const val = queryValue(getPair(pairs, egoId, g.id)) + Math.random() * 1e-6;
    if (val > fallbackVal) {
      fallbackVal = val;
      fallback = g.id;
    }
    if (avoid.has(g.id)) continue;
    if (val > bestVal) {
      bestVal = val;
      best = g.id;
    }
  }
  return best ?? fallback;
}

// ---- single long-table ordering (legacy / single-table fallback) ------------
// Greedy nearest-neighbor from several starts, then 2-opt local search.

function weight(pairs, a, b) {
  return getPair(pairs, a, b).affinity;
}

function pathScore(pairs, order) {
  let s = 0;
  for (let i = 0; i < order.length - 1; i++) s += weight(pairs, order[i], order[i + 1]);
  return s;
}

function greedyFrom(pairs, ids, startIdx) {
  const used = new Array(ids.length).fill(false);
  const order = [ids[startIdx]];
  used[startIdx] = true;
  for (let step = 1; step < ids.length; step++) {
    const last = order[order.length - 1];
    let bestIdx = -1;
    let bestW = -Infinity;
    for (let j = 0; j < ids.length; j++) {
      if (used[j]) continue;
      const w = weight(pairs, last, ids[j]) + Math.random() * 1e-9;
      if (w > bestW) {
        bestW = w;
        bestIdx = j;
      }
    }
    order.push(ids[bestIdx]);
    used[bestIdx] = true;
  }
  return order;
}

function twoOpt(pairs, order) {
  let improved = true;
  let best = order.slice();
  let bestScore = pathScore(pairs, best);
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const score = pathScore(pairs, cand);
        if (score > bestScore + 1e-9) {
          best = cand;
          bestScore = score;
          improved = true;
        }
      }
    }
  }
  return { order: best, score: bestScore };
}

export function bestOrdering(pairs, guests) {
  const ids = guests.map((g) => g.id);
  if (ids.length <= 1) return { order: ids.slice(), score: 0 };
  let best = null;
  let bestScore = -Infinity;
  const starts = Math.min(ids.length, 8);
  for (let s = 0; s < starts; s++) {
    const startIdx = Math.floor((s * ids.length) / starts);
    const greedy = greedyFrom(pairs, ids, startIdx);
    const polished = twoOpt(pairs, greedy);
    if (polished.score > bestScore) {
      bestScore = polished.score;
      best = polished.order;
    }
  }
  return { order: best, score: bestScore };
}

// ---- multi-table 2D seating -------------------------------------------------
//
// Each table is a rectangle:
//   Side A:  [0] [1] … [k-1]
//            ─────────────────   ← "across" the table
//   Side B:  [k] [k+1] … [2k-1]
//
// sideA[i] sits directly across from sideB[i].
// Scoring combines three positional relationships:
//   adjacent (same side, next to each other)   → weight WADJ
//   across (opposite side, same column)         → weight WACROSS
//   diagonal (2×2 quad corners: A[i]/B[i+1] etc.) → weight WDIAG (group affinity)

// Score a single table arrangement.
// `arr` is flat: [A0, A1, ..., A_{k-1}, B0, B1, ..., B_{k-1}], nulls = empty seats.
function tableArrScore(pairs, arr) {
  const k = arr.length >> 1;
  const w = (a, b) => (a && b) ? getPair(pairs, a, b).affinity : 0;
  let s = 0;
  for (let i = 0; i < k - 1; i++) s += WADJ * w(arr[i], arr[i + 1]);
  for (let i = 0; i < k - 1; i++) s += WADJ * w(arr[k + i], arr[k + i + 1]);
  for (let i = 0; i < k; i++) s += WACROSS * w(arr[i], arr[k + i]);
  for (let i = 0; i < k - 1; i++) {
    s += WDIAG * w(arr[i], arr[k + i + 1]);
    s += WDIAG * w(arr[i + 1], arr[k + i]);
  }
  return s;
}

// Swap-based local search: try every pair of positions and keep improvements.
function optimizeTable(pairs, arr) {
  let best = arr.slice();
  let bestScore = tableArrScore(pairs, best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length; i++) {
      for (let j = i + 1; j < best.length; j++) {
        if (!best[i] || !best[j]) continue; // skip empty seats
        const c = best.slice();
        [c[i], c[j]] = [c[j], c[i]];
        const sc = tableArrScore(pairs, c);
        if (sc > bestScore + 1e-9) {
          best = c;
          bestScore = sc;
          improved = true;
        }
      }
    }
  }
  return { arr: best, score: bestScore };
}

// Greedy chain → split into two sides → best of several starts.
function initTable(pairs, ids, k) {
  if (ids.length === 0) return Array(k * 2).fill(null);
  let bestArr = null;
  let bestScore = -Infinity;
  const starts = Math.min(ids.length, 6);
  for (let s = 0; s < starts; s++) {
    const startIdx = Math.floor((s * ids.length) / starts);
    const used = new Array(ids.length).fill(false);
    const chain = [ids[startIdx]];
    used[startIdx] = true;
    while (chain.length < ids.length) {
      const last = chain[chain.length - 1];
      let bestIdx = -1, bestW = -Infinity;
      for (let j = 0; j < ids.length; j++) {
        if (used[j]) continue;
        const w = getPair(pairs, last, ids[j]).affinity + Math.random() * 1e-9;
        if (w > bestW) { bestW = w; bestIdx = j; }
      }
      chain.push(ids[bestIdx]);
      used[bestIdx] = true;
    }
    const arr = chain.slice(0, k).concat(chain.slice(k));
    while (arr.length < k * 2) arr.push(null);
    const sc = tableArrScore(pairs, arr);
    if (sc > bestScore) { bestScore = sc; bestArr = arr; }
  }
  return bestArr;
}

// Greedy partition: assign guests to tables by maximising within-table affinity.
function partitionGuests(pairs, ids, numTables, spt) {
  const tables = Array.from({ length: numTables }, () => []);
  if (ids.length === 0) return tables;

  // Rank guests by total affinity (centrality) — put most-connected guests first
  // so they become table seeds.
  const centrality = ids
    .map((id) => ({
      id,
      score: ids.reduce((s, oid) => s + (oid !== id ? getPair(pairs, id, oid).affinity : 0), 0),
    }))
    .sort((a, b) => b.score - a.score);

  const used = new Set();
  // Seed each table with the most central unassigned guest.
  for (let t = 0; t < numTables; t++) {
    for (const { id } of centrality) {
      if (!used.has(id)) { tables[t].push(id); used.add(id); break; }
    }
  }

  // Assign remaining guests to the table with highest average affinity to its members.
  for (const { id } of centrality) {
    if (used.has(id)) continue;
    let bestT = -1, bestScore = -Infinity;
    for (let t = 0; t < numTables; t++) {
      if (tables[t].length >= spt) continue;
      const avg = tables[t].reduce((s, tid) => s + getPair(pairs, id, tid).affinity, 0) / tables[t].length;
      if (avg > bestScore) { bestScore = avg; bestT = t; }
    }
    if (bestT === -1) bestT = tables.reduce((bt, tbl, i) => tbl.length < tables[bt].length ? i : bt, 0);
    tables[bestT].push(id);
    used.add(id);
  }

  return tables;
}

// Improve partition by trying all cross-table guest swaps.
function improvePartition(pairs, tables) {
  const internalScore = (tbl) => {
    let s = 0;
    for (let i = 0; i < tbl.length; i++)
      for (let j = i + 1; j < tbl.length; j++)
        s += getPair(pairs, tbl[i], tbl[j]).affinity;
    return s;
  };

  let improved = true;
  let passes = 0;
  while (improved && passes++ < 20) {
    improved = false;
    for (let t1 = 0; t1 < tables.length; t1++) {
      for (let t2 = t1 + 1; t2 < tables.length; t2++) {
        for (let i = 0; i < tables[t1].length; i++) {
          for (let j = 0; j < tables[t2].length; j++) {
            const before = internalScore(tables[t1]) + internalScore(tables[t2]);
            [tables[t1][i], tables[t2][j]] = [tables[t2][j], tables[t1][i]];
            const after = internalScore(tables[t1]) + internalScore(tables[t2]);
            if (after <= before + 1e-9) {
              // revert
              [tables[t1][i], tables[t2][j]] = [tables[t2][j], tables[t1][i]];
            } else {
              improved = true;
            }
          }
        }
      }
    }
  }
  return tables;
}

// Top-level solver: partition guests across tables then optimise each table's
// 2D arrangement.  seatsPerTable must be even (each side has spt/2 seats).
export function bestMultiTableArrangement(pairs, guests, numTables, seatsPerTable) {
  // Ensure even seat count so both sides are equal.
  const spt = seatsPerTable % 2 === 0 ? seatsPerTable : seatsPerTable + 1;
  const k = spt / 2;
  const ids = guests.map((g) => g.id);
  const byId = new Map(guests.map((g) => [g.id, g]));

  if (ids.length === 0) return { tables: [], score: 0 };

  let partition = partitionGuests(pairs, ids, numTables, spt);
  partition = improvePartition(pairs, partition);

  let totalScore = 0;
  const tables = partition.map((tblIds) => {
    if (tblIds.length === 0) return { sideA: [], sideB: [], score: 0 };
    const arr0 = initTable(pairs, tblIds, k);
    const { arr, score } = optimizeTable(pairs, arr0);
    totalScore += score;
    const toGuest = (id) => (id ? (byId.get(id) || null) : null);
    const sideA = arr.slice(0, k).map(toGuest);
    const sideB = arr.slice(k).map(toGuest);
    return { sideA, sideB, score };
  });

  return { tables, score: totalScore };
}

// Top and bottom rated pairs that actually have votes behind them.
export function rankedPairs(pairs, guests) {
  const byId = new Map(guests.map((g) => [g.id, g]));
  const rows = [];
  for (const [key, p] of Object.entries(pairs)) {
    if (p.votes === 0) continue;
    const [a, b] = key.split('|');
    if (!byId.has(a) || !byId.has(b)) continue;
    rows.push({
      a,
      b,
      nameA: byId.get(a).name,
      nameB: byId.get(b).name,
      score: neighborScore(p),
      votes: p.votes,
    });
  }
  rows.sort((x, y) => y.score - x.score);
  return rows;
}
