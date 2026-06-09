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

// ---- hard constraints -------------------------------------------------------
// Two kinds of organiser-set rules override the learned affinities:
//   • adjacent: a pair that MUST sit directly next to each other (couples).
//   • group:    a set that MUST share a table (families) — not necessarily
//               adjacent. Adjacency implies grouping too.
// Adjacency is enforced with a large bonus in the table arranger; grouping is
// enforced structurally by partitioning whole clusters (never split) onto tables.
const ADJ_BONUS = 1000; // dwarfs any realistic affinity sum, so couples win

function akey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Connected components over adjacency + group edges. Anyone linked by any
// constraint ends up in one cluster that must stay on the same table.
function buildClusters(ids, constraints) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [a, b] of (constraints.adjacent || [])) union(a, b);
  for (const grp of (constraints.groups || [])) {
    for (let i = 1; i < grp.length; i++) union(grp[0], grp[i]);
  }
  const clusters = new Map();
  for (const id of ids) {
    const r = find(id);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(id);
  }
  return [...clusters.values()];
}

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

// Count required-adjacent pairs that actually sit next to each other (same side).
function satisfiedAdjacencies(arr, adjSet) {
  if (!adjSet || adjSet.size === 0) return 0;
  const k = arr.length >> 1;
  let n = 0;
  for (let i = 0; i < k - 1; i++) {
    if (arr[i] && arr[i + 1] && adjSet.has(akey(arr[i], arr[i + 1]))) n++;
    if (arr[k + i] && arr[k + i + 1] && adjSet.has(akey(arr[k + i], arr[k + i + 1]))) n++;
  }
  return n;
}

// Swap-based local search. Optimises the *constrained* objective (affinity plus
// adjacency bonus) but reports the plain affinity score for display.
function optimizeTable(pairs, arr, adjSet) {
  const obj = (a) => tableArrScore(pairs, a) + ADJ_BONUS * satisfiedAdjacencies(a, adjSet);
  let best = arr.slice();
  let bestObj = obj(best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length; i++) {
      for (let j = i + 1; j < best.length; j++) {
        if (!best[i] && !best[j]) continue; // both empty — nothing to gain
        const c = best.slice();
        [c[i], c[j]] = [c[j], c[i]];
        const sc = obj(c);
        if (sc > bestObj + 1e-9) {
          best = c;
          bestObj = sc;
          improved = true;
        }
      }
    }
  }
  return { arr: best, score: tableArrScore(pairs, best) };
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

// Average affinity between a cluster and an existing table's members.
function clusterTableAffinity(pairs, cluster, table) {
  if (table.length === 0) return 0;
  let s = 0, n = 0;
  for (const a of cluster) for (const b of table) { s += getPair(pairs, a, b).affinity; n++; }
  return n ? s / n : 0;
}

// Total within-table affinity across a whole partition (the partition objective).
function partitionScore(pairs, tables) {
  let s = 0;
  for (const tbl of tables)
    for (let i = 0; i < tbl.length; i++)
      for (let j = i + 1; j < tbl.length; j++)
        s += getPair(pairs, tbl[i], tbl[j]).affinity;
  return s;
}

// Place whole clusters onto tables, capacity-aware, maximising within-table
// affinity. Clusters are never split, so groups/couples always share a table.
// Big clusters go first (bin-packing); ties broken randomly across restarts.
function partitionOnce(pairs, clusters, numTables, spt) {
  const tables = Array.from({ length: numTables }, () => []);
  const order = clusters
    .map((c) => ({ c, r: Math.random() }))
    .sort((x, y) => (y.c.length - x.c.length) || (x.r - y.r))
    .map((o) => o.c);

  for (const cl of order) {
    let bestT = -1, bestScore = -Infinity;
    for (let t = 0; t < numTables; t++) {
      if (tables[t].length + cl.length > spt) continue;
      const score = clusterTableAffinity(pairs, cl, tables[t]) + Math.random() * 1e-9;
      if (score > bestScore) { bestScore = score; bestT = t; }
    }
    // No table has room (over-capacity / oversized cluster): drop into the
    // emptiest table so we still produce a usable chart rather than crashing.
    if (bestT === -1) bestT = tables.reduce((bi, tbl, i) => (tbl.length < tables[bi].length ? i : bi), 0);
    tables[bestT].push(...cl);
  }
  return tables;
}

// Best partition over several randomised restarts.
function partitionClusters(pairs, clusters, numTables, spt) {
  let best = null, bestScore = -Infinity;
  const restarts = Math.min(48, 8 + clusters.length * 3);
  for (let r = 0; r < restarts; r++) {
    const tables = partitionOnce(pairs, clusters, numTables, spt);
    const score = partitionScore(pairs, tables);
    if (score > bestScore) { bestScore = score; best = tables; }
  }
  return best || Array.from({ length: numTables }, () => []);
}

// Top-level solver: cluster constrained guests, partition clusters across
// tables, then optimise each table's 2D arrangement (honouring adjacency).
// seatsPerTable must be even (each side has spt/2 seats).
export function bestMultiTableArrangement(pairs, guests, numTables, seatsPerTable, constraints = {}) {
  const cons = { adjacent: constraints.adjacent || [], groups: constraints.groups || [] };
  // Ensure even seat count so both sides are equal.
  const spt = seatsPerTable % 2 === 0 ? seatsPerTable : seatsPerTable + 1;
  const k = spt / 2;
  const ids = guests.map((g) => g.id);
  const byId = new Map(guests.map((g) => [g.id, g]));

  if (ids.length === 0) return { tables: [], score: 0 };

  // Only keep constraint edges between guests that still exist.
  const present = new Set(ids);
  const adjSet = new Set(
    cons.adjacent
      .filter(([a, b]) => present.has(a) && present.has(b))
      .map(([a, b]) => akey(a, b)),
  );

  const clusters = buildClusters(ids, cons);
  const partition = partitionClusters(pairs, clusters, numTables, spt);

  let totalScore = 0;
  const tables = partition.map((tblIds) => {
    if (tblIds.length === 0) return { sideA: [], sideB: [], score: 0 };
    const arr0 = initTable(pairs, tblIds, k);
    const { arr, score } = optimizeTable(pairs, arr0, adjSet);
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
