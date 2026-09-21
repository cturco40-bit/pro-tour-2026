// Tests for the season archive / rollover model.
//
//   node tests/season-rollover.test.js
//
// Same approach as playoff-start-strokes.test.js: the function sources are
// pulled out of index.html and evaluated, so these exercise the shipped code
// rather than a copy of it.
//
// What matters here is that an archive is a faithful, self-contained record of
// a finished season, and that starting the next one carries forward exactly the
// world-ranking points the season ended on — nothing more.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  let start = SRC.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, 'index.html no longer defines function ' + name + '()');
  // Keep the `async` keyword — dropping it turns every `await` inside into a
  // syntax error, which reads as a mysterious per-test failure.
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
  return kind + ' ' + name + '=' + m[1] + ';';
}

// Multi-line array/object literals (CALENDAR, SEASON_PATHS, ...) need brace
// matching rather than a single-line regex.
function extractBlockDecl(kind, name) {
  const re = new RegExp('^' + kind + '\\s+' + name + '\\s*=', 'm');
  const m = SRC.match(re);
  assert.ok(m, 'index.html no longer defines ' + kind + ' ' + name);
  const start = m.index;
  let i = start, depth = 0, seen = false;
  for (; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === '[' || ch === '{') { depth++; seen = true; }
    else if (ch === ']' || ch === '}') { depth--; if (seen && depth === 0) break; }
  }
  return SRC.slice(start, SRC.indexOf(';', i) + 1);
}

const FNS = [
  'strokesOnHole', 'netOnHole', 'calcNetVsPar', 'getPenalty', 'getStartStrokes',
  'getEffectiveNvp', 'getEffectiveNet', 'fullySubmittedRounds', 'calcSeasonStandings',
  'assignPointsWithTies', 'assignMoneyWithTies', 'ptsTableFor', 'roundTo5',
  'calcPrizePool', 'calcPayoutsFromPool', 'calcRoundPayouts', 'payoutsFor',
  'calcPlayoffPool', 'calcPlayoffPayouts', 'calcPlayoffEarnings', 'calcPlayoffPoints',
  'buildPlayoffCombined', 'championshipField', 'playoffsSettled',
  'calcWorldRankings', 'applySeasonRules', 'blankCalendar', 'nextWrBase', 'buildSeasonSummary',
  'seasonYear', 'seasonLabel', 'seasonShort', 'getBlockRound',
];

const PARS = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];
const PAR_TOTAL = PARS.reduce((a, v) => a + v, 0);
const NAMES = ['Ann Reyes', 'Ben Okafor', 'Cal Nguyen', 'Dee Marchetti',
  'Eli Sandoval', 'Fay Brennan', 'Gus Petrov', 'Hana Ito'];

const sandbox = {
  roundScores: {}, activeGroups: {}, penalties: {}, blockRounds: {},
  coursePars: {}, courseStrokeIndex: {}, scorecardPhotos: {},
  PLAYERS: NAMES.slice(),
  WR_BASE: {}, seasonMeta: { year: 2026, label: '2026' },
  PTS: [300, 225, 200, 175, 150, 125, 110, 100],
  settings: {
    entryFee: 60, sponsorDiscount: 0, playoffEntryFee: 100, seasonWinnerPrize: 500,
    majorMult: 1.2, majorsOn: false,
    pts: [300, 225, 200, 175, 150, 125, 110, 100],
    playoffPts: [750, 650, 550, 500, 450, 400, 350, 300],
    prizePercentages: [52, 26, 14, 8], playoffPrizePercentages: [52, 24, 14, 10],
  },
  window: {},
  console,
};
sandbox.window._roundWinnerOverrides = {};
vm.createContext(sandbox);

vm.runInContext(
  [extractDecl('const', 'PLAYOFF_BONUS_ROUND'), extractDecl('const', 'PLAYOFF_FINAL_ROUND'),
   extractDecl('const', 'PLAYOFF_ROUNDS'), extractDecl('const', 'REGULAR_ROUNDS'),
   extractDecl('const', 'DEFAULT_SI'), extractDecl('const', 'ROUND_8_NAME'),
   extractBlockDecl('const', 'CALENDAR'),
   extractBlockDecl('const', 'DEFAULT_SETTINGS'),
   extractBlockDecl('const', 'SEASON_PATHS'),
   extractBlockDecl('const', 'SEASON_CLEAR_PATHS')]
    .concat(FNS.map(extractFn)).join('\n'),
  sandbox
);

const { blankCalendar, nextWrBase, buildSeasonSummary, calcWorldRankings } = sandbox;

// `const` declarations inside the VM are lexical — they never become properties
// of the sandbox object the way function declarations do. Read them back by
// evaluating the bare identifier in the same context.
const inCtx = (name) => vm.runInContext(name, sandbox);
const SEASON_PATHS = inCtx('SEASON_PATHS');
const SEASON_CLEAR_PATHS = inCtx('SEASON_CLEAR_PATHS');
const CALENDAR = inCtx('CALENDAR');
const REGULAR_ROUNDS = inCtx('REGULAR_ROUNDS');
[['SEASON_PATHS', SEASON_PATHS], ['SEASON_CLEAR_PATHS', SEASON_CLEAR_PATHS],
 ['CALENDAR', CALENDAR], ['REGULAR_ROUNDS', REGULAR_ROUNDS]].forEach(([n, v]) => {
  assert.ok(Array.isArray(v) && v.length, n + ' did not load out of index.html');
});

// ── Scenario builder ───────────────────────────────────────────────────────
// Every player posts a gross of par + offset on every regular round, off a
// handicap of 0, so net-vs-par is exactly the offset and finishing order is
// simply the order of NAMES.
function holesFor(offset) {
  const holes = PARS.slice();
  holes[0] += offset;               // put the whole offset on hole 1
  return holes;
}

// A round only counts once every group in it has submitted, and a single-group
// round is never treated as real (fullySubmittedRounds needs at least two), so
// the field is split into two foursomes exactly like a live round.
const GROUP_SIZE = 4;
function groupsOf(names) {
  const gs = [];
  names.forEach((n, i) => {
    const g = Math.floor(i / GROUP_SIZE);
    if (!gs[g]) gs[g] = { teeTime: '', players: [] };
    gs[g].players.push({ name: n, hcp: 0 });
  });
  return gs;
}

function buildSeason({ regular = 8, playoffs = true } = {}) {
  sandbox.roundScores = {};
  sandbox.activeGroups = {};
  sandbox.coursePars = {};
  sandbox.courseStrokeIndex = {};
  sandbox.penalties = {};
  sandbox.blockRounds = {};

  const addRound = (round, startStrokes) => {
    sandbox.coursePars[round] = PARS.slice();
    const gs = groupsOf(NAMES);
    if (startStrokes) gs.forEach((g) => g.players.forEach((p) => { p.startStrokes = 0; }));
    sandbox.activeGroups[round] = gs;
    gs.forEach((g, gi) => {
      sandbox.roundScores[round + '__' + gi] = {
        round, gi, submitted: true, submittedAt: 1,
        players: g.players.map((p) => ({
          name: p.name, hcp: 0,
          holes: holesFor(NAMES.indexOf(p.name)),
          ...(startStrokes ? { startStrokes: 0 } : {}),
        })),
      };
    });
  };

  REGULAR_ROUNDS.slice(0, regular).forEach((round) => addRound(round, false));
  if (playoffs) ['Playoff 1', 'Championship'].forEach((round) => addRound(round, true));
}

// Drops a player out of a round entirely — card and group both, the way a
// withdrawal actually looks in the data.
function removeFromRound(round, name) {
  Object.keys(sandbox.roundScores).forEach((k) => {
    const sc = sandbox.roundScores[k];
    if (sc.round === round) sc.players = sc.players.filter((p) => p.name !== name);
  });
  (sandbox.activeGroups[round] || []).forEach((g) => {
    g.players = g.players.filter((p) => p.name !== name);
  });
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

console.log('\nseason archive & rollover\n');

// ── 1. The paths that make up a season ─────────────────────────────────────
test('every path that gets cleared is also archived', () => {
  SEASON_CLEAR_PATHS.forEach((p) => {
    assert.ok(SEASON_PATHS.includes(p),
      p + ' is cleared on rollover but never archived — that data would be lost');
  });
});

test('roster, settings and the calendar survive the rollover', () => {
  ['roster', 'settings', 'calendar'].forEach((p) => {
    assert.ok(SEASON_PATHS.includes(p), p + ' should be captured in the archive');
    assert.ok(!SEASON_CLEAR_PATHS.includes(p), p + ' must not be wiped by the rollover');
  });
});

test('the live scoring paths are all captured', () => {
  ['roundScores', 'activeGroups', 'penalties', 'blockRounds',
    'coursePars', 'courseStrokeIndex', 'scorecardPhotos'].forEach((p) => {
    assert.ok(SEASON_PATHS.includes(p), 'archive is missing ' + p);
  });
});

// ── 2. World-ranking carry-forward ─────────────────────────────────────────
test('next season starts on this season\'s final totals', () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const finals = {};
  calcWorldRankings().forEach((p) => { finals[p.n] = p.p; });
  const carry = nextWrBase();
  NAMES.forEach((n) => {
    assert.strictEqual(carry[n], finals[n],
      n + ' should carry ' + finals[n] + ' into next season, got ' + carry[n]);
  });
});

test('carry-forward compounds — it does not reset to the literal', () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const firstCarry = nextWrBase();
  // Open the next season on those totals and play an identical one.
  sandbox.WR_BASE = firstCarry;
  buildSeason();
  const secondCarry = nextWrBase();
  NAMES.forEach((n) => {
    assert.ok(secondCarry[n] > firstCarry[n],
      n + ' should gain points in a second season, went ' + firstCarry[n] + ' -> ' + secondCarry[n]);
    // Two identical seasons on top of a zero base: the second total is exactly
    // twice the first, because a season's earned points are the same both times.
    assert.strictEqual(Math.round(secondCarry[n] * 10), Math.round(firstCarry[n] * 2 * 10),
      n + ' second-season total should be exactly double the first');
  });
});

test('a player with no rounds carries their starting points unchanged', () => {
  sandbox.WR_BASE = { 'Hana Ito': 1234.5 };
  buildSeason();
  // Drop Hana from every round she would otherwise appear in.
  REGULAR_ROUNDS.forEach((r) => removeFromRound(r, 'Hana Ito'));
  ['Playoff 1', 'Championship'].forEach((r) => removeFromRound(r, 'Hana Ito'));
  assert.strictEqual(nextWrBase()['Hana Ito'], 1234.5);
});

// ── 3. The archived summary ────────────────────────────────────────────────
test('summary ranks the season the way the standings do', () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const sum = buildSeasonSummary();
  assert.strictEqual(sum.standings.length, NAMES.length);
  assert.strictEqual(sum.standings[0].rank, 1);
  // NAMES[0] shot the lowest score in every round.
  assert.strictEqual(sum.standings[0].name, 'Ann Reyes');
  for (let i = 1; i < sum.standings.length; i++) {
    assert.ok(sum.standings[i].points <= sum.standings[i - 1].points,
      'standings must be ordered by points, descending');
  }
});

test('summary names the champion once both playoff rounds are in', () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const sum = buildSeasonSummary();
  assert.strictEqual(sum.champion, 'Ann Reyes');
  assert.strictEqual(sum.playoff[0].name, 'Ann Reyes');
  assert.strictEqual(sum.playoff[0].rank, 1);
});

test('no champion is recorded while the Championship is unplayed', () => {
  sandbox.WR_BASE = {};
  buildSeason();
  delete sandbox.roundScores['Championship__0'];
  const sum = buildSeasonSummary();
  assert.strictEqual(sum.champion, null,
    'a half-finished playoff must not be archived as a title');
});

test('no season winner is recorded before all 8 regular rounds are in', () => {
  sandbox.WR_BASE = {};
  buildSeason({ regular: 7 });
  assert.strictEqual(buildSeasonSummary().seasonWinner, null);
  buildSeason({ regular: 8 });
  assert.strictEqual(buildSeasonSummary().seasonWinner, 'Ann Reyes');
});

test('earnings include the season-winner prize and the playoff pool', () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const sum = buildSeasonSummary();
  const byName = {};
  sum.earnings.forEach((e) => { byName[e.name] = e.amount; });
  const winner = sum.seasonWinner;
  assert.ok(byName[winner] >= sandbox.settings.seasonWinnerPrize,
    'the season winner should be paid at least the ' + sandbox.settings.seasonWinnerPrize + ' prize');
  const total = sum.earnings.reduce((a, e) => a + e.amount, 0);
  assert.ok(total > 0, 'a completed season should pay out something');
});

test('a withdrawal keeps its round but holds no playoff position', () => {
  sandbox.WR_BASE = {};
  buildSeason();
  // Hana posted Playoff 1 but is not in the Championship field.
  removeFromRound('Championship', 'Hana Ito');
  const sum = buildSeasonSummary();
  const hana = sum.playoff.find((p) => p.name === 'Hana Ito');
  assert.ok(hana, 'the withdrawn player should still appear on the archived board');
  assert.strictEqual(hana.wd, true);
  assert.strictEqual(hana.rank, null, 'a withdrawal must not hold a ranked position');
  sum.playoff.filter((p) => !p.wd).forEach((p, i) => {
    assert.strictEqual(p.rank, i + 1, 'ranked positions must stay contiguous');
  });
});

test('summary survives a season with no playoff rounds at all', () => {
  sandbox.WR_BASE = {};
  buildSeason({ playoffs: false });
  const sum = buildSeasonSummary();
  assert.strictEqual(sum.playoff.length, 0);
  assert.strictEqual(sum.champion, null);
  assert.ok(sum.standings.length > 0, 'the regular season should still be recorded');
});

// ── 4. The new season's calendar ───────────────────────────────────────────
test('a new season gets a complete, blank calendar', () => {
  const fresh = blankCalendar();
  assert.strictEqual(fresh.length, CALENDAR.length);
  fresh.forEach((c, i) => {
    assert.strictEqual(c.round, CALENDAR[i].round, 'round names carry over');
    assert.strictEqual(c.type, CALENDAR[i].type, 'round types carry over');
    assert.strictEqual(c.date, 'TBD');
    assert.strictEqual(c.course, '');
    assert.strictEqual(c.eventName, '');
    assert.strictEqual(c.teeTime, '');
  });
});

test('blank calendar entries are complete objects, not partials', () => {
  // The `calendar` listener does Object.assign(CALENDAR[i], c). A partial entry
  // would leave last season's venue or event name sitting in memory.
  const keys = ['round', 'date', 'type', 'course', 'eventName', 'teeTime'];
  blankCalendar().forEach((c) => {
    keys.forEach((k) => {
      assert.ok(Object.prototype.hasOwnProperty.call(c, k),
        'a blank calendar round is missing "' + k + '" — Object.assign would keep last season\'s value');
    });
  });
});

test('the blank calendar does not mutate the in-memory CALENDAR', () => {
  const before = JSON.stringify(CALENDAR);
  const fresh = blankCalendar();
  fresh[0].course = 'Somewhere Else';
  assert.strictEqual(JSON.stringify(CALENDAR), before,
    'blankCalendar() must hand back copies, not references');
});

// ── 5. Season identity ─────────────────────────────────────────────────────
test('season helpers read from seasonMeta', () => {
  sandbox.seasonMeta = { year: 2027, label: '2027' };
  assert.strictEqual(sandbox.seasonYear(), 2027);
  assert.strictEqual(sandbox.seasonLabel(), '2027');
  assert.strictEqual(sandbox.seasonShort(), '27');
});

test('season helpers fall back safely on junk', () => {
  sandbox.seasonMeta = {};
  assert.strictEqual(sandbox.seasonYear(), 2026);
  assert.strictEqual(sandbox.seasonLabel(), '2026');
});


// ── 6. The rollover itself, end to end ─────────────────────────────────────
// archiveSeasonAndStartNew() is the one function where ordering is the safety
// model, so it gets exercised against an in-memory stand-in for the Realtime
// Database rather than trusted by reading. The stand-in records the order of
// every write, which is what the ordering assertions below check.

function makeDb() {
  const store = {};
  const writes = [];                       // ordered log of every set()
  const split = (path) => path.split('/').filter(Boolean);
  const getAt = (path) => {
    let n = store;
    for (const k of split(path)) {
      if (n == null || typeof n !== 'object') return null;
      n = n[k];
      if (n === undefined) return null;
    }
    return n === undefined ? null : n;
  };
  const setAt = (path, val) => {
    const ks = split(path);
    let n = store;
    for (let i = 0; i < ks.length - 1; i++) {
      if (typeof n[ks[i]] !== 'object' || n[ks[i]] === null) n[ks[i]] = {};
      n = n[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (val === null || val === undefined) delete n[last];
    else n[last] = JSON.parse(JSON.stringify(val));
  };
  const ref = (path) => ({
    set: (v) => { writes.push({ path, cleared: v === null }); setAt(path, v); return Promise.resolve(); },
    child: (c) => ref(path + '/' + c),
    push: (v) => { setAt(path + '/_' + writes.length, v); return Promise.resolve(); },
    once: () => Promise.resolve({ val: () => getAt(path) }),
  });
  return { ref, getAt, setAt, writes, store };
}

// Loads the rollover functions into a context wired to `fake`, with the browser
// bits (DOM, alert/confirm, renders) stubbed.
let quietConsole = null;   // set while a test deliberately provokes a failure
function rolloverCtx(fake, inputs, answers) {
  const els = {
    'as-season-pin': { value: inputs.pin },
    'as-rollover-confirm': { value: inputs.phrase },
    'as-next-season-year': { value: String(inputs.nextYear) },
    'as-archive-btn': { disabled: false, textContent: '' },
    'as-rollover-btn': { disabled: false, textContent: '' },
    'as-archive-list': { innerHTML: '' },
  };
  const log = { alerts: [], confirms: [], toasts: [], downloads: [] };

  const ctx = {
    ...sandbox,
    db: fake,
    currentUser: { email: 'commish@protour2026.com' },
    adminUnlocked: true,
    CALENDAR: JSON.parse(JSON.stringify(CALENDAR)),
    PLAYERS: sandbox.PLAYERS.slice(),
    WR_BASE: JSON.parse(JSON.stringify(sandbox.WR_BASE)),
    seasonMeta: { year: inputs.year, label: String(inputs.year) },
    roundScores: JSON.parse(JSON.stringify(sandbox.roundScores)),
    activeGroups: JSON.parse(JSON.stringify(sandbox.activeGroups)),
    penalties: JSON.parse(JSON.stringify(sandbox.penalties)),
    blockRounds: {}, coursePars: JSON.parse(JSON.stringify(sandbox.coursePars)),
    courseStrokeIndex: {}, sponsorLogos: {}, scorecardPhotos: {},
    window: { _roundWinnerOverrides: {} },
    document: { getElementById: (id) => els[id] || null },
    Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout: () => {},
    getPin: () => '1234',
    alert: (m) => log.alerts.push(String(m)),
    confirm: (m) => { log.confirms.push(String(m)); return answers.shift() !== false; },
    showToast: (m) => log.toasts.push(String(m)),
    renderHome() {}, renderStandings() {}, renderFoursomePage() {},
    applySeasonBranding() {},
    console: quietConsole || console,
    log,
  };
  ctx.fbGet = (path) => Promise.resolve(fake.ref(path).once().then((s) => s.val())).then((v) => v);
  ctx.fbSet = (path, value) => fake.ref(path).set(value);
  ctx._downloadJson = (obj, filename) => { log.downloads.push({ filename, data: obj }); };
  vm.createContext(ctx);

  vm.runInContext(
    [extractDecl('const', 'PLAYOFF_BONUS_ROUND'), extractDecl('const', 'PLAYOFF_FINAL_ROUND'),
     extractDecl('const', 'PLAYOFF_ROUNDS'), extractDecl('const', 'REGULAR_ROUNDS'),
     extractDecl('const', 'DEFAULT_SI'), extractDecl('const', 'ROUND_8_NAME'),
     extractDecl('const', 'ROLLOVER_MUTE_MS'),
     extractDecl('const', 'ARCHIVE_INDEX_PATH'), extractDecl('const', 'ARCHIVE_DATA_PATH'),
     extractBlockDecl('const', 'DEFAULT_SETTINGS'),
     extractBlockDecl('const', 'SEASON_PATHS'),
     extractBlockDecl('const', 'SEASON_CLEAR_PATHS')]
      .concat(FNS.map(extractFn))
      .concat(['_fmtBytes', 'snapshotSeasonData', '_writeArchive', 'checkSeasonPin',
               'archiveSeasonOnly', 'archiveSeasonAndStartNew', 'renderSeasonArchiveList']
        .map(extractFn))
      .join('\n'),
    ctx
  );
  return ctx;
}

// Seeds the fake database with a full season at the live paths.
function seedDb(fake, ctx) {
  const enc = (o) => {
    const out = {};
    Object.entries(o).forEach(([k, v]) => { out[k.replace(/__/g, '___')] = v; });
    return out;
  };
  fake.setAt('roundScores', enc(ctx.roundScores));
  fake.setAt('activeGroups', ctx.activeGroups);
  fake.setAt('coursePars', ctx.coursePars);
  fake.setAt('penalties', enc({ 'Ann Reyes__Round 1': 2 }));
  fake.setAt('sponsorLogos', { 'Round 1': 'data:image/png;base64,AAAA' });
  fake.setAt('scorecardPhotos', { 'Round 1___0': 'data:image/jpeg;base64,BBBB' });
  fake.setAt('settings', ctx.settings);
  fake.setAt('roster', ctx.PLAYERS);
  fake.setAt('calendar', ctx.CALENDAR);
  fake.setAt('auditLog', { a1: { user: 'x', action: 'write', detail: 'roundScores', ts: 1 } });
}

async function runRollover({ answers = [], inputs = {} } = {}) {
  sandbox.WR_BASE = {};
  buildSeason();
  const fake = makeDb();
  const ctx = rolloverCtx(fake, {
    pin: '1234', phrase: 'ARCHIVE 2026', year: 2026, nextYear: 2027, ...inputs,
  }, answers.slice());
  seedDb(fake, ctx);
  await ctx.archiveSeasonAndStartNew();
  return { ctx, fake, log: ctx.log };
}

// Run the happy path once and assert against it repeatedly.
const happy = (() => {
  let r;
  return async () => (r = r || await runRollover({ answers: [true, true, true] }));
})();

const asyncTests = [];
function atest(name, fn) { asyncTests.push([name, fn]); }

atest('the season is archived with every path intact', async () => {
  const { fake } = await happy();
  const data = fake.getAt('seasonArchives/2026');
  assert.ok(data, 'nothing was archived');
  ['roundScores', 'activeGroups', 'coursePars', 'penalties', 'sponsorLogos',
    'scorecardPhotos', 'settings', 'roster', 'calendar', 'auditLog'].forEach((k) => {
    assert.ok(data[k], 'archive is missing ' + k);
  });
  assert.strictEqual(Object.keys(data.roundScores).length,
    Object.keys(fake.getAt('seasonArchives/2026/roundScores')).length);
});

atest('archived scorecards keep their ___ key encoding verbatim', async () => {
  const { fake } = await happy();
  const keys = Object.keys(fake.getAt('seasonArchives/2026/roundScores'));
  assert.ok(keys.length > 0);
  keys.forEach((k) => {
    assert.ok(k.includes('___'),
      'archived key "' + k + '" lost its Firebase encoding — it could not be written back');
  });
});

atest('meta records the champion and is written after the payload', async () => {
  const { fake } = await happy();
  const meta = fake.getAt('seasons/2026/meta');
  assert.ok(meta, 'no meta written');
  assert.strictEqual(meta.year, 2026);
  assert.strictEqual(meta.champion, 'Ann Reyes');
  assert.ok(meta.scorecards > 0);
  const paths = fake.writes.map((w) => w.path);
  assert.ok(paths.indexOf('seasonArchives/2026') < paths.indexOf('seasons/2026/meta'),
    'meta must be written after data — it is the marker that the payload completed');
  assert.ok(paths.indexOf('seasons/2026/summary') < paths.indexOf('seasons/2026/meta'),
    'meta must be written after summary');
});

atest('nothing is cleared until the archive is written and downloaded', async () => {
  const { fake, log } = await happy();
  const paths = fake.writes.map((w) => w.path);
  const firstClear = fake.writes.findIndex((w) => w.cleared && !(w.path.startsWith('seasons/')||w.path.startsWith('seasonArchives/')));
  assert.ok(firstClear > -1, 'the rollover never cleared anything');
  assert.ok(paths.indexOf('seasons/2026/meta') < firstClear,
    'a clear happened before the archive was complete');
  assert.strictEqual(log.downloads.length, 1, 'the JSON copy should be downloaded exactly once');
  assert.ok(log.downloads[0].filename.includes('2026'));
});

atest('the season flips before any clear, retiring every local backup', async () => {
  const { fake } = await happy();
  const paths = fake.writes.map((w) => w.path);
  const firstClear = fake.writes.findIndex((w) => w.cleared && !(w.path.startsWith('seasons/')||w.path.startsWith('seasonArchives/')));
  assert.ok(paths.indexOf('seasonMeta') < firstClear,
    'seasonMeta must be written before the clears, or a player could restore the old season '
    + 'from their phone into the freshly-emptied cloud');
});

atest('push notifications are muted across the clears, then unmuted', async () => {
  const { fake } = await happy();
  const paths = fake.writes.map((w) => w.path);
  const firstClear = fake.writes.findIndex((w) => w.cleared && !(w.path.startsWith('seasons/')||w.path.startsWith('seasonArchives/')));
  assert.ok(paths.indexOf('rollover/until') < firstClear,
    'the push mute must be set before groups start being cleared');
  assert.strictEqual(fake.getAt('rollover/until'), null,
    'the mute must be lifted when the rollover finishes');
});

atest('the live season is emptied and the new one stood up', async () => {
  const { fake, ctx } = await happy();
  ['roundScores', 'activeGroups', 'penalties', 'coursePars',
    'sponsorLogos', 'scorecardPhotos', 'auditLog'].forEach((k) => {
    assert.strictEqual(fake.getAt(k), null, k + ' should have been cleared');
  });
  assert.ok(fake.getAt('roster'), 'the roster must survive');
  assert.ok(fake.getAt('settings'), 'settings must survive');
  assert.deepStrictEqual(fake.getAt('seasonMeta'), { year: 2027, label: '2027' });
  assert.strictEqual(fake.getAt('calendar')[0].date, 'TBD');
  assert.strictEqual(fake.getAt('calendar')[0].course, '');
  assert.strictEqual(ctx.seasonMeta.year, 2027, 'the in-memory season should follow');
});

atest('world-ranking points carry into the new season', async () => {
  const { fake } = await happy();
  const carried = fake.getAt('wrBase');
  assert.ok(carried, 'wrBase was never written');
  const archivedWorld = fake.getAt('seasons/2026/summary').world;
  archivedWorld.forEach((row) => {
    assert.strictEqual(carried[row.name], row.total,
      row.name + ' should start next season on their final total of ' + row.total);
  });
});

atest('the player-facing record stays small - the bulk lives elsewhere', async () => {
  const { fake } = await happy();
  // Standings > History reads the whole index for every player, on every open.
  // If the verbatim snapshot lived under it, that would be megabytes of base64
  // scorecard photos pulled down to render a champion's name.
  const index = fake.getAt('seasons/2026');
  assert.deepStrictEqual(Object.keys(index).sort(), ['meta', 'summary'],
    'the player-facing record should hold nothing but meta and summary');
  assert.ok(!JSON.stringify(index).includes('base64'),
    'an image leaked into the record every player downloads');
  assert.ok(fake.getAt('seasonArchives/2026/scorecardPhotos'),
    'the photos should still be archived, just not in the index');
});

atest('a failed archive clears nothing', async () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const fake = makeDb();
  quietConsole = { ...console, error() {}, warn() {} };   // the failure below is the point
  const ctx = rolloverCtx(fake, { pin: '1234', phrase: 'ARCHIVE 2026', year: 2026, nextYear: 2027 },
    [true, true, true]);
  quietConsole = null;
  seedDb(fake, ctx);
  // Break the archive write the way a denying security rule would: the write
  // reports success but nothing lands.
  const realRef = fake.ref;
  ctx.fbSet = (path, value) => realRef(path).set(value);
  ctx.db = {
    ref: (path) => (path.startsWith('seasons/')||path.startsWith('seasonArchives/')
      ? { set: () => Promise.resolve(), child(c) { return ctx.db.ref(path + '/' + c); },
          once: () => Promise.resolve({ val: () => null }), push: () => Promise.resolve() }
      : realRef(path)),
  };
  vm.runInContext('db = this.db; fbSet = this.fbSet;', ctx);
  await ctx.archiveSeasonAndStartNew();

  assert.ok(ctx.log.alerts.some((a) => /failed/i.test(a)),
    'a failed archive must say so');
  assert.ok(Object.keys(fake.getAt('roundScores') || {}).length > 0,
    'THE SEASON WAS CLEARED DESPITE THE ARCHIVE FAILING');
  assert.ok(fake.getAt('activeGroups'), 'groups were cleared despite the archive failing');
  assert.strictEqual(ctx.log.downloads.length, 0, 'nothing should be downloaded on failure');
});

atest('declining the final confirmation changes nothing', async () => {
  const { fake, log } = await runRollover({ answers: [false] });
  assert.strictEqual(fake.getAt('seasons/2026/meta'), null);
  assert.ok(Object.keys(fake.getAt('roundScores') || {}).length > 0);
  assert.strictEqual(fake.getAt('seasonMeta'), null);
  assert.ok(log.toasts.some((t) => /cancel/i.test(t)));
});

atest('re-archiving an existing season asks before overwriting', async () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const fake = makeDb();
  const ctx = rolloverCtx(fake, { pin: '1234', phrase: 'ARCHIVE 2026', year: 2026, nextYear: 2027 },
    [false]);   // decline the overwrite prompt
  seedDb(fake, ctx);
  fake.setAt('seasons/2026/meta', { year: 2026, archivedAt: 1, scorecards: 99, champion: 'Someone' });
  await ctx.archiveSeasonAndStartNew();
  assert.ok(ctx.log.confirms.some((c) => /ALREADY archived/i.test(c)),
    'an existing archive must be flagged before it is overwritten');
  assert.strictEqual(fake.getAt('seasons/2026/meta').scorecards, 99,
    'the existing archive was overwritten despite the prompt being declined');
  assert.ok(Object.keys(fake.getAt('roundScores') || {}).length > 0);
});

atest('archive-only leaves the live season untouched', async () => {
  sandbox.WR_BASE = {};
  buildSeason();
  const fake = makeDb();
  const ctx = rolloverCtx(fake, { pin: '1234', phrase: '', year: 2026, nextYear: 2027 }, [true]);
  seedDb(fake, ctx);
  const before = JSON.stringify(fake.getAt('roundScores'));
  await ctx.archiveSeasonOnly();
  assert.ok(fake.getAt('seasons/2026/meta'), 'archive-only should still archive');
  assert.strictEqual(JSON.stringify(fake.getAt('roundScores')), before,
    'archive-only must not touch the live season');
  assert.strictEqual(fake.getAt('seasonMeta'), null, 'archive-only must not start a new season');
  assert.strictEqual(ctx.log.downloads.length, 1);
});

(async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
  }
  REPORT();
})();

function REPORT() {
  console.log('\n' + passed + ' passed' +
  (process.exitCode ? ', some FAILED' : '') + '\n');
}
