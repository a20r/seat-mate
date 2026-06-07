// affinity.js — the brains of SeatMate.
//
// We collect Tinder-style swipes on guest *pairs* ("would these two be good
// neighbors at a long table?") and turn them into a single shared affinity
// score per pair using an ELO-like update with a decaying K-factor. Those
// affinities then drive (a) which pair to ask about next (active learning),
// (b) which "ego" guest to anchor the next batch of cards on, and (c) the
// final optimal long-table ordering — the best linear extension of the
// partially-ordered preference data we've gathered.

// ---- tunables ---------------------------------------------------------------
export const K0 = 1.0; // initial learning rate for a brand-new pair
export const TAU = 4; // votes-scale over which the K-factor decays
const EGO_CARDS_PER_SESSION = 7; // soft cap on cards before we switch ego
const EGO_NEED_FLOOR = 0.45; // switch ego once its remaining uncertainty
// drops below this fraction of the global max

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

// ---- final ordering: best long-table seating --------------------------------
// We want the Hamiltonian path that maximizes the sum of adjacent affinities
// (each person has up to two neighbors). That's NP-hard, so we use greedy
// nearest-neighbor from several starts, then 2-opt local search to polish.

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
