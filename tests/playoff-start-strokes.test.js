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
  'startStrokesForSeed', 'getStartStrokes', 'hasStartStrokes', 'fmtStart', 'fmtNvp',
  'strokesOnHole', 'netOnHole', 'calcNetVsPar',
  'getPenalty', 'getEffectiveNvp', 'getCarryIn', 'latestHandicaps',
  'autoAssignChampionshipGroups', 'fullySubmittedRounds',
  'calcPrizePool', 'payoutsFor', 'calcRoundPayouts', 'calcPayoutsFromPool', 'roundTo5',
  'repairLegacyPlayoffHandicaps',
];

// Module globals these functions close over. Tests set them per scenario.
const sandbox = {
  roundScores: {}, activeGroups: {}, penalties: {},
  coursePars: {}, courseStrokeIndex: {},
  settings: { entryFee: 60, sponsorDiscount: 0, playoffEntryFee: 100, seasonWinnerPrize: 500,
              prizePercentages: [52, 26, 14, 8] },
};
vm.createContext(sandbox);
vm.runInContext(
  [extractConst('PLAYOFF_FIELD_SIZE'), extractConst('PLAYOFF_BONUS_ROUND'),
   extractConst('PLAYOFF_FINAL_ROUND'), extractConst('PLAYOFF_ROUNDS'),
   extractConst('REGULAR_ROUNDS'), extractConst('DEFAULT_SI')]
    .concat(FNS.map(extractFn)).join('\n'),
  sandbox
);

const startStrokesForSeed = sandbox.startStrokesForSeed;
const getStartStrokes = sandbox.getStartStrokes;
const hasStartStrokes = sandbox.hasStartStrokes;
const calcNetVsPar = sandbox.calcNetVsPar;
const strokesOnHole = sandbox.strokesOnHole;

const NAMES = [
  'Mark Metallo', 'Daniel Alonzi', 'Phil Schieda', 'Stephen Ceccanese',
  'Anthony Piacentini', 'Christian Turco', 'Adrian Perpetua', 'Jean-Paul Piacente',
  'Elbron Barzegar', 'Andrew Piacentini', 'Marco Rossi', 'Luca Bianchi',
  'Anthony Arci', 'Vince Colangelo', 'Sal Moretti',
];

const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
const SI = [1, 3, 5, 7, 9, 11, 13, 15, 17, 2, 4, 6, 8, 10, 12, 14, 16, 18];
const PAR_TOTAL = PARS.reduce(function (a, v) { return a + v; }, 0);

// Build Playoff 1 groups the way Save Groups does: {name, hcp, startStrokes}.
// `starts` is a per-position array; omit an entry to leave the box empty.
function setGroups(names, starts) {
  const gs = [];
  names.forEach(function (n, i) {
    const g = Math.floor(i / 4);
    if (!gs[g]) gs[g] = { players: [], teeTime: '' };
    const rec = { name: n, hcp: 8 + i };
    if (starts && starts[i] !== undefined) rec.startStrokes = starts[i];
    gs[g].players.push(rec);
  });
  sandbox.activeGroups = { 'Playoff 1': gs };
  return gs;
}

// The conventional fill: -2 / -1 / 0 by position.
function conventionalStarts(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(startStrokesForSeed(i + 1));
  return out;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

console.log('\nplayoff start strokes\n');

// ── 1. The convention behind the fill button ─────────────────────────────
test('positions 1-4 are -2, 5-8 are -1, 9-12 are even', function () {
  assert.deepStrictEqual(
    conventionalStarts(12),
    [-2, -2, -2, -2, -1, -1, -1, -1, 0, 0, 0, 0]);
});

test('call-ups from 13th, 14th, 15th are +2, +3, +4', function () {
  assert.strictEqual(startStrokesForSeed(13), 2, '13th');
  assert.strictEqual(startStrokesForSeed(14), 3, '14th');
  assert.strictEqual(startStrokesForSeed(15), 4, '15th');
});

// ── 2. The typed value is the source of truth ────────────────────────────
test('getStartStrokes reads the value on the group record', function () {
  setGroups(NAMES.slice(0, 12), conventionalStarts(12));
  assert.strictEqual(getStartStrokes('Mark Metallo', 'Playoff 1'), -2, 'group 1');
  assert.strictEqual(getStartStrokes('Anthony Piacentini', 'Playoff 1'), -1, 'group 2');
  assert.strictEqual(getStartStrokes('Elbron Barzegar', 'Playoff 1'), 0, 'group 3');
});

test('a typed value beats the convention for that position', function () {
  // The real case: 13th-place Anthony Arci is called up into group 1 after a
  // withdrawal. Group position says -2; he is typed as +2 and stays +2.
  const names = NAMES.slice(0, 12);
  names[2] = 'Anthony Arci';
  const starts = conventionalStarts(12);
  starts[2] = 2;                                   // typed by hand
  setGroups(names, starts);
  assert.strictEqual(getStartStrokes('Anthony Arci', 'Playoff 1'), 2,
    'a 13th-place call-up sitting in group 1 still starts +2');
  // Nobody else is disturbed.
  assert.strictEqual(getStartStrokes('Mark Metallo', 'Playoff 1'), -2);
  assert.strictEqual(getStartStrokes('Stephen Ceccanese', 'Playoff 1'), -2);
  assert.strictEqual(getStartStrokes('Anthony Piacentini', 'Playoff 1'), -1);
});

test('an unset box is zero, not a guess', function () {
  setGroups(NAMES.slice(0, 12), []);              // nothing typed anywhere
  NAMES.slice(0, 12).forEach(function (n) {
    assert.strictEqual(getStartStrokes(n, 'Playoff 1'), 0, n);
  });
});

test('a player who is not in the groups carries nothing', function () {
  setGroups(NAMES.slice(0, 12), conventionalStarts(12));
  assert.strictEqual(getStartStrokes('Sal Moretti', 'Playoff 1'), 0);
});

test('swapping a name out drops their start with them', function () {
  setGroups(NAMES.slice(0, 12), conventionalStarts(12));
  assert.strictEqual(getStartStrokes('Phil Schieda', 'Playoff 1'), -2);
  const names = NAMES.slice(0, 12);
  names[2] = 'Anthony Arci';
  const starts = conventionalStarts(12); starts[2] = 2;
  setGroups(names, starts);
  assert.strictEqual(getStartStrokes('Phil Schieda', 'Playoff 1'), 0,
    'the player who left carries nothing');
  assert.strictEqual(getStartStrokes('Anthony Arci', 'Playoff 1'), 2);
});

// ── 3. Round gating: the live regular season must be untouched ───────────
test('start strokes apply to Playoff 1 only', function () {
  setGroups(NAMES.slice(0, 12), conventionalStarts(12));
  sandbox.activeGroups['Round 1'] = sandbox.activeGroups['Playoff 1'];
  sandbox.activeGroups['Championship'] = sandbox.activeGroups['Playoff 1'];
  assert.strictEqual(getStartStrokes('Mark Metallo', 'Playoff 1'), -2);
  ['Round 1', 'Round 4', 'Round 8', 'Championship'].forEach(function (r) {
    assert.strictEqual(getStartStrokes('Mark Metallo', r), 0, r);
  });
});

test('hasStartStrokes drives the UI, and is false until something is typed', function () {
  setGroups(NAMES.slice(0, 12), []);
  assert.strictEqual(hasStartStrokes('Playoff 1'), false, 'nothing entered');
  setGroups(NAMES.slice(0, 12), conventionalStarts(12));
  assert.strictEqual(hasStartStrokes('Playoff 1'), true, 'values entered');
  assert.strictEqual(hasStartStrokes('Round 1'), false, 'never on a regular round');
  assert.strictEqual(hasStartStrokes('Championship'), false, 'never in round 2');
});

// ── 4. Net calculation ───────────────────────────────────────────────────
test('net = gross - handicap + startStrokes', function () {
  const holes = [5, 4, 3, 6, 4, 5, 3, 5, 4, 4, 5, 3, 5, 4, 4, 3, 6, 5];
  const gross = holes.reduce(function (a, v) { return a + v; }, 0);
  [[10, -2], [8, -1], [14, 0], [12, 2], [0, -2]].forEach(function (pair) {
    const hcp = pair[0], startStrokes = pair[1];
    // The app scores net-vs-par hole by hole (calcNetVsPar), because absolute
    // nets from two rounds don't sum to anything meaningful.
    const nvp = calcNetVsPar(holes, hcp, PARS, SI) + startStrokes;
    // Over a completed 18 that is exactly gross - hcp + startStrokes, offset by
    // par: the per-hole stroke allocation sums back to the full handicap.
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

test('startStrokes shifts net one-for-one and the handicap is untouched', function () {
  const holes = [5, 4, 3, 6, 4, 5, 3, 5, 4, 4, 5, 3, 5, 4, 4, 3, 6, 5];
  const base = calcNetVsPar(holes, 10, PARS, SI);
  assert.strictEqual(base + -2, base - 2, 'a -2 start is 2 better');
  assert.strictEqual(base + 2, base + 2, 'a +2 start is 2 worse');
  assert.strictEqual(calcNetVsPar(holes, 10, PARS, SI), base, 'same handicap in, same out');
});

test('hcp and startStrokes stay separate fields on the record', function () {
  const groups = setGroups(NAMES.slice(0, 12), conventionalStarts(12));
  groups.forEach(function (g) {
    g.players.forEach(function (p) {
      assert.strictEqual(typeof p.hcp, 'number', p.name + ' keeps a real handicap');
      assert.strictEqual(typeof p.startStrokes, 'number', p.name + ' has a separate start');
      assert.ok(p.hcp >= 8, p.name + ' handicap was not folded into the start');
    });
  });
});

// ── 5. Championship: no start strokes, R1 net carries in ─────────────────
// Build a submitted Playoff 1 whose finishing order is names[0..n]:
// position i finishes at (i - 12) vs par, so names[0] is the leader.
function seedPlayoff1(names) {
  sandbox.roundScores = {};
  sandbox.penalties = {};
  sandbox.coursePars = { 'Playoff 1': PARS, 'Championship': PARS };
  sandbox.courseStrokeIndex = { 'Playoff 1': SI, 'Championship': SI };
  const hcps = {};
  names.forEach(function (n, i) { hcps[n] = 5 + i; });
  sandbox.activeGroups = { 'Playoff 1': [] };
  for (let g = 0; g * 4 < names.length; g++) {
    const slice = names.slice(g * 4, g * 4 + 4);
    sandbox.activeGroups['Playoff 1'].push({
      players: slice.map(function (n) { return { name: n, hcp: hcps[n], startStrokes: 0 }; }), teeTime: '',
    });
    sandbox.roundScores['Playoff 1__' + g] = {
      round: 'Playoff 1', gi: g, submitted: true,
      players: slice.map(function (n) {
        const pos = names.indexOf(n);
        const holes = PARS.slice();
        holes[0] = PARS[0] + hcps[n] + (pos - 12);
        return { name: n, hcp: hcps[n], holes: holes };
      }),
    };
  }
  return hcps;
}

test('Championship: 9th-12th tee off first, top 4 play in the final group', function () {
  const names = NAMES.slice(0, 12);
  seedPlayoff1(names);
  const groups = sandbox.autoAssignChampionshipGroups();
  assert.strictEqual(groups.length, 3, 'three groups');
  const nameOf = function (g) { return Array.from(g.players, function (p) { return p.name; }); };
  assert.deepStrictEqual(nameOf(groups[0]), names.slice(8, 12).reverse(), 'first off is 9th-12th');
  assert.deepStrictEqual(nameOf(groups[1]), names.slice(4, 8).reverse(), 'middle is 5th-8th');
  assert.deepStrictEqual(nameOf(groups[2]), names.slice(0, 4).reverse(), 'final group is the top 4');
  assert.ok(nameOf(groups[2]).indexOf(names[0]) >= 0, 'the leader is in the last group');
});

test('Championship tee order is the exact reverse of the Playoff 1 blocks', function () {
  const names = NAMES.slice(0, 12);
  seedPlayoff1(names);
  const ch = Array.from(sandbox.autoAssignChampionshipGroups(), function (g) {
    return Array.from(g.players, function (p) { return p.name; }).sort();
  });
  const p1 = [names.slice(0, 4), names.slice(4, 8), names.slice(8, 12)]
    .map(function (g) { return g.slice().sort(); }).reverse();
  assert.deepStrictEqual(ch, p1, 'the block that tees off first in R1 tees off last in R2');
});

test('Championship handicaps are locked to the Playoff 1 card', function () {
  const names = NAMES.slice(0, 12);
  const hcps = seedPlayoff1(names);
  Array.from(sandbox.autoAssignChampionshipGroups()).forEach(function (g) {
    Array.from(g.players).forEach(function (p) {
      assert.strictEqual(p.hcp, hcps[p.name], p.name + ' carries the same handicap');
    });
  });
});

test('Championship groups are empty until Playoff 1 is fully submitted', function () {
  seedPlayoff1(NAMES.slice(0, 12));
  sandbox.roundScores['Playoff 1__0'].submitted = false;
  assert.strictEqual(sandbox.autoAssignChampionshipGroups().length, 0);
});

test('the Playoff 1 net carries in as the Championship starting score', function () {
  const names = NAMES.slice(0, 12);
  seedPlayoff1(names);
  names.forEach(function (n, i) {
    assert.strictEqual(sandbox.getCarryIn(n, 'Championship'), i - 12, n);
  });
});

test('carry-in applies to the Championship only, never to Playoff 1 or a regular round', function () {
  seedPlayoff1(NAMES.slice(0, 12));
  ['Playoff 1', 'Round 1', 'Round 8'].forEach(function (r) {
    assert.strictEqual(sandbox.getCarryIn(NAMES[0], r), 0, r);
  });
});

test('carry-in is zero for someone who did not play Playoff 1', function () {
  seedPlayoff1(NAMES.slice(0, 12));
  assert.strictEqual(sandbox.getCarryIn('Sal Moretti', 'Championship'), 0);
});

test('carry-in is NOT folded into the per-round net, so it cannot double count', function () {
  const names = NAMES.slice(0, 12);
  seedPlayoff1(names);
  // getEffectiveNvp must still report Playoff 1 alone, or buildPlayoffCombined
  // (which sums r1 + r2) would count round 1 twice.
  Array.from(sandbox.roundScores['Playoff 1__0'].players).forEach(function (p) {
    assert.strictEqual(sandbox.getEffectiveNvp(p, 'Playoff 1'), names.indexOf(p.name) - 12, p.name);
  });
});

test('a typed start feeds straight into the Playoff 1 net', function () {
  const names = NAMES.slice(0, 12);
  seedPlayoff1(names);                             // everyone at (i - 12), starts 0
  // Give the leader +2 by hand, as a call-up would be.
  sandbox.activeGroups['Playoff 1'][0].players[0].startStrokes = 2;
  const card = sandbox.roundScores['Playoff 1__0'];
  const leader = Array.from(card.players).find(function (p) { return p.name === names[0]; });
  assert.strictEqual(sandbox.getEffectiveNvp(leader, 'Playoff 1'), -12 + 2,
    'the typed +2 lands on the score');
});

// ── 6. Money: playoff rounds carry no per-round purse ────────────────────
test('the round entry fee never applies to a playoff round', function () {
  seedPlayoff1(NAMES.slice(0, 12));
  sandbox.activeGroups['Championship'] = sandbox.activeGroups['Playoff 1'];
  sandbox.activeGroups['Round 1'] = sandbox.activeGroups['Playoff 1'];
  assert.strictEqual(sandbox.calcPrizePool('Playoff 1'), 0, 'Playoff 1 has no purse');
  assert.strictEqual(sandbox.calcPrizePool('Championship'), 0, 'the Championship has no purse');
  assert.strictEqual(sandbox.calcPrizePool('Round 1'), 12 * 60, 'a regular round still pools');
});

test('payoutsFor pays nothing on a playoff round', function () {
  assert.strictEqual(sandbox.payoutsFor('Playoff 1'), null);
  assert.strictEqual(sandbox.payoutsFor('Championship'), null);
  assert.ok(Array.isArray(sandbox.payoutsFor('Round 1')), 'regular rounds still pay out');
});

// ── 7. Legacy repair ─────────────────────────────────────────────────────
test('groups saved by the old inflated-handicap model are repaired', function () {
  // That model wrote hcp = real handicap + group bonus, alongside baseHcp.
  const groups = { 'Playoff 1': [{ players: [{ name: 'Mark Metallo', hcp: 12, baseHcp: 10, bonus: 2 }] }] };
  sandbox.repairLegacyPlayoffHandicaps(groups);
  const p = groups['Playoff 1'][0].players[0];
  assert.strictEqual(p.hcp, 10, 'the real handicap is restored');
  assert.strictEqual(p.baseHcp, undefined);
  assert.strictEqual(p.bonus, undefined);
});

test('repair is idempotent and leaves clean records alone', function () {
  const groups = { 'Playoff 1': [{ players: [{ name: 'Mark Metallo', hcp: 10, startStrokes: -2 }] }] };
  sandbox.repairLegacyPlayoffHandicaps(groups);
  sandbox.repairLegacyPlayoffHandicaps(groups);
  const p = groups['Playoff 1'][0].players[0];
  assert.strictEqual(p.hcp, 10);
  assert.strictEqual(p.startStrokes, -2, 'a typed start is never touched by the repair');
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', with failures' : '') + '\n');
