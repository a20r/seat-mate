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
`http://<your-computer-ip>:3000` while on the same Wi‑Fi.

## Guest list

Three ways to populate the pool:

- **Import from Zola** — on the start screen, tap *Import guest list from Zola*,
  then choose your Zola **Guest List → Export** CSV (or paste it). Headers are
  matched flexibly (Name or First/Last, plus Party, Relationship, Side, Notes).
  If the CSV has a **Wedding** RSVP column, only guests **attending the wedding**
  are imported. Each Zola **party** can be kept together as a family group.
- Edit `data/guests.json` (id, name, side, relationship, notes, funFact).
- `POST /api/guests` to add one live.

## Seating rules (couples & families)

Tap a person's name at the top of the swipe screen to pin who must sit **right
beside** them (couples) or at the **same table** (families). These are hard
constraints the solver always honors. Swipe **up** (or tap **?**) to skip a
pairing you're not sure about.

## Deploy (Railway)

The repo ships a `railway.json` (Nixpacks build, `node server.js`, `/health`
check). Point a Railway service at this repo and it auto-deploys on push.

**Persistence:** the app stores everything in JSON files under a data directory.
Add a **Railway volume** to the service (any mount path) — Railway sets
`RAILWAY_VOLUME_MOUNT_PATH`, which the app uses automatically, so your guest list,
votes, and seating rules survive every redeploy. Locally it falls back to `./data`;
override with the `DATA_DIR` env var if you like. `PORT` is read from the
environment (Railway sets it). Once deployed, import your guest list once and
share the public URL.

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

| Method | Path                  | Purpose                                       |
| ------ | --------------------- | --------------------------------------------- |
| POST   | `/api/raters`         | Register a rater, get a `raterId`             |
| GET    | `/api/card`           | Next ego + candidate card to rate             |
| POST   | `/api/vote`           | Submit a swipe, get the next card             |
| POST   | `/api/skip`           | "Not sure" — skip a pairing, get the next card|
| GET    | `/api/results`        | Suggested seating, top/avoid pairs, stats     |
| GET    | `/api/matrix`         | Full affinity matrix                          |
| GET/POST | `/api/guests`       | List / add guests                             |
| POST   | `/api/guests/import`  | Import a Zola CSV (wedding-attending only)    |
| GET/POST/DELETE | `/api/constraints` | List / add / remove couple & family pins |
| GET/POST | `/api/config`       | Tables × seats-per-table                      |
| GET    | `/health`             | Healthcheck (Railway)                         |

State persists to JSON files under the data directory (`data/state.json`,
`data/guests.json`, `data/config.json` — all git-ignored, kept on the Railway
volume in production). Delete them to reset.
