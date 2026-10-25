# Platform APIs: what they give, what they don't, and how Vestigo uses them

None of the platforms expose a play-session history. They only report **lifetime totals** plus a few timestamps. Vestigo gets as much out of each API as it can. The table below shows which signals each platform provides and what Vestigo does with them.

| Signal | Steam | PlayStation | Xbox (OpenXBL) | Custom / API push | Used for |
|---|---|---|---|---|---|
| Lifetime minutes per game | ✅ `playtime_forever` | ✅ `playDuration` | ✅ `MinutesPlayed` stat (1 request per title) | ✅ | Deltas between syncs → sessions |
| Last played time | ✅ `rtime_last_played` | ✅ `lastPlayedDateTime` | ✅ `titleHistory.lastTimePlayed` | optional | Pins the end of a session; upper bound for history |
| First played time | ❌ | ✅ `firstPlayedDateTime` | ❌ | optional | Lower bound for history (high confidence) |
| Launch count | ❌ | ✅ `playCount` | ❌ | optional | Splits one sync's delta into *n* sessions; shapes history |
| Recent minutes | ✅ `playtime_2weeks` | ❌ | ❌ | optional (`recent_minutes`) | Exact minutes in the last 14 days on import; narrows weekly/monthly windows |
| Per-device minutes | ✅ Windows / Mac / Linux / **Steam Deck** / offline | category (PS4 / PS5 / PC) | device list only | optional | Tags each session with the device it was played on; flags offline play |
| Live "currently playing" | ✅ `GetPlayerSummaries.gameid` | ✅ `basicPresences` | ✅ `/presence` | ✅ `POST /accounts/:id/presence` | Exact session start/end; triggers a sync when you stop playing |
| Activity timestamps | ✅ achievement unlock times; purchase dates via the pasted licenses page | ✅ trophy earned times (plus first/last played) | ✅ achievement unlock times; screenshot / clip dates | — | Dates pre-tracking history |
| Achievements / trophies | ✅ names, icons, hidden flag, rarity | ✅ names, icons, grade, rarity, DLC groups | ✅ names, icons, gamerscore, rarity (modern + Xbox 360) | — | Kept per game, attached to sessions by time, achievement stats |
| Release date | ✅ store `appdetails` | — | — | — | History can't start before release |
| Account creation date | ✅ `timecreated` | — | — | — | History can't start before the account existed |
| Date added / purchased | ❌ | ❌ | ❌ | ✅ `date_added` (CSV/JSON) | Lower bound for history |

## Steam (official Web API)

**Calls per sync:**
- **Owned games:** 1 call to `IPlayerService/GetOwnedGames` for your whole library.
- **Profile:** 1 call to `ISteamUser/GetPlayerSummaries`, at most once a week. It gives your account creation date, persona name and privacy state.

**Presence:**
- `GetPlayerSummaries` is checked every 2 minutes (720 calls a day).
- When you stop playing, a sync runs **90 seconds later**. Steam writes playtime when a game exits, so the session is recorded with exact start and end times.

**Enrichment (runs once per game in the background, after the first import):**
- `ISteamUserStats/GetPlayerAchievements` returns the unlock time of every achievement. These are real timestamps of when you were playing, and they anchor the history estimate. Calls are spaced 250 ms apart.
- The store `appdetails` endpoint returns the release date. Calls are spaced 1.6 s apart, which is within the store's limit of about 200 requests per 5 minutes.
- Games with the most pre-tracking hours are processed first, up to 400 games per run. Runs continue until every game is done.
- The achievements themselves are kept too: `GetPlayerAchievements` is asked with `l=english` (names, descriptions), `GetSchemaForGame` adds icons and the hidden flag (once per app, cached for a day, skipped once stored), and `GetGlobalAchievementPercentagesForApp` the rarity (no key, cached per app for a day). Games without stats answer errors or empty lists and simply have none.

**Limits:**
- **Web API:** 100,000 calls a day per key.
- **Store API:** about 200 requests per 5 minutes.
- **Retries:** 429 and 5xx responses are retried, and `Retry-After` is respected.

**Limitations:**
- **No session history and no purchase date.** The API only returns lifetime totals. The purchase date is on your [licenses page](https://store.steampowered.com/account/licenses/), which the API can't read: copy the table and paste it on **Improve history** (`POST /api/v1/accounts/:id/licenses`). Products are matched to games by title (editions included; soundtracks, DLC and bundles are skipped), and the earliest date becomes the start of that game's history window. English month names are parsed.
- **Playtime is written when the game exits.** A game left running shows up on the sync after it closes.
- **Offline play** is reported when the client reconnects. It's tracked through `playtime_disconnected`, and sessions are tagged "includes offline play". If the delta is larger than the real time since the last sync, the excess is filed as undated history instead of an impossible session.
- **Privacy:** your profile and "Game details" must be **Public**. Presence also needs a public profile; private profiles get a clear warning.
- **Family Sharing:** borrowed games and non-Steam shortcuts are not reported.

## PlayStation (PlayStation App private API)

**Calls per sync:** about 1 request per 200 titles to `gamelist/v2/users/me/titles`. Each title includes `playDuration`, `firstPlayedDateTime`, `lastPlayedDateTime` and `playCount`.

**Authentication:**
- The NPSSO token is exchanged for an access token and a refresh token.
- Access tokens refresh automatically. The refresh token lasts about 2 months, after which you paste a new NPSSO.
- The PSN account id is read from the token for presence lookups.

**Presence:**
- `userProfile/v1/internal/users/{id}/basicPresences` is checked every 3 minutes.
- When a session ends, a sync runs **15 minutes** later, because Sony's `playDuration` lags.

**Advantages:**
- **The best data of any platform.** First and last played plus launch count date your history with **high confidence**.
- **Trophy earned times** fill in when play happened between first and last played. Background enrichment maps each title to its trophy set(s) (`trophy/v1/users/me/titles/trophyTitles?npTitleIds=`, 5 titles per request), then reads earned trophies per set (`npServiceName=trophy2` for PS5, `trophy` for PS4). Calls are spaced 3.2 s apart, at most 120 per run, with 15 minutes between runs, to stay well inside Sony's limits.
- **Trophies are kept:** the earned list gives each trophy's grade and the share of players who have it; the set's own list (`trophy/v1/npCommunicationIds/{id}/trophyGroups/all/trophies`, one more request per set) gives names, details, icons and DLC groups. It is read again only when a trophy it doesn't know appears. After you play a title, its earned trophies are read again (the title's trophy sets are remembered for a day, so that is usually 1 request). The platinum counts as completing the game.
- **Launch-count deltas** split a sync window into the right number of sessions.

**Limits:** undocumented, roughly 300 requests per 15 minutes. A sync is cheap: 1 request per 200 titles.

**Limitations:**
- **PS4 and PS5 only**, plus PC titles that use PSN. No PS3, Vita or PSP.
- **Private API:** it can change without notice. Responses are parsed defensively.
- **Lag:** `playDuration` can trail the end of a session by several minutes.
- **Cloud streaming** may not be counted.
- **Never-launched games** don't appear.

## Xbox (OpenXBL)

Microsoft has no public consumer API, so Vestigo uses [OpenXBL](https://xbl.io).

**Calls per sync:**
- 1 call to `player/titleHistory`, which gives the title list and last played times.
- 1 call to `achievements/stats/{titleId}` per title **whose last-played time changed**. Unchanged titles reuse the stored value.
- **Titles with no `MinutesPlayed` stat** (many PC / Game Pass games) report no playtime at all, so there is nothing to subtract:
  - Each finished live-presence span becomes an exact session and is added to the title's total.
  - If presence missed a session (quota pause, container down, presence off) but the title's last-played time moved, one session is recorded ending at that time. It is as long as your typical session, capped by the time since the previous play, and marked "≈ length".
  - These titles are rechecked weekly. If the stat appears, its first value is filed as history minus what was already tracked, so nothing is counted twice.
- Enrichment also reads `dvr/screenshots` and `dvr/gameclips` (2 requests per run). Capture dates are moments of real play and anchor history like achievements do. Only captures still stored by Xbox are returned, so this mostly helps recent history.
- Titles are checked most recently played first.

**Hourly budget:**
- Every request is counted per account, per hour (shown on the System page).
- Syncs, presence and enrichment share the plan's limit: **150 requests an hour on the free plan**. Set your plan's limit on the account if it's different.
- Syncs keep 15% of the budget in reserve.
- Presence checks every 5 minutes (12 requests an hour) and pauses when the budget runs low.
- Enrichment, which reads achievement unlock times from `achievements/player/{xuid}/{titleId}`, only uses budget while more than 30% is left. The same reply carries the achievements (names, icons, gamerscore, rarity; Xbox 360 titles too), so keeping them costs nothing extra.
- A title played since its achievements were read is read again after the sync (1 request, at most 5 titles per run), also only above that 30% reserve.
- Titles read before achievements were kept are back-filled once: at most a quarter of the hourly limit per clock hour, never into the reserve, so presence and syncs always have room.

**Large first import:**
- Titles that don't fit in the hour's budget are **deferred** to the next sync.
- Their time is filed as history, not as new play.
- The sync result shows a warning with how many titles were deferred.

**Limitations:**
- **Third-party service:** endpoint shapes aren't officially documented and are parsed defensively. The Xbox Home and dashboard title ids are ignored.
- **Missing playtime:** some titles (apps, some backward-compatible Xbox 360 games) have no `MinutesPlayed` stat.
- **Lag:** the stat can trail the end of a session by several minutes, so the post-session sync runs after **10 minutes**.

## Custom accounts / API push

Use these for Switch spreadsheets, Playnite, emulators, Epic, GOG and so on. Push lifetime totals to `POST /api/v1/accounts/:id/report`. Optional fields:
- `last_played_at`
- `first_played_at`
- `date_added`
- `play_count`
- `recent_minutes` and `recent_days`
- `device`

Reports are compared with the previous one exactly like platform syncs. To get exact session times, send presence to `POST /api/v1/accounts/:id/presence` (for example from a Home Assistant automation).

## History models: each platform's reporting semantics, built into the design

The platforms don't just expose different fields. They **report history in functionally different ways**, and those differences decide what a change in the totals means. Each provider declares a `profile.history` (see `src/providers/*.js`). The sync engine interprets every report through that profile (`src/services/model.js`), so there are no platform `if`s in the engine.

| Property | Steam | PlayStation | Xbox | Custom | Why it matters |
|---|---|---|---|---|---|
| `update`: when totals change | `on-exit` | `delayed` (15 min) | `periodic` (10 min lag) | `on-report` | Determines which real-time window a delta covers. Also whether a running session is already in the total. |
| `last_played`: what the timestamp marks | **start** (launch) | end | end (latest activity) | configurable | Sessions are pinned from the start on Steam and from the end elsewhere. Pinning Steam by the end would shift every session by its own length. |
| `recent`: rolling counter | 14 days (strict) | – | – | optional | Minutes beyond the counter can't be recent, so they were offline play uploaded late. The counter also narrows weekly and monthly windows. |
| `play_count`: launches | – | ✅ | – | optional | A delta with *n* new launches becomes *n* sessions. |
| `first_played` | – | ✅ | – | optional | Gives history a hard start date. |
| `devices`, `offline_counter` | Win/Mac/Linux/Deck, offline | – | – | optional | Tags each session's device and flags late-uploaded offline play. |
| `single_title`: one game at a time | ✅ | ✅ | ✅ | – | A later launch of any game caps the previous session. |
| `grouping` | – | concept id | – | – | PS4 and PS5 versions are one game. |
| `complete_library` | ✅ | ✅ | unless titles were deferred | – | A title missing from a complete report is marked "no longer in library". |

### Rules derived from the models

Steps 1–7 are tried in order; steps 8–11 are checks that apply throughout.

1. **Window:** a report at time *t* describes play up to *t − lag*. A delta between reports at *t₁* and *t₂* therefore covers *(t₁ − lag, t₂ − lag]*.
2. **Capacity:** on-exit and delayed platforms deliver a whole session at once, even if it started before the window. A delta may therefore exceed the time since the last sync by up to one maximum-length session without being called "late".
3. **Presence spans:**
   - Spans become **exact** sessions. Presence is ground truth for when a session ran.
   - On on-exit and delayed platforms, only spans that ended at least *lag* ago are used. Periodic platforms (Xbox) can use running spans, and a later report extends the *same* session.
   - Every recorded session **claims** the spans it covers, so a span is never used twice.
   - A pinned session confirmed by a span is upgraded to exact.
4. **Launch counter** (PSN): a delta with *n* new launches becomes *n* sessions, and the last one is pinned.
5. **Continuation** (periodic platforms): a delta that touches a session cut off by the previous report extends that session.
6. **Pinning by last played** (start or end, per the model):
   - **Steam's launch time only proves when the *last* session started.** If the delta doesn't fit after it, or is longer than the player's long sessions, a typical-length session is placed at the launch and the rest just before it.
   - Xbox and PSN get the mirror rule around the end time.
   - **Typical lengths are learned** from the player's own exactly observed sessions. Defaults: 120 min median, 240 min long.
7. **Large deltas over multi-day windows:** spread across the days, weighted toward the last activity, capped per day. Integer minutes are allocated exactly, so no minute is ever lost to rounding.
8. **Self-repair:** if a new delta pins to a launch time that was already used, the earlier pin was a session still running at that report. It is moved to before the launch.
9. **Strict recent counter** (Steam): minutes beyond `playtime_2weeks` are offline play uploaded late. They become undated history instead of being crammed into the window.
10. **Calibration:** whenever presence shows exactly when a session ran, the account checks whether the platform's last-played timestamp sat at that session's start or end. After 3+ observations agreeing ≥75%, the learned meaning overrides the declared one for that account. If a platform changes its behaviour, Vestigo follows it.
11. **Totals never go down:** a total lower than before is ignored. It is almost always a glitch (an empty stat, a bad report) that comes back later, so the total keeps its high-water mark and only play above it is new. Nothing is counted twice when it recovers.

### Measured accuracy (ground-truth simulation)

`test/simulation.test.js` generates random play histories:
- evenings, with sessions crossing midnight
- repeat sessions of the same game
- long sessions
- sessions still running at sync time

A simulated platform then reports each history exactly the way the real one does, and the real engine processes the reports. Results over 24 random 3-week histories per scenario:

| Scenario | Tracked minutes | Sessions | Minutes on the wrong day (avg / worst) |
|---|---|---|---|
| Steam, daily sync + presence | exact | 1:1 with real sessions, exact times | 0.06% / 0.11% |
| PlayStation, daily + presence | exact | 1:1, exact | 0.10% / 0.20% |
| Xbox, hourly + presence (long sessions split across reports) | exact | 1:1, exact | 0.16% / 0.28% |
| PlayStation, daily, no presence | exact | 1:1 (launch counter) | 0.5% / 3% |
| Xbox, daily, no presence | exact | close | 1.7% / 6.5% |
| Steam, daily, no presence | exact | close; launch times exact | 3.7% / ~10% |
| Steam, weekly, no presence | exact | – | ~33% (a weekly total carries no day-level information) |

Across all runs:
- Totals are exact.
- No session overlaps another or lies in the future.
- Calibration learns "start" for Steam and "end" for PlayStation.
- A deliberately mis-declared model is corrected by calibration.

### Long-run verification (6 months, all imports, one database)

`test/longrun.test.js` covers half a year of play in one database. It runs in New York by default, crossing both DST changes, and is repeated in UTC, London, Tokyo and Auckland. The scenario includes:

- **Steam:** an initial import with 400 days of prior history, including legacy titles that report no timestamps.
- **CSV:** a Switch spreadsheet with first/last played dates and launch counts, plus a row duplicating a Steam game.
- **JSON:** an import with explicit sessions, imported twice.
- **PlayStation:** connected two months in, so part of its history overlaps months already tracked.
- **Xbox:** connected three months in. Titles deferred by the hourly budget arrive an hour later as back-fill.
- **Steam during the run:**
  - a game bought and played the same evening
  - offline play uploaded 25 days later
  - a refund
- **Manual sessions** logged through the API.
- **An export, then an import into a fresh instance.**

The checks are exact:
- **Per title:** every title's sessions (tracked + dated history + undated) add up to the platform's total.
- **Rollups:** they equal the sessions, with nothing pending.
- **History vs tracked:** each account's history equals what it reported when connected. Its tracked play equals everything after that.
- **Late uploads:** offline play uploaded late is identified exactly as late.
- **Agreement:** the stats API, year in review, heatmap and lifetime totals all agree with the database.
- **Duplicates:** the duplicated spreadsheet row is flagged, and excluding it makes the lifetime total equal the true total.
- **Round trip:** export → import preserves lifetime totals, tracked minutes, exclusions, hidden games, cover art, first-played / date-added dates and your history choices (Don't chart, a first-played window, a confirmed estimate - its exact days in JSON, its window in CSV). A choice you already made here is never replaced by a file's.

Accuracy over those 6 months:

| | Steam | PlayStation | Xbox (no presence) |
|---|---|---|---|
| Tracked minutes on the wrong day | 0.04% | 0.04% | 0.02% |
| Pre-tracking history in the wrong **month** | 23% | 14% | 27% |
| … with the learned play style (only 4 fully tracked games) | 23%¹ | 12% | 27%¹ |
| … plus the pasted licenses page | 12% | | |
| … plus achievement times | 9.6% | | |
| Switch spreadsheet history in the wrong month (first/last dates) | | | 26% → 24% with the learned style |
| Busiest day of estimated history (all games) | ≤ 9.4 h (cap 12 h) | | |

¹ When only last played is known, the learned style is used only once 20+ games are behind it. With a handful of games, a start-less guess did more harm than good in testing.

#### Learning the player's style

The biggest error left after the evidence is used up is *how* a player spreads a game's hours, which differs a lot between people. So Vestigo learns it from the player's own data (`learnStyle` / `learnStyleFromDb` in `inference.js`):

- **Teachers:** games tracked from their very first session (no pre-tracking time) that have gone quiet for 30 days, plus history entries with 8+ achievement/trophy times. Each is kept as a compact signature: total minutes, span, the share of minutes in each twentieth of its life, and the share by days before its last session.
- **Use:** a game is dated like the k = 8 most similar teachers (by size, and by span when the start is known), blended with the default shape by evidence: weight = games / (games + 5).
- **Updates:** relearned after syncs (at most every 10 minutes), enrichment, imports and the licenses paste. When the style shifts by 20%+ (or is learned for the first time), all history is re-dated. Settings → "Learn my play pattern" turns it off.

Measured on simulated players (history known from first/last played, month-level error), learning from 30 of the player's games:

| Player | Default shape | Learned style | Best possible² |
|---|---|---|---|
| Burst then taper | 26% | 21% | 17% |
| Steady sporadic play | 19% | 13% | 13% |
| Short binges | 24% | 11% | 12% |
| Mixed | 24% | 22% | |

² An oracle that knows the generator exactly and only has the same first/last dates.

The same work fixed a flaw in spreading: days that would get under 15 minutes used to be dropped and their minutes moved to the busiest days, which erased long low-intensity tails. They are now gathered into nearby days instead. The default shape (`SHAPE`) was re-tuned for that. Neither was tuned against the long-run scenario.

What remains is information the platforms simply don't provide. The clearest case is two Steam sessions of the same game between two daily syncs: only the later launch time is reported. **Enable live presence (the default) for exact sessions.** Without it, sync more often for better day placement.

Simulator assumptions, which the self-calibration and the logged sync details let you check against reality:
- PSN updates `playCount` together with `playDuration`.
- Xbox flushes `MinutesPlayed` in about 5-minute steps, with about a 10-minute lag.
- Steam stamps `rtime_last_played` at launch.

## How pre-tracking history is dated (no import-day spikes)

When a game is first seen with existing playtime, that time is history, not play. It is dated from the evidence above (implemented in `src/services/inference.js`):

1. **Window:**
   - **End:** last played. It never extends past last played or past the start of tracking.
   - **Start:** first played, else the first achievement/trophy/capture, else the date added (CSV, or the Steam licenses page). If none is known, the start is estimated from a plausible pace of play, or from how far back the player's similar games reach once 20+ are learned.
   - **Lower bounds:** release date and account creation date.
2. **Shape:**
   - The player's learned style when available (see above); otherwise play is assumed to be intense after starting a game and to taper off, with a bump near the last session.
   - Achievement unlock days get extra weight.
   - With Steam's 2-week counter, those minutes go exactly into the last 14 days.
3. **Realistic days:**
   - Each game is capped at 10 hours a day.
   - All games together are capped at **12 hours a day**, and the budget is shared across the whole library. Games with the best evidence are placed first, so a 2,000-game import never stacks 40 hours onto one Saturday.
   - Days with only a few minutes are gathered into nearby days, so quiet stretches keep their share.
4. **Result:**
   - Stored as **estimated** sessions with a confidence of high, medium or low.
   - **In charts:** included, drawn hatched.
   - **Never counted in:** streaks, today, this week, session counts or averages.
   - **Undatable time:** kept as undated history, which counts toward lifetime totals only.
5. **Re-dating:**
   - **Automatic:** whenever new evidence arrives (achievements or release dates from background enrichment).
   - **Manual:** the **Improve history** page ranks games by uncertain hours (low-confidence + undated, medium at half weight) and takes a year / quarter / month answer per game (`GET /api/v1/history/review`). Exact dates can be set on the game page, or choose "Don't chart".
   - **Everything at once:** from the System page.
