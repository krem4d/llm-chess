// The board on screen: squares, pieces, sliding moves, drag and click input,
// right-click arrows and circles, and the promotion picker.
import { pieceUrl } from '/themes.js';

const FILES = 'abcdefgh';
const SLIDE_MS = 190;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
// Right-drag colors, like chess.com: plain, Shift, Ctrl, Alt.
const MARK_COLORS = { plain: '#f0a03c', shift: '#7fbf4d', ctrl: '#e0584b', alt: '#4ea3e6' };

export function createBoard(root, { onMove }) {
  const sqLayer = root.querySelector('.squares');
  const svg = root.querySelector('.arrows');
  const promo = root.querySelector('#promo');
  let state = null;     // last render input
  let selected = null;
  let drag = null;      // { from, ghost, img, moved }
  let marks = [];       // { from, to, color } — to === from means a circle
  let markStart = null;

  const orderedSquares = () => {
    const list = [];
    for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) list.push(FILES[f] + (r + 1));
    return state.flipped ? list.reverse() : list;
  };

  // Square name -> [col, row] on screen (0..7 from top-left).
  const toCell = sq => {
    const f = FILES.indexOf(sq[0]), r = Number(sq[1]) - 1;
    return state.flipped ? [7 - f, r] : [f, 7 - r];
  };
  const fromPoint = (x, y) => {
    const box = sqLayer.getBoundingClientRect();
    const col = Math.floor(((x - box.left) / box.width) * 8);
    const row = Math.floor(((y - box.top) / box.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return state.flipped ? FILES[7 - col] + (row + 1) : FILES[col] + (8 - row);
  };

  const legalTargets = from => state.chess.moves({ square: from, verbose: true });
  const canPick = sq => state.interactive && state.chess.get(sq)?.color === state.chess.turn();

  function render(next) {
    state = next;
    if (!state.interactive) selected = null;
    const { chess, last, theme } = state;
    const targets = selected ? legalTargets(selected).map(m => m.to) : [];
    const checkSq = chess.inCheck() ? kingSquare(chess, chess.turn()) : null;

    const cells = orderedSquares().map((sq, i) => {
      const el = document.createElement('div');
      const f = FILES.indexOf(sq[0]), r = Number(sq[1]) - 1;
      el.className = 'sq' + ((f + r) % 2 === 0 ? ' dark' : '');
      el.dataset.sq = sq;
      if (last && (sq === last.from || sq === last.to)) el.classList.add('last');
      if (sq === selected) el.classList.add('sel');
      if (sq === checkSq) el.classList.add('check');
      const piece = chess.get(sq);
      if (targets.includes(sq)) el.classList.add(piece ? 'capture' : 'target');
      if (canPick(sq) || targets.includes(sq)) el.classList.add('clickable');
      if (piece) {
        const img = new Image();
        img.src = pieceUrl(theme, piece.color, piece.type);
        img.alt = '';
        img.draggable = false;
        el.append(img);
      }
      if (i % 8 === 0) el.append(coord('rank', sq[1]));
      if (i >= 56) el.append(coord('file', sq[0]));
      return el;
    });
    sqLayer.replaceChildren(...cells);
    drawMarks();
  }

  // Slides pieces after a render. moves: [{ from, to }]; reverse slides to -> from.
  function animate(moves, reverse = false) {
    for (const { from, to } of moves) {
      const [a, b] = reverse ? [to, from] : [from, to];
      const img = sqLayer.querySelector(`[data-sq="${b}"] img`);
      const src = sqLayer.querySelector(`[data-sq="${a}"]`);
      if (!img || !src) continue;
      const p = src.getBoundingClientRect(), q = img.parentElement.getBoundingClientRect();
      img.animate(
        [{ transform: `translate(${p.left - q.left}px, ${p.top - q.top}px)` }, { transform: 'none' }],
        { duration: SLIDE_MS, easing: EASE },
      );
    }
  }

  // ---------- marks ----------

  function drawMarks() {
    const parts = [];
    for (const m of marks) {
      const [x1, y1] = toCell(m.from).map(v => v + 0.5);
      if (m.from === m.to) {
        parts.push(`<circle cx="${x1}" cy="${y1}" r="0.45" fill="none" stroke="${m.color}" stroke-width="0.07" opacity="0.85"/>`);
        continue;
      }
      const [x2, y2] = toCell(m.to).map(v => v + 0.5);
      const dx = x2 - x1, dy = y2 - y1;
      // Knight jumps get an L-shaped arrow: long leg first.
      const knight = (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
      const corner = knight ? (Math.abs(dy) > Math.abs(dx) ? [x1, y2] : [x2, y1]) : null;
      const [hx, hy] = corner ?? [x1, y1];
      const len = Math.hypot(x2 - hx, y2 - hy);
      const ux = (x2 - hx) / len, uy = (y2 - hy) / len;
      const tipBack = 0.38;
      const bx = x2 - ux * tipBack, by = y2 - uy * tipBack;
      const sx = x1 + (corner ? 0 : ux * 0.28), sy = y1 + (corner ? 0 : uy * 0.28);
      const shaft = corner
        ? `M${x1 + Math.sign(hx - x1) * 0.28} ${y1 + Math.sign(hy - y1) * 0.28}L${hx} ${hy}L${bx} ${by}`
        : `M${sx} ${sy}L${bx} ${by}`;
      const w = 0.24;
      const head = `${x2},${y2} ${bx - uy * w},${by + ux * w} ${bx + uy * w},${by - ux * w}`;
      parts.push(`<g opacity="0.82"><path d="${shaft}" fill="none" stroke="${m.color}" stroke-width="0.17" stroke-linejoin="round"/><polygon points="${head}" fill="${m.color}"/></g>`);
    }
    svg.innerHTML = parts.join('');
  }

  function toggleMark(from, to, color) {
    const i = marks.findIndex(m => m.from === from && m.to === to);
    if (i >= 0 && marks[i].color === color) marks.splice(i, 1);
    else if (i >= 0) marks[i].color = color;
    else marks.push({ from, to, color });
    drawMarks();
  }

  function clearMarks() {
    if (!marks.length) return;
    marks = [];
    drawMarks();
  }

  // ---------- input ----------

  root.addEventListener('contextmenu', e => e.preventDefault());

  root.addEventListener('pointerdown', e => {
    if (!state || !promo.hidden) return;
    const sq = fromPoint(e.clientX, e.clientY);
    if (!sq) return;
    if (e.button === 2) {
      markStart = sq;
      return;
    }
    if (e.button !== 0) return;
    clearMarks();

    if (selected && selected !== sq && legalTargets(selected).some(m => m.to === sq)) {
      tryMove(selected, sq, true);
      return;
    }
    if (!canPick(sq)) {
      if (selected) { selected = null; render(state); }
      return;
    }
    const wasSelected = selected === sq;
    selected = sq;
    render(state);
    const img = sqLayer.querySelector(`[data-sq="${sq}"] img`);
    const ghost = img.cloneNode();
    ghost.className = 'drag-ghost';
    const size = img.getBoundingClientRect().width;
    ghost.style.width = ghost.style.height = `${size}px`;
    root.append(ghost);
    img.classList.add('lifted');
    drag = { from: sq, ghost, img, size, wasSelected, moved: false };
    moveGhost(e);
    try { root.setPointerCapture(e.pointerId); } catch {}
  });

  root.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.moved = true;
    moveGhost(e);
    const over = fromPoint(e.clientX, e.clientY);
    sqLayer.querySelectorAll('.hover').forEach(el => el.classList.remove('hover'));
    if (over) sqLayer.querySelector(`[data-sq="${over}"]`)?.classList.add('hover');
  });

  root.addEventListener('pointerup', e => {
    if (e.button === 2 && markStart) {
      const end = fromPoint(e.clientX, e.clientY);
      if (end) toggleMark(markStart, end, e.shiftKey ? MARK_COLORS.shift : e.ctrlKey ? MARK_COLORS.ctrl : e.altKey ? MARK_COLORS.alt : MARK_COLORS.plain);
      markStart = null;
      return;
    }
    if (!drag) return;
    const d = drag;
    drag = null;
    d.ghost.remove();
    d.img.classList.remove('lifted');
    sqLayer.querySelectorAll('.hover').forEach(el => el.classList.remove('hover'));
    const to = fromPoint(e.clientX, e.clientY);
    if (to && to !== d.from && legalTargets(d.from).some(m => m.to === to)) {
      tryMove(d.from, to, false);
    } else if (to === d.from && d.wasSelected && !d.moved) {
      selected = null; // second click on the same piece drops the selection
      render(state);
    }
  });

  function moveGhost(e) {
    const box = root.getBoundingClientRect();
    drag.ghost.style.transform = `translate(${e.clientX - box.left - drag.size / 2}px, ${e.clientY - box.top - drag.size / 2}px)`;
  }

  async function tryMove(from, to, slide) {
    const moves = legalTargets(from).filter(m => m.to === to);
    let promotion;
    if (moves.some(m => m.promotion)) {
      promotion = await choosePromotion(to, state.chess.turn());
      if (!promotion) { selected = null; render(state); return; }
    }
    selected = null;
    onMove({ from, to, promotion }, slide);
  }

  function choosePromotion(to, color) {
    const [col, row] = toCell(to);
    promo.style.left = `${col * 12.5}%`;
    promo.classList.toggle('from-bottom', row === 7);
    promo.replaceChildren(...['q', 'n', 'r', 'b'].map(t => {
      const b = document.createElement('button');
      b.dataset.p = t;
      b.innerHTML = `<img alt="${{ q: 'Queen', n: 'Knight', r: 'Rook', b: 'Bishop' }[t]}" src="${pieceUrl(state.theme, color, t)}">`;
      return b;
    }));
    promo.hidden = false;
    return new Promise(ok => {
      const done = v => {
        promo.hidden = true;
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', esc);
        ok(v);
      };
      const outside = e => { if (!promo.contains(e.target)) { e.stopPropagation(); done(null); } };
      const esc = e => { if (e.key === 'Escape') done(null); };
      promo.onclick = e => { const b = e.target.closest('button'); if (b) done(b.dataset.p); };
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', esc);
    });
  }

  return { render, animate, clearMarks };
}

function coord(kind, text) {
  const s = document.createElement('span');
  s.className = `coord ${kind}`;
  s.textContent = text;
  return s;
}

function kingSquare(chess, color) {
  for (const row of chess.board()) for (const p of row) if (p?.type === 'k' && p.color === color) return p.square;
}
