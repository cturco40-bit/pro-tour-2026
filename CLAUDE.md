# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Pro Tour 2026 — a single-page PWA for a 27-player golf league. Live scoring, group/foursome management, season standings + playoffs, and an admin panel. Deployed to GitHub Pages at `protour.ca` (custom domain via `CNAME`). Repo: `github.com/cturco40-bit/pro-tour-2026`.

There is no build step, no package manager, no test runner. The whole app is `index.html` (~8k lines, HTML + CSS + inline JS) plus `service-worker.js`, `manifest.json`, and a handful of PNG assets. Edits to `index.html` are the work.

## Common commands

```bash
# Local preview (any static server). DEV_MODE auto-activates on localhost
# and bypasses Firebase auth, seeding fake roster + one submitted scorecard:
python -m http.server 8000        # then open http://localhost:8000

# Ship a change:
# 1. Edit index.html
# 2. Bump service-worker.js CACHE_NAME (vNN → vNN+1) so clients prompt for
#    update; otherwise the old shell sticks around for offline users
# 3. git add / commit / push to main → GitHub Pages auto-deploys

# Regenerating PWA icons from logo-pro-tour.png (requires Pillow):
python -c "
from PIL import Image
src = Image.open('logo-pro-tour.png').convert('RGBA')
def sq(size, bg=(250,250,244,255)):
    c = Image.new('RGBA',(size,size),bg)
    t = int(size*0.85); w,h = src.size
    nw,nh = (t, int(h*t/w)) if w>h else (int(w*t/h), t)
    r = src.resize((nw,nh), Image.LANCZOS)
    c.paste(r, ((size-nw)//2,(size-nh)//2), r); return c
sq(192).save('icon-192.png','PNG',optimize=True)
sq(512).save('icon-512.png','PNG',optimize=True)
sq(180).save('apple-touch-icon.png','PNG',optimize=True)
"
```

There is no lint and no test runner. The one test file is plain Node, no deps:

```bash
node tests/playoff-start-strokes.test.js   # playoff start-stroke model
```

Otherwise verify changes by loading the local preview and clicking through the affected flow.

## Architecture

### Single file, sectioned by comment banners

`index.html` is organized by `// ═══════════════ NAME ═══════════════` banners. Use these to navigate — `grep -n "^// ═\|^// ─" index.html` lists every section. Major regions (line numbers shift as the file grows; grep for the banner):

- `DATA` — `PLAYERS[]` roster (hard-coded), `WR_BASE` starting world-ranking points, `CALENDAR[]` (10 rounds: 8 regular + Playoff 1 + Championship), `PTS[]`, `DEFAULT_SI`, `REGULAR_ROUNDS`
- `STATE` — top-level mutable globals: `activeGroups`, `roundScores`, `coursePars`, `courseStrokeIndex`, `penalties`, `settings`, `sponsorLogos`
- `PAGE NAV` — `showPage(id, btn)` switches `.pg` panes and re-renders; bottom nav buttons route here
- `HOME`, `FOURSOME LIST PAGE`, `STANDINGS`, `Schedule with scorecard history`, `ADMIN`, `ACCOUNT PAGE` — each page has its own `renderX()` function called from `showPage`
- `SCORECARD CELL HELPER` (`scorecardCell()`) + `HALFWAY & FINAL SCORECARD REVIEW` + the `.sc-overlay` element — the live scoring overlay
- Scoring math: `strokesOnHole`, `calcNetVsPar`, `getEffectiveNet`, `fullySubmittedRounds`, `calcSeasonStandings`, `assignPointsWithTies`, `assignMoneyWithTies`, `buildPlayoffCombined`
- Money/points: `calcPrizePool(round)` (regular rounds = players × entryFee − sponsorDiscount), `calcPlayoffPool()` (entry pool minus `seasonWinnerPrize`), `calcPlayoffPayouts()`, `calcRoundPayouts(round)`
- `STARTUP` — last block of the file; loads Firebase compat SDKs, then either `startDevMode()` on localhost or `initAuth()` in production

### Firebase Realtime Database is the source of truth

- Config inline in `index.html` (project `pro-tour-2026-58184`). API key is a public client key — Firebase Security Rules are the access control. **Do not** treat it as a secret to hide.
- Auth = email/password where username is mapped via `usernameToEmail(u) → u + '@protour2026.com'`. The 27-player roster all have accounts at this fake domain.
- Live listeners are set up once in `initFirebase()` via `fbOn(path, cb)` on `roundScores`, `activeGroups`, `settings`, `coursePars`, `courseStrokeIndex`, `penalties`, `sponsorLogos`. Each callback normalizes Firebase's "array as numeric-keyed object" quirk and re-renders any active page.
- Writes go through `fbSet(path, value)` which mirrors to Firebase AND pushes an entry to `auditLog/`. The Admin → Audit Log section reads from there. **Important:** `roundScores` keys use `__` (e.g. `Round 1__0`); Firebase paths replace `__` with `___` because Firebase rejects keys with `__` patterns. `saveOneScorecard(key)` writes a single group rather than the full map, so concurrent groups in the same round can't overwrite each other's holes — prefer it over `saveRoundScores()` for in-progress writes.
- `localStorage` is a backup, not a cache: `RSCORES_BACKUP_KEY` snapshots `roundScores` on every change so a dropped connection at the course doesn't lose entered holes. `restoreRoundScoresLocal()` is the recovery path. `NOTIFIED_SUBMITS_KEY` is the dedupe set for submission notifications — without it the app re-fires a notification for every already-submitted card on each open.

### Service Worker / PWA update flow

- `service-worker.js` is **network-first** for HTML (always fetch fresh `index.html`, fall back to cache offline). Other GET requests are also network-first but cached on success. Firebase / Google requests skip the SW entirely.
- The SW does **not** call `skipWaiting()` on install — the page shows a "new version available" prompt that posts `SKIP_WAITING` to the worker when the user accepts. Always bump `CACHE_NAME` when shipping; old clients won't see the new HTML on the next open if you don't.
- iOS PWAs cache the manifest at install time. Changing `theme_color`, the icons, or `apple-mobile-web-app-status-bar-style` requires the user to **delete and reinstall** the home-screen icon. There is no programmatic refresh.
- The `apple-mobile-web-app-status-bar-style` meta is intentionally `default` (not `black-translucent`), and theme color is cream `#fafaf4`. Don't switch to `black-translucent` — it makes the page bleed under the iOS status bar.

### Design system (since the 2026 redesign)

CSS custom properties in `:root` define the palette and type stack:
- `--green` `#1a4d2e`, `--gold` `#f4d940`, `--gold-deep` `#c9a826`, `--bg` `#fafaf4` (cream), `--card` `#fff`, `--hair` (hairline border), `--sub` / `--muted` (text tones)
- `--ff-display` Big Shoulders Display (uppercase headlines + numerals)
- `--ff-body` Inter Tight (body)
- `--ff-mono` IBM Plex Mono (small uppercase labels with `letter-spacing:.14–.16em`)

Reusable patterns (all defined near the top of the `<style>` block):
- `.ho-row` / `.ho-pos` / `.ho-name-wrap` / `.ho-val` — the shared list-row used on Home and reused for Player Stats. Three columns: rank · name+meta · value+sub.
- `.st-row.season|.world|.playoff|.earn` + `.st-head.X` + `.st-h` + `.st-cell` — Standings tables. Each variant defines its own `grid-template-columns` so the header and rows align (use fixed-width last columns, never `auto`, or the Big-Shoulders numerals will push the columns off-grid).
- `.lb-row` / `.lb-pos` / `.lb-name` / `.lb-score` / `.lb-thru` — foursomes Live Leaderboard. **Separate** from `.st-row` (there used to be a collision; do not reintroduce one).
- `.as-section` / `.as-section-hdr` + `h3` — Admin accordion sections. Open state adds `.open` to both the body and the header (the header class drives the bottom-border reveal). Danger variant: `.as-section.as-danger` swaps to a red-tinted card for destructive actions like Clear Scores.
- `.card` (cream surface, hairline border) and `.ctitle` (mono uppercase title with a gold-dot `::before`) are the common card chrome.

Hard rules from the redesign work — re-check them before any UI change:
- No emojis anywhere user-facing. Use inline SVGs (or text). The codebase was scrubbed of ~30 emoji spots; don't reintroduce them.
- Big Shoulders Display for any number that's meant to be read as a score (gross, net, points, money, rank). Plex Mono for labels above/below those numbers. Inter Tight for prose.
- `word-break:keep-all` on display headings and mono labels so a long label drops to a new line instead of breaking mid-word.
- The full-page header (`.hdr`) shows on every page **except** Home (Home has its own `.brand-block`). `showPage()` toggles it. No back button — the scorecard overlay has its own.

### Scoring model

- Each group's scorecard lives at `roundScores[round__gi]`. `gi` is the 0-based group index within `activeGroups[round]`. The scorecard has `{round, gi, players:[{name,hcp,holes:[18]}], submitted, submittedAt, roundStartedAt}`.
- `strokesOnHole(hcp, si)` returns how many handicap strokes a player gets on that hole (`floor(hcp/18) + (si <= hcp%18 ? 1 : 0)`). Used everywhere — including the asterisk display in unplayed cells.
- `calcNetVsPar(holes, hcp, pars, siArr)` returns net-vs-par as a signed integer; `getEffectiveNet(player, round)` adds penalty strokes and returns the comparable number for leaderboards. **Always** prefer `getEffectiveNet` for season/standings calcs — raw `holes.sum() - hcp` ignores penalty adjustments.
- Season standings (`calcSeasonStandings`): top 5 of 8 regular rounds count, with Round 8 blocked if the player played all 8. Ties on the same score get a `T` prefix in the rank label.
- Playoff money: combined net over Playoff 1 + Championship; pool = `players × playoffEntryFee − seasonWinnerPrize` (the season-winner prize is **carved out** of the playoff pool, not added on top). `assignMoneyWithTies` splits payouts evenly across tied positions. Playoff rounds carry **no per-round purse** — the round entry fee never applies to them, and `calcPrizePool()` returns 0 for a playoff round so it can't leak into a displayed purse.

### Playoff start strokes

The playoff advantage is a **start-stroke adjustment to the score, never a handicap change** — handicap is the player's handicap everywhere in the app. `Playoff net = gross − course handicap + startStrokes`.

- The field is a locked record at Firebase `playoffField` (`playoffField` global, `savePlayoffField()`). Admin locks it from Setup → Playoff 1; that lock is what **issues** start strokes and is the gating step — `autoAssignPlayoffGroups()` refuses to build groups without it.
- `startStrokes` is assigned once from the player's **original** final-standings seed: seeds 1–4 → −2, 5–8 → −1, 9–12 → 0. Immutable after that. There is deliberately **no live-derived fallback** in `getStartStrokes()`, so a post-lock penalty edit can never shift a start already issued.
- Withdrawals re-seed for **group placement only** (`activeFieldOrder()` → `effectiveSeed`, `group`). Seed 5 at −1 can end up in group 1 and is still −1.
- Alternates fill the vacated 12th spot from standings order and are priced by **call-up order**, not seed: 1st +2, 2nd +3, 3rd +4. `nextCallUp` is monotonic — never derive it from how many alternates are currently active, or a withdrawn alternate makes the next call-up recycle a price.
- Start strokes apply to **Playoff 1 only** and ride into the combined total; the Championship re-applies nothing. A player's Playoff 1 net *is* their Championship starting score.
- **Championship tee order reverses Playoff 1**: `autoAssignChampionshipGroups()` sends 9th–12th after R1 off first and puts the top 4 in the final group. Handicaps are locked to what each player played Playoff 1 off.
- Pure, testable core: `assignInitialField`, `withdrawFromField`, `activeFieldOrder`. Tests live in `tests/playoff-start-strokes.test.js` (`node tests/playoff-start-strokes.test.js`) and extract the real functions out of `index.html` rather than copying them.
- `repairLegacyPlayoffHandicaps()` restores `hcp` from `baseHcp` on Playoff 1 groups saved by the **old** model, which inflated the handicap by a group bonus. That inflation would now double-count against start strokes.

### Admin

- Gated by a 4-digit PIN stored in Firebase at `pin` (default `1234`; `getPin()` is the accessor). `adminUnlocked` is a runtime flag — there's no role on the auth user.
- Sections are accordions controlled by `toggleAS(id)`. Each section's body is `#as-body-{id}` and arrow is `#as-garr-{id}`. The function closes all other sections when one opens — keep that in mind if adding parallel-open sections.
- "Clear Scores" actions all require re-entering the PIN in the inline input (`#clear-confirm-pin`); `checkClearPin()` is the gate.

### Things that bite

- **Don't** edit `roundScores[key]` via the whole-map write while another device might be submitting — use `saveOneScorecard(key)` for per-group writes.
- **Don't** rely on `Array.isArray(sc.players)` after a Firebase round-trip — the listener normalizes, but raw paths can return numeric-keyed objects. If you add a new live listener, normalize the same way.
- The `__` → `___` Firebase-key replacement is mandatory; forgetting it silently writes to a malformed path that the live listener won't echo back.
- Pre-existing modals (Mid-Round LB, Round Results, Tiebreak, Confirm Submit, Player Breakdown, Player Stats) are built imperatively in JS, not in static HTML — search by the modal id (`mid-lb-modal`, `round-results-modal`, etc.) to find the builder.
- The 27-player roster is hard-coded in the `DATA` section. Add/remove via Admin → Player Roster, which writes to Firebase `roster/` and rehydrates `PLAYERS` on next load — editing the literal array directly will desync from Firebase state.
- iOS PWA reinstall is the only way to update the home-screen icon or status-bar color. Mention it in shipping notes when changing those.

## Conventions when editing

- Prefer editing the existing render function for a page over wrapping it in a new abstraction — the file is large but each page is self-contained.
- Bump `CACHE_NAME` in `service-worker.js` on every shippable change, even cosmetic ones, or returning users won't see them until next install.
- When changing the design language, also touch the modals that build their own DOM imperatively — they don't share CSS class hierarchies with the page-level renders.
- Commit messages on `main` typically include a `(vNN)` suffix matching the new SW cache version, e.g. `Schedule cards: cleaner layout, full-width titles (v61)`.
