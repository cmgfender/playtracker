# Vestigo brand

**Vestigo** is Latin for "I track, I follow the trail". Platforms only report totals; Vestigo reads
the traces your play leaves behind and turns them into sessions.

- **Name:** "Vestigo" everywhere in the UI. "Vestigo Media Tracker" is the formal long name: the
  web app manifest name, the README title line, the OpenAPI description, and the Docker and Unraid
  descriptions.
- **Formerly PlayTracker.** Say so only where someone upgrading needs it (README, the legacy
  Unraid template, the Docker image description). Compatibility names stay as they are and are not
  branding: `PLAYTRACKER_*` variables, `playtracker.db`, the `pt_session` cookie, `pt_` tokens,
  `playtracker_*` metrics and the `"playtracker-export"` file format id.
- **Tagline:** "Every session leaves a trace."

## The mark

A **V drawn as a trail**: two dashes fading in on the left arm, a solid right arm, and a dot at the
point where the trail touches the ground. It is a V and a footprint trail at once.

On a 24 × 24 grid, stroked with `currentColor`, `stroke-width` 4.2, round caps:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linecap="round" aria-hidden="true">
  <path d="M4.06 4.16 5.53 7.01" opacity=".55"/>
  <path d="M7.96 11.72 9.43 14.56" opacity=".8"/>
  <path d="M14.57 14.56 16.04 11.72M18.47 7.01 19.94 4.16"/>
  <circle cx="12" cy="19.54" r="2.4" fill="currentColor" stroke="none"/>
</svg>
```

| Use | Geometry |
|---|---|
| App icon (`public/icon.svg`, `icon-192.png`, `icon-512.png`) | 512 tile, corner radius 116, brand gradient, white mark at 66% of the tile, centred |
| Favicon (16–32 px) | Same tile with the mark at 72% and **all segments solid**: the fading dashes vanish at that size |
| Maskable icon (`icon-maskable.svg`, `icon-maskable-512.png`) | Full bleed (no radius), mark at 55%, inside the 80% safe zone |
| Apple touch icon (`icon-180.png`) | Full bleed: iOS rounds the corners itself |
| In the UI | Mark on the brand tile next to the wordmark: sidebar 30 px tile (radius 9) with a 20 px mark; mobile top bar 26 px tile with a 17 px mark; login and first run 56 px tile (radius 16) with a 36 px mark |

Nav and other small icons are drawn at stroke 2 like the rest of the icon set; the heavy mark is
for the logo only.

## Wordmark

"Vestigo", capital V only, in the system sans (`--font`) at weight 800, letter-spacing −0.035em,
line-height 1, 10 px to the right of the mark tile.

- Sidebar: wordmark 19 px with the sub-line "Media tracker" below it (11 px, weight 500, no
  tracking, `var(--muted)`).
- Mobile top bar: wordmark 17 px, no sub-line.
- Login and first run: stacked and centred, wordmark 28 px, then the tagline at 13.5 px in
  `var(--muted)`. The login lockup is not a link.
- Browser tab: "&lt;Page&gt; · Vestigo", or "Vestigo" alone on Home.

Never write the mark followed by "estigo", italicise the wordmark, put a gradient on the letters,
or recolour the logo tile with the user's accent.

## Palette

**Brand constants** (the logo tile and the app icons only; they never follow the user's accent, so
the logo always matches the favicon):

| Token | Value |
|---|---|
| Vestigo Violet | `#7656ff` |
| Trace Cyan | `#22d3ee` |
| Tile end | `#0891b2` (white mark on it: at least 3.68:1; on Trace Cyan it would be 1.81:1) |
| `--brand-grad` | `linear-gradient(135deg, #7656ff, #0891b2)` |
| Tile glow | `0 6px 18px -6px #7656ff` |

**Interface accent:**

- `--accent` defaults to `#7656ff` (white text on it: 4.62:1). A stored `#7c5cff`, the old
  default, is read as `#7656ff`; any other custom accent is kept.
- `--accent2` is `#22d3ee` (light theme `#0e7490`), only for time, live and progress highlights.
- `--on-accent` is the text and icon colour on accent fills: `#fff` when it reaches 4.5:1 on the
  accent, otherwise `#0b0d12`.
- Accent presets: Violet `#7656ff` (default), Cyan `#22d3ee`, Mint `#34d399`, Rose `#f472b6`,
  Ember `#fb923c`, Gold `#facc15`, Red `#ef4444`, Sky `#60a5fa`.

Dark theme neutrals: bg `#0b0d12`, bg2 `#10131a`, panel `#151922`, panel2 `#1b2030`, line
`#262c3d`, text `#e8ebf3`, muted `#8a93a8`, dim `#7f889d`. Text meets WCAG AA (4.5:1) in every
theme; platform colours and chips are checked against the panel they sit on.

## Voice

Calm, precise and a little warm, like a field notebook for your play rather than a hype machine.

- Use sentence case and short sentences.
- No exclamation marks, and no emoji in the UI or in webhooks.
- Buttons start with a verb: "Connect an account", "Log session", "Sync now".
- Lead with the number: "3h 10m on Hades".
- Pluralise correctly: "1 session · 1 game".
- Errors say what happened, then what to do next: "Steam didn't answer. Vestigo will retry at
  05:00 — or sync now."

**Trace and trail language** is only for brand moments: login, first run, empty states, Year in
review and the README. Functional labels stay literal: Library, Sessions, Stats, Sync now.

**Terms of record** are always:

- "tracked": seen between syncs
- "estimated history": dated by inference, drawn hatched
- "undated": lifetime totals only

**Naming:** call the product "Vestigo", never "the app". Use the name only where an actor is
needed; otherwise write neutrally, e.g. "before tracking began".

**Sample lines:**

- Login: "Every session leaves a trace."
- Empty library: "No tracks yet — Connect Steam, Xbox or PlayStation and Vestigo picks up your
  library, and every hour you've already played."
- Year in review: "The trail you left in 2026."
- Webhook: "Vestigo · Steam Deck synced — 2 sessions, 1h 40m played"
