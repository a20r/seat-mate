// store.js — tiny JSON-file persistence so ratings survive restarts and are
// shared across every rater hitting the same server (that's what makes the
// app work "in parallel"). No database to set up.
//
// Data is organized into **datasets** (one per event — e.g. Wedding, Welcome
// Party, Rehearsal Dinner). Each dataset has its own guests/state/config under
// DATA_DIR/datasets/<slug>/, so you can seat each event separately with its own
// fresh slate. A pointer file (active.json) records which one is selected.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, copyFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Crash-safe write: serialize to a temp file, snapshot the previous good copy to
// <file>.bak, then atomically rename temp -> file. A crash can never leave the
// real file half-written, and the last good version is always recoverable.
function writeJSONAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (existsSync(file)) { try { copyFileSync(file, `${file}.bak`); } catch { /* best effort */ } }
  renameSync(tmp, file);
}

// Read JSON, falling back to the .bak snapshot if the primary is missing or
// corrupt — so a bad file never silently turns into "no data".
function readJSON(file, fallback) {
  for (const f of [file, `${file}.bak`]) {
    if (!existsSync(f)) continue;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { /* try next */ }
  }
  return fallback;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Where data lives. On Railway, point this at a mounted volume
// (RAILWAY_VOLUME_MOUNT_PATH is set automatically when one is attached) so the
// data survives redeploys. Falls back to the local ./data folder.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(__dirname, '..', 'data');
const DATASETS_DIR = join(DATA_DIR, 'datasets');
const ACTIVE_FILE = join(DATA_DIR, 'active.json');

const emptyState = () => ({
  pairs: {},
  raters: {},
  voteLog: [],
  constraints: { adjacent: [], groups: [] },
  placements: {}, // seatKey "t:side:pos" -> guestId (manual overrides)
});

const defaultConfig = () => ({ numTables: 2, seatsPerTable: 6 });

export function slugify(s) {
  return (s || '')
    .toString().toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'event';
}

function ensureRoot() {
  if (!existsSync(DATASETS_DIR)) mkdirSync(DATASETS_DIR, { recursive: true });
}

// One-time migration: if there's a legacy flat data/ layout (guests.json at the
// root) and no datasets yet, fold it into a "wedding" dataset so nothing is lost.
function migrateLegacy() {
  ensureRoot();
  const legacyGuests = join(DATA_DIR, 'guests.json');
  if (readdirSync(DATASETS_DIR).length === 0 && existsSync(legacyGuests)) {
    const dir = join(DATASETS_DIR, 'wedding');
    mkdirSync(dir, { recursive: true });
    for (const f of ['guests.json', 'state.json', 'config.json']) {
      const src = join(DATA_DIR, f);
      if (existsSync(src)) renameSync(src, join(dir, f));
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ label: 'Wedding' }, null, 2));
    if (!existsSync(ACTIVE_FILE)) writeFileSync(ACTIVE_FILE, JSON.stringify({ slug: 'wedding' }));
  }
}

export function listDatasets() {
  migrateLegacy();
  return readdirSync(DATASETS_DIR)
    .filter((d) => {
      try { return statSync(join(DATASETS_DIR, d)).isDirectory(); } catch { return false; }
    })
    .map((slug) => datasetMeta(slug))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.label.localeCompare(b.label));
}

export function datasetMeta(slug) {
  const dir = join(DATASETS_DIR, slug);
  let meta = { label: slug };
  try { meta = { ...meta, ...JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) }; } catch { /* default */ }
  let count = 0;
  try { count = JSON.parse(readFileSync(join(dir, 'guests.json'), 'utf8')).length; } catch { /* 0 */ }
  return { slug, label: meta.label || slug, order: meta.order, count };
}

export function getActiveSlug() {
  const all = listDatasets();
  if (all.length === 0) return null;
  try {
    const { slug } = JSON.parse(readFileSync(ACTIVE_FILE, 'utf8'));
    if (slug && all.some((d) => d.slug === slug)) return slug;
  } catch { /* fall through */ }
  return all[0].slug;
}

export function setActiveSlug(slug) {
  ensureRoot();
  writeFileSync(ACTIVE_FILE, JSON.stringify({ slug }));
}

// Create (or overwrite) a dataset with a fresh, empty voting slate.
export function createDataset(slug, label, guests, config = {}, order) {
  ensureRoot();
  const dir = join(DATASETS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'guests.json'), JSON.stringify(guests, null, 2));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(emptyState(), null, 2));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig(), ...config }, null, 2));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ label, order }, null, 2));
  return datasetMeta(slug);
}

function activeDir() {
  const slug = getActiveSlug();
  if (!slug) { // no datasets at all — make a default so the app still boots
    createDataset('default', 'Seating', [], {}, 0);
    setActiveSlug('default');
    return join(DATASETS_DIR, 'default');
  }
  const dir = join(DATASETS_DIR, slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const stateFile = () => join(activeDir(), 'state.json');
const guestsFile = () => join(activeDir(), 'guests.json');
const configFile = () => join(activeDir(), 'config.json');

export function loadGuests() {
  return readJSON(guestsFile(), []);
}

export function saveGuests(guests) {
  writeJSONAtomic(guestsFile(), guests);
}

export function loadState() {
  return { ...emptyState(), ...readJSON(stateFile(), {}) };
}

let pending = false;
let cached = null;

// Debounced write — many votes can arrive quickly; we coalesce disk writes.
// The destination path is resolved at flush time, so it always targets whatever
// dataset is currently active.
export function saveState(state) {
  cached = state;
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    if (cached) writeJSONAtomic(stateFile(), cached);
  }, 250);
}

export function flush() {
  if (cached) writeJSONAtomic(stateFile(), cached);
}

// Drop the debounce cache without writing — used right before switching the
// active dataset so a pending write can't leak one event's votes into another.
export function resetWriteCache() {
  pending = false;
  cached = null;
}

export function loadConfig() {
  return { ...defaultConfig(), ...readJSON(configFile(), {}) };
}

export function saveConfig(cfg) {
  writeJSONAtomic(configFile(), cfg);
}
