# 🪑 SeatMate

**Tinder for long-table seating charts**, with an ELO-flavored rating system.

You're shown one guest (the **ego**) and a card for another guest. Swipe **right**
if they'd be great neighbors, **left** if they wouldn't. Lots of people can swipe
at the same time — every vote feeds one shared affinity model. Hit **End** to see
the affinities and an auto-generated suggested seating order.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000`. To swipe from your iPhone, open
`http://<your-computer-ip>:3000` while on the same Wi‑Fi (or deploy the folder to
any Node host — Render, Railway, Fly, Glitch — no database required).

## Guest list

Edit `data/guests.json` (id, name, side, relationship, notes, funFact) before
you start, or add guests live via `POST /api/guests`. Card content is intentionally
simple for now — enrich the fields later and the UI picks them up automatically.

## How it works

### ELO-like affinity per pair
Each pair `(A, B)` carries an affinity score. A swipe is treated as a Bernoulli
outcome (right = 1, left = 0). We nudge the score toward the result with a
**decaying K-factor** — big early adjustments, tiny ones once a pair has many
votes — exactly like an ELO rating settling as games are played. The displayed
"% match" is `sigmoid(affinity)`. Because the score is shared and converges, many
raters voting in parallel simply sharpen the same estimate.

### Automatic ego switching (the cool part)
Every guest has a *remaining uncertainty* = the summed information value of the
pairs touching them (unseen pairs count most; then undecided, lightly-voted
pairs). The app anchors you to the guest with the **most uncertainty left**, keeps
feeding you their most informative candidates, and **moves the ego on its own**
once that uncertainty drops or you've seen a batch. Parallel raters are pushed
toward *different* egos so the crowd covers the guest list efficiently — this is
active learning over a partially-ordered set.

### Finding the best ordering
A long table is a path where everyone has up to two neighbors. We look for the
ordering that **maximizes total adjacent affinity** (a max-weight Hamiltonian
path) using greedy nearest-neighbor starts polished with 2-opt — the best linear
extension of the preferences gathered so far. That ordering, the power pairs, and
the keep-apart pairs all show up on the **End / Affinities** screen.

## API

| Method | Path            | Purpose                                  |
| ------ | --------------- | ---------------------------------------- |
| POST   | `/api/raters`   | Register a rater, get a `raterId`        |
| GET    | `/api/card`     | Next ego + candidate card to rate        |
| POST   | `/api/vote`     | Submit a swipe, get the next card        |
| GET    | `/api/results`  | Suggested seating, top/avoid pairs, stats|
| GET    | `/api/matrix`   | Full affinity matrix                     |
| GET/POST | `/api/guests` | List / add guests                        |

State persists to `data/state.json` (git-ignored). Delete it to reset all votes.
