// Sounds are made with the Web Audio API, so there are no audio files to license.
let ctx;

function audio() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// A short filtered noise burst sounds like a piece set down on wood.
function knock(at, gain, freq) {
  const a = audio();
  const len = Math.floor(a.sampleRate * 0.06);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 4;
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(a.destination);
  src.start(a.currentTime + at);
}

function tone(at, freq, dur, gain = 0.12) {
  const a = audio();
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t = a.currentTime + at;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur);
}

export const sounds = {
  move: () => knock(0, 1.6, 1800),
  capture: () => { knock(0, 2.2, 1300); knock(0.05, 1.4, 2200); },
  castle: () => { knock(0, 1.6, 1800); knock(0.12, 1.6, 1700); },
  check: () => { knock(0, 1.6, 1800); tone(0.02, 880, 0.25, 0.08); },
  start: () => { tone(0, 523, 0.2); tone(0.12, 784, 0.35); },
  end: () => { tone(0, 784, 0.25); tone(0.15, 659, 0.25); tone(0.3, 523, 0.5); },
  error: () => tone(0, 180, 0.3, 0.15),
};
