// ════════════════════════════════════════════════════════════════════════════
// Pro Tour 2026 — true push notifications
//
// Two Realtime Database triggers turn a data change into a Cloud Messaging push:
//   • activeGroups/{round}  → tell a player when THEY are moved/added/removed, or
//                             when their group's tee time changes.
//   • calendar              → tell EVERYONE in a round when its venue / date /
//                             first tee time changes.
//
// Push content is derived entirely from the before/after data here on the server,
// so a client can never inject arbitrary notification text. The only thing that
// must stay byte-for-byte identical to the client is normalizeUsername(), because
// it's the key tokens are stored under: fcmTokens/{normalizedUsername}/{token}.
// ════════════════════════════════════════════════════════════════════════════

const { onValueWritten } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();

// Cap concurrency so a runaway can never balloon cost — far more than this league
// will ever need, but a hard ceiling all the same.
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

// Collect { name, body } messages, group them per player, and send + prune.
async function deliver(messages){
  if (!messages.length) return;
  const byName = {};
  messages.forEach(m => { (byName[m.name] = byName[m.name] || []).push(m.body); });

  await Promise.all(Object.entries(byName).map(async ([name, bodies]) => {
    const uname = normalizeUsername(name);
    const snap = await admin.database().ref('fcmTokens/' + uname).once('value');
    const tokVal = snap.val();
    if (!tokVal) return;
    const tokens = Object.keys(tokVal);
    if (!tokens.length) return;

    const body = bodies.join('  ');
    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      data: { title: 'Pro Tour — Schedule Update', body },
    });

    // Prune tokens FCM reports as dead so they don't rot forever.
    const removals = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument') {
          removals.push(admin.database().ref('fcmTokens/' + uname + '/' + tokens[i]).remove());
        }
      }
    });
    await Promise.all(removals);
  }));
}

// ─── Trigger 1: group changes for one round ────────────────────────────────
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

  await deliver(messages);
});

// ─── Trigger 2: calendar (venue / date / first tee time) ───────────────────
exports.notifyCalendarChange = onValueWritten('/calendar', async (event) => {
  const before = coerceArray(event.data.before.val());
  const after  = coerceArray(event.data.after.val());

  // Need the current groups to know who's in each affected round.
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

  await deliver(messages);
});
