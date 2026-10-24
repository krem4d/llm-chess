import { Chess } from '/vendor/chess.js';
import { systemPrompt, turnPrompt, parseMove, moveList } from '/prompt.js';
import { THEMES, pieceUrl } from '/themes.js';
import { sounds } from '/sound.js';
import { createBoard } from '/board.js';

const MAX_ATTEMPTS = 3; // illegal answers in a row before a model forfeits
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const OPENINGS = [
  ['Italian', '1. e4 e5 2. Nf3 Nc6 3. Bc4'],
  ['Ruy Lopez', '1. e4 e5 2. Nf3 Nc6 3. Bb5'],
  ['Sicilian', '1. e4 c5'],
  ['French', '1. e4 e6'],
  ['Caro-Kann', '1. e4 c6'],
  ["Queen's Gambit", '1. d4 d5 2. c4'],
  ["King's Indian", '1. d4 Nf6 2. c4 g6'],
  ['London', '1. d4 d5 2. Bf4'],
  ['English', '1. c4'],
];
const ENGINE_NAME = { human: 'Human', claude: 'Claude', codex: 'Codex' };
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- state ----------

let game = new Chess();
let fens = [game.fen()];   // position after each ply; fens[0] is the start
let view = null;           // ply being reviewed, or null for the live position
let mode = 'idle';         // idle | setup (playing an opening by hand) | play
let openingPlies = 0;
let paused = false;
let result = null;         // { title, detail }
let overlayClosed = false;
let token = 0;             // bumps on every new game, so late answers from an old game are dropped
let abort = null;
let flipped = false;
let theme = THEMES[store.get('theme')] ? store.get('theme') : 'classic';
let soundOn = store.get('sound', true);
let models = { claude: { models: [], efforts: [] }, codex: [] };
const sessions = { w: null, b: null }; // one CLI session per seat for the whole game
const thinking = { w: null, b: null }; // { since, note }

const defaults = {
  w: { engine: 'human', model: '', effort: 'high', vision: 'image' },
  b: { engine: 'claude', model: 'opus', effort: 'high', vision: 'image' },
};
let seats = { w: store.get('player-w', defaults.w), b: store.get('player-b', defaults.b) };
let draft = structuredClone(seats);

const board = createBoard($('#board'), { onMove: humanMove });

// ---------- helpers ----------

const colorName = c => (c === 'w' ? 'White' : 'Black');
const isAI = c => seats[c].engine !== 'human';
const shownChess = () => (view === null ? game : new Chess(fens[view]));
const shownPly = () => (view === null ? fens.length - 1 : view);
const play = name => soundOn && sounds[name]();

function label(c, s = seats[c]) {
  if (s.engine === 'human') return 'Human';
  return `${ENGINE_NAME[s.engine]} ${s.model}`;
}

function logo(engine, size = '') {
  const n = el('span', `logo ${engine} ${size}`);
  n.setAttribute('aria-hidden', 'true');
  return n;
}

// ---------- rendering ----------

function render() {
  const t = THEMES[theme];
  const root = document.documentElement.style;
  root.setProperty('--light', t.light);
  root.setProperty('--dark', t.dark);
  root.setProperty('--mark', t.mark);
  $('#theme-swatch').style.background = `conic-gradient(${t.light} 0 25%, ${t.dark} 0 50%, ${t.light} 0 75%, ${t.dark} 0)`;

  const chess = shownChess();
  const ply = shownPly();
  const last = ply > 0 ? game.history({ verbose: true })[ply - 1] : null;
  const live = view === null;
  const interactive = live && !result && (mode === 'setup' || (mode === 'play' && !paused && !isAI(game.turn())));
  board.render({ chess, flipped, last, theme, interactive });

  const [top, bottom] = flipped ? ['w', 'b'] : ['b', 'w'];
  renderBar($('#bar-top'), top, chess);
  renderBar($('#bar-bottom'), bottom, chess);
  renderMoves(ply);
  renderMatchup();
  renderOverlay();
  renderThinking();

  $('#setup-banner').hidden = mode !== 'setup';
  $('#board').classList.toggle('reviewing', !live);
  const pause = $('#pause');
  pause.disabled = mode !== 'play' || !!result;
  pause.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
  pause.querySelector('span').textContent = paused ? 'Resume' : 'Pause';
  document.querySelectorAll('[data-nav]').forEach(b => {
    b.disabled = (b.dataset.nav === 'first' || b.dataset.nav === 'prev') ? ply === 0 : live;
  });
  $('#sound use').setAttribute('href', soundOn ? '#i-sound' : '#i-mute');
}

function renderBar(node, c, chess) {
  const s = seats[c];
  const missing = captured(chess);
  const enemy = c === 'w' ? 'b' : 'w';
  const myLead = material(chess, c) - material(chess, enemy);

  const who = el('div', 'who');
  who.append(el('span', `disc ${c}`));
  if (s.engine !== 'human') who.append(logo(s.engine));
  who.append(el('span', 'name', label(c)));

  const caps = el('div', 'caps');
  for (const type of ['q', 'r', 'b', 'n', 'p']) {
    for (let i = 0; i < missing[enemy][type]; i++) {
      const img = new Image();
      img.src = pieceUrl(theme, enemy, type);
      img.alt = '';
      caps.append(img);
    }
  }
  if (myLead > 0) caps.append(el('span', 'lead', `+${myLead}`));
  who.append(caps);

  const status = el('div', 'status');
  const live = view === null;
  if (live && thinking[c]) {
    status.classList.add('busy');
    status.append(el('span', 'pulse'), el('span', 'thinking-time', thinkingText(c)));
  } else if (mode !== 'idle' && !result && live && game.turn() === c) {
    status.append(el('span', 'to-move', s.engine === 'human' ? (mode === 'setup' ? 'To move' : 'Your move') : paused ? 'Paused' : 'To move'));
  }
  node.replaceChildren(who, status);
  node.classList.toggle('active', mode !== 'idle' && !result && game.turn() === c);
}

function captured(chess) {
  const left = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of chess.board()) for (const p of row) if (p && p.type !== 'k') left[p.color][p.type]++;
  const out = { w: {}, b: {} };
  for (const c of ['w', 'b']) for (const t in START_COUNT) out[c][t] = Math.max(0, START_COUNT[t] - left[c][t]);
  return out;
}

function material(chess, c) {
  let sum = 0;
  for (const row of chess.board()) for (const p of row) if (p?.color === c && p.type !== 'k') sum += VALUES[p.type];
  return sum;
}

function renderMoves(ply) {
  const h = game.history();
  const items = [];
  for (let i = 0; i < h.length; i += 2) {
    const li = el('li');
    li.append(el('span', 'n', `${i / 2 + 1}.`));
    for (const j of [i, i + 1]) {
      if (j >= h.length) break;
      const b = el('button', 'ply', h[j]);
      b.dataset.ply = j + 1;
      if (j < openingPlies) b.classList.add('book');
      if (j + 1 === ply) b.classList.add('cur');
      li.append(b);
    }
    items.push(li);
  }
  const list = $('#moves');
  list.replaceChildren(...items);
  list.classList.toggle('empty', !h.length);
  const cur = list.querySelector('.cur');
  if (cur) list.scrollTop = cur.offsetTop - list.clientHeight / 2;
}

function renderMatchup() {
  const node = $('#matchup');
  if (mode === 'idle') { node.replaceChildren(); return; }
  const side = c => {
    const s = el('span', 'side');
    if (seats[c].engine !== 'human') s.append(logo(seats[c].engine));
    s.append(el('span', '', label(c)));
    return s;
  };
  node.replaceChildren(side('w'), el('span', 'vs', 'vs'), side('b'));
}

function renderOverlay() {
  const node = $('#overlay');
  if (mode === 'idle') {
    node.hidden = false;
    node.className = 'overlay intro';
    node.innerHTML = '<div class="card"><h2>Set up a match</h2><p>Pick two players: Claude, Codex, or you.</p><button class="btn primary" data-act="setup">New game</button></div>';
    return;
  }
  if (result && !overlayClosed && view === null) {
    if (node.classList.contains('result') && !node.hidden) return; // keep the entrance animation from replaying
    node.hidden = false;
    node.className = 'overlay result';
    node.innerHTML = '<div class="card"><h2></h2><p></p><div class="row"><button class="btn ghost" data-act="review">Review</button><button class="btn primary" data-act="setup">New game</button></div></div>';
    node.querySelector('h2').textContent = result.title;
    node.querySelector('p').textContent = result.detail;
    return;
  }
  node.hidden = true;
  node.className = 'overlay';
}

// ---------- reply panels ----------

function buildFeed(c) {
  const node = $(`#feed-${c}`);
  const s = seats[c];
  node.replaceChildren();
  node.classList.toggle('is-human', s.engine === 'human');
  node.classList.toggle('is-idle', mode === 'idle');

  const head = el('header', 'feed-head');
  const id = el('div', 'feed-id');
  id.append(s.engine === 'human' ? el('span', `disc big ${c}`) : logo(s.engine, 'big'));
  const names = el('div', 'feed-names');
  names.append(el('strong', '', s.engine === 'human' ? 'Human' : ENGINE_NAME[s.engine]));
  names.append(el('span', '', s.engine === 'human' ? `Plays ${colorName(c)}` : s.model));
  id.append(names);
  head.append(id);
  const tags = el('div', 'tags');
  tags.append(el('span', `tag side-${c}`, colorName(c)));
  if (s.engine !== 'human') {
    tags.append(el('span', 'tag', `${s.effort} effort`));
    tags.append(el('span', 'tag', s.vision === 'blind' ? 'Blindfold' : 'Board image'));
  }
  head.append(tags);

  const list = el('div', 'feed-list');
  if (mode === 'idle') list.append(el('p', 'feed-empty', `${colorName(c)}'s replies show up here.`));
  else if (s.engine === 'human') list.append(el('p', 'feed-empty', 'Your moves are in the move list below the board.'));
  else list.append(el('p', 'feed-empty', 'Each reply and the move it chose will show up here.'));
  const think = el('div', 'thinking-card');
  think.hidden = true;
  think.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span>Thinking</span><span class="thinking-time"></span>';
  list.append(think);
  node.append(head, list);
}

function addEntry(c, { ply, san, text, ms, illegal, error }) {
  const list = $(`#feed-${c} .feed-list`);
  list.querySelector('.feed-empty')?.remove();
  const card = el('article', 'entry' + (illegal ? ' illegal' : '') + (error ? ' error' : ''));
  const head = el('header');
  if (san) {
    const chip = el('button', 'san-chip', `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '...'} ${san}`);
    chip.dataset.ply = ply;
    chip.title = 'Show this position';
    head.append(chip);
  } else {
    head.append(el('span', 'flag', error ? 'Error' : `Illegal: ${illegal}`));
  }
  if (ms != null) head.append(el('span', 'time', `${(ms / 1000).toFixed(1)}s`));
  const body = el('div', 'reply', text.trim());
  card.append(head, body);
  list.insertBefore(card, list.querySelector('.thinking-card'));
  // Long replies start folded; the button only shows when there is more to read.
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 4) {
      const more = el('button', 'more', 'Show all');
      more.onclick = () => {
        const open = card.classList.toggle('open');
        more.textContent = open ? 'Show less' : 'Show all';
      };
      card.append(more);
    }
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  });
}

function thinkingText(c) {
  const t = thinking[c];
  if (!t) return '';
  const sec = Math.floor((Date.now() - t.since) / 1000);
  const time = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return t.note ? `${t.note} · ${time}` : `Thinking · ${time}`;
}

function renderThinking() {
  for (const c of ['w', 'b']) {
    const card = $(`#feed-${c} .thinking-card`);
    if (!card) continue;
    const was = card.hidden;
    card.hidden = !thinking[c];
    card.querySelector('.thinking-time').textContent = thinking[c] ? thinkingText(c).replace(/^Thinking · /, '') : '';
    if (was && !card.hidden) card.parentElement.scrollTo({ top: card.parentElement.scrollHeight, behavior: 'smooth' });
  }
}

setInterval(() => {
  if (!thinking.w && !thinking.b) return;
  const [top, bottom] = flipped ? ['w', 'b'] : ['b', 'w'];
  const t = $('#bar-top .thinking-time'), b = $('#bar-bottom .thinking-time');
  if (t) t.textContent = thinkingText(top);
  if (b) b.textContent = thinkingText(bottom);
  renderThinking();
}, 1000);

// ---------- the image a model sees ----------

const imgCache = new Map();
function loadImg(src) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = fail;
      img.src = src;
    }));
  }
  return imgCache.get(src);
}

// Draws the live position from `color`'s side and returns base64 PNG data.
async function boardImage(color) {
  const FILES = 'abcdefgh';
  const S = 96, canvas = document.createElement('canvas');
  canvas.width = canvas.height = S * 8;
  const c = canvas.getContext('2d');
  const t = THEMES[theme];
  const last = game.history({ verbose: true }).at(-1);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const f = color === 'w' ? col : 7 - col;
      const r = color === 'w' ? 7 - row : row;
      const sq = FILES[f] + (r + 1);
      const x = col * S, y = row * S;
      const isDark = (f + r) % 2 === 0;
      c.fillStyle = isDark ? t.dark : t.light;
      c.fillRect(x, y, S, S);
      if (last && (sq === last.from || sq === last.to)) {
        c.fillStyle = t.mark;
        c.fillRect(x, y, S, S);
      }
      const p = game.get(sq);
      if (p) c.drawImage(await loadImg(pieceUrl(theme, p.color, p.type)), x, y, S, S);
      c.font = 'bold 18px sans-serif';
      c.fillStyle = isDark ? t.light : t.dark;
      if (col === 0) c.fillText(String(r + 1), x + 5, y + 20);
      if (row === 7) c.fillText(FILES[f], x + S - 16, y + S - 7);
    }
  }
  return canvas.toDataURL('image/png').split(',')[1];
}

// ---------- game flow ----------

// Pieces that move in a ply: the piece itself, plus the rook when castling.
function slides(m) {
  const list = [{ from: m.from, to: m.to }];
  const r = m.color === 'w' ? '1' : '8';
  if (m.isKingsideCastle()) list.push({ from: `h${r}`, to: `f${r}` });
  if (m.isQueensideCastle()) list.push({ from: `a${r}`, to: `d${r}` });
  return list;
}

function moveSound(m) {
  if (game.inCheck()) play('check');
  else if (m.isKingsideCastle() || m.isQueensideCastle()) play('castle');
  else if (m.isCapture()) play('capture');
  else play('move');
}

function humanMove(move, slide) {
  if (mode === 'setup') {
    const m = game.move(move);
    fens.push(game.fen());
    moveSound(m);
    render();
    if (slide) board.animate(slides(m));
    return;
  }
  makeMove(move, slide);
}

function makeMove(move, slide = true) {
  const m = game.move(move);
  fens.push(game.fen());
  if (game.isCheckmate()) result = { title: `${colorName(m.color)} wins`, detail: `Checkmate by ${label(m.color)}.` };
  else if (game.isStalemate()) result = { title: 'Draw', detail: 'Stalemate.' };
  else if (game.isInsufficientMaterial()) result = { title: 'Draw', detail: 'Insufficient material.' };
  else if (game.isThreefoldRepetition()) result = { title: 'Draw', detail: 'Threefold repetition.' };
  else if (game.isDrawByFiftyMoves()) result = { title: 'Draw', detail: 'Fifty-move rule.' };
  if (result) play('end');
  else moveSound(m);
  render();
  if (slide && view === null) board.animate(slides(m));
  next();
}

function next() {
  if (mode !== 'play' || result || paused) return;
  const c = game.turn();
  if (isAI(c) && !thinking[c]) askModel(c);
}

async function askModel(c) {
  const my = token;
  const s = { ...seats[c] };
  const name = colorName(c);
  const sighted = s.vision === 'image';
  const opp = c === 'w' ? 'b' : 'w';
  const system = systemPrompt({ color: name, opponent: label(opp), sighted });
  const errors = [];
  thinking[c] = { since: Date.now(), note: '' };
  render();

  try {
    while (errors.length < MAX_ATTEMPTS) {
      const prompt = turnPrompt({ color: name, history: game.history(), sighted, errors });
      const image = sighted ? await boardImage(c) : null;
      if (my !== token) return; // paused or restarted while the image was drawn
      abort = new AbortController();
      const res = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: s.engine, model: s.model, effort: s.effort, system, prompt, image, session: sessions[c] }),
        signal: abort.signal,
      });
      const data = await res.json();
      if (my !== token) return;
      if (!res.ok) throw new Error(data.error);
      sessions[c] = data.session;

      const move = parseMove(data.text);
      let legal = null;
      try { legal = move && game.move(move); } catch {}
      if (legal) {
        game.undo(); // makeMove plays it for real, with sounds and end checks
        thinking[c] = null;
        addEntry(c, { ply: fens.length, san: legal.san, text: data.text, ms: data.ms });
        makeMove(move);
        return;
      }
      errors.push(move ?? '(no MOVE line)');
      addEntry(c, { illegal: move ?? 'no MOVE line', text: data.text, ms: data.ms });
      play('error');
      thinking[c] = { since: thinking[c].since, note: `Retry ${errors.length} of ${MAX_ATTEMPTS - 1}` };
      render();
    }
    thinking[c] = null;
    result = { title: `${colorName(opp)} wins`, detail: `${label(c)} gave ${MAX_ATTEMPTS} illegal moves in a row.` };
    play('end');
    render();
  } catch (e) {
    if (my !== token || e.name === 'AbortError') return;
    thinking[c] = null;
    paused = true;
    addEntry(c, { error: true, text: e.message });
    play('error');
    render();
  }
}

function resetLive(moves = []) {
  token++;
  abort?.abort();
  game = new Chess();
  fens = [game.fen()];
  for (const san of moves) {
    game.move(san);
    fens.push(game.fen());
  }
  view = null;
  result = null;
  overlayClosed = false;
  paused = false;
  thinking.w = thinking.b = null;
  sessions.w = sessions.b = null;
  board.clearMarks();
}

function startGame(moves) {
  const probe = new Chess();
  moves.forEach(m => probe.move(m));
  if (probe.isGameOver()) {
    const err = $('#opening-error');
    $('#opening-moves').value = moveList(moves);
    markOpening();
    err.textContent = 'This position is already over. Choose fewer moves.';
    err.hidden = false;
    if (!$('#setup').classList.contains('open')) openSetup(); // reopening would reset unsaved player choices
    return;
  }
  seats = structuredClone(draft);
  store.set('player-w', seats.w);
  store.set('player-b', seats.b);
  resetLive(moves);
  openingPlies = moves.length;
  mode = 'play';
  // Human plays Black against a model: show the board from Black's side.
  flipped = seats.b.engine === 'human' && seats.w.engine !== 'human';
  buildFeed('w');
  buildFeed('b');
  closeSetup();
  play('start');
  render();
  next();
}

// ---------- review ----------

function setView(ply) {
  const lastPly = fens.length - 1;
  ply = Math.max(0, Math.min(lastPly, ply));
  const from = shownPly();
  if (ply === from) return;
  view = ply === lastPly ? null : ply;
  board.clearMarks();
  render();
  const h = game.history({ verbose: true });
  if (ply === from + 1) board.animate(slides(h[from]));
  if (ply === from - 1) board.animate(slides(h[ply]), true);
  if (Math.abs(ply - from) === 1) play(h[Math.min(ply, from)].isCapture() ? 'capture' : 'move');
}

// ---------- setup drawer ----------

function buildSeat(c) {
  const node = $('#seat-tpl').content.firstElementChild.cloneNode(true);
  node.querySelector('.disc').classList.add(c);
  node.querySelector('.seat-name').textContent = colorName(c);
  for (const b of node.querySelectorAll('[data-k="engine"] button')) {
    if (b.dataset.v !== 'human') b.prepend(logo(b.dataset.v));
  }
  const pick = k => node.querySelector(`[data-k="${k}"]`);

  const sync = () => {
    const d = draft[c];
    node.classList.toggle('human', d.engine === 'human');
    for (const k of ['engine', 'vision']) {
      for (const b of pick(k).querySelectorAll('button')) {
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(b.dataset.v === d[k]));
      }
    }
    if (d.engine === 'claude') {
      fill(pick('model'), models.claude.models, d.model);
      fill(pick('effort'), models.claude.efforts, d.effort);
    } else if (d.engine === 'codex') {
      fill(pick('model'), models.codex.map(m => m.id), d.model);
      fill(pick('effort'), models.codex.find(m => m.id === pick('model').value)?.efforts ?? [], d.effort);
    }
    if (d.engine !== 'human') {
      d.model = pick('model').value;
      d.effort = pick('effort').value;
    }
  };

  for (const k of ['engine', 'vision']) {
    pick(k).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (k === 'engine' && draft[c].engine !== b.dataset.v) draft[c].model = '';
      draft[c][k] = b.dataset.v;
      sync();
    });
  }
  for (const k of ['model', 'effort']) pick(k).addEventListener('change', e => { draft[c][k] = e.target.value; sync(); });
  $('#seats').append(node);
  return sync;
}

function fill(sel, values, current) {
  sel.replaceChildren(...values.map(v => new Option(v, v)));
  sel.disabled = !values.length;
  if (values.includes(current)) sel.value = current;
}

let syncSeats = [];

function openSetup() {
  if (mode !== 'setup') draft = structuredClone(seats);
  syncSeats.forEach(f => f());
  $('#setup').classList.add('open');
  $('#setup').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  requestAnimationFrame(() => $('#scrim').classList.add('show'));
  setTimeout(() => $('#start').focus(), 50);
}

function closeSetup() {
  $('#setup').classList.remove('open');
  $('#setup').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('show');
  setTimeout(() => ($('#scrim').hidden = true), 250);
}

// Returns the SAN moves typed in the opening box, or throws with a readable message.
function openingMoves() {
  const text = $('#opening-moves').value.trim();
  if (!text) return [];
  const probe = new Chess();
  try {
    probe.loadPgn(text);
  } catch {
    throw new Error('These moves are not legal from the starting position.');
  }
  return probe.history();
}

function checkOpening() {
  const err = $('#opening-error');
  try {
    const moves = openingMoves();
    err.hidden = true;
    return moves;
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    return null;
  }
}

function buildOpenings() {
  const box = $('#openings');
  for (const [name, moves] of OPENINGS) {
    const b = el('button', 'chip', name);
    b.type = 'button';
    b.title = moves;
    b.onclick = () => {
      const area = $('#opening-moves');
      area.value = area.value.trim() === moves ? '' : moves;
      markOpening();
      checkOpening();
    };
    box.append(b);
  }
}

function markOpening() {
  const v = $('#opening-moves').value.trim();
  for (const b of $('#openings').children) b.classList.toggle('on', b.title === v);
}

// ---------- theme menu ----------

function buildThemes() {
  const menu = $('#theme-menu');
  for (const [id, t] of Object.entries(THEMES)) {
    const b = el('button', 'theme-opt');
    b.setAttribute('role', 'menuitemradio');
    b.dataset.theme = id;
    const sw = el('span', 'mini');
    sw.style.background = `conic-gradient(${t.light} 0 25%, ${t.dark} 0 50%, ${t.light} 0 75%, ${t.dark} 0)`;
    const knight = new Image();
    knight.src = pieceUrl(id, 'w', 'n');
    knight.alt = '';
    sw.append(knight);
    b.append(sw, el('span', '', t.name));
    b.onclick = () => {
      theme = id;
      store.set('theme', theme);
      toggleThemeMenu(false);
      render();
    };
    menu.append(b);
  }
}

function toggleThemeMenu(open) {
  const menu = $('#theme-menu');
  menu.hidden = !open;
  $('#theme-btn').setAttribute('aria-expanded', String(open));
  for (const b of menu.children) b.setAttribute('aria-checked', String(b.dataset.theme === theme));
}

// ---------- events ----------

$('#open-setup').onclick = openSetup;
$('#close-setup').onclick = closeSetup;
$('#scrim').onclick = closeSetup;
$('#start').onclick = () => {
  const moves = checkOpening();
  if (moves) startGame(moves);
};
$('#opening-moves').addEventListener('input', () => { markOpening(); checkOpening(); });

$('#setup-on-board').onclick = () => {
  const moves = checkOpening();
  if (!moves) return;
  resetLive(moves);
  mode = 'setup';
  openingPlies = 0;
  flipped = false;
  closeSetup();
  render();
};
$('#setup-undo').onclick = () => {
  if (fens.length < 2) return;
  game.undo();
  fens.pop();
  render();
};
$('#setup-back').onclick = () => {
  $('#opening-moves').value = moveList(game.history());
  markOpening();
  checkOpening();
  openSetup();
};
$('#setup-start').onclick = () => startGame(game.history());

$('#overlay').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'setup') openSetup();
  if (act === 'review') { overlayClosed = true; render(); }
});

$('#pause').onclick = () => {
  paused = !paused;
  if (paused) {
    token++; // drop the answer in flight; Resume asks again
    abort?.abort();
    thinking.w = thinking.b = null;
  }
  render();
  next();
};

$('#flip').onclick = () => { flipped = !flipped; render(); };
$('#sound').onclick = () => { soundOn = !soundOn; store.set('sound', soundOn); render(); };
$('#theme-btn').onclick = e => { e.stopPropagation(); toggleThemeMenu($('#theme-menu').hidden); };
document.addEventListener('click', e => { if (!e.target.closest('.theme-picker')) toggleThemeMenu(false); });

$('#pgn').onclick = async () => {
  game.header('White', label('w'), 'Black', label('b'));
  await navigator.clipboard.writeText(game.pgn());
  const b = $('#pgn');
  b.classList.add('done');
  b.title = 'Copied';
  setTimeout(() => { b.classList.remove('done'); b.title = 'Copy PGN'; }, 1200);
};

document.querySelector('.controls').addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]')?.dataset.nav;
  if (!nav) return;
  const ply = shownPly();
  setView({ first: 0, prev: ply - 1, next: ply + 1, last: fens.length - 1 }[nav]);
});
document.addEventListener('click', e => {
  const b = e.target.closest('.ply, .san-chip');
  if (b) setView(Number(b.dataset.ply));
});

document.addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'Escape') { closeSetup(); toggleThemeMenu(false); return; }
  if ($('#setup').classList.contains('open')) return;
  const ply = shownPly();
  const keys = { ArrowLeft: ply - 1, ArrowRight: ply + 1, Home: 0, End: fens.length - 1, ArrowUp: 0, ArrowDown: fens.length - 1 };
  if (e.key in keys) { e.preventDefault(); setView(keys[e.key]); }
  if (e.key === 'f' || e.key === 'F') { flipped = !flipped; render(); }
});

// ---------- start ----------

try {
  models = await (await fetch('/api/models')).json();
} catch {}
syncSeats = [buildSeat('w'), buildSeat('b')];
syncSeats.forEach(f => f());
buildOpenings();
buildThemes();
buildFeed('w');
buildFeed('b');
render();
