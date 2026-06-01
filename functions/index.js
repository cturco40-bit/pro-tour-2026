// ════════════════════════════════════════════════════════════════════════════
// Pro Tour 2026 — true push notifications
//
// Three Realtime Database triggers turn a data change into a Cloud Messaging push:
//   • activeGroups/{round}        → SCHEDULE: tell a player when THEY are
//                                   moved/added/removed, or their tee time changes.
//   • calendar                    → SCHEDULE: tell EVERYONE in a round when its
//                                   venue / date / first tee time changes.
//   • roundScores/{key}/submitted → SCORING: tell EVERYONE opted-in when a group
//                                   submits a scorecard.
//
// Each device's token carries per-category preferences:
//   fcmTokens/{normalizedUsername}/{token} = { scoring: bool, schedule: bool, ts }
// so the two in-app toggles are honoured independently here. Older tokens stored
// as a bare timestamp number are treated as opted-in to both categories.
//
// Push content is derived entirely from the before/after data on the server, so a
// client can never inject arbitrary text. normalizeUsername() must stay identical
// to the client — it's the key tokens are stored under.
// ════════════════════════════════════════════════════════════════════════════

const { onValueWritten } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();

// Cap concurrency so a runaway can never balloon cost.
setGlobalOptions({ maxInstances: 5 });

// MUST match index.html's normalizeUsername exactly (token storage key).
function normalizeUsername(s){ return String(s || '').trim().toLowerCase().replace(/\s+/g, ''); }

// Firebase stores arrays as arrays when dense, objects-with-numeric-keys otherwise.
function coerceArray(v){
  if (Array.isArray(v)) return v.filter(x => x != null);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map(k => v[k]).filter(x => x != null);
  }
  return [];
}

// A token opts into a category unless its stored prefs explicitly say false.
// Bare-number (legacy) tokens opt into everything.
function tokenAllows(meta, category){
  if (meta && typeof meta === 'object') return meta[category] !== false;
  return true;
}

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

// Send to an explicit list of {uname, token}, pruning the ones FCM reports dead.
async function sendToTargets(targets, title, body, tag){
  if (!targets.length) return;
  const resp = await admin.messaging().sendEachForMulticast({
    tokens: targets.map(t => t.token),
    data: { title, body, tag },
  });
  const removals = [];
  resp.responses.forEach((r, i) => {
    if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) {
      removals.push(admin.database().ref('fcmTokens/' + targets[i].uname + '/' + targets[i].token).remove());
    }
  });
  await Promise.all(removals);
}

// name -> { gi, teeTime } for one round's activeGroups value
function playerGroupMap(groupsVal){
  const map = {};
  coerceArray(groupsVal).forEach((g, gi) => {
    const tee = (g && g.teeTime) || '';
    coerceArray(g && g.players).forEach(p => {
      if (p && p.name) map[p.name] = { gi, teeTime: tee };
    });
  });
  return map;
}

// SCHEDULE delivery: { name, body } messages → that player's schedule-enabled tokens.
async function deliverSchedule(messages){
  if (!messages.length) return;
  const byName = {};
  messages.forEach(m => { (byName[m.name] = byName[m.name] || []).push(m.body); });

  await Promise.all(Object.entries(byName).map(async ([name, bodies]) => {
    const uname = normalizeUsername(name);
    const snap = await admin.database().ref('fcmTokens/' + uname).once('value');
    const tokVal = snap.val();
    if (!tokVal) return;
    const targets = Object.entries(tokVal)
      .filter(([, meta]) => tokenAllows(meta, 'schedule'))
      .map(([token]) => ({ uname, token }));
    await sendToTargets(targets, 'Pro Tour — Schedule Update', bodies.join('  '), 'protour-schedule');
  }));
}

// SCORING delivery: broadcast one body to every scoring-enabled token (all users).
async function broadcastScoring(body){
  const snap = await admin.database().ref('fcmTokens').once('value');
  const all = snap.val() || {};
  const targets = [];
  Object.entries(all).forEach(([uname, toks]) => {
    Object.entries(toks || {}).forEach(([token, meta]) => {
      if (tokenAllows(meta, 'scoring')) targets.push({ uname, token });
    });
  });
  await sendToTargets(targets, 'Scorecard Submitted', body, 'protour-scoring');
}

// ─── Trigger 1: group changes for one round (SCHEDULE) ─────────────────────
exports.notifyGroupChange = onValueWritten('/activeGroups/{round}', async (event) => {
  const round = event.params.round;
  const before = playerGroupMap(event.data.before.val());
  const after  = playerGroupMap(event.data.after.val());

  const messages = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  names.forEach(name => {
    const b = before[name], a = after[name];
    if (!b && a) {
      messages.push({ name, body: `${round}: you've been added to Group ${a.gi + 1}.` });
    } else if (b && !a) {
      messages.push({ name, body: `${round}: you've been removed from the groups.` });
    } else if (b && a) {
      if (b.gi !== a.gi) {
        messages.push({ name, body: `${round}: you've been moved to Group ${a.gi + 1}.` });
      } else if ((b.teeTime || '') !== (a.teeTime || '') && a.teeTime) {
        messages.push({ name, body: `${round}: your tee time is now ${a.teeTime}.` });
      }
    }
  });

  await deliverSchedule(messages);
});

// ─── Trigger 2: calendar venue / date / first tee time (SCHEDULE) ──────────
exports.notifyCalendarChange = onValueWritten('/calendar', async (event) => {
  const before = coerceArray(event.data.before.val());
  const after  = coerceArray(event.data.after.val());

  const agSnap = await admin.database().ref('activeGroups').once('value');
  const ag = agSnap.val() || {};

  const messages = [];
  after.forEach((c, i) => {
    if (!c || !c.round) return;
    const b = before[i] || {};
    const parts = [];
    if ((c.course  || '') !== (b.course  || '') && c.course)                    parts.push(`venue is now ${c.course}`);
    if ((c.date    || '') !== (b.date    || '') && c.date && c.date !== 'TBD')   parts.push(`date is ${c.date}`);
    if ((c.teeTime || '') !== (b.teeTime || '') && c.teeTime)                    parts.push(`first tee at ${c.teeTime}`);
    if (!parts.length) return;

    const body = `${c.round}: ${parts.join(', ')}.`;
    Object.keys(playerGroupMap(ag[c.round])).forEach(name => messages.push({ name, body }));
  });

  await deliverSchedule(messages);
});

// ─── Trigger 3: a group submits its scorecard (SCORING) ────────────────────
exports.notifyScorecardSubmit = onValueWritten('/roundScores/{key}/submitted', async (event) => {
  const before = event.data.before.val();
  const after  = event.data.after.val();
  if (after !== true || before === true) return; // only on the false/undefined → true transition

  let card = null;
  try { const s = await event.data.after.ref.parent.once('value'); card = s.val(); } catch (e) {}
  if (!card) return;

  const round = card.round || 'Round';
  const names = coerceArray(card.players)
    .map(p => p && p.name)
    .filter(Boolean)
    .map(n => String(n).split(' ')[0]) // first names, matches the in-app notification
    .join(', ');
  const body = names ? `${round} — ${names} finished` : `${round} — a group finished`;

  await broadcastScoring(body);
});
