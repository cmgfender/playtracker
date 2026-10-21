# PlayTracker

A self-hosted game playtime and session tracker for Docker and Unraid. It's fast, mobile-friendly and has a full API.

Steam, Xbox and PlayStation tell you **how long you've played in total**, but not **when**. PlayTracker saves your lifetime playtime on a schedule (hourly, daily, weekly, monthly or every *X* days/hours). The difference between two snapshots becomes a **play session**.

- **Platforms:** Steam (Web API), Xbox (OpenXBL), PlayStation (NPSSO), plus **custom accounts** you push totals to over the API (Switch, Epic, GOG, emulators, Playnite…). You can also add games by hand and log sessions manually.
- **Session detection:**
  - Deltas between syncs become sessions.
  - When a platform reports a "last played" time (Steam, Xbox, PSN), the session is pinned to it.
  - When it doesn't, the minutes are spread across the sync window, so weekly or monthly syncs still give sensible daily charts.
  - Deltas below a threshold build up until they're big enough.
  - Impossible deltas (more playtime than wall-clock time since the last sync) are clamped.
- **Mass initial imports:** your existing hours are stored as **history (baseline)**. They count toward lifetime totals but never show up as a fake 500-hour session on day one.
  - Steam's "last 2 weeks" figure is turned into a real session on import.
  - Games that first appear later but were last played *before* the previous sync are also imported as history.
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

```bash
docker run -d --name playtracker -p 8080:8080 \
  -v /path/to/appdata/playtracker:/data \
  -e TZ=America/New_York \
  ghcr.io/cmgfender/playtracker:latest
```

Open `http://<host>:8080`, go to **Accounts → Connect** and pick a platform. The first sync imports your library.

To try it without credentials, seed a demo database:
```bash
node src/demo.js ./data/playtracker.db && npm start
```

### Unraid

The template is in [`unraid/playtracker.xml`](unraid/playtracker.xml). To use it:

1. Copy it to `/boot/config/plugins/dockerMan/templates-user/my-playtracker.xml`.
2. In the Unraid web UI, go to **Docker → Add Container** and select *playtracker*.

Data is stored in `/mnt/user/appdata/playtracker`, and the container runs as `99:100` by default.

### docker compose

See [`docker-compose.yml`](docker-compose.yml).

## Connecting platforms

| Platform | What you need | Notes |
|---|---|---|
| **Steam** | A [Web API key](https://steamcommunity.com/dev/apikey) and your SteamID64, vanity name or profile URL | Profile → Privacy → *Game details* must be **Public**. Reports lifetime minutes, last-2-weeks minutes and the last played time. |
| **PlayStation** | An NPSSO token: sign in on playstation.com, then open `https://ca.account.sony.com/api/v1/ssocookie` | It's exchanged for a refresh token, which lasts about 2 months; re-enter the NPSSO when it expires. Covers PS4 and PS5 titles with play duration and first/last played times. |
| **Xbox** | An [OpenXBL](https://xbl.io) API key (sign in with your Microsoft account) | Reads title history and the `MinutesPlayed` stat for each title. Only titles whose last-played time changed are looked up again, which keeps you under OpenXBL's free rate limits. A large first import can take a couple of syncs. |
| **Custom** | Nothing | Push lifetime totals to `POST /api/v1/accounts/:id/report`. They are compared with the previous report exactly like a platform sync. |

> **Sync frequency vs precision:** you can only see what happened between two snapshots. Daily syncs (the default) give per-day sessions. Hourly syncs give near-exact sessions plus time-of-day stats. Weekly or monthly syncs still work: the minutes are spread across the window, and Steam's 2-week counter or the platform's last-played time narrows it down when available. Each account can override the global schedule.

## How sessions are computed

```
sync N-1: Hades = 6 000 min      sync N: Hades = 6 090 min
→ session: 90 min, window [sync N-1, sync N], ended ≈ last_played_at
```

1. **First time a game is seen during an account's first sync:** its lifetime total is stored as *baseline* (history). Steam's `playtime_2weeks` is turned into a session within the last 14 days.
2. **A new game shows up in a later sync:**
   - If its playtime fits in the time since the last sync, all of it is a session.
   - If the platform says it was last played *before* that sync, the playtime is filed as baseline.
3. **Deltas smaller than "minimum session" (default 2 min)** are held back and build up until they're big enough.
4. **Deltas larger than the elapsed time** (plus a tolerance) are capped at the elapsed time. The excess goes to baseline.
5. **Playtime that goes down** (refunds, resets) updates the total but creates no session.

Synced sessions can be moved to history: delete them, or untick "count in stats". Lifetime totals always come from the platform, so they never change. Manual and imported sessions can be fully edited or deleted.

## Importing history

Go to **Settings → Import** and upload a CSV or JSON file (or `POST /api/v1/import`).

```csv
title,platform,playtime_hours,last_played,status,rating
Hades,switch,42,2025-11-02,completed,10
Celeste,import,12.5,,beaten,
```

JSON can include individual sessions, which are tracked as real sessions:
```json
{ "games": [ { "title": "Zelda: TotK", "platform": "switch", "playtime_minutes": 9000,
  "sessions": [ { "date": "2026-03-01", "minutes": 120 } ] } ] }
```

Totals not covered by sessions are filed as history. Re-importing the same file is safe: it is idempotent. If the same games are also on a synced account, the **Duplicates** page flags them so they aren't counted twice.

## API

Create a token under **Settings → API tokens**. Browse the docs in the app at `/api`, or read the raw OpenAPI spec at `/api/openapi.json`.

```bash
# dashboard numbers
curl -H "Authorization: Bearer pt_…" http://host:8080/api/v1/widget

# push totals for a custom account
curl -X POST http://host:8080/api/v1/accounts/4/report -H "Authorization: Bearer pt_…" \
  -H "Content-Type: application/json" \
  -d '{"games":[{"id":"totk","title":"Zelda: TotK","playtime_minutes":5230}]}'

# log a session
curl -X POST http://host:8080/api/v1/sessions -H "Authorization: Bearer pt_…" \
  -H "Content-Type: application/json" -d '{"game_id":12,"minutes":45,"note":"Chapter 3"}'

# trigger a sync and wait for the result
curl -X POST "http://host:8080/api/v1/accounts/1/sync?wait=true" -H "Authorization: Bearer pt_…"
```

Main endpoints:
- **Library:** `games`, `games/:id`, `games/:id/merge`, `entries/:id` (exclude, split, move, push playtime)
- **Sessions and stats:** `sessions` (list, create, edit, bulk), `stats`, `stats/heatmap`, `stats/year/:year`
- **Duplicates:** `duplicates`
- **Accounts and syncing:** `accounts`, `accounts/:id/sync`, `accounts/:id/report`, `syncs`
- **Admin:** `settings`, `tokens`, `import`, `export`, `backup`

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `TZ` | `UTC` | Timezone for daily buckets and scheduled sync times |
| `PLAYTRACKER_DATA` | `/data` | Where `playtracker.db` lives |
| `PLAYTRACKER_DB` | | Full path to the database file instead (overrides `PLAYTRACKER_DATA`) |
| `PLAYTRACKER_PASSWORD` | | Password for the UI and API. You can also set one in Settings. With no password, access is open (fine on a trusted LAN). |
| `PLAYTRACKER_SECURE_COOKIE` | `false` | Set to `true` when served over HTTPS |
| `PLAYTRACKER_CORS_ORIGIN` | | Lets another origin call the API from a browser |
| `PUID` / `PGID` | `99` / `100` | User and group the container runs as |

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
npm start          # http://localhost:8080 (data in ./data)
npm run dev        # restart on change
npm test           # node:test suite (sync engine, stats, duplicates, import, API)
```

The app is plain Node 22 with no dependencies and no build step:
- `src/services/sync.js` is the session engine.
- `src/providers/*` contains the Steam, Xbox and PSN clients.
- `public/` holds the vanilla-JS single-page app.

## License

MIT
