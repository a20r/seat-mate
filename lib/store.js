// store.js — tiny JSON-file persistence so ratings survive restarts and are
// shared across every rater hitting the same server (that's what makes the
// app work "in parallel"). No database to set up.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATE_FILE = join(DATA_DIR, 'state.json');
const GUESTS_FILE = join(DATA_DIR, 'guests.json');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadGuests() {
  if (!existsSync(GUESTS_FILE)) return [];
  return JSON.parse(readFileSync(GUESTS_FILE, 'utf8'));
}

export function saveGuests(guests) {
  ensureDir();
  writeFileSync(GUESTS_FILE, JSON.stringify(guests, null, 2));
}

const emptyState = () => ({
  pairs: {},
  raters: {},
  voteLog: [],
  constraints: { adjacent: [], groups: [] },
});

export function loadState() {
  if (!existsSync(STATE_FILE)) return emptyState();
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...emptyState(), ...s };
  } catch {
    return emptyState();
  }
}

let pending = false;
let cached = null;

// Debounced write — many votes can arrive quickly; we coalesce disk writes.
export function saveState(state) {
  ensureDir();
  cached = state;
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    if (cached) writeFileSync(STATE_FILE, JSON.stringify(cached, null, 2));
  }, 250);
}

export function flush() {
  if (cached) {
    ensureDir();
    writeFileSync(STATE_FILE, JSON.stringify(cached, null, 2));
  }
}

const defaultConfig = () => ({ numTables: 2, seatsPerTable: 6 });

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return defaultConfig();
  try {
    return { ...defaultConfig(), ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
