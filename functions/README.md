# Pro Tour push notifications (Cloud Functions)

Two Realtime Database triggers send a Firebase Cloud Messaging push when the
schedule changes:

- `notifyGroupChange` — watches `activeGroups/{round}`. Tells a player when they
  are moved/added/removed from a group, or when their group's tee time changes.
- `notifyCalendarChange` — watches `calendar`. Tells everyone in a round when its
  venue, date, or first tee time changes.

The static site (GitHub Pages) is unaffected — this is a **separate** deploy.

## One-time setup

1. **Enable the Blaze plan** on the Firebase project (`pro-tour-2026-58184`).
   Console → ⚙️ → Usage and billing → Modify plan → Blaze. Add a budget alert
   (e.g. $1) in Google Cloud Billing for peace of mind.

2. **Generate the Web Push key.** Console → Project Settings → Cloud Messaging →
   *Web Push certificates* → **Generate key pair**. Copy the public key and paste
   it into `VAPID_PUBLIC_KEY` in `index.html`, then commit + push (bump the
   service-worker `CACHE_NAME`).

3. **Install the Firebase CLI** (once, globally):

   ```bash
   npm install -g firebase-tools
   firebase login
   ```

4. **Security rules:** make sure authenticated users can write their own token.
   Add to the Realtime Database rules if not already covered:

   ```json
   "fcmTokens": { ".read": "auth != null", ".write": "auth != null" }
   ```

## Deploy

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

Re-run `firebase deploy --only functions` after any change to `functions/index.js`.

## How it stays cheap

- One invocation per group/calendar **save** (not per player notified — one run
  sends to everyone in a single execution). FCM sends are free.
- `maxInstances: 5` caps concurrency.
- Dead tokens are pruned automatically from each send response.
