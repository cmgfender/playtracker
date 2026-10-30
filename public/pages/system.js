import { $, $$, esc, ago, fmtDate, fmtTime, platDot, icon, api, toast, fail, confirmBox, rerender } from '../app.js';
import { arrow, kpi } from './shared.js';

// =====================================================================
// API docs
// =====================================================================
export async function apidocs(view, stale) {
  const res = await fetch('/api/openapi.json');
  const spec = await res.json();
  if (stale()) return;
  const origin = location.origin;
  const groups = {};
  for (const [p, ops] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(ops)) (groups[op.tags[0]] ||= []).push({ p, m, op });
  view.innerHTML = `
    <div class="page-h"><div><h1>API</h1><p>Everything in the UI is available over a JSON REST API. <a href="/api/openapi.json" target="_blank" class="link">OpenAPI spec${icon('external', 'ic-inline')}</a></p></div></div>
    <div class="grid grid-2">
      <div class="card"><h2>Authentication</h2><p class="small muted">Create a token under Settings › API tokens and send it as a header (or <code>?api_key=</code> for simple widgets). Without a UI password the API is open on your LAN.</p>
        <pre class="code">curl -H "Authorization: Bearer vg_…" ${esc(origin)}/api/v1/widget</pre></div>
      <div class="card"><h2>Push playtime (custom accounts)</h2><p class="small muted">Send lifetime totals from Playnite, a Switch spreadsheet or a script. Vestigo diffs them like any other sync.</p>
        <pre class="code">curl -X POST ${esc(origin)}/api/v1/accounts/ID/report \\
  -H "Authorization: Bearer vg_…" -H "Content-Type: application/json" \\
  -d '{"games":[{"id":"zelda-totk","title":"Zelda: TotK","playtime_minutes":5230}]}'</pre></div>
      <div class="card"><h2>Log a session</h2><pre class="code">curl -X POST ${esc(origin)}/api/v1/sessions -H "Authorization: Bearer vg_…" \\
  -H "Content-Type: application/json" -d '{"game_id":12,"minutes":45,"note":"Chapter 3"}'</pre></div>
      <div class="card"><h2>Dashboards</h2><p class="small muted"><code>GET /api/v1/widget</code> returns flat numbers for Homepage / Homarr / Home Assistant REST sensors. Prometheus metrics live at <code>/metrics</code>.</p>
        <pre class="code">- Vestigo:
    widget:
      type: customapi
      url: ${esc(origin)}/api/v1/widget?api_key=vg_…
      mappings:
        - field: week_hours
          label: This week
          suffix: h</pre></div>
    </div>
    <div class="card" style="margin-top:16px">${Object.entries(groups).map(([tag, ops]) => `<h2 style="margin:18px 0 8px;text-transform:capitalize">${esc(tag)}</h2>
      <div class="scroll-x"><table class="tbl api-table">${ops.map(({ p, m, op }) => `<tr><td style="width:70px"><span class="method m-${m}">${m.toUpperCase()}</span></td><td><span class="mono">${esc(p)}</span><div class="small muted">${esc(op.summary)}</div>
        ${op.parameters.filter((x) => x.in === 'query').length ? `<div class="tiny dim">query: ${op.parameters.filter((x) => x.in === 'query').map((x) => `<code>${esc(x.name)}</code>${x.description ? ` ${esc(x.description)}` : ''}`).join(' · ')}</div>` : ''}
        ${op.requestBody ? `<div class="tiny dim">body: <code>${esc(Object.values(op.requestBody.content)[0]?.schema?.description || '')}</code>${Object.keys(op.requestBody.content).filter((t) => t !== 'application/json').map((t) => ` <span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}</td></tr>`).join('')}</table></div>`).join('')}</div>`;
}

// =====================================================================
// System: health, error log, API usage, diagnostics
// =====================================================================
export async function system(view, stale) {
  const [sys, logs] = await Promise.all([api('/system'), api('/logs?level=error,warn&limit=200')]);
  if (stale()) return;
  const mb = (b) => `${(b / 1048576).toFixed(b > 1e8 ? 0 : 1)} MB`;
  const up = (sec) => (sec > 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : sec > 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);
  const health = sys.errors_24h ? ['bad', `${sys.errors_24h} error${sys.errors_24h > 1 ? 's' : ''} in 24h`] : sys.warnings_24h ? ['warn', `${sys.warnings_24h} warning${sys.warnings_24h > 1 ? 's' : ''} in 24h`] : ['good', 'Healthy'];
  view.innerHTML = `
    <div class="page-h"><div><h1>System</h1><p>Vestigo ${esc(sys.version)} · Node ${esc(sys.node)} · up ${up(sys.uptime_s)} · TZ ${esc(sys.tz)}${sys.tz_env ? '' : ' <span style="color:var(--warn)">(TZ not set)</span>'}</p></div>
      <div class="row"><span class="badge ${health[0]}" style="height:30px;padding:0 12px">${health[1]}</span><button class="btn" id="sys-dl">${icon('download')}Diagnostics</button></div></div>
    <div class="kpis">
      ${kpi('Errors (24h)', sys.errors_24h, `${sys.warnings_24h} warnings`)}
      ${kpi('Requests', sys.http?.requests?.toLocaleString() || 0, `${sys.http?.errors || 0} failed · ${sys.http?.slow || 0} slow`)}
      ${kpi('Database', mb(sys.db_bytes), `${sys.counts.sessions_tracked.toLocaleString()} sessions`)}
      ${kpi('Memory', `${sys.memory_mb}<small>MB</small>`, `heap ${sys.heap_mb} MB`)}
      ${kpi('Library', sys.counts.games.toLocaleString(), `${sys.counts.entries.toLocaleString()} entries`)}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Accounts &amp; API usage</h2><a href="/accounts" data-link>Manage${arrow()}</a></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>Account</th><th>Last sync</th><th>Next</th><th>API calls (1h / 24h)</th><th>Rate limited</th><th>Reporting model</th><th>Presence</th><th>History dating</th></tr></thead><tbody>
      ${sys.accounts.map((a) => `<tr>
        <td class="nowrap">${platDot(a.platform)} <b>${esc(a.name)}</b>${a.last_status === 'error' ? `<div class="tiny" style="color:var(--bad);max-width:260px;white-space:normal">${esc(a.last_error || '')}</div>` : ''}${a.failed_syncs_7d ? `<div class="tiny muted">${a.failed_syncs_7d} failed syncs in 7 days</div>` : ''}</td>
        <td class="nowrap">${a.last_sync ? `<span class="badge ${a.last_sync.status === 'ok' ? 'good' : a.last_sync.status === 'warning' ? 'warn' : 'bad'}">${esc(a.last_sync.status)}</span> ${ago(a.last_sync.started_at)}<div class="tiny dim">${esc(a.last_sync.trigger)} · ${((a.last_sync.duration_ms || 0) / 1000).toFixed(1)}s</div>` : 'never'}</td>
        <td class="nowrap">${a.push ? 'push' : a.next_sync_at ? ago(a.next_sync_at) : '—'}</td>
        <td class="nowrap">${a.api_usage_hour.calls}${a.hourly_limit ? ` / ${a.hourly_limit}` : ''} · ${a.api_usage_24h.calls}${a.api_usage_24h.errors ? `<div class="tiny" style="color:var(--warn)">${a.api_usage_24h.errors} failed</div>` : ''}
          ${a.api_quota?.remaining != null ? `<div class="tiny dim">service reports ${a.api_quota.remaining} left${a.api_quota.resetAt ? ` · resets ${fmtTime(a.api_quota.resetAt)}` : ''}</div>` : ''}
          ${a.api_quota?.blockedUntil > Date.now() ? `<div class="tiny" style="color:var(--warn)">paused until ${fmtTime(a.api_quota.blockedUntil)}</div>` : ''}</td>
        <td>${a.api_usage_24h.rate_limited ? `<span class="badge warn">${a.api_usage_24h.rate_limited}</span>` : '—'}</td>
        <td class="small" style="min-width:180px">${a.history_model ? `${esc(a.history_model.update)}<div class="tiny dim">last played = ${esc(a.history_model.last_played)}</div>` : '—'}</td>
        <td class="nowrap small">${a.presence ? (a.presence.enabled ? (a.presence.error ? `<span style="color:var(--warn)">${esc(a.presence.error)}</span>` : a.presence.last_poll ? `ok · ${ago(a.presence.last_poll)}` : 'waiting') : 'off') : '—'}</td>
        <td class="small">${!a.can_enrich ? '<span class="muted">from platform dates</span>' : a.enrichment_pending ? `${a.enrichment_pending} titles queued` : 'up to date'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No accounts.</td></tr>'}
      </tbody></table></div>
      <div class="row wrap" style="margin-top:12px"><button class="btn sm" id="sys-reinfer">Re-date all history</button><a class="btn sm ghost" href="/history" data-link>Improve history${icon('arrowR')}</a>${sys.accounts.filter((a) => a.enrichment_pending && a.can_enrich).map((a) => `<button class="btn sm ghost" data-enrich="${a.id}">Fetch history dates for ${esc(a.name)}</button>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Error log</h2><div class="row wrap">
        <div class="seg" id="log-lvl" aria-label="Show"><button data-l="error,warn" class="on">Errors &amp; warnings</button><button data-l="error">Errors</button><button data-l="warn">Warnings</button></div>
        <button class="btn sm ghost" id="log-clear">${icon('trash')}Clear</button></div></div>
      <div class="search" style="margin-bottom:10px">${icon('search')}<input class="input" id="log-q" aria-label="Filter log" placeholder="Filter messages (account, game, error…)"></div>
      <div id="log-list"></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Recent console output</h2><span class="tiny muted">same as docker logs</span></div><div class="console">${sys.console.map(esc).join('\n') || 'Nothing yet.'}</div></div>
      <div class="card"><div class="card-h"><h2>Storage</h2></div>
        <div class="scroll-x"><table class="tbl cap-table">${[['Database file', sys.data_dir || 'in-memory'], ['Size (incl. WAL)', mb(sys.db_bytes)], ...(sys.backups?.dir ? [['Backups', `${sys.backups.last ? `last ${ago(sys.backups.last.at)} (${mb(sys.backups.last.bytes)})` : 'none yet'} · ${sys.backups.count} kept${sys.backups.enabled ? '' : ' · automatic backups off'}${sys.backups.last_error ? ` · last attempt failed: ${sys.backups.last_error.message}` : ''}`], ['Backup folder', sys.backups.dir]] : []), ...(sys.igdb?.configured ? [['IGDB metadata', `${sys.igdb.coverage.matched.toLocaleString()} of ${sys.igdb.coverage.total.toLocaleString()} games matched${sys.igdb.coverage.pending ? ` · ${sys.igdb.coverage.pending.toLocaleString()} to look up` : ''}${sys.igdb.running ? ' · matching now' : sys.igdb.last_run_at ? ` · last pass ${ago(sys.igdb.last_run_at)}` : ''}${sys.igdb.last_error ? ` · failed: ${sys.igdb.last_error.message}` : ''}`]] : []), ['Weekly summary', sys.weekly_summary?.enabled ? `on, ${sys.weekly_summary.time}${sys.weekly_summary.last_sent_week ? ` · last sent for the week of ${sys.weekly_summary.last_sent_week}` : ''}` : 'off (or no webhook URL)'], ['Tracked sessions', sys.counts.sessions_tracked.toLocaleString()], ['Estimated history chunks', sys.counts.sessions_estimated.toLocaleString()], ['Rollup rows', sys.counts.rollup_rows.toLocaleString()], ['Pending rollups', sys.counts.rollup_queue], ['Snapshots', sys.counts.snapshots.toLocaleString()], ['Presence spans', sys.counts.presence_spans.toLocaleString()], ['Stored log entries', sys.counts.logs.toLocaleString()], ['Running as uid', sys.uid ?? '—'], ['UI password', sys.auth_enabled ? 'on' : 'off']].map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>
        <p class="tiny muted">Logs are also written to stdout (Unraid: container › Logs). Set <code>LOG_LEVEL=debug</code>, <code>LOG_FORMAT=json</code> or <code>VESTIGO_LOG_FILE=/data/vestigo.log</code> for more.</p></div>
    </div>`;
  let level = 'error,warn'; let q = '';
  const drawLogs = (items) => {
    $('#log-list').innerHTML = items.length ? items.map((l) => `<details class="log-row"><summary><span class="lvl lvl-${l.level}">${l.level}</span><span class="tiny muted nowrap">${fmtDate(l.time)} ${fmtTime(l.time)}</span><span class="tiny dim nowrap">${esc(l.source)}</span><span class="grow small" style="word-break:break-word">${esc(l.message)}</span></summary>
      ${l.context ? `<pre class="code">${esc(JSON.stringify(l.context, null, 2))}</pre>` : ''}${l.stack ? `<pre class="code">${esc(l.stack)}</pre>` : ''}</details>`).join('')
      : `<div class="empty" style="padding:24px"><div class="em-ic">${icon('check')}</div><h2>All clear</h2><p>No ${level === 'warn' ? 'warnings' : 'errors'} logged.</p></div>`;
  };
  drawLogs(logs.items);
  const reload = async () => drawLogs((await api(`/logs?level=${level}&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`)).items);
  $('#log-lvl').addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (!b) return; level = b.dataset.l; $$('#log-lvl button').forEach((x) => x.classList.toggle('on', x === b)); reload(); });
  let t;
  $('#log-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); reload(); }, 250); });
  $('#log-clear').addEventListener('click', async () => { if (await confirmBox('Every stored log entry will be deleted. This cannot be undone.', { ok: 'Clear', danger: true, title: 'Clear the log?' })) { await api('/logs', { method: 'DELETE' }); rerender(); } });
  $('#sys-reinfer').addEventListener('click', async () => { try { const r = await api('/history/reinfer', { method: 'POST' }); toast(`Re-dated history for ${r.entries} titles`); } catch (e) { fail(e); } });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-enrich]');
    if (!b) return;
    try { await api(`/accounts/${b.dataset.enrich}/enrich`, { method: 'POST' }); toast('Fetching achievement times / release dates in the background'); } catch (err) { fail(err); }
  });
  $('#sys-dl').addEventListener('click', async () => {
    const [d, l, syncs] = await Promise.all([api('/system'), api('/logs?limit=1000'), api('/syncs?limit=200')]);
    const blob = new Blob([JSON.stringify({ generated_at: new Date().toISOString(), system: d, logs: l.items, syncs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `vestigo-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  });
}
