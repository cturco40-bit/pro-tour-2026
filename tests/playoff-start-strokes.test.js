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
  // Round-shaped functions — these read module globals, stubbed per test below.
  'getPenalty', 'getEffectiveNvp', 'getCarryIn', 'latestHandicaps',
  'autoAssignChampionshipGroups', 'autoAssignPlayoffGroups',
  'fullySubmittedRounds', 'calcPrizePool', 'payoutsFor',
  'calcRoundPayouts', 'calcPayoutsFromPool', 'roundTo5',
  'reconcilePlayoffFieldWithGroups', 'savePlayoffField', 'fmtStart', 'fmtNvp',
];

// Module globals these functions close over. Tests set them per scenario.
const sandbox = {
  playoffField: null, roundScores: {}, activeGroups: {}, penalties: {},
  coursePars: {}, courseStrokeIndex: {},
  settings: { entryFee: 60, sponsorDiscount: 0, playoffEntryFee: 100, seasonWinnerPrize: 500,
              prizePercentages: [52, 26, 14, 8] },
  // savePlayoffField() persists via fbSet — capture the writes so a test can
  // assert the record actually gets saved, not just mutated in memory.
  _writes: [],
  fbSet: function (path, value) { sandbox._writes.push({ path: path, value: value }); },
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


// ── 7. Championship: tee order reverses Playoff 1 ────────────────────────
// These drive the REAL autoAssignChampionshipGroups() through the sandbox, so
// flipping the sort in index.html fails them.

// Build a submitted Playoff 1 whose finishing order is exactly names[0..n]:
// position i finishes at (i - 12) vs par, so names[0] is the leader.
function seedPlayoff1(names) {
  sandbox.roundScores = {};
  sandbox.penalties = {};
  sandbox.playoffField = null;                 // no start strokes needed here
  sandbox.coursePars = { 'Playoff 1': PARS, 'Championship': PARS };
  sandbox.courseStrokeIndex = { 'Playoff 1': SI, 'Championship': SI };
  const hcps = {};
  names.forEach(function (n, i) { hcps[n] = 5 + i; });
  sandbox.activeGroups = { 'Playoff 1': [] };
  for (let g = 0; g * 4 < names.length; g++) {
    const slice = names.slice(g * 4, g * 4 + 4);
    sandbox.activeGroups['Playoff 1'].push({
      players: slice.map(function (n) { return { name: n, hcp: hcps[n] }; }), teeTime: '',
    });
    sandbox.roundScores['Playoff 1__' + g] = {
      round: 'Playoff 1', gi: g, submitted: true,
      players: slice.map(function (n) {
        const pos = names.indexOf(n);
        // net-vs-par = gross - hcp - par, so put the whole delta on hole 1.
        const holes = PARS.slice();
        holes[0] = PARS[0] + hcps[n] + (pos - 12);
        return { name: n, hcp: hcps[n], holes: holes };
      }),
    };
  }
  return hcps;
}

test('Championship: 9th-12th tee off first, top 4 play in the final group', function () {
  const names = ORDER.slice(0, 12);
  seedPlayoff1(names);
  const groups = sandbox.autoAssignChampionshipGroups();
  assert.strictEqual(groups.length, 3, 'three groups');
  const nameOf = function (g) { return Array.from(g.players, function (p) { return p.name; }); };
  assert.deepStrictEqual(nameOf(groups[0]), names.slice(8, 12).reverse(), 'first off is 9th-12th');
  assert.deepStrictEqual(nameOf(groups[1]), names.slice(4, 8).reverse(), 'middle is 5th-8th');
  assert.deepStrictEqual(nameOf(groups[2]), names.slice(0, 4).reverse(), 'final group is the top 4');
  assert.ok(nameOf(groups[groups.length - 1]).indexOf(names[0]) >= 0,
    'the leader is in the last group');
});

test('Championship tee order is the exact reverse of the Playoff 1 blocks', function () {
  const names = ORDER.slice(0, 12);
  seedPlayoff1(names);
  const ch = Array.from(sandbox.autoAssignChampionshipGroups(), function (g) {
    return Array.from(g.players, function (p) { return p.name; }).sort();
  });
  const p1 = [names.slice(0, 4), names.slice(4, 8), names.slice(8, 12)]
    .map(function (g) { return g.slice().sort(); }).reverse();
  assert.deepStrictEqual(ch, p1, 'the block that tees off first in R1 tees off last in R2');
});

test('Championship handicaps are locked to the Playoff 1 card', function () {
  const names = ORDER.slice(0, 12);
  const hcps = seedPlayoff1(names);
  Array.from(sandbox.autoAssignChampionshipGroups()).forEach(function (g) {
    Array.from(g.players).forEach(function (p) {
      assert.strictEqual(p.hcp, hcps[p.name], p.name + ' carries the same handicap');
    });
  });
});

test('Championship groups are empty until Playoff 1 is fully submitted', function () {
  seedPlayoff1(ORDER.slice(0, 12));
  sandbox.roundScores['Playoff 1__0'].submitted = false;
  assert.strictEqual(sandbox.autoAssignChampionshipGroups().length, 0);
});

// ── 8. Round 2 starts from the Round 1 net ───────────────────────────────
test('the Playoff 1 net carries in as the Championship starting score', function () {
  const names = ORDER.slice(0, 12);
  seedPlayoff1(names);
  names.forEach(function (n, i) {
    // seedPlayoff1 put each player at (i - 12) vs par in Playoff 1.
    assert.strictEqual(sandbox.getCarryIn(n, 'Championship'), i - 12, n);
  });
});

test('carry-in applies to the Championship only, never to Playoff 1 or a regular round', function () {
  seedPlayoff1(ORDER.slice(0, 12));
  ['Playoff 1', 'Round 1', 'Round 8'].forEach(function (r) {
    assert.strictEqual(sandbox.getCarryIn(ORDER[0], r), 0, r);
  });
});

test('carry-in is zero for someone who did not play Playoff 1', function () {
  seedPlayoff1(ORDER.slice(0, 12));
  assert.strictEqual(sandbox.getCarryIn('Sal Moretti', 'Championship'), 0);
});

test('carry-in is NOT folded into the per-round net, so it cannot double count', function () {
  const names = ORDER.slice(0, 12);
  seedPlayoff1(names);
  // getEffectiveNvp must still report Playoff 1 alone, or buildPlayoffCombined
  // (which sums r1 + r2) would count round 1 twice.
  sandbox.roundScores['Playoff 1__0'].players.forEach(function (p) {
    assert.strictEqual(sandbox.getEffectiveNvp(p, 'Playoff 1'), names.indexOf(p.name) - 12, p.name);
  });
});

// ── 9. Handicaps are never touched by seeding ────────────────────────────
test('autoAssignPlayoffGroups uses each player own handicap, unmodified', function () {
  const names = ORDER.slice(0, 12);
  const hcps = seedPlayoff1(names);
  sandbox.playoffField = assignInitialField(ORDER, 1);
  const groups = sandbox.autoAssignPlayoffGroups();
  assert.strictEqual(groups.length, 3);
  groups.forEach(function (g) {
    g.players.forEach(function (p) {
      assert.strictEqual(p.hcp, hcps[p.name], p.name + ' plays off their own handicap');
      assert.strictEqual(p.baseHcp, undefined, 'no legacy baseHcp is written');
      assert.strictEqual(p.bonus, undefined, 'no legacy per-group bonus is written');
    });
  });
  sandbox.playoffField = null;
});

test('autoAssignPlayoffGroups refuses to build without a locked field', function () {
  seedPlayoff1(ORDER.slice(0, 12));
  sandbox.playoffField = null;
  assert.strictEqual(sandbox.autoAssignPlayoffGroups().length, 0);
});

// ── 10. Money: playoff rounds carry no per-round purse ───────────────────
test('the round entry fee never applies to a playoff round', function () {
  seedPlayoff1(ORDER.slice(0, 12));
  sandbox.activeGroups['Championship'] = sandbox.activeGroups['Playoff 1'];
  sandbox.activeGroups['Round 1'] = sandbox.activeGroups['Playoff 1'];
  assert.strictEqual(sandbox.calcPrizePool('Playoff 1'), 0, 'Playoff 1 has no purse');
  assert.strictEqual(sandbox.calcPrizePool('Championship'), 0, 'the Championship has no purse');
  // The same 12 players on a regular round DO pay the round entry fee.
  assert.strictEqual(sandbox.calcPrizePool('Round 1'), 12 * 60, 'a regular round still pools');
});

test('payoutsFor pays nothing on a playoff round', function () {
  assert.strictEqual(sandbox.payoutsFor('Playoff 1'), null);
  assert.strictEqual(sandbox.payoutsFor('Championship'), null);
  assert.ok(Array.isArray(sandbox.payoutsFor('Round 1')), 'regular rounds still pay out');
});

// ── 11. The alternate queue is frozen at lock time ───────────────────────
test('the call-up queue is stored on the field, not recomputed live', function () {
  const f = assignInitialField(ORDER, 1);
  assert.deepStrictEqual(f.standingsOrder, ORDER, 'the full standings order is frozen in');
  // Withdraw passing a DIFFERENT live order — the frozen queue must win.
  const bogus = ['Sal Moretti', 'Vince Colangelo', 'Anthony Arci'];
  const after = withdrawFromField(f, 'Phil Schieda', bogus);
  assert.strictEqual(byName(after)['Anthony Arci'].startStrokes, 2,
    'the 13th-place player at lock time is still the one called up');
  assert.ok(!byName(after)['Sal Moretti'], 'a re-ordered live standings cannot jump the queue');
});

test('the frozen queue survives a Firebase round-trip', function () {
  const f = assignInitialField(ORDER, 1);
  const back = normalizePlayoffField(JSON.parse(JSON.stringify(f)));
  assert.deepStrictEqual(back.standingsOrder, ORDER);
  assert.strictEqual(byName(withdrawFromField(back, 'Phil Schieda', []))['Anthony Arci'].startStrokes, 2);
});


// ── 12. Hand-edited roster reconciles with the locked field ──────────────
// The commissioner's real move: swap a name in a group dropdown and hit Save,
// rather than using the WD button. The field record has to follow.
function groupsFrom(names) {
  const gs = [];
  for (let i = 0; i < names.length; i += 4) {
    gs.push({ players: names.slice(i, i + 4).map(function (n) { return { name: n, hcp: 10 }; }), teeTime: '' });
  }
  return gs;
}

test('swapping a name in the groups withdraws one and calls up the other at +2', function () {
  sandbox.playoffField = assignInitialField(ORDER, 1);
  // Phil Schieda (seed 3, -2) out; Anthony Arci (13th) in — the spec example.
  const names = ORDER.slice(0, 12).map(function (n) {
    return n === 'Phil Schieda' ? 'Anthony Arci' : n;
  });
  const moved = sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(names));
  assert.deepStrictEqual(Array.from(moved.withdrawn), ['Phil Schieda']);
  assert.strictEqual(moved.calledUp.length, 1);
  assert.strictEqual(moved.calledUp[0].name, 'Anthony Arci');
  assert.strictEqual(moved.calledUp[0].startStrokes, 2, 'called up at +2');
  assert.strictEqual(sandbox.getStartStrokes('Anthony Arci', 'Playoff 1'), 2);
  assert.strictEqual(sandbox.getStartStrokes('Phil Schieda', 'Playoff 1'), 0, 'the player who left carries nothing');
  assert.ok(sandbox._writes.some(function (w) { return w.path === 'playoffField'; }),
    'the updated field is persisted, not just held in memory');
  sandbox.playoffField = null;
});

test('a swap does not disturb anyone else’s start strokes', function () {
  const before = assignInitialField(ORDER, 1);
  sandbox.playoffField = before;
  const beforeStarts = startsOf(before);
  const names = ORDER.slice(0, 12).map(function (n) {
    return n === 'Phil Schieda' ? 'Anthony Arci' : n;
  });
  sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(names));
  Array.from(sandbox.playoffField.entries)
    .filter(function (e) { return !e.withdrawn && e.origin !== 'alternate'; })
    .forEach(function (e) {
      assert.strictEqual(e.startStrokes, beforeStarts[e.name], e.name + ' kept their start');
    });
  sandbox.playoffField = null;
});

test('the replacement moves up for group placement but keeps +2', function () {
  sandbox.playoffField = assignInitialField(ORDER, 1);
  const names = ORDER.slice(0, 12).map(function (n) {
    return n === 'Phil Schieda' ? 'Anthony Arci' : n;
  });
  sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(names));
  const live = activeFieldOrder(sandbox.playoffField);
  assert.strictEqual(live.length, 12, 'field is still 12 deep');
  // Seed 5 slides up into group 1 and is still -1.
  const ap = live.find(function (e) { return e.name === 'Anthony Piacentini'; });
  assert.strictEqual(ap.effectiveSeed, 4);
  assert.strictEqual(ap.group, 1);
  assert.strictEqual(ap.startStrokes, -1);
  sandbox.playoffField = null;
});

test('two separate swaps price the replacements +2 then +3', function () {
  sandbox.playoffField = assignInitialField(ORDER, 1);
  let names = ORDER.slice(0, 12).map(function (n) {
    return n === 'Phil Schieda' ? 'Anthony Arci' : n;
  });
  sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(names));
  names = names.map(function (n) { return n === 'Adrian Perpetua' ? 'Vince Colangelo' : n; });
  const moved = sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(names));
  assert.strictEqual(moved.calledUp[0].startStrokes, 3, 'second replacement is +3');
  assert.strictEqual(sandbox.getStartStrokes('Anthony Arci', 'Playoff 1'), 2, 'the first is still +2');
  sandbox.playoffField = null;
});

test('putting a withdrawn player back restores their original start, not a call-up price', function () {
  sandbox.playoffField = assignInitialField(ORDER, 1);
  const swapped = ORDER.slice(0, 12).map(function (n) {
    return n === 'Phil Schieda' ? 'Anthony Arci' : n;
  });
  sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(swapped));
  // Changed their mind — Phil is back in, Arci out again.
  sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(ORDER.slice(0, 12)));
  assert.strictEqual(sandbox.getStartStrokes('Phil Schieda', 'Playoff 1'), -2,
    'seed 3 gets his -2 back, not +2');
  assert.strictEqual(sandbox.getStartStrokes('Anthony Arci', 'Playoff 1'), 0);
  sandbox.playoffField = null;
});

test('an unchanged roster is a no-op', function () {
  sandbox.playoffField = assignInitialField(ORDER, 1);
  const moved = sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(ORDER.slice(0, 12)));
  assert.strictEqual(moved.withdrawn.length, 0);
  assert.strictEqual(moved.calledUp.length, 0);
  sandbox.playoffField = null;
});

test('an empty save never empties the field', function () {
  sandbox.playoffField = assignInitialField(ORDER, 1);
  const moved = sandbox.reconcilePlayoffFieldWithGroups([]);
  assert.strictEqual(moved.withdrawn.length, 0);
  assert.strictEqual(activeFieldOrder(sandbox.playoffField).length, 12);
  sandbox.playoffField = null;
});

test('reconciling does nothing when no field is locked', function () {
  sandbox.playoffField = null;
  const moved = sandbox.reconcilePlayoffFieldWithGroups(groupsFrom(ORDER.slice(0, 12)));
  assert.strictEqual(moved.withdrawn.length, 0);
  assert.strictEqual(moved.calledUp.length, 0);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', with failures' : '') + '\n');
