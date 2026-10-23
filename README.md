# PlayTracker

A self-hosted game playtime and session tracker for Docker and Unraid. It's fast, mobile-friendly and has a full API.

Steam, Xbox and PlayStation tell you **how long you've played in total**, but not **when**. PlayTracker saves your lifetime playtime on a schedule (hourly, daily, weekly, monthly or every *X* days/hours). The difference between two snapshots becomes a **play session**.

- **Platforms:** Steam (Web API), Xbox (OpenXBL), PlayStation (NPSSO), plus **custom accounts** you push totals to over the API (Switch, Epic, GOG, emulators, Playnite…). You can also add games by hand and log sessions manually.
- **Live presence:** PlayTracker watches what you're playing right now on Steam, PlayStation and Xbox.
  - Sessions get **exact start and end times**.
  - A sync runs right after you stop playing.
  - The dashboard shows a "Playing now" card.
- **Smart history:** existing hours are dated from first/last played, launch counts, achievement times and release dates, instead of spiking on import day. See below.
- **Session detection:**
  - Deltas between syncs become sessions.
  - When a platform reports a "last played" time (Steam, Xbox, PSN), the session is pinned to it.
  - When it doesn't, the minutes are spread across the sync window, so weekly or monthly syncs still give sensible daily charts.
  - Deltas below a threshold build up until they're big enough.
  - Impossible deltas (more playtime than wall-clock time since the last sync) are clamped.
- **Mass initial imports:** your existing hours never show up as a fake 500-hour session on day one. They become **history**, which is dated by evidence and drawn hatched in charts (see *Smart handling of your existing playtime*).
  - Games that first appear later but were last played *before* the previous sync are also treated as history.
- **Duplicate tracking:**
  - The same game on several platforms is grouped automatically. Platform tags and edition suffixes are ignored, e.g. *ELDEN RING (PS5)*, *Witcher 3 – GOTY Edition*.
  - Fuzzy **merge suggestions** catch the rest. Sequels are deliberately *not* matched (*Hades* vs *Hades II*).
  - **Double-counting detection** flags the same game counted from two sources (e.g. an imported spreadsheet plus the live Steam account) so you can exclude one with one click.
  - Manual merge, split and move.
- **Stats:**
  - Today, this week, 30 days, streaks.
  - Stacked per-platform charts and a GitHub-style heatmap.
  - Top games, weekday and time-of-day breakdowns.
  - Platform share and a **year in review** page.
- **Library:** cover grid or list, search, platform and status filters, favorites, ratings, notes, hidden games, statuses (playing, backlog, beaten, completed, dropped…).
- **API-first:**
  - REST/JSON for everything, with an auto-generated OpenAPI spec (`/api/openapi.json`) and an in-app docs page.
  - API tokens, a `/api/v1/widget` endpoint for Homepage, Homarr and Home Assistant, and Prometheus `/metrics`.
  - Webhooks (Discord and Slack formatted).
- **Ops:**
  - No dependencies at all: Node 22 plus the built-in SQLite.
  - Optional password, a JSON/CSV export and a one-click SQLite backup.
  - Installable as a mobile web app (PWA).

## Quick start

### Unraid (zero configuration)

1. **Add the template.** In the Unraid web UI, go to **Docker → Add Container** and paste the template URL `https://raw.githubusercontent.com/cmgfender/playtracker/main/unraid/playtracker.xml`. Or save [`unraid/playtracker.xml`](unraid/playtracker.xml) to `/boot/config/plugins/dockerMan/templates-user/my-playtracker.xml` and pick it.
2. **Click Apply.** No fields need changing:
   - **Port:** `7720`. It's uncommon, so it won't collide with the usual 8080 apps.
   - **Data:** `/mnt/user/appdata/playtracker`.
   - **User:** the container runs as `99:100` (nobody:users) and fixes the folder's ownership itself.
   - **Timezone:** Unraid passes its timezone in automatically.
3. **Open the WebUI** and go to **Accounts → Connect**.

The container needs nothing else: no setup scripts, no extra packages, no database server. It has a built-in healthcheck and shuts down cleanly when stopped. If you run it with host networking and 7720 is taken, it moves to the next free port and logs the URL.

> The image is published to GHCR by the CI workflow on every push to `main`. The first time, go to the package settings on GitHub (**Packages → playtracker → Package settings**) and set its visibility to **Public** so Unraid can pull it without logging in.

### Docker

```bash
docker run -d --name playtracker -p 7720:7720 --restart unless-stopped \
  -v /path/to/appdata/playtracker:/data \
  -e TZ=America/New_York \
  ghcr.io/cmgfender/playtracker:latest
```

There's also a [`docker-compose.yml`](docker-compose.yml).

### Try it without accounts

```bash
npm run demo -- ./data/playtracker.db && npm start
```

## Connecting platforms

| Platform | What you need | Notes |
|---|---|---|
| **Steam** | A [Web API key](https://steamcommunity.com/dev/apikey) and your SteamID64, vanity name or profile URL | Profile → Privacy → *Game details* must be **Public**. Reports lifetime minutes, last-2-weeks minutes and the last played time. |
| **PlayStation** | An NPSSO token: sign in on playstation.com, then open `https://ca.account.sony.com/api/v1/ssocookie` | It's exchanged for a refresh token, which lasts about 2 months; re-enter the NPSSO when it expires. Covers PS4 and PS5 titles with play duration and first/last played times. |
| **Xbox** | An [OpenXBL](https://xbl.io) API key (sign in with your Microsoft account) | Reads title history and the `MinutesPlayed` stat for each title. Only titles whose last-played time changed are looked up again, which keeps you under OpenXBL's free rate limits. A large first import can take a couple of syncs. |
| **Custom** | Nothing | Push lifetime totals to `POST /api/v1/accounts/:id/report`. They are compared with the previous report exactly like a platform sync. |

> **Sync frequency vs precision:** you can only see what happened between two snapshots. Daily syncs (the default) give per-day sessions. Hourly syncs give near-exact sessions plus time-of-day stats. Weekly or monthly syncs still work: the minutes are spread across the window, and Steam's 2-week counter or the platform's last-played time narrows it down when available. Each account can override the global schedule.

## Smart handling of your existing playtime

Importing a library with 3,000 hours would normally make "today" look like a 3,000-hour day. PlayTracker never records pre-tracking time as play. Instead it **dates** it from everything the platforms report:

- **PlayStation:** first played, last played, launch count and trophy earned times.
- **Steam:** last played, the 2-week counter, achievement unlock times, and purchase dates pasted from your licenses page.
- **Xbox:** last played, achievement unlock times, and screenshot / game clip dates.
- **Bounds:** release dates, account creation date, and dates added from CSV imports.

It then spreads the time over that period:
- **Your own play pattern.** Once a few games have been tracked from first session to last, PlayTracker learns how *you* spread play over a game (an early binge, steady evenings, a long tail) and dates history the same way, using your most similar games. Until then it uses a default shape: a burst after starting a game, a taper, and a bump near the last session.
- Each game is capped at 10 hours a day.
- All games together are capped at 12 hours a day, shared across the whole library.

The result:

- **Charts and year-in-review** show this **estimated history** hatched, with a confidence of high, medium or low per game. Toggle it on the Stats page.
- **Today, this week, streaks, session counts and averages** only ever use **tracked** play.
- **Time that can't be dated** stays as undated history (lifetime totals only).
- **Corrections:** the **Improve history** page lists the least certain games first. Answer "mostly played in 2023, Apr–Jun" with two taps per game, or choose "Don't chart". It also shows how much of your history is solidly dated, and takes the Steam licenses paste. Exact dates can be set on a game's page.

Each platform also *reports* history differently:
- Steam writes totals when a game closes and stamps last-played at **launch**.
- PlayStation reports about 15 minutes late, with launch counts.
- Xbox flushes minutes **during** play.

These differences are declared as per-platform **history models** that drive the sync engine. Presence observations **self-calibrate** them. They are verified by a ground-truth simulator: totals are exact in every scenario, and with presence fewer than 0.3% of minutes land on the wrong day.

Every platform's advantages and limits, and exactly how each is used, are documented in **[docs/PLATFORMS.md](docs/PLATFORMS.md)**. The same information is shown in the app under Accounts → "What each platform reports".

## How sessions are computed

```
sync N-1: Hades = 6 000 min      sync N: Hades = 6 090 min
→ session: 90 min, window [sync N-1, sync N], ended ≈ last_played_at
```

1. **First time a game is seen during an account's first sync:** its lifetime total becomes **history**, dated as described above. It is never recorded as play.
2. **A new game shows up in a later sync:**
   - If its playtime fits in the time since the last sync (and PSN doesn't say it was first played earlier), all of it is a session.
   - Otherwise, Steam's 2-week counter decides how much is new, and the rest is history.
3. **Turning a delta into sessions:**
   - **Presence spans:** exact sessions.
   - **PSN launch-count increase:** that many sessions.
   - **Up to 6 hours with a last-played time:** one session pinned to it.
   - **Larger deltas over multi-day windows:** spread over the days.
   - **Steam:** the session is tagged with the device (Deck, Windows…).
4. **Deltas smaller than "minimum session" (default 2 min)** are held back and build up until they're big enough.
5. **Deltas larger than the elapsed time** (offline play or platform back-fill) are capped at the elapsed time. The excess goes to undated history.
6. **Playtime that goes down** (refunds, resets) updates the total but creates no session.

Synced sessions can be moved to history: delete them, or untick "count in stats". Lifetime totals always come from the platform, so they never change. Manual and imported sessions can be fully edited or deleted.

## Importing history

Go to **Settings → Import** and upload a CSV or JSON file (or `POST /api/v1/import`).

```csv
title,platform,playtime_hours,last_played,status,rating
Hades,switch,42,2025-11-02,completed,10
Celeste,import,12.5,,beaten,
```

Optional columns `first_played`, `date_added` and `play_count` help date the hours (see *Smart handling of your existing playtime*).

JSON can include individual sessions, which are tracked as real sessions:
```json
{ "games": [ { "title": "Zelda: TotK", "platform": "switch", "playtime_minutes": 9000,
  "sessions": [ { "date": "2026-03-01", "minutes": 120 } ] } ] }
```

Totals not covered by sessions are filed as history and dated from those columns. Re-importing the same file is safe: it is idempotent. If the same games are also on a synced account, the **Duplicates** page flags them so they aren't counted twice.

## API

Create a token under **Settings → API tokens**. Browse the docs in the app at `/api`, or read the raw OpenAPI spec at `/api/openapi.json`.

```bash
# dashboard numbers
curl -H "Authorization: Bearer pt_…" http://host:7720/api/v1/widget

# push totals for a custom account
curl -X POST http://host:7720/api/v1/accounts/4/report -H "Authorization: Bearer pt_…" \
  -H "Content-Type: application/json" \
  -d '{"games":[{"id":"totk","title":"Zelda: TotK","playtime_minutes":5230}]}'

# log a session
curl -X POST http://host:7720/api/v1/sessions -H "Authorization: Bearer pt_…" \
  -H "Content-Type: application/json" -d '{"game_id":12,"minutes":45,"note":"Chapter 3"}'

# trigger a sync and wait for the result
curl -X POST "http://host:7720/api/v1/accounts/1/sync?wait=true" -H "Authorization: Bearer pt_…"
```

Main endpoints:
- **Library:** `games`, `games/:id`, `games/:id/merge`, `entries/:id` (exclude, split, move, push playtime)
- **Sessions and stats:** `sessions` (list, create, edit, bulk), `stats`, `stats/heatmap`, `stats/year/:year`
- **Duplicates:** `duplicates`
- **Accounts and syncing:** `accounts`, `accounts/:id/sync`, `accounts/:id/report`, `syncs`
- **Admin:** `settings`, `tokens`, `import`, `export`, `backup`

## Logging, errors & diagnostics

- **Console output:** stdout/stderr, which is what `docker logs` and Unraid's log viewer show. Timestamped, levelled and tagged by source (`sync`, `presence`, `api`, `rollup`).
- **Error log:** warnings and errors are also stored in the database for 30 days. Browse, filter and expand stack traces on the **System** page, or call `GET /api/v1/logs`. The sidebar badge shows errors from the last 24 hours, and the dashboard warns about them.
- **System page / `GET /api/v1/system`:** health at a glance.
  - **Per account:** last sync and its duration, failures in the last 7 days, and API calls this hour and in the last 24 hours, against the rate limit.
  - **Presence:** status of the live "currently playing" checks.
  - **History dating:** how many titles are still queued for background lookups.
  - **Server:** request and failure counts, slow requests, and database size.
  - **Console:** recent console output.
  - **Diagnostics download:** a JSON bundle to attach to bug reports.
- **Sync history:** every sync records its API calls, rate-limit hits, warnings, duration and errors.
- **Crashes:** uncaught exceptions are logged before exiting, so the container restarts cleanly. Unhandled promise rejections are logged, not fatal.
- **Webhooks** can be set to fire on errors only. Prometheus metrics are at `/metrics`.

| Variable | Default | |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `LOG_FORMAT` | text | Set to `json` for structured logs (Loki or ELK) |
| `PLAYTRACKER_LOG_FILE` | | Also write to a rotating file (5 MB × 2), e.g. `/data/playtracker.log` |
| `LOG_REQUESTS` | `false` | Log every API request. Requests over 3 s are always logged as slow. |

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `7720` | HTTP port |
| `TZ` | `UTC` | Timezone for daily buckets and scheduled sync times |
| `PLAYTRACKER_DATA` | `/data` | Where `playtracker.db` lives |
| `PLAYTRACKER_DB` | | Full path to the database file instead (overrides `PLAYTRACKER_DATA`) |
| `PLAYTRACKER_PASSWORD` | | Password for the UI and API. You can also set one in Settings. With no password, access is open (fine on a trusted LAN). |
| `PLAYTRACKER_SECURE_COOKIE` | `false` | Set to `true` when served over HTTPS |
| `PLAYTRACKER_CORS_ORIGIN` | | Lets another origin call the API from a browser |
| `PUID` / `PGID` | `99` / `100` | User and group the container runs as. It starts as root, fixes `/data` ownership, then drops to this user. |
| `PLAYTRACKER_PORT_FALLBACK` | `true` | With host networking, move to the next free port if the chosen one is taken |

Everything else (schedule, detection thresholds, webhook, theme) lives in **Settings**.

## Big libraries

PlayTracker is built for libraries with tens of thousands of games and years of hourly syncs:

- **Pre-aggregated stats:** every session's minutes are split into per-day and per-hour rollup rows when the session is written. Database triggers queue every change, so edits, merges, exclusions and deletes stay consistent. Stats, charts, streaks, heatmaps and the library are then served from covering indexes, never by scanning raw sessions.
- **Paging:** the library pages from the server with infinite scroll. Sessions use keyset paging (`?before=<next>`), so page 1000 is as fast as page 1.
- **Caching:** results are cached until the next write.
- **Streaming:** exports stream, and imports take bodies up to 256 MB.
- **Duplicate detection** compares each title with its neighbours in sorted order (O(n), not O(n²)).

`npm run bench -- 20000 500000` seeds 20k games across three accounts plus 500k sessions, then times the API. Typical results on a small VM:

| Endpoint | Cold | Cached |
|---|---|---|
| Dashboard `/summary` | ~0.4 s | ~45 ms |
| Library page (any sort/offset) | 30–60 ms | |
| Stats, 30 days / 12 months / all time | 0.1 / 0.2 / 1 s | ~5 ms |
| Sessions page | ~60 ms | |
| Follow-up sync of a 20k-game account | ~0.4 s | |
| Streamed export of everything (79 MB) | ~5 s | |

On upgrade, or if the container's `TZ` changes, the rollups are rebuilt once at startup. That takes about 10 s per 500k sessions.

## Development

```bash
npm start          # http://localhost:7720 (data in ./data)
npm run dev        # restart on change
npm test           # node:test suite: engine, platform simulations, 6-month long run, imports, API, plus test/suite
                   # (its browser UI tests need Playwright + Chromium and are skipped without them)
LONGRUN_REPORT=1 LONGRUN_TZ=Europe/London node --test test/longrun.test.js   # print accuracy figures
```

The app is plain Node 22 with no dependencies and no build step:
- `src/services/sync.js` is the session engine.
- `src/providers/*` contains the Steam, Xbox and PSN clients.
- `public/` holds the vanilla-JS single-page app.

## License

MIT
