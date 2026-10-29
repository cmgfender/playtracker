import {
  $, $$, esc, fmtMin, fmtHours, ago, fmtDate, icon, api, toast, fail, modal, confirmBox, rerender, state, applyTheme, paintAccent,
  accentOf, scrollMotion,
} from '../app.js';
import { parseLayout, layoutEditor } from './dashboard.js';
import { scheduleFields, bindScheduleFields, readSchedule } from './accounts.js';

// =====================================================================
// Settings
// =====================================================================
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const mb = (b) => `${(b / 1048576).toFixed(b >= 1e8 ? 0 : 1)} MB`;

/** The backups kept: the last one, the next, any error, and the files (download / delete). */
export function backupBox(b) {
  if (!b) return '<p class="small muted">Backups could not be read.</p>';
  if (!b.dir) return '';
  const err = b.last_error ? `<p class="small" style="color:var(--bad-ink);margin:6px 0">The last backup failed ${ago(b.last_error.at)}: ${esc(b.last_error.message)}. It is tried again a few hours later.</p>` : '';
  const line = b.last ? `Last backup ${ago(b.last.at)} (${mb(b.last.bytes)})` : 'No backup yet';
  const next = b.enabled && b.next_at ? ` · next ${b.next_at - Date.now() < 60_000 ? 'in a minute' : `${fmtDate(b.next_at)} ${new Date(b.next_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}` : b.enabled ? '' : ' · automatic backups are off';
  const rows = b.files.map((f) => `<div class="item"><div class="grow"><div class="ttl mono small ellipsis">${esc(f.name)}</div><div class="sub">${fmtDate(f.at, { year: 'numeric', month: 'short', day: 'numeric' })} ${new Date(f.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${mb(f.bytes)}${f.kind === 'before-upgrade' ? ' · before an update' : ''}</div></div>
    <a class="btn sm ghost" href="/api/v1/backups/${encodeURIComponent(f.name)}" download aria-label="Download ${esc(f.name)}">${icon('download')}</a><button class="btn sm ghost danger" data-bk-del="${esc(f.name)}" aria-label="Delete ${esc(f.name)}">${icon('trash')}</button></div>`).join('');
  return `${err}<div class="row wrap" style="margin-top:8px;align-items:center"><button class="btn sm" id="bk-now">${icon('download')}Back up now</button><span class="small muted">${line}${next}</span></div>
    ${b.files.length ? `<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">${b.files.length} kept · ${mb(b.total_bytes)}</summary><div class="list" style="margin-top:6px">${rows}</div></details>` : ''}`;
}

/** IGDB in one badge: not set up, matching, or how many games have metadata. */
function igdbBadge(st) {
  if (!st.configured) return '<span class="badge">Off</span>';
  if (st.running) return '<span class="badge accent">Matching…</span>';
  return st.last_error ? '<span class="badge bad">Error</span>' : `<span class="badge good">${st.coverage.matched.toLocaleString()} games</span>`;
}

/** What IGDB has done: matched so far, the pass running now, the last error. */
export function igdbStatus(st) {
  if (!st.configured) return st.credentials ? '<span class="muted">Turned off.</span>' : '';
  const c = st.coverage;
  const pct = c.total ? Math.round(((c.matched + c.unmatched) / c.total) * 100) : 0;
  const by = [c.by.steam && `${c.by.steam.toLocaleString()} by Steam id`, c.by.title && `${c.by.title.toLocaleString()} by title`, c.by.manual && `${c.by.manual} by you`].filter(Boolean).join(', ');
  return `${st.running ? `<div class="split-bar" style="margin-bottom:8px" role="progressbar" aria-valuemin="0" aria-valuemax="${st.total}" aria-valuenow="${st.done}" aria-label="Matching games"><i style="width:${st.total ? (st.done / st.total) * 100 : 0}%;background:var(--accent-mark)"></i></div>
      <p style="margin:0 0 6px">${st.phase === 'details' ? 'Reading details' : 'Matching'}: ${st.done.toLocaleString()} of ${st.total.toLocaleString()} games in this pass…</p>` : ''}
    <p class="muted" style="margin:0">${c.matched.toLocaleString()} of ${c.total.toLocaleString()} games have metadata${by ? ` (${by})` : ''}${c.unmatched ? ` · ${c.unmatched.toLocaleString()} not found` : ''}${c.pending ? ` · ${c.pending.toLocaleString()} still to look up` : ''} · ${pct}% looked at.</p>
    ${st.last_error ? `<p style="color:var(--bad-ink);margin:6px 0 0">The last pass failed ${ago(st.last_error.at)}: ${esc(st.last_error.message)}</p>` : ''}
    ${!st.running ? `<button class="btn sm" id="ig-run" style="margin-top:8px">${icon('sync')}Match now</button>` : ''}`;
}

const ACCENTS = [['#7656ff', 'Violet (default)'], ['#22d3ee', 'Cyan'], ['#34d399', 'Mint'], ['#f472b6', 'Rose'], ['#fb923c', 'Ember'], ['#facc15', 'Gold'], ['#ef4444', 'Red'], ['#60a5fa', 'Sky']];
function segSetting(key, title, opts, s, desc = '') {
  return `<div class="setting"><div><div class="t">${title}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div><div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(s[key]) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>`;
}

/** The "Install app" row: an Install button when the browser offers one, else how (or why not). */
function installRow() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const d = !window.isSecureContext ? 'Install and offline need HTTPS, e.g. through your reverse proxy.'
    : standalone ? 'Installed: Vestigo opens in its own window, and pages you opened work offline.'
      : state.installPrompt ? 'Its own window and icon, and pages you opened work offline.'
        : 'Use your browser’s Install or Add to Home Screen option. Pages you opened work offline.';
  return `<div class="setting" id="install"><div><div class="t">Install app</div><div class="d">${d}</div></div>${window.isSecureContext && !standalone && state.installPrompt ? `<button class="btn sm" id="inst-go">${icon('download')}Install</button>` : ''}</div>`;
}

/** A "Saved" tick beside a settings control for 1.5s; the live line says what was saved. */
function savedTick(at, what) {
  const row = at?.closest('.setting');
  const host = row?.querySelector('.t') || at?.closest('.field')?.querySelector('label') || (at?.matches('button') ? at.parentElement : at);
  if (!host) return;
  host.querySelector('.saved')?.remove();
  host.insertAdjacentHTML('beforeend', `<span class="saved" aria-hidden="true">${icon('check')}Saved</span>`);
  const tick = host.lastElementChild;
  const st = $('#set-st');
  if (st) st.textContent = `${what || row?.querySelector('.t')?.firstChild?.textContent?.trim() || 'Setting'} saved`;
  setTimeout(() => tick.classList.add('gone'), 1500);
  setTimeout(() => tick.remove(), 1900);
}

export async function settings(view, stale) {
  const [s, tokens, auth, bk, ig] = await Promise.all([api('/settings'), api('/tokens'), api('/auth/status'), api('/backups').catch(() => null), api('/igdb/status').catch(() => null)]);
  if (stale()) return;
  const sw = (key, title, desc) => `<div class="setting"><div><div class="t">${title}</div><div class="d">${desc}</div></div><label class="switch"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''} aria-label="${esc(title)}"><span></span></label></div>`;
  const accent = accentOf(s);
  view.innerHTML = `
    <div class="page-h"><div><h1>Settings</h1></div><span class="vh" role="status" id="set-st"></span></div>
    <div class="grid grid-2">
      <div class="stack">
        <div class="card" id="appearance"><div class="card-h"><h2>Appearance</h2><span class="tiny muted">saved for every device</span></div>
          ${segSetting('theme', 'Theme', [['dark', 'Dark'], ['black', 'Black'], ['light', 'Light'], ['auto', 'Auto']], s, 'Black is pure black for OLED screens')}
          <div class="setting"><div><div class="t" id="accent-t">Accent</div></div><div class="row wrap" role="group" aria-labelledby="accent-t">${ACCENTS.map(([c, name]) => `<button class="swatch" data-accent="${c}" style="--c:${c}" aria-label="${name}" title="${name}" aria-pressed="${accent === c}"></button>`).join('')}
            <input type="color" class="swatch" id="accent-custom" value="${esc(accent)}" title="Custom color" aria-label="Custom accent color"></div></div>
          ${segSetting('ui_density', 'Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], s, 'Compact fits more on screen')}
          ${segSetting('time_format', 'Time format', [['hm', '1h 5m'], ['decimal', '1.1h']], s)}
          <div class="setting"><div><div class="t">Start page</div><div class="d">What opens when you launch Vestigo</div></div><select class="input" data-str="start_page" style="width:auto">${[['home', 'Home'], ['library', 'Library'], ['sessions', 'Sessions'], ['stats', 'Stats']].map(([v, l]) => `<option value="${v}" ${s.start_page === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${installRow()}
          <h3 style="margin:16px 0 2px">Library</h3>
          ${segSetting('library_view', 'Default view', [['grid', 'Covers'], ['list', 'List']], s)}
          ${segSetting('cover_size', 'Cover size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], s)}
          ${segSetting('cover_titles', 'Titles on covers', [['auto', 'No art'], ['always', 'Always'], ['never', 'Never']], s, '“No art” only labels games without a cover image')}
          <div class="setting"><div class="t">Default sort</div><select class="input" data-str="default_library_sort" style="width:auto">${[['recent', 'Recently played'], ['playtime', 'Most played'], ['title', 'A–Z'], ['trending', 'Trending'], ['added', 'Recently added'], ['rating', 'Top rated']].map(([v, l]) => `<option value="${v}" ${s.default_library_sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${sw('library_hide_unplayed', 'Hide never-played games', 'Owned games you have never launched stay out of the library unless you ask for them')}
          <h3 style="margin:16px 0 8px" id="lay-h">Home sections</h3>
          <div id="set-layout"></div>
        </div>
        <div class="card" id="schedule"><div class="card-h"><h2>Sync schedule</h2><span class="badge accent" id="sched-label">${esc(s.schedule_label)}</span></div>
          <p class="small muted" style="margin-top:-6px">How often Vestigo snapshots your playtime. Shorter intervals = more precise sessions; the difference between two snapshots becomes a session. Accounts can override this.</p>
          <form class="stack" id="sched-f">${scheduleFields(s)}</form>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="sched-save">Save schedule</button></div>
        </div>
        <div class="card" id="detection"><div class="card-h"><h2>Session detection</h2></div>
          <div class="setting"><div><div class="t">Minimum session</div><div class="d">Smaller deltas accumulate until they reach this many minutes</div></div><input class="input" type="number" min="0" max="120" data-num="min_session_minutes" value="${s.min_session_minutes}" style="width:90px"></div>
          <div class="setting"><div><div class="t">Wall-clock tolerance</div><div class="d">If a platform reports more playtime than time elapsed since the last sync (+ this many minutes), the excess is filed as history</div></div><input class="input" type="number" min="0" max="600" data-num="max_overage_minutes" value="${s.max_overage_minutes}" style="width:90px"></div>
          ${sw('use_recent_on_import', 'Use Steam “last 2 weeks” on import', 'On a first import, Steam’s two-week playtime becomes a real session instead of history')}
          ${sw('history_learn', 'Learn my play pattern', 'Games tracked from first session to last teach how you spread play over a game; pre-tracking history is dated the same way')}
          ${sw('auto_merge_titles', 'Auto-group same titles', 'Same game on Steam/Xbox/PSN becomes one library entry (editions & platform tags ignored)')}
          <div class="setting"><div><div class="t">Week starts on</div></div><select class="input" data-num="week_starts_on" style="width:auto"><option value="1" ${s.week_starts_on === 1 ? 'selected' : ''}>Monday</option><option value="0" ${s.week_starts_on === 0 ? 'selected' : ''}>Sunday</option></select></div>
        </div>
      </div>
      <div class="stack">
        <div class="card" id="import"><div class="card-h"><h2>Import</h2></div>
          <p class="small muted" style="margin-top:-6px">Bring history from spreadsheets, other trackers, Switch, etc. CSV columns: <code>title</code>, <code>platform</code>, <code>playtime_hours</code> or <code>playtime_minutes</code>, <code>last_played</code>, <code>status</code>, <code>rating</code>, <code>notes</code>. JSON may include per-game <code>sessions</code>. Totals without sessions become <b>history</b> — counted in lifetime, never as a burst in your charts.</p>
          <label class="btn" style="cursor:pointer">${icon('upload')}Choose CSV / JSON / GameTrack .zip<input type="file" id="imp-file" class="vh" accept=".csv,.json,.txt,.zip,text/csv,application/json,application/zip"></label>
          <p class="tiny muted" style="margin:8px 0 0">GameTrack: in GameTrack choose Settings › Export, then pick the .zip here. Unlock times date your synced games' history; hours no account here tracks are added as history; nothing is counted twice.</p>
          <details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">…or paste</summary><textarea class="input mono" id="imp-text" aria-label="CSV or JSON to import" placeholder="title,platform,playtime_hours,status&#10;Hades,switch,42,completed" style="margin-top:8px"></textarea><button class="btn sm" id="imp-go" style="margin-top:8px">Import pasted data</button></details>
          <div id="imp-r" class="small" style="margin-top:10px" aria-live="polite"></div>
        </div>
        <div class="card" id="export"><div class="card-h"><h2>Export & backups</h2></div>
          <div class="row wrap"><a class="btn" href="/api/v1/export" download>${icon('download')}JSON</a><a class="btn" href="/api/v1/export?format=csv" download>${icon('download')}CSV</a><a class="btn" href="/api/v1/backup" download>${icon('download')}SQLite backup</a></div>
          <p class="small muted">Everything is stored in the container’s <code>/data</code> volume — on Unraid, map it to a folder under <code>/mnt/user/appdata</code>. <a href="/system" data-link class="link">System</a> shows the database file in use.</p>
          ${bk ? `<h3 style="margin:16px 0 2px" id="backups">Automatic backups</h3>
          ${segSetting('backup_mode', 'Schedule', [['daily', 'Daily'], ['weekly', 'Weekly'], ['off', 'Off']], s, bk.dir ? `Copies of the database in <code>${esc(bk.dir)}</code>${s.backup_mode === 'weekly' ? `, on ${WEEKDAY[s.week_starts_on ?? 1]}s` : ''}` : 'Not available: this instance keeps its database in memory')}
          <div class="setting"><div><div class="t">Time</div></div><input class="input" type="time" data-str="backup_time" value="${esc(s.backup_time)}" style="width:auto" aria-label="Backup time"></div>
          <div class="setting"><div><div class="t">Keep</div><div class="d">The oldest are removed beyond this many. A copy made before an update changes the database is kept apart (the last 3).</div></div><input class="input" type="number" min="1" max="90" data-num="backup_keep" value="${s.backup_keep}" style="width:90px" aria-label="Backups kept"></div>
          <div id="bk-box">${backupBox(bk)}</div>` : ''}
        </div>
        ${ig ? `<div class="card" id="metadata"><div class="card-h"><h2>Game metadata</h2><span id="ig-badge">${igdbBadge(ig)}</span></div>
          <p class="small muted" style="margin-top:-6px">Optional. With <a class="link" href="https://www.igdb.com" target="_blank" rel="noopener">IGDB</a> (run by Twitch), Vestigo adds genres, developers, series, release dates and typical times to beat to your games. That unlocks genre stats on Stats and Insights, a Genre filter in the library, and an About card on each game. Only game titles and Steam app ids are sent.</p>
          ${ig.from_env ? '<p class="small muted">The client id and secret are set with <code>VESTIGO_IGDB_CLIENT_ID</code> / <code>VESTIGO_IGDB_CLIENT_SECRET</code>.</p>' : `<form class="stack" id="ig-f" autocomplete="off">
            <div class="field"><label for="ig-id">Twitch client ID</label><input class="input" id="ig-id" value="${esc(s.igdb_client_id || '')}" spellcheck="false"></div>
            <div class="field"><label for="ig-secret">Client secret</label><input class="input" id="ig-secret" type="password" placeholder="${s.igdb_secret_set ? 'Saved (type a new one to replace it)' : ''}" spellcheck="false"></div>
            <details><summary class="small muted" style="cursor:pointer">How to get these (free, 2 minutes)</summary><ol class="small" style="margin:6px 0 0;padding-left:18px">
              <li>Sign in at <a class="link" href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener">dev.twitch.tv/console/apps</a> (a Twitch account with two-factor authentication).</li>
              <li><b>Register Your Application</b>: any name, OAuth redirect URL <code>http://localhost</code>, category <b>Application Integration</b>, client type <b>Confidential</b>.</li>
              <li>Open it: copy the <b>Client ID</b>, then <b>New Secret</b> and copy the secret.</li></ol></details>
            <div class="row wrap"><button class="btn primary">${icon('check')}Save &amp; test</button>${ig.credentials ? '<button type="button" class="btn ghost danger" id="ig-off">Remove</button>' : ''}</div></form>`}
          <div id="ig-st" class="small" style="margin-top:12px" aria-live="polite">${igdbStatus(ig)}</div>
        </div>` : ''}
        <div class="card" id="notifications"><div class="card-h"><h2>Notifications</h2></div>
          <div class="field"><label>Webhook URL</label><input class="input" data-str="webhook_url" value="${esc(s.webhook_url)}" placeholder="https://discord.com/api/webhooks/…"><div class="help">Discord and Slack get a formatted message; anything else gets JSON. Works with ntfy, Gotify bridges, Home Assistant, n8n…</div></div>
          <div class="setting"><div class="t">Send when</div><select class="input" data-str="webhook_on" style="width:auto"><option value="sessions" ${s.webhook_on === 'sessions' ? 'selected' : ''}>New sessions or errors</option><option value="always" ${s.webhook_on === 'always' ? 'selected' : ''}>Every sync</option><option value="errors" ${s.webhook_on === 'errors' ? 'selected' : ''}>Errors only</option></select></div>
          ${sw('weekly_summary', 'Weekly summary', `Last week’s hours, top games, new games and achievements, sent on ${WEEKDAY[s.week_starts_on ?? 1]}s (the first day of your week)`)}
          <div class="setting"><div><div class="t">Summary time</div></div><input class="input" type="time" data-str="weekly_summary_time" value="${esc(s.weekly_summary_time)}" style="width:auto" aria-label="Weekly summary time"></div>
          <div class="row wrap" style="margin-top:8px"><button class="btn sm" id="wk-preview">${icon('eye')}Preview</button><button class="btn sm" id="wk-send">${icon('external')}Send last week’s now</button></div>
        </div>
        <div class="card" id="security"><div class="card-h"><h2>Security</h2></div>
          ${auth.password_source === 'env' ? `<p class="small muted">Password is set with <code>${esc(auth.password_env || 'VESTIGO_PASSWORD')}</code> and can’t be changed here.</p>` : `
          <form class="stack" id="pw-f">${auth.auth_enabled ? '<div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>' : '<p class="small muted" style="margin:0">No password set — anyone on your network can open Vestigo. Set one before exposing it through a reverse proxy.</p>'}
            <div class="field"><label>${auth.auth_enabled ? 'New password (empty = remove)' : 'Password'}</label><input class="input" type="password" name="password" autocomplete="new-password"></div>
            <div><button class="btn">${auth.auth_enabled ? 'Update password' : 'Set password'}</button></div></form>`}
        </div>
        <div class="card" id="tokens"><div class="card-h"><h2>API tokens</h2><button class="btn sm" id="tok-new">${icon('key')}New token</button></div>
          <div class="list">${tokens.map((t) => `<div class="item"><div class="grow"><div class="ttl">${esc(t.name)}</div><div class="sub"><span class="mono">${esc(t.prefix)}…</span> · created ${fmtDate(t.created_at)} · ${t.last_used_at ? `used ${ago(t.last_used_at)}` : 'never used'}</div></div><button class="btn sm ghost danger" data-revoke="${t.id}">Revoke</button></div>`).join('') || '<p class="small muted">Tokens let scripts, Home Assistant, Homepage widgets or Playnite call the API. <a href="/api" data-link class="link">API docs</a></p>'}</div>
        </div>
      </div>
    </div>`;
  bindScheduleFields(view);
  $('#inst-go')?.addEventListener('click', async () => {
    const p = state.installPrompt;
    if (!p) return;
    p.prompt();
    const { outcome } = await p.userChoice.catch(() => ({}));
    if (outcome === 'accepted') { state.installPrompt = null; rerender(); }
  });
  // a change is confirmed by a "Saved" tick beside its control (and the #set-st live line), not a toast
  const save = async (patch, at, what) => {
    try { const r = await api('/settings', { method: 'PUT', body: patch }); state.settings = { ...state.settings, ...r }; $('#sched-label').textContent = r.schedule_label; applyTheme(state.settings); savedTick(at, what); return r; } catch (e) { fail(e); }
  };
  $('#sched-save').addEventListener('click', (e) => save(readSchedule(view), e.currentTarget, 'Sync schedule'));
  $$('[data-set]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.set]: el.checked }, el)));
  $$('[data-num]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.num]: Number(el.value) }, el)));
  $$('[data-str]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.str]: el.value }, el)));
  $$('[data-seg]', view).forEach((g) => g.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$('button', g).forEach((x) => x.classList.toggle('on', x === b));
    const r = await save({ [g.dataset.seg]: b.dataset.v }, g);
    if (r) applyTheme(state.settings);
  }));
  const setAccent = async (c) => {
    $$('[data-accent]', view).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.accent === c)));
    $('#accent-custom').value = c;
    const r = await save({ accent: c }, $('#accent-t'), 'Accent');
    if (r) applyTheme(state.settings);
  };
  $$('[data-accent]', view).forEach((b) => b.addEventListener('click', () => setAccent(b.dataset.accent)));
  $('#accent-custom').addEventListener('input', (e) => paintAccent(e.target.value)); // live preview, with its readable ink
  $('#accent-custom').addEventListener('change', (e) => setAccent(e.target.value));
  let layoutTimer;
  layoutEditor($('#set-layout'), parseLayout(s.dashboard_layout), (v) => { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => save({ dashboard_layout: v }, $('#lay-h'), 'Home sections'), 400); });
  // Imports preview first (dry run: nothing changes), then apply on confirm.
  const li = (cond, html) => (cond ? `<li>${html}</li>` : '');
  const fileSummary = (r) => `<ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${li(r.merged_synced, `${r.merged_synced} game${r.merged_synced === 1 ? '' : 's'} your synced accounts already track: their totals stay${r.synced_updated ? `, the file adds dates and details${r.sessions_restored ? ` and ${r.sessions_restored} exact past sessions (replacing estimates)` : ''}` : ''}`)}
      ${li(r.entries_created, `${r.entries_created} new game${r.entries_created === 1 ? '' : 's'} / entries`)}
      ${li(r.entries_updated, `${r.entries_updated} existing manual or imported entr${r.entries_updated === 1 ? 'y' : 'ies'} joined (totals only grow, never shrink)`)}
      ${li(r.sessions, `${r.sessions} sessions (${fmtMin(r.tracked_minutes)})`)}
      ${li(r.baseline_minutes, `${fmtHours(r.baseline_minutes)}h added as history, dated from the file`)}
      ${li(r.details_filled, `${r.details_filled} games get a status, rating or notes they did not have (yours are never replaced)`)}
      ${li(r.skipped, `<span class="muted">${r.skipped} rows skipped (no title or unreadable)</span>`)}
      ${r.unchanged && !r.entries_created && !r.entries_updated && !r.synced_updated ? '<li>Nothing new — everything in this file is already here.</li>' : ''}
    </ul>`;
  const gameTrackSummary = (r) => {
    const i = r.import || {};
    return `<ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${li(true, `${r.gametrack_games.toLocaleString()} GameTrack games read`)}
      ${li(r.anchors, `${r.anchors.toLocaleString()} achievement / trophy times date history${r.anchored_entries ? ` of ${r.anchored_entries} synced games` : ''}`)}
      ${li(r.imported_titles, `${r.imported_titles} games with playtime no account here tracks: ${fmtHours(i.baseline_minutes || 0)}h added as history`)}
      ${li(r.skipped_synced, `${r.skipped_synced} games skipped: already counted by your synced accounts`)}
      ${li(r.statuses || r.ratings || r.covers, `${r.statuses} statuses, ${r.ratings} ratings, ${r.covers} covers filled in where empty`)}
      ${li(r.wishlist_added, `${r.wishlist_added} wish-listed games added`)}
      ${li(r.skipped_no_playtime, `<span class="muted">${r.skipped_no_playtime} collection games without playtime left out</span>`)}
    </ul>`;
  };
  const previewThenApply = async ({ label, send, summary }) => {
    const out = $('#imp-r');
    out.innerHTML = `<span class="pulse muted">Checking ${esc(label)}…</span>`;
    try {
      const p = await send(true);
      out.innerHTML = `<div class="card" style="padding:12px"><b>Preview: ${esc(label)}</b>${summary(p)}
        <div class="small muted" style="margin-top:6px">Nothing has changed yet. Imports join your library: they fill gaps and add history, never replace what you set.</div>
        <div class="row" style="margin-top:10px"><button class="btn primary sm" id="imp-apply">${icon('check')}Import</button><button class="btn sm ghost" id="imp-cancel">Cancel</button></div></div>`;
      $('#imp-cancel').addEventListener('click', () => { out.innerHTML = ''; });
      $('#imp-apply').addEventListener('click', async () => {
        out.innerHTML = '<span class="pulse muted">Importing…</span>';
        try {
          const r = await send(false);
          out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Imported ${esc(label)}</b>${summary(r)}<div class="muted small" style="margin-top:6px">Importing the same file again changes nothing.</div></div>`;
        } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; }
      });
    } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; }
  };
  const doImport = (text, name = '') => {
    let body; let headers = {};
    const isJson = name.endsWith('.json') || /^\s*[[{]/.test(text);
    try { body = isJson ? JSON.parse(text) : text; } catch { $('#imp-r').innerHTML = '<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">That file is not valid JSON</div>'; return; }
    if (!isJson) headers = { 'Content-Type': 'text/csv' };
    return previewThenApply({ label: name || 'pasted data', send: (dry) => api(`/import${dry ? '?dry_run=true' : ''}`, { method: 'POST', body, headers }), summary: fileSummary });
  };
  const doGameTrack = (file) => previewThenApply({
    label: file.name, summary: gameTrackSummary,
    send: (dry) => api(`/import/gametrack${dry ? '?dry_run=true' : ''}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } }),
  });
  $('#imp-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f && /\.zip$/i.test(f.name)) doGameTrack(f);
    else if (f) doImport(await f.text(), f.name.toLowerCase());
    e.target.value = '';
  });
  $('#imp-go').addEventListener('click', () => { const t = $('#imp-text').value; if (t.trim()) doImport(t); });
  $('#pw-f')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('/auth/password', { method: 'PUT', body: { current: e.target.current?.value, password: e.target.password.value } }); state.authEnabled = r.auth_enabled; toast(r.auth_enabled ? 'Password saved' : 'Password removed'); rerender(); } catch (err) { fail(err); }
  });
  // IGDB: save and test the credentials, match now, follow a pass while it runs
  let igTimer;
  const igShow = (st) => {
    if (stale() || !$('#ig-st')) return; // left the page while a status call was out
    $('#ig-st').innerHTML = igdbStatus(st); $('#ig-badge').innerHTML = igdbBadge(st);
    clearTimeout(igTimer);
    if (st.running) igTimer = setTimeout(async () => { if (!stale() && $('#ig-st')) igShow(await api('/igdb/status').catch(() => st)); }, 3000);
  };
  if (ig) igShow(ig);
  $('#ig-f')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { igdb_client_id: $('#ig-id').value.trim(), igdb_enabled: true };
    if ($('#ig-secret').value.trim()) body.igdb_client_secret = $('#ig-secret').value.trim();
    try {
      await api('/settings', { method: 'PUT', body });
      $('#ig-secret').value = '';
      await api('/igdb/test', { method: 'POST' });
      toast('IGDB works: matching your games now');
      igShow(await api('/igdb/status'));
    } catch (err) { fail(err); igShow(await api('/igdb/status').catch(() => ig)); }
  });
  $('#ig-off')?.addEventListener('click', async () => {
    if (!(await confirmBox('Vestigo stops asking IGDB. The metadata already matched stays; remove the client id and secret?', { ok: 'Remove', danger: true, title: 'Remove IGDB?' }))) return;
    try { await api('/settings', { method: 'PUT', body: { igdb_client_id: '', igdb_client_secret: '' } }); rerender(); } catch (err) { fail(err); }
  });
  $('#ig-st')?.addEventListener('click', async (e) => {
    if (!e.target.closest('#ig-run')) return;
    try { igShow(await api('/igdb/run', { method: 'POST' })); } catch (err) { fail(err); }
  });
  $('#wk-preview').addEventListener('click', async () => {
    try {
      const w = await api('/summary/week?weeks_ago=1');
      modal({ title: 'Weekly summary', body: `<p class="small muted" style="margin-top:0">What the webhook gets on ${WEEKDAY[state.settings?.week_starts_on ?? 1]} at ${esc(state.settings?.weekly_summary_time || '09:00')}${state.settings?.webhook_url ? '' : ' (once a webhook URL is set)'}:</p><pre class="code" style="white-space:pre-wrap">${esc(w.text)}</pre>`, foot: '<button class="btn" data-close>Close</button>' });
    } catch (e) { fail(e); }
  });
  $('#wk-send').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await api('/summary/week/send', { method: 'POST' }); toast('Weekly summary sent'); } catch (err) { fail(err); } finally { b.disabled = false; }
  });
  const bkBox = $('#bk-box');
  // redraw the list keeping it open, and put focus back near where it was
  const bkRedraw = async (focus) => {
    const open = !!bkBox.querySelector('details')?.open;
    const b = await api('/backups').catch(() => null);
    if (stale() || !bkBox.isConnected) return;
    bkBox.innerHTML = backupBox(b);
    const d = bkBox.querySelector('details');
    if (d && open) d.open = true;
    (focus(bkBox) || bkBox.querySelector('#bk-now'))?.focus();
  };
  bkBox?.addEventListener('click', async (e) => {
    const go = e.target.closest('#bk-now');
    const del = e.target.closest('[data-bk-del]');
    if (go) {
      go.disabled = true;
      go.innerHTML = `${icon('sync')}Backing up…`;
      try { const r = await api('/backups', { method: 'POST' }); toast(`Backup saved: ${r.name}`); } catch (err) { fail(err); }
      await bkRedraw(() => null);
    } else if (del) {
      const rows = [...bkBox.querySelectorAll('[data-bk-del]')];
      const at = rows.indexOf(del);
      if (!(await confirmBox(`Delete ${del.dataset.bkDel}? This cannot be undone.`, { ok: 'Delete', danger: true, title: 'Delete backup?' }))) return;
      try { await api(`/backups/${encodeURIComponent(del.dataset.bkDel)}`, { method: 'DELETE' }); } catch (err) { fail(err); }
      await bkRedraw((box) => { const left = box.querySelectorAll('[data-bk-del]'); return left[Math.min(at, left.length - 1)] || box.querySelector('details summary'); });
    }
  });
  $('#tok-new').addEventListener('click', () => modal({
    title: 'New API token',
    body: '<div class="field"><label>Name</label><input class="input" id="tok-name" placeholder="Home Assistant"></div><div id="tok-out"></div>',
    foot: '<button class="btn" data-close>Close</button><button class="btn primary" id="tok-go">Create</button>',
    onMount(el) {
      el.querySelector('#tok-go').addEventListener('click', async (ev) => {
        try {
          const r = await api('/tokens', { method: 'POST', body: { name: el.querySelector('#tok-name').value || 'API token' } });
          ev.target.remove();
          el.querySelector('#tok-out').innerHTML = `<p class="small muted">Copy it now — it won’t be shown again.</p><pre class="code" style="white-space:pre-wrap;word-break:break-all">${esc(r.token)}</pre><button class="btn sm" id="tok-copy">Copy</button>`;
          el.querySelector('#tok-copy').addEventListener('click', () => navigator.clipboard?.writeText(r.token).then(() => toast('Copied')));
          el.querySelector('[data-close]').addEventListener('click', () => rerender(), { once: true });
        } catch (e) { fail(e); }
      });
    },
  }));
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    if (!(await confirmBox('Anything using this token will stop working. This cannot be undone.', { ok: 'Revoke', danger: true, title: 'Revoke token?' }))) return;
    await api(`/tokens/${b.dataset.revoke}`, { method: 'DELETE' }); rerender();
  });
  if (/^#(appearance|schedule|detection|import|export|backups|metadata|notifications|security|tokens)$/.test(location.hash)) setTimeout(() => $(location.hash)?.scrollIntoView({ behavior: scrollMotion() }), 100);
}
