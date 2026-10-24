import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMove, moveList, turnPrompt } from '../public/prompt.js';

test('parseMove reads the last MOVE line', () => {
  assert.equal(parseMove('Maybe Nf3?\nMOVE: e4\nOn second thought...\nMOVE: d4'), 'd4');
  assert.equal(parseMove('**MOVE:** Nf3+'), 'Nf3+');
  assert.equal(parseMove('MOVE: 12...Nf6.'), 'Nf6');
  assert.equal(parseMove('move: 0-0-0'), 'O-O-O');
  assert.equal(parseMove('MOVE: `e8=Q`'), 'e8=Q');
  assert.equal(parseMove('I play e4.'), null);
});

test('moveList numbers the moves', () => {
  assert.equal(moveList(['e4', 'e5', 'Nf3']), '1. e4 e5 2. Nf3');
});

test('turnPrompt names the move number and earlier illegal answers', () => {
  const p = turnPrompt({ color: 'Black', history: ['e4'], sighted: false, errors: ['Ke2'] });
  assert.match(p, /move 1\.\.\./);
  assert.match(p, /"Ke2" is not a legal move/);
  assert.match(p, /explain your move/);
});
