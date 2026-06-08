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
    // rater unknown (server restarted / data cleared) — re-register
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
      <div class="sub">next to <b>${esc(data.ego.name)}</b>?</div>
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
      // small delay so the fling animation reads before the next card pops in
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
  // red (low) -> amber -> sage (high)
  const hue = s * 120; // 0 red .. 120 green
  return `hsl(${hue}, 55%, 45%)`;
}

function renderResults(r) {
  const body = $('resultsBody');
  if (!r.progress || r.progress.totalVotes === 0) {
    body.innerHTML = '<div class="empty">No votes yet.<br />Swipe a few pairings and the seating chart will appear here.</div>';
    return;
  }

  // suggested long-table ordering
  let strip = '';
  r.seating.forEach((s, i) => {
    if (i > 0) {
      const link = s.neighborLeft ?? 0;
      strip += `<div class="link" style="background:${scoreColor(link)}"></div>`;
    }
    strip += `
      <div class="seat">
        <div class="bubble" style="background:${colorFor(s.name)}">${initials(s.name)}</div>
        <div class="seat-name">${esc(s.name)}</div>
      </div>`;
  });

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

  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="num">${r.progress.pairsSeen}</div><div class="lab">pairs rated</div></div>
      <div class="stat"><div class="num">${Math.round((r.progress.coverage || 0) * 100)}%</div><div class="lab">coverage</div></div>
      <div class="stat"><div class="num">${r.progress.totalVotes}</div><div class="lab">votes</div></div>
    </div>

    <div class="section-title">Suggested long table</div>
    <div class="table-strip">${strip}</div>
    <p class="muted" style="font-size:12px;margin:0 4px">Order maximizes total neighbor affinity. Colored links show how strong each adjacency is.</p>

    <div class="section-title">Power pairs ♥</div>
    ${r.topPairs.map(pairRow).join('') || '<p class="muted">—</p>'}

    <div class="section-title">Keep apart ✕</div>
    ${r.avoidPairs.filter((p) => p.score < 0.5).map(pairRow).join('') || '<p class="muted">Nothing flagged yet.</p>'}

    <div class="section-title">Raters</div>
    <div>${raters}</div>
  `;
}

// ---------- boot ----------
if (store.raterId) {
  startSwiping();
} else {
  show('join');
}
