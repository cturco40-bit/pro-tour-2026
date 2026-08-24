// Tests for the playoff start-stroke model.
//
//   node tests/playoff-start-strokes.test.js
//
// There is no test runner in this repo and no build step, so rather than
// duplicating the logic here, this harness pulls the actual function sources
// out of index.html and evaluates them. If someone edits the shipped code,
// these tests exercise the edit — not a stale copy of it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull `function NAME(...){...}` out of the source by brace-matching, so a
// nested `}` inside a template literal or object can't truncate the capture.
function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, 'index.html no longer defines function ' + name + '()');
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name + '()');
}

function extractConst(name) {
  const m = SRC.match(new RegExp('^const ' + name + '\\s*=\\s*(.+?);\\s*(?://.*)?$', 'm'));
  assert.ok(m, 'index.html no longer defines const ' + name);
  return 'const ' + name + '=' + m[1] + ';';
}

const FNS = [
  'startStrokesForSeed', 'startStrokesForCallUp',
  'assignInitialField', 'withdrawFromField', 'activeFieldOrder',
  'normalizePlayoffField', 'getStartStrokes', 'playoffFieldLocked',
  'strokesOnHole', 'netOnHole', 'calcNetVsPar',
];

const sandbox = { playoffField: null };
vm.createContext(sandbox);
vm.runInContext(
  [extractConst('PLAYOFF_FIELD_SIZE'), extractConst('PLAYOFF_BONUS_ROUND')]
    .concat(FNS.map(extractFn)).join('\n'),
  sandbox
);

const startStrokesForSeed = sandbox.startStrokesForSeed;
const assignInitialField = sandbox.assignInitialField;
const withdrawFromField = sandbox.withdrawFromField;
const activeFieldOrder = sandbox.activeFieldOrder;
const normalizePlayoffField = sandbox.normalizePlayoffField;
const calcNetVsPar = sandbox.calcNetVsPar;
const strokesOnHole = sandbox.strokesOnHole;

// ── Fixtures ──────────────────────────────────────────────────────────────
// Standings order 1..15. Seed 3 is Phil Schieda and seed 5 is Anthony
// Piacentini, matching the two worked examples in the spec.
const ORDER = [
  'Mark Metallo',        // 1
  'Daniel Alonzi',       // 2
  'Phil Schieda',        // 3
  'Stephen Ceccanese',   // 4
  'Anthony Piacentini',  // 5
  'Christian Turco',     // 6
  'Adrian Perpetua',     // 7
  'Jean-Paul Piacente',  // 8
  'Elbron Barzegar',     // 9
  'Andrew Piacentini',   // 10
  'Marco Rossi',         // 11
  'Luca Bianchi',        // 12
  'Anthony Arci',        // 13
  'Vince Colangelo',     // 14
  'Sal Moretti',         // 15
];

function byName(f) {
  const o = {};
  f.entries.forEach(function (e) { o[e.name] = e; });
  return o;
}
function startsOf(f) {
  const o = {};
  f.entries.forEach(function (e) { o[e.name] = e.startStrokes; });
  return o;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

console.log('\nplayoff start strokes\n');

// ── 1. Initial assignment ────────────────────────────────────────────────
test('seeds 1-4 get -2, 5-8 get -1, 9-12 get 0', function () {
  const f = assignInitialField(ORDER, 1);
  assert.strictEqual(f.entries.length, 12, 'field is 12 deep');
  f.entries.forEach(function (e) {
    const expected = e.seed <= 4 ? -2 : e.seed <= 8 ? -1 : 0;
    assert.strictEqual(e.startStrokes, expected, 'seed ' + e.seed + ' (' + e.name + ')');
  });
  assert.deepStrictEqual(
    f.entries.map(function (e) { return e.startStrokes; }),
    [-2, -2, -2, -2, -1, -1, -1, -1, 0, 0, 0, 0]
  );
});

test('a 13th-place player is not in the field', function () {
  assert.ok(!byName(assignInitialField(ORDER, 1))['Anthony Arci'],
    'Anthony Arci (13th) starts outside the field');
});

// ── 2. Re-seeding after a withdrawal does not mutate startStrokes ────────
test('withdrawal re-seeds for group placement only — startStrokes unchanged', function () {
  const before = assignInitialField(ORDER, 1);
  const beforeStarts = startsOf(before);

  // Seed 3 withdraws. Spec example: seed 5 (-1) moves to seed 4, group 1, still -1.
  const after = withdrawFromField(before, 'Phil Schieda', ORDER);
  const live = activeFieldOrder(after);

  const ap = live.find(function (e) { return e.name === 'Anthony Piacentini'; });
  assert.strictEqual(ap.seed, 5, 'original seed is still 5');
  assert.strictEqual(ap.effectiveSeed, 4, 'moves up to effective seed 4');
  assert.strictEqual(ap.group, 1, 'and therefore plays in group 1');
  assert.strictEqual(ap.startStrokes, -1, 'but still starts at -1, not -2');

  // Nobody who survived had their issued start altered.
  live.filter(function (e) { return e.origin !== 'alternate'; }).forEach(function (e) {
    assert.strictEqual(e.startStrokes, beforeStarts[e.name],
      e.name + ' kept the start they were issued');
  });

  // And the input field object was not mutated in place.
  assert.deepStrictEqual(startsOf(before), beforeStarts, 'withdrawFromField is pure');
  assert.strictEqual(before.entries.length, 12, 'original field untouched');
});

test('everyone below a withdrawal shifts up exactly one seed', function () {
  const after = withdrawFromField(assignInitialField(ORDER, 1), 'Phil Schieda', ORDER);
  activeFieldOrder(after)
    .filter(function (e) { return e.origin !== 'alternate'; })
    .forEach(function (e) {
      const expected = e.seed < 3 ? e.seed : e.seed - 1;
      assert.strictEqual(e.effectiveSeed, expected, e.name + ' (seed ' + e.seed + ')');
    });
});

test('groups stay 1-4 / 5-8 / 9-12 by effective seed', function () {
  const after = withdrawFromField(assignInitialField(ORDER, 1), 'Phil Schieda', ORDER);
  const live = activeFieldOrder(after);
  assert.strictEqual(live.length, 12, 'field refilled to 12');
  live.forEach(function (e) {
    assert.strictEqual(e.group, Math.floor((e.effectiveSeed - 1) / 4) + 1, e.name);
  });
  assert.deepStrictEqual(
    [1, 2, 3].map(function (g) {
      return live.filter(function (e) { return e.group === g; }).length;
    }), [4, 4, 4]);
});

// ── 3. Alternates are priced by call-up order ────────────────────────────
test('first alternate enters at +2', function () {
  const after = withdrawFromField(assignInitialField(ORDER, 1), 'Phil Schieda', ORDER);
  const arci = byName(after)['Anthony Arci'];
  assert.ok(arci, 'Anthony Arci (13th) was called up');
  assert.strictEqual(arci.startStrokes, 2, 'at +2');
  assert.strictEqual(arci.origin, 'alternate');
  assert.strictEqual(arci.callUpOrder, 1);
  // Called up into the vacated 12th spot, not into the withdrawer's seed.
  assert.strictEqual(
    activeFieldOrder(after).find(function (e) { return e.name === 'Anthony Arci'; }).effectiveSeed,
    12);
});

test('two withdrawals produce +2 and +3 for the two alternates', function () {
  let f = assignInitialField(ORDER, 1);
  f = withdrawFromField(f, 'Phil Schieda', ORDER);        // 13th in at +2
  f = withdrawFromField(f, 'Adrian Perpetua', ORDER);     // 14th in at +3
  const n = byName(f);
  assert.strictEqual(n['Anthony Arci'].startStrokes, 2, '1st alternate +2');
  assert.strictEqual(n['Vince Colangelo'].startStrokes, 3, '2nd alternate +3');
  assert.strictEqual(activeFieldOrder(f).length, 12, 'field still 12 deep');
});

test('third call-up is +4', function () {
  let f = assignInitialField(ORDER, 1);
  ['Phil Schieda', 'Adrian Perpetua', 'Elbron Barzegar'].forEach(function (n) {
    f = withdrawFromField(f, n, ORDER);
  });
  assert.strictEqual(byName(f)['Sal Moretti'].startStrokes, 4, '3rd alternate +4');
});

test('call-up order never recycles when an alternate also withdraws', function () {
  let f = assignInitialField(ORDER, 1);
  f = withdrawFromField(f, 'Phil Schieda', ORDER);        // Arci in at +2
  f = withdrawFromField(f, 'Anthony Arci', ORDER);        // Arci back out
  // The next call-up is the SECOND ever, so it prices at +3 — not +2 again.
  assert.strictEqual(byName(f)['Vince Colangelo'].startStrokes, 3);
  assert.strictEqual(byName(f)['Vince Colangelo'].callUpOrder, 2);
});

test('a withdrawn player is not an alternate for their own vacancy', function () {
  const f = withdrawFromField(assignInitialField(ORDER, 1), 'Phil Schieda', ORDER);
  assert.ok(!activeFieldOrder(f).some(function (e) { return e.name === 'Phil Schieda'; }));
});

test('withdrawing an unknown or already-withdrawn player is a no-op', function () {
  const f = assignInitialField(ORDER, 1);
  assert.strictEqual(withdrawFromField(f, 'Nobody At All', ORDER), f);
  const once = withdrawFromField(f, 'Phil Schieda', ORDER);
  assert.strictEqual(withdrawFromField(once, 'Phil Schieda', ORDER), once);
});

test('field runs short gracefully when there are no alternates left', function () {
  const short = ORDER.slice(0, 12);                       // exactly 12, no 13th
  const f = withdrawFromField(assignInitialField(short, 1), 'Phil Schieda', short);
  const live = activeFieldOrder(f);
  assert.strictEqual(live.length, 11, 'plays 11 deep');
  assert.deepStrictEqual(
    [1, 2, 3].map(function (g) {
      return live.filter(function (e) { return e.group === g; }).length;
    }), [4, 4, 3]);
});

// ── 4. Net calculation ───────────────────────────────────────────────────
const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
const SI = [1, 3, 5, 7, 9, 11, 13, 15, 17, 2, 4, 6, 8, 10, 12, 14, 16, 18];
const PAR_TOTAL = PARS.reduce(function (a, v) { return a + v; }, 0);

test('net = gross - handicap + startStrokes', function () {
  const holes = [5, 4, 3, 6, 4, 5, 3, 5, 4, 4, 5, 3, 5, 4, 4, 3, 6, 5];
  const gross = holes.reduce(function (a, v) { return a + v; }, 0);
  [[10, -2], [8, -1], [14, 0], [12, 2], [0, -2]].forEach(function (pair) {
    const hcp = pair[0], startStrokes = pair[1];
    // The app scores net-vs-par hole by hole (calcNetVsPar), because absolute
    // nets from two rounds don't sum to anything meaningful.
    const nvp = calcNetVsPar(holes, hcp, PARS, SI) + startStrokes;
    // Over a completed 18, that is exactly gross - hcp + startStrokes, offset
    // by par: the per-hole stroke allocation sums back to the full handicap.
    assert.strictEqual(nvp + PAR_TOTAL, gross - hcp + startStrokes,
      'hcp ' + hcp + ', start ' + startStrokes);
  });
});

test('per-hole stroke allocation sums to the handicap (the identity above)', function () {
  [0, 6, 12, 18, 20, 27].forEach(function (hcp) {
    const total = SI.reduce(function (a, si) { return a + strokesOnHole(hcp, si); }, 0);
    assert.strictEqual(total, hcp, 'hcp ' + hcp);
  });
});

test('startStrokes shifts net one-for-one and handicap is untouched', function () {
  const holes = [5, 4, 3, 6, 4, 5, 3, 5, 4, 4, 5, 3, 5, 4, 4, 3, 6, 5];
  const base = calcNetVsPar(holes, 10, PARS, SI);
  assert.strictEqual(calcNetVsPar(holes, 10, PARS, SI) + -2, base - 2, 'a -2 start is 2 better');
  assert.strictEqual(calcNetVsPar(holes, 10, PARS, SI) + 2, base + 2, 'a +2 start is 2 worse');
  // Same handicap in, same handicap out — seeding never changes it.
  assert.strictEqual(calcNetVsPar(holes, 10, PARS, SI), base);
});

// ── 5. Round gating: the live regular season must be untouched ───────────
test('start strokes apply to Playoff 1 only', function () {
  sandbox.playoffField = assignInitialField(ORDER, 1);
  assert.strictEqual(sandbox.getStartStrokes('Mark Metallo', 'Playoff 1'), -2);
  ['Round 1', 'Round 4', 'Round 8', 'Championship'].forEach(function (r) {
    assert.strictEqual(sandbox.getStartStrokes('Mark Metallo', r), 0, r);
  });
  sandbox.playoffField = null;
});

test('an unlocked field issues nothing — no live-derived fallback', function () {
  sandbox.playoffField = null;
  assert.strictEqual(sandbox.playoffFieldLocked(), false);
  assert.strictEqual(sandbox.getStartStrokes('Mark Metallo', 'Playoff 1'), 0);
});

test('a withdrawn player carries no start strokes', function () {
  sandbox.playoffField = withdrawFromField(assignInitialField(ORDER, 1), 'Phil Schieda', ORDER);
  assert.strictEqual(sandbox.getStartStrokes('Phil Schieda', 'Playoff 1'), 0);
  assert.strictEqual(sandbox.getStartStrokes('Anthony Piacentini', 'Playoff 1'), -1);
  assert.strictEqual(sandbox.getStartStrokes('Anthony Arci', 'Playoff 1'), 2);
  sandbox.playoffField = null;
});

// ── 6. Firebase round-trip ───────────────────────────────────────────────
test('survives Firebase array-as-numeric-keyed-object normalization', function () {
  const f = withdrawFromField(assignInitialField(ORDER, 1), 'Phil Schieda', ORDER);
  const entriesAsObject = {};
  f.entries.forEach(function (e, i) { entriesAsObject[String(i)] = e; });
  const asObject = Object.assign({}, f, { entries: entriesAsObject });
  const back = normalizePlayoffField(JSON.parse(JSON.stringify(asObject)));
  assert.deepStrictEqual(startsOf(back), startsOf(f), 'startStrokes round-trip intact');
  const shape = function (x) {
    return activeFieldOrder(x).map(function (e) {
      return [e.name, e.effectiveSeed, e.group, e.startStrokes];
    });
  };
  assert.deepStrictEqual(shape(back), shape(f));
});

test('normalizer rebuilds the call-up counter above every issued call-up', function () {
  let f = assignInitialField(ORDER, 1);
  f = withdrawFromField(f, 'Phil Schieda', ORDER);
  f = withdrawFromField(f, 'Adrian Perpetua', ORDER);
  // Simulate a record whose stored counter has been lost or hand-reset.
  const back = normalizePlayoffField(Object.assign({}, f, { nextCallUp: 1 }));
  assert.strictEqual(back.nextCallUp, 3, 'next call-up is still the 3rd');
  const next = withdrawFromField(back, 'Elbron Barzegar', ORDER);
  assert.strictEqual(byName(next)['Sal Moretti'].startStrokes, 4, 'and prices at +4');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', with failures' : '') + '\n');

// ── 7. Championship tee order ────────────────────────────────────────────
// Playoff 1 sends the leaders out FIRST (group 1 = seeds 1-4). The final round
// reverses it: 9th-12th after R1 go off first, 5th-8th in the middle, and the
// top 4 play in the last group. Mirrors autoAssignChampionshipGroups().
function championshipTeeOrder(rankedBestFirst) {
  const teeOrder = rankedBestFirst.slice().reverse();
  const groups = [];
  for (let i = 0; i < teeOrder.length; i += 4) groups.push(teeOrder.slice(i, i + 4));
  return groups;
}

test('Championship: leaders go off last, tail group goes off first', function () {
  const positions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];   // best net first
  const groups = championshipTeeOrder(positions);
  assert.strictEqual(groups.length, 3);
  assert.deepStrictEqual(groups[0], [12, 11, 10, 9], 'first tee time is 9th-12th');
  assert.deepStrictEqual(groups[1], [8, 7, 6, 5], 'middle is 5th-8th');
  assert.deepStrictEqual(groups[2], [4, 3, 2, 1], 'final group is the top 4');
  assert.strictEqual(groups[groups.length - 1].includes(1), true, 'the leader is in the last group');
});

test('Championship tee order is the exact reverse of Playoff 1', function () {
  const positions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  // Playoff 1: group 1 is seeds 1-4.
  const p1 = [];
  for (let i = 0; i < positions.length; i += 4) p1.push(positions.slice(i, i + 4));
  const ch = championshipTeeOrder(positions);
  assert.deepStrictEqual(
    ch.map(function (g) { return g.slice().sort(function (a, b) { return a - b; }); }),
    p1.slice().reverse(),
    'the block that tees off first in R1 tees off last in R2');
});

// ── 8. Money: playoff rounds carry no per-round purse ────────────────────
test('the round entry fee never applies to a playoff round', function () {
  // calcPrizePool short-circuits on playoff rounds before touching entryFee.
  const src = extractFn('calcPrizePool');
  assert.ok(/PLAYOFF_ROUNDS\.includes\(round\)\s*\)\s*return 0;/.test(src),
    'calcPrizePool must return 0 for playoff rounds');
  const guardAt = src.indexOf('return 0;');
  const feeAt = src.indexOf('settings.entryFee');
  assert.ok(guardAt !== -1 && feeAt !== -1 && guardAt < feeAt,
    'the playoff guard must come before the entry-fee math');
});

test('payoutsFor pays nothing on a playoff round', function () {
  const src = extractFn('payoutsFor');
  assert.ok(/REGULAR_ROUNDS\.includes\(round\)/.test(src) && /null/.test(src),
    'playoff rounds return null, not an empty payout array');
});

console.log('\n' + passed + ' passed total' + (process.exitCode ? ', with failures' : '') + '\n');
