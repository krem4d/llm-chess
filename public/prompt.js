// What the models are told each turn, and how their answer is read back.

export function systemPrompt({ color, opponent, sighted }) {
  return [
    `You are playing a game of chess as ${color}. Your opponent (${opponent}) plays the other side.`,
    'You are a player in this game, not an assistant: your only job is to choose the strongest move.',
    'This is one continuous conversation for the whole game. Each turn you receive the full list of moves played so far in Standard Algebraic Notation (SAN); always trust that list over your memory.',
    sighted
      ? `You also receive an image of the current board, seen from your side: your ${color.toLowerCase()} pieces are at the bottom. The last move is highlighted.`
      : 'You are playing blindfold: no board is shown. Keep track of the position from the move list alone.',
    'Do not use any tools. Think as long as you need.',
    'In every reply, first explain your move in 1 to 3 short sentences: what it does and why you chose it (the threat, the plan, or what it stops). Never reply with the move alone.',
    'Then end your reply with one final line in exactly this form:',
    'MOVE: <your move in SAN>',
    'Examples: "MOVE: e4", "MOVE: Nf3", "MOVE: O-O", "MOVE: exd5", "MOVE: e8=Q".',
  ].join('\n');
}

// history: SAN moves from the start of the game.
export function turnPrompt({ color, history, sighted, errors = [] }) {
  const lines = [];
  lines.push(history.length ? `Moves so far: ${moveList(history)}` : 'No moves have been played yet. You make the first move.');
  lines.push(`You are ${color}. It is your turn: move ${Math.floor(history.length / 2) + 1}${color === 'White' ? '.' : '...'}`);
  if (sighted) lines.push('The attached image shows the current position from your side.');
  lines.push('Briefly explain your move (1 to 3 sentences), then end with the line "MOVE: <your move in SAN>".');
  for (const e of errors) lines.push(`Your earlier answer "${e}" is not a legal move in this position. Choose a legal move.`);
  return lines.join('\n\n');
}

export function moveList(history) {
  return history.map((san, i) => (i % 2 ? san : `${i / 2 + 1}. ${san}`)).join(' ');
}

// Returns the move text the model chose, or null. Takes the last "MOVE:" line,
// so a model that drafts several moves before deciding is read correctly.
export function parseMove(text) {
  const matches = [...String(text).matchAll(/MOVE:\s*[*`"']*\s*([^\s*`"']+)/gi)];
  if (!matches.length) return null;
  return matches.at(-1)[1]
    .replace(/^\d+\.+/, '') // "12...Nf6" -> "Nf6"
    .replace(/[.,;!?]+$/, '')
    .replace(/0-0-0/, 'O-O-O').replace(/0-0/, 'O-O');
}
