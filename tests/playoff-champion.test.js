// Tests for who the app calls champion.
//
//   node tests/playoff-champion.test.js
//
// Same approach as the other two suites: the function sources are pulled out of
// index.html and evaluated, so these exercise the shipped code.
//
// The title is decided on the combined Playoff 1 + Championship net. Three ways
// that goes wrong quietly, all covered below: crowning someone before the
// Championship is in, letting a withdrawal hold the lead, and picking one name
// out of a tie that has no declared winner.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  let start = SRC.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, 'index.html no longer defines function ' + name + '()');
  if (SRC.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces extracting ' + name + '()');
}

function extractDecl(kind, name) {
  const m = SRC.match(new RegExp('^' + kind + ' ' + name + '\\s*=\\s*(.+?);\\s*(?://.*)?$', 'm'));
  assert.ok(m, 'index.html no longer defines ' + kind + ' ' + name);
  return 'const ' + name + '=' + m[1] + ';';
}

const FNS = [
  'strokesOnHole', 'netOnHole', 'calcNetVsPar', 'getPenalty', 'getStartStrokes',
  'getEffectiveNvp', 'fullySubmittedRounds', 'championshipField', 'playoffsSettled',
  'buildPlayoffCombined', 'playoffFinalOrder', 'playoffChampions',
];

const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
const NAMES = ['Ann Reyes', 'Ben Okafor', 'Cal Nguyen', 'Dee Marchetti',
  'Eli Sandoval', 'Fay Brennan', 'Gus Petrov', 'Hana Ito'];

const sandbox = {
  roundScores: {}, activeGroups: {}, penalties: {},
  coursePars: {}, courseStrokeIndex: {},
  PLAYERS: NAMES.slice(), console,
};
vm.createContext(sandbox);
vm.runInContext(
  [extractDecl('const', 'PLAYOFF_BONUS_ROUND'), extractDecl('const', 'PLAYOFF_FINAL_ROUND'),
   extractDecl('const', 'PLAYOFF_ROUNDS'), extractDecl('const', 'REGULAR_ROUNDS'),
   extractDecl('const', 'DEFAULT_SI')]
    .concat(FNS.map(extractFn)).join('\n'),
  sandbox
);

const { playoffFinalOrder, playoffChampions, playoffsSettled } = sandbox;

// A card whose net-vs-par off scratch is exactly `nvp`: the whole difference
// goes on hole 1, so the intent of each scenario stays readable.
function holesFor(nvp) {
  const h = PARS.slice();
  h[0] += nvp;
  return h;
}

// Two groups per round — fullySubmittedRounds() ignores a single-group round.
function setRound(round, scores, { submitted = true, field = null } = {}) {
  sandbox.coursePars[round] = PARS.slice();
  const names = field || Object.keys(scores);
  const gs = [[], []];
  names.forEach((n, i) => gs[i % 2].push({ name: n, hcp: 0, startStrokes: 0 }));
  sandbox.activeGroups[round] = gs.map((players) => ({ teeTime: '', players }));
  gs.forEach((players, gi) => {
    sandbox.roundScores[round + '__' + gi] = {
      round, gi, submitted,
      players: players.map((p) => ({
        name: p.name, hcp: 0, startStrokes: 0, holes: holesFor(scores[p.name] ?? 0),
      })),
    };
  });
}

function reset() {
  sandbox.roundScores = {};
  sandbox.activeGroups = {};
  sandbox.penalties = {};
  sandbox.coursePars = {};
  sandbox.courseStrokeIndex = {};
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

console.log('\nplayoff champion\n');

// ── 1. The ordinary case ──────────────────────────────────────────────────
test('the lowest combined total wins the title', () => {
  reset();
  setRound('Playoff 1',    { 'Ann Reyes': -2, 'Ben Okafor': -5, 'Cal Nguyen': -1, 'Dee Marchetti': 0 });
  setRound('Championship', { 'Ann Reyes': -6, 'Ben Okafor': -1, 'Cal Nguyen': -2, 'Dee Marchetti': 0 });
  const champs = playoffChampions();
  assert.strictEqual(champs.length, 1, 'one clear winner expected');
  // Ann: -8 combined, Ben: -6. The title follows the two-round total, not
  // either round on its own — Ben won Playoff 1 outright.
  assert.strictEqual(champs[0].name, 'Ann Reyes');
  assert.strictEqual(champs[0].combinedNet, -8);
});

test('the final order is sorted, lowest first', () => {
  reset();
  setRound('Playoff 1',    { 'Ann Reyes': -2, 'Ben Okafor': -5, 'Cal Nguyen': -1, 'Dee Marchetti': 0 });
  setRound('Championship', { 'Ann Reyes': -6, 'Ben Okafor': -1, 'Cal Nguyen': -2, 'Dee Marchetti': 0 });
  const order = Array.from(playoffFinalOrder(), (p) => p.name);
  assert.deepStrictEqual(order, ['Ann Reyes', 'Ben Okafor', 'Cal Nguyen', 'Dee Marchetti']);
});

// ── 2. Nothing is decided until both rounds are in ────────────────────────
test('no champion before the Championship is complete', () => {
  reset();
  setRound('Playoff 1',    { 'Ann Reyes': -2, 'Ben Okafor': -5, 'Cal Nguyen': -1, 'Dee Marchetti': 0 });
  assert.strictEqual(playoffsSettled(), false);
  // playoffFinalOrder still has a leader — it's a live board. The gate is
  // playoffsSettled(), which is what renderHomeChampion() checks.
  assert.ok(playoffFinalOrder().length > 0, 'the live board still ranks the field');
});

test('an unsubmitted Championship group leaves the title open', () => {
  reset();
  setRound('Playoff 1',    { 'Ann Reyes': -2, 'Ben Okafor': -5, 'Cal Nguyen': -1, 'Dee Marchetti': 0 });
  setRound('Championship', { 'Ann Reyes': -6, 'Ben Okafor': -1, 'Cal Nguyen': -2, 'Dee Marchetti': 0 });
  sandbox.roundScores['Championship__1'].submitted = false;
  assert.strictEqual(playoffsSettled(), false,
    'one group still out means the playoffs have not settled');
});

// ── 3. A withdrawal can't hold the lead ───────────────────────────────────
test('a withdrawal is out of the order, however low their Playoff 1 was', () => {
  reset();
  // Hana runs away with Playoff 1 and then does not tee it up in the final.
  setRound('Playoff 1', { 'Ann Reyes': -2, 'Ben Okafor': -3, 'Hana Ito': -12, 'Dee Marchetti': 0 });
  setRound('Championship', { 'Ann Reyes': -6, 'Ben Okafor': -1, 'Dee Marchetti': 0 },
    { field: ['Ann Reyes', 'Ben Okafor', 'Dee Marchetti'] });

  const order = playoffFinalOrder().map((p) => p.name);
  assert.ok(!order.includes('Hana Ito'),
    'a withdrawal must not appear in the ranked order — their total is frozen on one round');
  const champs = playoffChampions();
  assert.strictEqual(champs.length, 1);
  assert.strictEqual(champs[0].name, 'Ann Reyes',
    'the title goes to the best two-round score among players who finished');
});

// ── 4. Ties have no declared winner ───────────────────────────────────────
test('a tie on the combined total yields co-champions, not a pick', () => {
  reset();
  setRound('Playoff 1',    { 'Ann Reyes': -4, 'Ben Okafor': -2, 'Cal Nguyen': -1, 'Dee Marchetti': 0 });
  setRound('Championship', { 'Ann Reyes': -3, 'Ben Okafor': -5, 'Cal Nguyen': -2, 'Dee Marchetti': 0 });
  // Ann -7, Ben -7.
  const champs = playoffChampions();
  assert.strictEqual(champs.length, 2, 'both tied players should be named');
  assert.deepStrictEqual(Array.from(champs, (c) => c.name).sort(), ['Ann Reyes', 'Ben Okafor']);
  champs.forEach((c) => assert.strictEqual(c.combinedNet, -7));
});

test('a three-way tie names all three', () => {
  reset();
  setRound('Playoff 1',    { 'Ann Reyes': -4, 'Ben Okafor': -2, 'Cal Nguyen': -5, 'Dee Marchetti': 0 });
  setRound('Championship', { 'Ann Reyes': -3, 'Ben Okafor': -5, 'Cal Nguyen': -2, 'Dee Marchetti': 0 });
  const champs = playoffChampions();
  assert.strictEqual(champs.length, 3);
  assert.deepStrictEqual(Array.from(champs, (c) => c.name).sort(),
    ['Ann Reyes', 'Ben Okafor', 'Cal Nguyen']);
});

test('a tie behind the leader does not make co-champions', () => {
  reset();
  setRound('Playoff 1',    { 'Ann Reyes': -6, 'Ben Okafor': -2, 'Cal Nguyen': -1, 'Dee Marchetti': 0 });
  setRound('Championship', { 'Ann Reyes': -4, 'Ben Okafor': -3, 'Cal Nguyen': -4, 'Dee Marchetti': 0 });
  // Ann -10 alone; Ben and Cal tie at -5 for second.
  const champs = playoffChampions();
  assert.strictEqual(champs.length, 1, 'only a tie AT THE TOP makes co-champions');
  assert.strictEqual(champs[0].name, 'Ann Reyes');
});

// ── 5. Degenerate input ───────────────────────────────────────────────────
test('no playoff rounds at all means no champion', () => {
  reset();
  assert.strictEqual(playoffChampions().length, 0);
  assert.strictEqual(playoffFinalOrder().length, 0);
});

test('a field where everyone withdrew names nobody', () => {
  reset();
  setRound('Playoff 1', { 'Ann Reyes': -2, 'Ben Okafor': -3 });
  // A Championship round exists with a field that shares nobody with Playoff 1.
  setRound('Championship', { 'Cal Nguyen': -1, 'Dee Marchetti': 0 });
  const champs = playoffChampions();
  // Cal and Dee played the final and are in its field, so they rank; Ann and
  // Ben are withdrawals. The point is that no withdrawal takes the title.
  champs.forEach((c) => {
    assert.ok(!['Ann Reyes', 'Ben Okafor'].includes(c.name),
      c.name + ' withdrew and must not be champion');
  });
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : '') + '\n');
