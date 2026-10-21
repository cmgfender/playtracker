# Platform APIs: what they give, what they don't, and how PlayTracker uses them

None of the platforms expose a play-session history. They only report **lifetime totals** plus a few timestamps. PlayTracker gets as much out of each API as it can. The table below shows which signals each platform provides and what PlayTracker does with them.

| Signal | Steam | PlayStation | Xbox (OpenXBL) | Custom / API push | Used for |
|---|---|---|---|---|---|
| Lifetime minutes per game | ✅ `playtime_forever` | ✅ `playDuration` | ✅ `MinutesPlayed` stat (1 request per title) | ✅ | Deltas between syncs → sessions |
| Last played time | ✅ `rtime_last_played` | ✅ `lastPlayedDateTime` | ✅ `titleHistory.lastTimePlayed` | optional | Pins the end of a session; upper bound for history |
| First played time | ❌ | ✅ `firstPlayedDateTime` | ❌ | optional | Lower bound for history (high confidence) |
| Launch count | ❌ | ✅ `playCount` | ❌ | optional | Splits one sync's delta into *n* sessions; shapes history |
| Recent minutes | ✅ `playtime_2weeks` | ❌ | ❌ | optional (`recent_minutes`) | Exact minutes in the last 14 days on import; narrows weekly/monthly windows |
| Per-device minutes | ✅ Windows / Mac / Linux / **Steam Deck** / offline | category (PS4 / PS5 / PC) | device list only | optional | Tags each session with the device it was played on; flags offline play |
| Live "currently playing" | ✅ `GetPlayerSummaries.gameid` | ✅ `basicPresences` | ✅ `/presence` | ✅ `POST /accounts/:id/presence` | Exact session start/end; triggers a sync when you stop playing |
| Activity timestamps | ✅ achievement unlock times | (not needed: first/last played) | ✅ achievement unlock times | — | Dates pre-tracking history |
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

**Limits:**
- **Web API:** 100,000 calls a day per key.
- **Store API:** about 200 requests per 5 minutes.
- **Retries:** 429 and 5xx responses are retried, and `Retry-After` is respected.

**Limitations:**
- **No session history and no purchase date.** The API only returns lifetime totals.
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
- **Launch-count deltas** split a sync window into the right number of sessions.

**Limits:** undocumented, roughly 300 requests per 15 minutes. A sync is cheap: 1 request per 200 titles.

**Limitations:**
- **PS4 and PS5 only**, plus PC titles that use PSN. No PS3, Vita or PSP.
- **Private API:** it can change without notice. Responses are parsed defensively.
- **Lag:** `playDuration` can trail the end of a session by several minutes.
- **Cloud streaming** may not be counted.
- **Never-launched games** don't appear.

## Xbox (OpenXBL)

Microsoft has no public consumer API, so PlayTracker uses [OpenXBL](https://xbl.io).

**Calls per sync:**
- 1 call to `player/titleHistory`, which gives the title list and last played times.
- 1 call to `achievements/stats/{titleId}` per title **whose last-played time changed**. Unchanged titles reuse the stored value.
- Titles are checked most recently played first.

**Hourly budget:**
- Every request is counted per account, per hour (shown on the System page).
- Syncs, presence and enrichment share the plan's limit: **150 requests an hour on the free plan**. Set your plan's limit on the account if it's different.
- Syncs keep 15% of the budget in reserve.
- Presence checks every 5 minutes (12 requests an hour) and pauses when the budget runs low.
- Enrichment, which reads achievement unlock times from `achievements/player/{xuid}/{titleId}`, only uses budget while more than 30% is left.

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

## How a sync delta becomes sessions

Steps 1–4 are tried in order; step 5 is applied to whatever delta was accepted.

1. **Presence spans** observed in the sync window become **exact** sessions. A delta is split across several spans by their length.
2. **Launch count increased by *n*** (PSN): the delta becomes *n* sessions, and the last one is pinned to the last-played time.
3. **Delta of 6 hours or less, with a last-played time:** one continuous session ending at last played (**pinned**).
4. **Large delta over a multi-day window:** spread over the days of the window, weighted toward the last-played day and capped per day (**window**). It is never one giant block.
5. **Sanity checks:**
   - Deltas larger than the real time elapsed are clamped, and the rest goes to undated history.
   - Deltas under the minimum session length build up until they're big enough.
   - Playtime that goes down (refunds, resets) is followed without creating a session.

## How pre-tracking history is dated (no import-day spikes)

When a game is first seen with existing playtime, that time is history, not play. It is dated from the evidence above (implemented in `src/services/inference.js`):

1. **Window:**
   - **End:** last played. It never extends past last played or past the start of tracking.
   - **Start:** first played, else the first achievement, else the date added. If none is known, the start is estimated from a plausible pace of play.
   - **Lower bounds:** release date and account creation date.
2. **Shape:**
   - Play is assumed to be intense after starting a game and to taper off, with a bump near the last session.
   - Achievement unlock days get extra weight.
   - With Steam's 2-week counter, those minutes go exactly into the last 14 days.
3. **Realistic days:**
   - Each game is capped at 10 hours a day.
   - All games together are capped at **12 hours a day**, and the budget is shared across the whole library. Games with the best evidence are placed first, so a 2,000-game import never stacks 40 hours onto one Saturday.
   - Days with only a few minutes are folded into busier ones.
4. **Result:**
   - Stored as **estimated** sessions with a confidence of high, medium or low.
   - **In charts:** included, drawn hatched.
   - **Never counted in:** streaks, today, this week, session counts or averages.
   - **Undatable time:** kept as undated history, which counts toward lifetime totals only.
5. **Re-dating:**
   - **Automatic:** whenever new evidence arrives (achievements or release dates from background enrichment).
   - **Manual:** on the game page, set the dates you played it, or choose "Don't chart".
   - **Everything at once:** from the System page.
