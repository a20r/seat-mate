// app.js — SeatMate client. Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then((r) => r.json());

const store = {
  raterId: localStorage.getItem('sm_raterId') || null,
  name: localStorage.getItem('sm_name') || '',
};

let currentCard = null; // {ego, candidate, pair, progress}
let busy = false;

// ---------- view switching ----------
function show(view) {
  for (const v of ['join', 'swipe', 'results']) $(`view-${v}`).classList.add('hidden');
  $(`view-${view}`).classList.remove('hidden');
}

// ---------- avatars ----------
function colorFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `hsl(${h}, 42%, 48%)`;
}
function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

// ---------- join ----------
$('joinBtn').onclick = async () => {
  const name = $('nameInput').value.trim() || 'Anonymous';
  const res = await api('/api/raters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  store.raterId = res.raterId;
  store.name = res.name;
  localStorage.setItem('sm_raterId', res.raterId);
  localStorage.setItem('sm_name', res.name);
  startSwiping();
};
$('resultsLinkBtn').onclick = () => openResults();
$('backToJoin').onclick = () => show('join');
$('endBtn').onclick = () => openResults();
$('backToSwipe').onclick = () => show('swipe');
$('refreshResults').onclick = () => openResults();

if (store.name) $('nameInput').value = store.name;

// ---------- swiping ----------
async function startSwiping() {
  show('swipe');
  await loadCard();
}

async function loadCard() {
  if (!store.raterId) return show('join');
  const data = await api(`/api/card?raterId=${store.raterId}`);
  if (data.error) {
    localStorage.removeItem('sm_raterId');
    store.raterId = null;
    return show('join');
  }
  if (data.needGuests) {
    $('deck').innerHTML = '<div class="card"><div class="empty">Add at least two guests in <b>data/guests.json</b> to start.</div></div>';
    return;
  }
  renderCard(data);
}

function renderCard(data) {
  currentCard = data;
  $('egoName').textContent = data.ego.name;
  updateProgress(data.progress);

  const c = data.candidate;
  const chips = [c.side, c.relationship].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  const field = (label, val) =>
    val ? `<div class="field"><div class="label">${label}</div><div class="value">${esc(val)}</div></div>` : '';
  const scorePct = Math.round(data.pair.score * 100);

  const deck = $('deck');
  deck.innerHTML = `
    <div class="card" id="topCard">
      <div class="stamp like">SEAT 'EM</div>
      <div class="stamp nope">NOPE</div>
      <div class="avatar" style="background:${colorFor(c.name)}">${initials(c.name)}</div>
      <h2>${esc(c.name)}</h2>
      <div class="sub">near <b>${esc(data.ego.name)}</b>?</div>
      <div class="chips">${chips}</div>
      ${field('Notes', c.notes)}
      ${field('Fun fact', c.funFact)}
      <div class="meta">
        <span>${data.pair.votes} vote${data.pair.votes === 1 ? '' : 's'} so far</span>
        <span class="score-pill">${scorePct}% match</span>
      </div>
    </div>`;
  attachDrag($('topCard'));
}

function updateProgress(p) {
  const pct = Math.round((p.coverage || 0) * 100);
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = `${p.pairsSeen}/${p.totalPairs} pairings explored · ${p.totalVotes} votes · ${p.guests} guests`;
}

function esc(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- drag / swipe gestures ----------
function attachDrag(card) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const likeStamp = card.querySelector('.stamp.like');
  const nopeStamp = card.querySelector('.stamp.nope');

  const down = (x, y) => { startX = x; startY = y; dragging = true; card.style.transition = 'none'; };
  const move = (x, y) => {
    if (!dragging) return;
    dx = x - startX; dy = y - startY;
    const rot = dx / 18;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    const t = Math.min(Math.abs(dx) / 120, 1);
    likeStamp.style.opacity = dx > 0 ? t : 0;
    nopeStamp.style.opacity = dx < 0 ? t : 0;
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = 'transform 0.3s ease';
    if (dx > 110) return fling('right');
    if (dx < -110) return fling('left');
    card.style.transform = '';
    likeStamp.style.opacity = 0;
    nopeStamp.style.opacity = 0;
  };

  card.addEventListener('touchstart', (e) => down(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  card.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
  card.addEventListener('touchend', up);
  card.addEventListener('mousedown', (e) => down(e.clientX, e.clientY));
  window.addEventListener('mousemove', (e) => dragging && move(e.clientX, e.clientY));
  window.addEventListener('mouseup', up);

  function fling(dir) {
    const offX = dir === 'right' ? window.innerWidth : -window.innerWidth;
    card.style.transform = `translate(${offX}px, ${dy}px) rotate(${dir === 'right' ? 22 : -22}deg)`;
    vote(dir);
  }
}

async function vote(direction) {
  if (busy || !currentCard) return;
  busy = true;
  const { ego, candidate } = currentCard;
  try {
    const res = await api('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raterId: store.raterId, egoId: ego.id, candidateId: candidate.id, direction }),
    });
    if (res.next) {
      setTimeout(() => { renderCard(res.next); busy = false; }, 180);
    } else {
      busy = false;
      loadCard();
    }
  } catch {
    busy = false;
    loadCard();
  }
}

$('likeBtn').onclick = () => { const c = $('topCard'); if (c) { c.style.transition = 'transform 0.3s ease'; c.style.transform = `translate(${window.innerWidth}px,0) rotate(22deg)`; } vote('right'); };
$('nopeBtn').onclick = () => { const c = $('topCard'); if (c) { c.style.transition = 'transform 0.3s ease'; c.style.transform = `translate(${-window.innerWidth}px,0) rotate(-22deg)`; } vote('left'); };

// ---------- results ----------
async function openResults() {
  show('results');
  $('resultsBody').innerHTML = '<p class="muted">Crunching the affinities…</p>';
  const r = await api('/api/results');
  renderResults(r);
}

function scoreColor(s) {
  const hue = s * 120;
  return `hsl(${hue}, 55%, 45%)`;
}

// ---------- config panel ----------
function renderConfigPanel(cfg, onSave) {
  return `
    <div class="config-panel" id="configPanel">
      <div class="config-row">
        <label class="config-label">Tables</label>
        <div class="config-stepper">
          <button class="step-btn" data-field="numTables" data-delta="-1">−</button>
          <span class="step-val" id="cfgNumTables">${cfg.numTables}</span>
          <button class="step-btn" data-field="numTables" data-delta="1">+</button>
        </div>
        <label class="config-label">Seats / table</label>
        <div class="config-stepper">
          <button class="step-btn" data-field="seatsPerTable" data-delta="-2">−</button>
          <span class="step-val" id="cfgSeatsPerTable">${cfg.seatsPerTable}</span>
          <button class="step-btn" data-field="seatsPerTable" data-delta="2">+</button>
        </div>
        <button class="config-save-btn" id="configSaveBtn">Recalculate</button>
      </div>
      <p class="config-hint">Seats per table must be even (${cfg.seatsPerTable / 2} per side).</p>
    </div>`;
}

function attachConfigHandlers(cfg, onSave) {
  const localCfg = { ...cfg };

  document.querySelectorAll('.step-btn').forEach((btn) => {
    btn.onclick = () => {
      const field = btn.dataset.field;
      const delta = parseInt(btn.dataset.delta, 10);
      let val = localCfg[field] + delta;
      if (field === 'numTables') val = Math.max(1, Math.min(20, val));
      if (field === 'seatsPerTable') val = Math.max(2, Math.min(40, val));
      localCfg[field] = val;
      $(`cfg${field.charAt(0).toUpperCase() + field.slice(1)}`).textContent = val;
      // Update hint
      const hint = document.querySelector('.config-hint');
      if (hint) hint.textContent = `Seats per table must be even (${localCfg.seatsPerTable / 2} per side).`;
    };
  });

  $('configSaveBtn').onclick = () => onSave(localCfg);
}

// Build the seating table HTML for one table entry.
function renderTableSection(tableData, tableNum, totalTables) {
  const { sideA, sideB, score } = tableData;
  const k = Math.max(sideA.length, sideB.length);
  if (k === 0) return '';

  // Pad shorter side with nulls.
  const a = [...sideA];
  const b = [...sideB];
  while (a.length < k) a.push(null);
  while (b.length < k) b.push(null);

  // Side A row: seats + links between adjacent pairs.
  function seatHTML(g) {
    if (!g) return `<div class="seat empty-seat"><div class="bubble empty-bubble">?</div><div class="seat-name muted">—</div></div>`;
    return `<div class="seat">
      <div class="bubble" style="background:${colorFor(g.name)}">${initials(g.name)}</div>
      <div class="seat-name">${esc(g.name)}</div>
    </div>`;
  }

  function adjLinkHTML(g1, g2) {
    if (!g1 || !g2) return `<div class="adj-link empty-link"></div>`;
    // Use neighborScore — approximate from affinity sigmoid, but we don't have
    // it here. We'll color by the stored score if available; for now use a neutral color.
    return `<div class="adj-link"></div>`;
  }

  function acrossLinkHTML(ga, gb) {
    if (!ga || !gb) return `<div class="across-seg empty-across"></div>`;
    return `<div class="across-seg"></div>`;
  }

  // Build side A strip.
  let sideAHtml = '';
  for (let i = 0; i < k; i++) {
    sideAHtml += seatHTML(a[i]);
    if (i < k - 1) sideAHtml += adjLinkHTML(a[i], a[i + 1]);
  }

  // Build across bar.
  let acrossHtml = '';
  for (let i = 0; i < k; i++) {
    acrossHtml += acrossLinkHTML(a[i], b[i]);
    if (i < k - 1) acrossHtml += `<div class="across-spacer"></div>`;
  }

  // Build side B strip.
  let sideBHtml = '';
  for (let i = 0; i < k; i++) {
    sideBHtml += seatHTML(b[i]);
    if (i < k - 1) sideBHtml += adjLinkHTML(b[i], b[i + 1]);
  }

  const label = totalTables > 1 ? `Table ${tableNum}` : 'Your Table';
  return `
    <div class="table-section">
      <div class="table-header">
        <span class="table-label">${label}</span>
        <span class="table-score">${(score || 0).toFixed(1)} affinity pts</span>
      </div>
      <div class="table-body">
        <div class="side-label">Side A</div>
        <div class="seat-row">${sideAHtml}</div>
        <div class="across-row">${acrossHtml}</div>
        <div class="seat-row">${sideBHtml}</div>
        <div class="side-label side-label-b">Side B</div>
      </div>
      <p class="table-hint">Adjacent = strongest bond · Across = medium · Diagonal = group</p>
    </div>`;
}

function renderResults(r) {
  const body = $('resultsBody');

  if (!r.progress || r.progress.totalVotes === 0) {
    body.innerHTML = `
      ${renderConfigPanel(r.config || { numTables: 2, seatsPerTable: 6 }, saveConfig)}
      <div class="empty">No votes yet.<br />Swipe a few pairings and the seating chart will appear here.</div>`;
    attachConfigHandlers(r.config || { numTables: 2, seatsPerTable: 6 }, saveConfig);
    return;
  }

  const pairRow = (p) => `
    <div class="pair-row">
      <span class="pair-names">${esc(p.nameA)} &middot; ${esc(p.nameB)}</span>
      <span class="pair-meta">
        <span class="bar"><span style="width:${Math.round(p.score * 100)}%;background:${scoreColor(p.score)}"></span></span>
        <span class="pct">${Math.round(p.score * 100)}%</span>
        <span class="votes">${p.votes}🗳</span>
      </span>
    </div>`;

  const raters = (r.raters || []).filter((x) => x.votes > 0).sort((a, b) => b.votes - a.votes)
    .map((x) => `<span class="rater-pill"><b>${esc(x.name)}</b> ${x.votes}</span>`).join('') || '<span class="muted">—</span>';

  const tables = (r.tables || []);
  const tablesHtml = tables.map((t, i) => renderTableSection(t, i + 1, tables.length)).join('');

  body.innerHTML = `
    ${renderConfigPanel(r.config, saveConfig)}

    <div class="stat-grid">
      <div class="stat"><div class="num">${r.progress.pairsSeen}</div><div class="lab">pairs rated</div></div>
      <div class="stat"><div class="num">${Math.round((r.progress.coverage || 0) * 100)}%</div><div class="lab">coverage</div></div>
      <div class="stat"><div class="num">${r.progress.totalVotes}</div><div class="lab">votes</div></div>
    </div>

    <div class="section-title">Seating Chart</div>
    <p class="muted" style="font-size:12px;margin:0 4px 10px">Placement maximises adjacent + across-table + group affinities.</p>
    ${tablesHtml}

    <div class="section-title">Power pairs ♥</div>
    ${r.topPairs.map(pairRow).join('') || '<p class="muted">—</p>'}

    <div class="section-title">Keep apart ✕</div>
    ${r.avoidPairs.filter((p) => p.score < 0.5).map(pairRow).join('') || '<p class="muted">Nothing flagged yet.</p>'}

    <div class="section-title">Raters</div>
    <div>${raters}</div>
  `;

  attachConfigHandlers(r.config, saveConfig);
}

async function saveConfig(cfg) {
  $('resultsBody').innerHTML = '<p class="muted">Recalculating…</p>';
  await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  const r = await api('/api/results');
  renderResults(r);
}

// ---------- boot ----------
if (store.raterId) {
  startSwiping();
} else {
  show('join');
}
