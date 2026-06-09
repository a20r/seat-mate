// app.js — SeatMate client. Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then((r) => r.json());

const store = {
  raterId: localStorage.getItem('sm_raterId') || null,
  name: localStorage.getItem('sm_name') || '',
  guests: [],
};

let currentCard = null; // {ego, candidate, pair, progress}
let busy = false;
let shownEgoId = null;  // which ego the deck is currently showing

// ---------- view switching ----------
function show(view) {
  for (const v of ['join', 'swipe', 'results']) $(`view-${v}`).classList.add('hidden');
  $(`view-${view}`).classList.remove('hidden');
}

// ---------- avatars ----------
function colorFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `hsl(${h}, 38%, 46%)`;
}
function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('');
}
function esc(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- guests cache ----------
async function refreshGuests() {
  try {
    const r = await api('/api/guests');
    store.guests = r.guests || [];
  } catch { /* offline — sheet falls back to free text */ }
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

// Render the next card — if the person we're seating changed, play a full-screen
// takeover first so it's never ambiguous who the card is about.
async function renderCard(data) {
  const changed = data.ego.id !== shownEgoId;
  shownEgoId = data.ego.id;
  if (changed) {
    await playEgoIntro(data.ego, () => paintCard(data));
  } else {
    paintCard(data);
  }
}

function paintCard(data) {
  currentCard = data;
  $('egoName').textContent = data.ego.name;
  $('hintEgo').textContent = data.ego.name.split(/\s+/)[0];
  updateProgress(data.progress);

  const c = data.candidate;
  const chips = [c.side, c.relationship].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  const field = (label, val) =>
    val ? `<div class="field"><div class="label">${label}</div><div class="value">${esc(val)}</div></div>` : '';
  const scorePct = Math.round(data.pair.score * 100);

  $('deck').innerHTML = `
    <div class="card" id="topCard">
      <div class="stamp like">SEAT</div>
      <div class="stamp nope">NOPE</div>
      <div class="stamp up">TOGETHER</div>
      <div class="avatar" style="background:${colorFor(c.name)}">${initials(c.name)}</div>
      <h2>${esc(c.name)}</h2>
      <div class="sub">beside <b>${esc(data.ego.name)}</b>?</div>
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

// ---------- ego-change takeover ----------
// Returns a promise that resolves once the overlay has fully lifted. `onCover`
// fires while the screen is fully obscured, so the deck can be swapped unseen.
function playEgoIntro(ego, onCover) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'ego-intro';
    ov.style.setProperty('--ego-color', colorFor(ego.name));
    ov.innerHTML = `
      <div class="ego-intro-veil"></div>
      <div class="ego-intro-inner">
        <div class="ego-intro-eyebrow">Now seating</div>
        <div class="ego-intro-avatar">${initials(ego.name)}</div>
        <div class="ego-intro-rule"></div>
        <div class="ego-intro-name">${esc(ego.name)}</div>
        <div class="ego-intro-tag">Who should sit beside them?</div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('show'));

    let covered = false;
    const cover = () => { if (!covered) { covered = true; try { onCover && onCover(); } catch (_) {} } };
    setTimeout(cover, 560);                       // swap deck while fully veiled
    setTimeout(() => ov.classList.add('out'), 1050);
    setTimeout(() => { ov.remove(); resolve(); }, 1500);
  });
}

// ---------- drag / swipe gestures ----------
function attachDrag(card) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const likeStamp = card.querySelector('.stamp.like');
  const nopeStamp = card.querySelector('.stamp.nope');
  const upStamp = card.querySelector('.stamp.up');

  const down = (x, y) => { startX = x; startY = y; dx = 0; dy = 0; dragging = true; card.style.transition = 'none'; };
  const move = (x, y) => {
    if (!dragging) return;
    dx = x - startX; dy = y - startY;
    const vertical = dy < 0 && Math.abs(dy) > Math.abs(dx);
    if (vertical) {
      card.style.transform = `translate(0, ${dy}px) scale(${1 - Math.min(Math.abs(dy) / 1600, 0.05)})`;
      upStamp.style.opacity = Math.min(Math.abs(dy) / 110, 1);
      likeStamp.style.opacity = 0; nopeStamp.style.opacity = 0;
    } else {
      const rot = dx / 18;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      const t = Math.min(Math.abs(dx) / 120, 1);
      likeStamp.style.opacity = dx > 0 ? t : 0;
      nopeStamp.style.opacity = dx < 0 ? t : 0;
      upStamp.style.opacity = 0;
    }
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = 'transform 0.3s ease';
    // swipe up → seat-together sheet (takes priority when mostly vertical)
    if (dy < -90 && Math.abs(dy) > Math.abs(dx) * 1.2) {
      card.style.transform = '';
      likeStamp.style.opacity = nopeStamp.style.opacity = upStamp.style.opacity = 0;
      return openSheet();
    }
    if (dx > 110) return fling('right');
    if (dx < -110) return fling('left');
    card.style.transform = '';
    likeStamp.style.opacity = 0;
    nopeStamp.style.opacity = 0;
    upStamp.style.opacity = 0;
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
$('togetherBtn').onclick = () => openSheet();

// ---------- seat-together sheet ----------
let sheetMode = 'adjacent';

function openSheet() {
  if (!currentCard) return;
  const ego = currentCard.ego;
  $('sheetEgo').textContent = ego.name;
  $('sheetMsg').textContent = '';
  $('sheetMsg').className = 'sheet-msg';
  $('sheetInput').value = '';
  $('sheetChips').innerHTML = '';
  setSheetMode('adjacent');

  // datalist of everyone except the current ego
  $('guestNames').innerHTML = store.guests
    .filter((g) => g.id !== ego.id)
    .map((g) => `<option value="${esc(g.name)}"></option>`)
    .join('');

  const sheet = $('seatSheet');
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => sheet.classList.add('open'));
  setTimeout(() => $('sheetInput').focus(), 250);
}

function closeSheet() {
  const sheet = $('seatSheet');
  sheet.classList.remove('open');
  setTimeout(() => sheet.classList.add('hidden'), 280);
}

function setSheetMode(mode) {
  sheetMode = mode;
  document.querySelectorAll('#sheetMode .seg-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  $('sheetInput').placeholder = mode === 'adjacent'
    ? 'Who must sit right beside them?'
    : 'Who must share their table?';
}

document.querySelectorAll('#sheetMode .seg-opt').forEach((b) => {
  b.onclick = () => setSheetMode(b.dataset.mode);
});

async function addFromSheet() {
  const name = $('sheetInput').value.trim();
  const msg = $('sheetMsg');
  if (!name) { msg.textContent = 'Type a name first.'; msg.className = 'sheet-msg warn'; return; }

  const res = await api('/api/constraints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: sheetMode, egoId: currentCard.ego.id, name }),
  });
  if (res.error) {
    msg.textContent = res.error === 'no guest matches' ? `No guest named “${name}”.` : res.error;
    msg.className = 'sheet-msg warn';
    return;
  }
  const verb = sheetMode === 'adjacent' ? 'beside' : 'with';
  const icon = sheetMode === 'adjacent' ? '💍' : '👪';
  const chip = document.createElement('span');
  chip.className = 'added-chip';
  chip.innerHTML = `${icon} ${esc(res.matched.name)} <small>${verb}</small>`;
  $('sheetChips').appendChild(chip);
  msg.textContent = `Pinned ${res.matched.name} ${verb} ${currentCard.ego.name}.`;
  msg.className = 'sheet-msg ok';
  $('sheetInput').value = '';
  $('sheetInput').focus();
}

$('sheetAdd').onclick = addFromSheet;
$('sheetInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromSheet(); } });
$('sheetCancel').onclick = closeSheet;
$('sheetDone').onclick = closeSheet;
$('seatSheet').querySelector('.sheet-scrim').onclick = closeSheet;

// ---------- results ----------
async function openResults() {
  show('results');
  $('resultsBody').innerHTML = '<p class="muted">Crunching the seating…</p>';
  const r = await api('/api/results');
  renderResults(r);
}

function scoreColor(s) {
  const hue = s * 120;
  return `hsl(${hue}, 45%, 46%)`;
}

function renderConfigPanel(cfg) {
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
      <p class="config-hint">Seats per table is even — ${cfg.seatsPerTable / 2} on each side.</p>
    </div>`;
}

function attachConfigHandlers(cfg) {
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
      const hint = document.querySelector('.config-hint');
      if (hint) hint.textContent = `Seats per table is even — ${localCfg.seatsPerTable / 2} on each side.`;
    };
  });
  $('configSaveBtn').onclick = () => saveConfig(localCfg);
}

// One table rendered as Side A · across bar · Side B.
function renderTableSection(tableData, tableNum, totalTables, pinned) {
  const { sideA, sideB, score } = tableData;
  const k = Math.max(sideA.length, sideB.length);
  if (k === 0) return '';
  const a = [...sideA]; const b = [...sideB];
  while (a.length < k) a.push(null);
  while (b.length < k) b.push(null);

  const seatHTML = (g) => {
    if (!g) return `<div class="seat empty-seat"><div class="bubble empty-bubble">·</div><div class="seat-name muted">—</div></div>`;
    const pin = pinned.has(g.id) ? '<span class="pin-dot" title="Pinned by a rule">•</span>' : '';
    return `<div class="seat">
      <div class="bubble" style="background:${colorFor(g.name)}">${initials(g.name)}${pin}</div>
      <div class="seat-name">${esc(g.name)}</div>
    </div>`;
  };

  let sideAHtml = '';
  for (let i = 0; i < k; i++) { sideAHtml += seatHTML(a[i]); if (i < k - 1) sideAHtml += `<div class="adj-link${a[i] && a[i + 1] ? '' : ' empty-link'}"></div>`; }
  let acrossHtml = '';
  for (let i = 0; i < k; i++) { acrossHtml += `<div class="across-seg${a[i] && b[i] ? '' : ' empty-across'}"></div>`; if (i < k - 1) acrossHtml += `<div class="across-spacer"></div>`; }
  let sideBHtml = '';
  for (let i = 0; i < k; i++) { sideBHtml += seatHTML(b[i]); if (i < k - 1) sideBHtml += `<div class="adj-link${b[i] && b[i + 1] ? '' : ' empty-link'}"></div>`; }

  const label = totalTables > 1 ? `Table ${romanOrNum(tableNum)}` : 'The Table';
  return `
    <div class="table-section">
      <div class="table-header">
        <span class="table-label">${label}</span>
        <span class="table-score">${(score || 0).toFixed(1)} affinity</span>
      </div>
      <div class="table-body">
        <div class="side-label">Side A</div>
        <div class="seat-row">${sideAHtml}</div>
        <div class="across-row">${acrossHtml}</div>
        <div class="seat-row">${sideBHtml}</div>
        <div class="side-label side-label-b">Side B</div>
      </div>
      <p class="table-hint">Beside · strongest &nbsp;|&nbsp; Across · medium &nbsp;|&nbsp; Diagonal · group</p>
    </div>`;
}

function romanOrNum(n) {
  const r = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  return r[n] || n;
}

function renderConstraints(cons) {
  const adj = cons?.adjacent || [];
  const groups = cons?.groups || [];
  if (adj.length === 0 && groups.length === 0) return '';

  const adjRows = adj.map((c) => `
    <div class="rule-row">
      <span class="rule-icon">💍</span>
      <span class="rule-text">${esc(c.nameA)} <em>beside</em> ${esc(c.nameB)}</span>
      <button class="rule-x" data-type="adjacent" data-a="${c.a}" data-b="${c.b}">×</button>
    </div>`).join('');

  const grpRows = groups.map((g) => `
    <div class="rule-row">
      <span class="rule-icon">👪</span>
      <span class="rule-text">${g.members.map((m) => esc(m.name)).join(' · ')}</span>
      <button class="rule-x" data-type="group" data-index="${g.index}">×</button>
    </div>`).join('');

  return `
    <div class="section-title">Pinned together</div>
    <div class="rules">${adjRows}${grpRows}</div>`;
}

function renderResults(r) {
  const body = $('resultsBody');
  const cons = r.constraints || { adjacent: [], groups: [] };

  if (!r.progress || r.progress.totalVotes === 0) {
    body.innerHTML = `
      ${renderConfigPanel(r.config || { numTables: 2, seatsPerTable: 6 })}
      ${renderConstraints(cons)}
      <div class="empty">No votes yet.<br />Swipe a few pairings and the seating chart will bloom here.</div>`;
    attachConfigHandlers(r.config || { numTables: 2, seatsPerTable: 6 });
    attachRuleHandlers();
    return;
  }

  // ids that are pinned by any rule, to flag them on the chart
  const pinned = new Set();
  for (const c of cons.adjacent) { pinned.add(c.a); pinned.add(c.b); }
  for (const g of cons.groups) for (const m of g.members) pinned.add(m.id);

  const pairRow = (p) => `
    <div class="pair-row">
      <span class="pair-names">${esc(p.nameA)} &middot; ${esc(p.nameB)}</span>
      <span class="pair-meta">
        <span class="bar"><span style="width:${Math.round(p.score * 100)}%;background:${scoreColor(p.score)}"></span></span>
        <span class="pct">${Math.round(p.score * 100)}%</span>
        <span class="votes">${p.votes}</span>
      </span>
    </div>`;

  const raters = (r.raters || []).filter((x) => x.votes > 0).sort((a, b) => b.votes - a.votes)
    .map((x) => `<span class="rater-pill"><b>${esc(x.name)}</b> ${x.votes}</span>`).join('') || '<span class="muted">—</span>';

  const tables = r.tables || [];
  const tablesHtml = tables.map((t, i) => renderTableSection(t, i + 1, tables.length, pinned)).join('');

  body.innerHTML = `
    ${renderConfigPanel(r.config)}

    <div class="stat-grid">
      <div class="stat"><div class="num">${r.progress.pairsSeen}</div><div class="lab">pairs rated</div></div>
      <div class="stat"><div class="num">${Math.round((r.progress.coverage || 0) * 100)}%</div><div class="lab">coverage</div></div>
      <div class="stat"><div class="num">${r.progress.totalVotes}</div><div class="lab">votes</div></div>
    </div>

    ${renderConstraints(cons)}

    <div class="section-title">Seating chart</div>
    ${tablesHtml}

    <div class="section-title">Power pairs</div>
    ${r.topPairs.map(pairRow).join('') || '<p class="muted">—</p>'}

    <div class="section-title">Keep apart</div>
    ${r.avoidPairs.filter((p) => p.score < 0.5).map(pairRow).join('') || '<p class="muted">Nothing flagged yet.</p>'}

    <div class="section-title">Raters</div>
    <div class="raters-wrap">${raters}</div>
  `;

  attachConfigHandlers(r.config);
  attachRuleHandlers();
}

function attachRuleHandlers() {
  document.querySelectorAll('.rule-x').forEach((btn) => {
    btn.onclick = async () => {
      const type = btn.dataset.type;
      const payload = type === 'group'
        ? { type, index: parseInt(btn.dataset.index, 10) }
        : { type, a: btn.dataset.a, b: btn.dataset.b };
      await api('/api/constraints', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      openResults();
    };
  });
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
refreshGuests();
if (store.raterId) {
  startSwiping();
} else {
  show('join');
}
