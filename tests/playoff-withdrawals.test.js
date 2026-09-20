// Tests for withdrawals and playoff money settlement.
//
//   node tests/playoff-withdrawals.test.js
//
// Same harness as playoff-start-strokes.test.js: the functions under test are
// pulled out of index.html and evaluated, so these exercise the shipped code
// rather than a copy of it.
//
// Two rules are under test.
//
//   1. Playoff money settles ONCE, when BOTH playoff rounds are complete.
//      Before that, calcPlayoffEarnings() owes nothing. It used to assign the
//      whole pool the moment Playoff 1 finished, because a combined total with
//      no round 2 in it still sorts — so the standings read as a settled payout
//      with half the playoffs left to play.
//
//   2. A player who posted Playoff 1 and is not in the Championship field has
//      withdrawn. Their total is frozen on round 1 while the field plays 18 more
//      holes, so they hold no position and take no money. Their round-1 result
//      is untouched: they played it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

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
  'strokesOnHole', 'netOnHole', 'calcNetVsPar', 'fmtNvp', 'nvpCls', 'fmtElapsed',
  'getPenalty', 'getEffectiveNvp', 'getStartStrokes', 'getCarryIn',
  'fullySubmittedRounds', 'assignMoneyWithTies',
  'roundTo5', 'calcPayoutsFromPool', 'calcPlayoffPool', 'calcPlayoffPayouts',
  'championshipField', 'playoffsSettled', 'buildPlayoffCombined', 'calcPlayoffEarnings',
  'lbHasCarryIn', 'buildLiveRows', 'liveBoardSub',
];

const sandbox = {
  roundScores: {}, activeGroups: {}, penalties: {},
  coursePars: {}, courseStrokeIndex: {},
  PLAYERS: [],
  DEFAULT_SETTINGS: { playoffPrizePercentages: [50, 25, 15, 10] },
  settings: { playoffEntryFee: 100, seasonWinnerPrize: 500,
              playoffPrizePercentages: [50, 25, 15, 10] },
  Date: Date, Math: Math, Set: Set, Object: Object, Array: Array, String: String,
};
vm.createContext(sandbox);
vm.runInContext(
  [extractConst('PLAYOFF_BONUS_ROUND'), extractConst('PLAYOFF_FINAL_ROUND'),
   extractConst('PLAYOFF_ROUNDS'), extractConst('REGULAR_ROUNDS'), extractConst('DEFAULT_SI')]
    .concat(FNS.map(extractFn)).join('\n'),
  sandbox
);

const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
const SI = [1, 3, 5, 7, 9, 11, 13, 15, 17, 2, 4, 6, 8, 10, 12, 14, 16, 18];

const FIELD = [
  'Mark Metallo', 'Daniel Alonzi', 'Phil Schieda', 'Stephen Ceccanese',
  'Anthony Piacentini', 'Christian Turco', 'Adrian Perpetua', 'Jean-Paul Piacente',
  'Elbron Barzegar', 'Andrew Piacentini', 'Marco Rossi', 'Luca Bianchi',
];
const WITHDREW = ['Phil Schieda', 'Christian Turco', 'Marco Rossi'];

// Everyone plays off scratch and shoots par except hole 1, so a player's
// net-vs-par for the round is exactly the number asked for here.
function holesFor(nvp) {
  const h = PARS.slice();
  h[0] = PARS[0] + nvp;
  return h;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Build one playoff round: groups, and (if scores given) a submitted card each.
function setRound(round, names, starts, scores, groupSize) {
  const groups = chunk(names, groupSize).map(function (gp) {
    return { teeTime: '', players: gp.map(function (n) {
      const rec = { name: n, hcp: 0 };
      if (starts && starts[n] !== undefined) rec.startStrokes = starts[n];
      return rec;
    }) };
  });
  sandbox.activeGroups[round] = groups;
  sandbox.coursePars[round] = PARS;
  sandbox.courseStrokeIndex[round] = SI;
  if (!scores) return;
  groups.forEach(function (g, gi) {
    sandbox.roundScores[round + '__' + gi] = {
      round: round, gi: gi, submitted: true, roundStartedAt: 0, submittedAt: 0,
      players: g.players.map(function (p) {
        return { name: p.name, hcp: 0, holes: holesFor(scores[p.name]) };
      }),
    };
  });
}

function reset() {
  sandbox.roundScores = {};
  sandbox.activeGroups = {};
  sandbox.penalties = {};
  sandbox.coursePars = {};
  sandbox.courseStrokeIndex = {};
  sandbox.PLAYERS = FIELD.slice();
}

// Playoff 1: the three who go on to withdraw post the three best rounds, which
// is the case that actually costs money if they stay in the sort.
const P1 = {
  'Phil Schieda': -6, 'Christian Turco': -5, 'Marco Rossi': -4,
  'Mark Metallo': -3, 'Daniel Alonzi': -2, 'Stephen Ceccanese': -1,
  'Anthony Piacentini': 0, 'Adrian Perpetua': 1, 'Jean-Paul Piacente': 2,
  'Elbron Barzegar': 3, 'Andrew Piacentini': 4, 'Luca Bianchi': 5,
};
const STARTS = {};
FIELD.forEach(function (n, i) { STARTS[n] = i < 4 ? -2 : i < 8 ? -1 : 0; });

// Championship: the nine who show up. Everyone shoots level.
const PLAYING = FIELD.filter(function (n) { return WITHDREW.indexOf(n) < 0; });
const P2 = {};
PLAYING.forEach(function (n) { P2[n] = 0; });

function afterRoundOne() {
  reset();
  setRound('Playoff 1', FIELD, STARTS, P1, 4);
}

function championshipFieldSet() {
  afterRoundOne();
  setRound('Championship', PLAYING, null, null, 3);
}

function afterBothRounds() {
  afterRoundOne();
  setRound('Championship', PLAYING, null, P2, 3);
}

// assignMoneyWithTies returns a row for everyone it ranked, $0 included, so
// "who got paid" is the count of non-zero amounts.
function paidCount(earn) {
  return Object.keys(earn).filter(function (k) { return earn[k] > 0; }).length;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

console.log('\nplayoff withdrawals & money settlement\n');

// ── 1. Money holds until both rounds are complete ────────────────────────
test('no money is owed with only Playoff 1 in the book', function () {
  afterRoundOne();
  assert.strictEqual(sandbox.playoffsSettled(), false);
  assert.strictEqual(paidCount(sandbox.calcPlayoffEarnings()), 0,
    'the full pool used to be assigned off Playoff 1 alone');
});

test('no money is owed while the Championship is in progress', function () {
  championshipFieldSet();
  // One group is away and has posted, the rest have not.
  sandbox.roundScores['Championship__0'] = {
    round: 'Championship', gi: 0, submitted: false, roundStartedAt: 0,
    players: sandbox.activeGroups['Championship'][0].players.map(function (p) {
      const h = PARS.slice(); h[0] = PARS[0]; h[1] = PARS[1] - 1;
      return { name: p.name, hcp: 0, holes: h.map(function (v, i) { return i < 2 ? v : null; }) };
    }),
  };
  assert.strictEqual(sandbox.playoffsSettled(), false);
  assert.strictEqual(paidCount(sandbox.calcPlayoffEarnings()), 0);
});

test('money settles once the Championship is complete', function () {
  afterBothRounds();
  assert.strictEqual(sandbox.playoffsSettled(), true);
  const earn = sandbox.calcPlayoffEarnings();
  const total = Object.keys(earn).reduce(function (a, k) { return a + earn[k]; }, 0);
  assert.ok(total > 0, 'the pool pays out once both rounds are in');
  assert.strictEqual(paidCount(earn), 4, 'four spots paid');
});

// ── 2. Withdrawals hold no position and take no money ────────────────────
test('a player missing from the Championship field is flagged WD', function () {
  championshipFieldSet();
  const combined = sandbox.buildPlayoffCombined();
  WITHDREW.forEach(function (n) {
    const row = combined.find(function (r) { return r.name === n; });
    assert.ok(row, n + ' keeps their row');
    assert.strictEqual(row.wd, true, n + ' is marked withdrawn');
  });
  PLAYING.forEach(function (n) {
    assert.strictEqual(combined.find(function (r) { return r.name === n; }).wd, false, n);
  });
});

test('the Playoff 1 result of a withdrawal is left alone', function () {
  championshipFieldSet();
  const row = sandbox.buildPlayoffCombined().find(function (r) { return r.name === 'Phil Schieda'; });
  assert.strictEqual(row.r1, P1['Phil Schieda'] + STARTS['Phil Schieda'],
    'round 1 net still carries his start strokes and nothing else');
});

test('withdrawals take no money even holding the three best round-1 scores', function () {
  afterBothRounds();
  const earn = sandbox.calcPlayoffEarnings();
  WITHDREW.forEach(function (n) {
    assert.strictEqual(earn[n], undefined, n + ' is out of the money');
  });
  // Best 2-round total among the nine who played takes first.
  const combined = sandbox.buildPlayoffCombined().filter(function (r) { return !r.wd; });
  combined.sort(function (a, b) { return a.combinedNet - b.combinedNet; });
  const paid = Object.keys(earn).sort(function (a, b) { return earn[b] - earn[a]; });
  assert.strictEqual(paid[0], combined[0].name, 'first money goes to the best 2-round total');
});

test('nobody is a withdrawal before the Championship field is built', function () {
  afterRoundOne();
  assert.strictEqual(sandbox.championshipField().size, 0);
  assert.ok(sandbox.buildPlayoffCombined().every(function (r) { return r.wd === false; }),
    'an empty field means "not set yet", not "everyone withdrew"');
});

// ── 3. The live board shows the standings going into the round ───────────
test('the Championship board is populated before anyone tees off', function () {
  championshipFieldSet();
  assert.strictEqual(sandbox.lbHasCarryIn('Championship'), true);
  const rows = sandbox.buildLiveRows('Championship');
  assert.strictEqual(rows.length, PLAYING.length, 'the whole field, no cards posted');
  assert.ok(rows.every(function (r) { return r.started === false && r.thru === 0; }));
  assert.ok(rows.every(function (r) { return r.today === 0; }), 'nothing played today yet');
});

test('the pre-round board is ordered by what each player carries in', function () {
  championshipFieldSet();
  const rows = sandbox.buildLiveRows('Championship');
  const expected = PLAYING.slice().sort(function (a, b) {
    return (P1[a] + STARTS[a]) - (P1[b] + STARTS[b]);
  });
  assert.strictEqual(rows.map(function (r) { return r.name; }).join(' | '), expected.join(' | '));
  assert.strictEqual(rows[0].nvp, P1[expected[0]] + STARTS[expected[0]],
    'the leader starts on their Playoff 1 net, not on even');
});

test('withdrawals are not seated on the Championship board', function () {
  championshipFieldSet();
  const names = sandbox.buildLiveRows('Championship').map(function (r) { return r.name; });
  WITHDREW.forEach(function (n) {
    assert.strictEqual(names.indexOf(n), -1, n + ' is not in the field');
  });
});

test('today and the running total are separate numbers', function () {
  championshipFieldSet();
  const leader = PLAYING.slice().sort(function (a, b) {
    return (P1[a] + STARTS[a]) - (P1[b] + STARTS[b]);
  })[0];
  // Leader's group is away and two under through four.
  const gi = sandbox.activeGroups['Championship'].findIndex(function (g) {
    return g.players.some(function (p) { return p.name === leader; });
  });
  sandbox.roundScores['Championship__' + gi] = {
    round: 'Championship', gi: gi, submitted: false, roundStartedAt: 0,
    players: sandbox.activeGroups['Championship'][gi].players.map(function (p) {
      const h = [PARS[0] - 1, PARS[1] - 1, PARS[2], PARS[3]];
      while (h.length < 18) h.push(null);
      return { name: p.name, hcp: 0, holes: h };
    }),
  };
  const row = sandbox.buildLiveRows('Championship').find(function (r) { return r.name === leader; });
  assert.strictEqual(row.today, -2, 'two under today');
  assert.strictEqual(row.carry, P1[leader] + STARTS[leader], 'carrying in the Playoff 1 net');
  assert.strictEqual(row.nvp, row.today + row.carry, 'the total is the sum of the two');
  assert.strictEqual(row.thru, 4);
});

test('a regular round is not seeded from the groups', function () {
  reset();
  setRound('Round 3', FIELD, null, null, 4);
  assert.strictEqual(sandbox.lbHasCarryIn('Round 3'), false);
  assert.strictEqual(sandbox.buildLiveRows('Round 3').length, 0,
    'nobody has teed off, and everyone starting level is not a leaderboard');
});

// Opening a scorecard writes the card before a hole is posted. That must not
// park a whole group at even par above everyone who is over it.
test('a card with no holes posted keeps its group off a regular-round board', function () {
  reset();
  setRound('Round 3', FIELD, null, null, 4);
  sandbox.roundScores['Round 3__0'] = {
    round: 'Round 3', gi: 0, submitted: false, roundStartedAt: 0,
    players: sandbox.activeGroups['Round 3'][0].players.map(function (p) {
      return { name: p.name, hcp: 0, holes: PARS.map(function () { return null; }) };
    }),
  };
  assert.strictEqual(sandbox.buildLiveRows('Round 3').length, 0);
});

test('an empty card in the Championship still sits on its carry-in', function () {
  championshipFieldSet();
  sandbox.roundScores['Championship__1'] = {
    round: 'Championship', gi: 1, submitted: false, roundStartedAt: 0,
    players: sandbox.activeGroups['Championship'][1].players.map(function (p) {
      return { name: p.name, hcp: 0, holes: PARS.map(function () { return null; }) };
    }),
  };
  const rows = sandbox.buildLiveRows('Championship');
  assert.strictEqual(rows.length, PLAYING.length, 'still the whole field, once each');
  const who = sandbox.activeGroups['Championship'][1].players[0].name;
  const row = rows.find(function (r) { return r.name === who; });
  assert.strictEqual(row.started, false);
  assert.strictEqual(row.nvp, P1[who] + STARTS[who], 'seated on the Playoff 1 net');
});

test('the board says what it is showing before play starts', function () {
  championshipFieldSet();
  const rows = sandbox.buildLiveRows('Championship');
  assert.strictEqual(sandbox.liveBoardSub(rows, 'Championship'),
    'Standings going into the final round');
});

console.log('\n' + passed + ' passed\n');
