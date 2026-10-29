import {
  $, esc, fmtMin, fmtHours, ago, fmtDate, fmtTime, plat, platDot, platIcon, icon, api, toast, undoToast, fail, modal, confirmBox,
  rerender, state, watchSync, syncStarted,
} from '../app.js';
import { WD, emptyState } from './shared.js';

// =====================================================================
// Accounts
// =====================================================================
const SCHED_MODES = [['daily', 'Daily'], ['days', 'Every X days'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['hours', 'Every X hours'], ['hourly', 'Hourly'], ['off', 'Manual only']];

export function scheduleFields(s, prefix = '') {
  const mode = s.schedule_mode || 'daily';
  return `<div class="field"><label>Frequency</label><select class="input" name="${prefix}schedule_mode">${SCHED_MODES.map(([v, l]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="grid grid-2">
      <div class="field" data-when="days hours"><label>Every</label><input class="input" type="number" min="1" max="365" name="${prefix}schedule_every" value="${s.schedule_every ?? 2}"></div>
      <div class="field" data-when="weekly"><label>Weekday</label><select class="input" name="${prefix}schedule_weekday">${WD.map((d, i) => `<option value="${i}" ${Number(s.schedule_weekday) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div class="field" data-when="monthly"><label>Day of month</label><input class="input" type="number" min="1" max="28" name="${prefix}schedule_monthday" value="${s.schedule_monthday ?? 1}"></div>
      <div class="field" data-when="daily days weekly monthly"><label>Time</label><input class="input" type="time" name="${prefix}schedule_time" value="${esc(s.schedule_time || '04:00')}"></div>
    </div>`;
}

export function bindScheduleFields(root, prefix = '') {
  const sel = root.querySelector(`[name=${prefix}schedule_mode]`);
  if (!sel) return;
  const upd = () => root.querySelectorAll('[data-when]').forEach((el) => { el.style.display = el.dataset.when.split(' ').includes(sel.value) ? '' : 'none'; });
  sel.addEventListener('change', upd); upd();
}

export function readSchedule(root, prefix = '') {
  const v = (k) => root.querySelector(`[name=${prefix}${k}]`)?.value;
  return { schedule_mode: v('schedule_mode'), schedule_every: Number(v('schedule_every')), schedule_weekday: Number(v('schedule_weekday')), schedule_monthday: Number(v('schedule_monthday')), schedule_time: v('schedule_time') };
}

function capabilityTable(info) {
  const c = info.capabilities || {};
  const rows = [
    ['Lifetime playtime', c.lifetime], ['Recent playtime', c.recent], ['Last played', c.last_played], ['First played', c.first_played],
    ['Launch count', c.play_count], ['Devices', c.per_device], ['Live presence', c.presence], ['History dating', c.history_anchors], ['Rate limits', c.rate_limit],
  ];
  return `<div class="scroll-x" style="margin-top:8px"><table class="tbl cap-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v ? esc(v) : '<span class="dim">not available</span>'}</td></tr>`).join('')}</table></div>
    ${(c.limitations || []).length ? `<div class="small" style="margin-top:8px"><b>Limitations</b><ul style="margin:6px 0 0;padding-left:18px" class="muted">${c.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}`;
}

export async function accountModal(platforms, existing = null) {
  const pick = (p) => {
    const info = platforms.find((x) => x.id === p);
    const a = existing || { config: {}, name: info.label, enabled: true, schedule: null };
    modal({
      title: existing ? `Edit ${esc(a.name)}` : `Connect ${esc(info.label)}`,
      body: `<form class="stack" id="acc-f" autocomplete="off">
        <p class="small muted" style="margin:0">${esc(info.notes)}</p>
        <div class="field"><label>Display name</label><input class="input" name="name" value="${esc(a.name)}"></div>
        ${info.fields.map((f) => `<div class="field"><label>${esc(f.label)}${f.required ? '' : ' <span class="dim">(optional)</span>'}</label>
          ${f.type === 'select' ? `<select class="input" name="cfg_${f.key}">${f.options.map((o) => `<option value="${esc(o)}" ${(a.config[f.key] ?? f.options[0]) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
            : `<input class="input" name="cfg_${f.key}" type="${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}" value="${esc(a.config[f.key] ?? '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false">`}
          ${f.help ? `<div class="help">${esc(f.help).replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</div>` : ''}</div>`).join('')}
        ${info.push ? `<div class="card small" style="padding:12px">Push totals with <code>POST /api/v1/accounts/${existing ? existing.id : ':id'}/report</code> — see the <a href="/api" data-link class="link">API page</a>.</div>` : `
        <div class="setting" style="padding:0;border:0"><div><div class="t">Custom schedule</div><div class="d">Override the global sync schedule for this account</div></div><label class="switch"><input type="checkbox" id="acc-own" ${a.schedule ? 'checked' : ''}><span></span></label></div>
        <div id="acc-sched" class="stack ${a.schedule ? '' : 'hide'}">${scheduleFields(a.schedule || state.settings || {}, 'a_')}</div>`}
        <div id="acc-test-r" class="small"></div>
        <details><summary class="small muted" style="cursor:pointer">What ${esc(info.label)} provides &amp; its limits</summary>${capabilityTable(info)}</details>
      </form>`,
      foot: `${existing ? `<button class="btn danger" id="acc-del" aria-label="Unlink account" title="Unlink account">${icon('trash')}</button>` : ''}<span class="grow"></span>${info.push ? '' : '<button class="btn" id="acc-test">Test</button>'}<button class="btn primary" id="acc-save">${existing ? 'Save' : 'Connect & import'}</button>`,
      onMount(el, close) {
        bindScheduleFields(el, 'a_');
        el.querySelector('#acc-own')?.addEventListener('change', (e) => el.querySelector('#acc-sched').classList.toggle('hide', !e.target.checked));
        const collect = () => {
          const f = el.querySelector('#acc-f');
          const config = {};
          for (const fl of info.fields) config[fl.key] = f[`cfg_${fl.key}`].value.trim();
          const own = el.querySelector('#acc-own')?.checked;
          return { platform: p, name: f.name.value.trim() || info.label, config, schedule: own ? readSchedule(el, 'a_') : null };
        };
        el.querySelector('#acc-test')?.addEventListener('click', async (ev) => {
          const b = ev.currentTarget; b.disabled = true; b.textContent = 'Testing…';
          const out = el.querySelector('#acc-test-r');
          try {
            const body = collect();
            if (existing && Object.values(body.config).some((v) => String(v).startsWith('••'))) { out.innerHTML = '<span class="muted">Re-enter secrets to test, or just Save and Sync.</span>'; return; }
            const r = await api('/accounts/test', { method: 'POST', body });
            out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Connected</b> — ${r.games} games, ${r.played} played, ${fmtHours(r.minutes)}h total.
              <div class="muted">${r.with_dates} of ${r.games} titles have play dates for dating your history${r.account_created_at ? ` · account created ${fmtDate(r.account_created_at, { year: 'numeric', month: 'short' })}` : ''}${r.presence ? ` · presence: ${esc(r.presence)}` : ''} · ${r.api_calls} API calls</div>
              ${r.sample?.length ? `<div class="muted">e.g. ${r.sample.map(esc).join(', ')}</div>` : ''}${r.warning ? `<div style="color:var(--warn)">${esc(r.warning)}</div>` : ''}</div>`;
          } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; } finally { b.disabled = false; b.textContent = 'Test'; }
        });
        el.querySelector('#acc-save').addEventListener('click', async () => {
          const body = collect();
          try {
            if (existing) {
              await api(`/accounts/${existing.id}`, { method: 'PATCH', body });
              toast('Account saved');
            } else {
              await api('/accounts', { method: 'POST', body });
              toast(info.push ? 'Account created' : 'Connected — importing your library…');
              syncStarted();
              setTimeout(() => watchSync(), 1000);
            }
            close(); rerender();
          } catch (e) { fail(e); }
        });
        el.querySelector('#acc-del')?.addEventListener('click', async () => {
          if (!(await confirmBox(`Unlink ${esc(a.name)}? All games, snapshots and sessions from this account will be deleted. This cannot be undone.`, { ok: 'Unlink & delete', danger: true, title: 'Unlink account?' }))) return;
          try { await api(`/accounts/${existing.id}`, { method: 'DELETE' }); close(); toast('Account removed'); rerender(); } catch (e) { fail(e); }
        });
      },
    });
  };
  if (existing) return pick(existing.platform);
  modal({
    title: 'Connect an account',
    body: `<div class="plat-pick">${platforms.map((p) => `<button data-p="${p.id}">${platIcon(p.id, 38)}<div><b>${esc(p.label)}</b><div class="tiny muted">${p.push ? 'Push via API' : 'Automatic sync'}</div></div></button>`).join('')}</div>
      <p class="small muted">Nintendo, Epic, GOG, emulators? Use a <b>Custom</b> account with the push API, or add games manually and log sessions.</p>`,
    onMount(el, close) { el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { close(); pick(b.dataset.p); })); },
  });
}

export async function accounts(view, stale) {
  const [accs, platforms, syncs] = await Promise.all([api('/accounts'), api('/platforms'), api('/syncs?limit=40')]);
  if (stale()) return;
  view.innerHTML = `
    <div class="page-h"><div><h1>Accounts</h1><p>Global schedule: ${esc(state.settings?.schedule_label || '')} · <a href="/settings" data-link class="link">change</a></p></div>
      <div class="row"><button class="btn" data-action="sync-all">${icon('sync')}<span class="lbl">Sync all</span></button><button class="btn primary" id="acc-add">${icon('plus')}Connect</button></div></div>
    ${accs.length ? `<div class="grid grid-2">${accs.map((a) => `<div class="card acct">
      <div class="row">${platIcon(a.platform, 44)}
        <div class="grow"><h2 class="ellipsis">${esc(a.name)}</h2><div class="small muted">${esc(plat(a.platform).label)} · ${a.push ? 'API push' : esc(a.schedule_label)}${a.schedule ? ' <span class="badge">custom</span>' : ''}</div></div>
        ${a.syncing ? '<span class="badge accent pulse">Syncing</span>' : a.last_status === 'error' ? '<span class="badge bad">Error</span>' : a.last_status === 'warning' ? '<span class="badge warn">Warning</span>' : !a.enabled ? '<span class="badge">Paused</span>' : a.last_sync_at ? '<span class="badge good">OK</span>' : '<span class="badge">New</span>'}</div>
      ${a.last_error ? `<div class="small" style="color:${a.last_status === 'error' ? 'var(--bad)' : 'var(--warn)'}">${esc(a.last_error)}</div>` : ''}
      ${a.history_model ? `<div class="small muted" title="How ${esc(plat(a.platform).label)} reports history and how Vestigo interprets it">Totals update ${esc(a.history_model.update)} · last played = ${esc(a.history_model.last_played)}${a.history_model.counters.length ? ` · ${esc(a.history_model.counters.join(', '))}` : ''}</div>` : ''}
      ${a.presence ? `<div class="small muted row" style="gap:6px">${a.presence.enabled ? (a.presence.error ? `<span style="color:var(--warn)">Presence: ${esc(a.presence.error)}</span>` : `<span class="live-dot" style="animation:none;background:${a.presence.last_poll ? 'var(--good)' : 'var(--dim)'}"></span>Live presence every ${Math.round(a.presence.interval_sec / 60) || 1} min${a.presence.last_poll ? ` · checked ${ago(a.presence.last_poll)}` : ''}`) : 'Live presence off'}</div>` : ''}
      ${a.hourly_limit ? `<div class="small muted">API this hour: ${a.api_usage_hour.calls}/${a.hourly_limit}<div class="meter" style="margin-top:4px"><i class="${a.api_usage_hour.calls > a.hourly_limit * 0.8 ? 'hot' : ''}" style="width:${Math.min(100, (a.api_usage_hour.calls / a.hourly_limit) * 100)}%"></i></div></div>` : ''}
      <div class="meta"><div><b>${a.games ?? 0}</b><span>games</span></div><div><b>${fmtHours(a.minutes ?? 0)}h</b><span>lifetime</span></div><div><b>${a.last_sync_at ? ago(a.last_sync_at) : 'never'}</b><span>${a.push ? 'last report' : a.next_sync_at && a.enabled ? `next ${ago(a.next_sync_at)}` : 'last sync'}</span></div></div>
      <div class="row wrap">
        ${a.push ? '' : `<button class="btn sm${a.syncing ? ' loading' : ''}" data-sync="${a.id}" ${a.syncing ? 'disabled' : ''}>${icon('sync')}${a.syncing ? 'Syncing…' : 'Sync now'}</button>`}
        <button class="btn sm ghost" data-edit="${a.id}">${icon('edit')}Edit</button>
        <button class="btn sm ghost" data-toggle="${a.id}">${a.enabled ? 'Pause' : 'Resume'}</button>
        <a class="btn sm ghost" href="/library?platform=${a.platform}" data-link>Games</a>
      </div></div>`).join('')}</div>`
    : `<div class="card">${emptyState('accounts', 'No accounts yet', 'Connect Steam, Xbox or PlayStation. The first sync imports your library and existing playtime as history; later syncs turn new playtime into sessions.', `<button class="btn primary" id="acc-add2">${icon('plus')}Connect an account</button>`)}</div>`}
    <details class="card" style="margin-top:16px"><summary style="cursor:pointer"><h2 style="display:inline">What each platform reports</h2> <span class="small muted">— and how Vestigo uses it</span></summary>
      <div class="grid grid-2" style="margin-top:14px">${platforms.map((p) => `<div><div class="row" style="margin-bottom:6px"><span class="dot" style="background:${plat(p.id).color};width:10px;height:10px"></span><h3>${esc(p.label)}</h3></div><p class="small muted" style="margin:0 0 6px">${esc(p.notes)}</p>${p.history_model ? `<div class="small" style="margin-bottom:6px"><b>Reporting model:</b> totals update ${esc(p.history_model.update)}; last played = ${esc(p.history_model.last_played)}${p.history_model.counters.length ? `; extra counters: ${esc(p.history_model.counters.join(', '))}` : ''}${p.history_model.grouping ? `; versions grouped by ${esc(p.history_model.grouping)}` : ''}</div>` : ''}${capabilityTable(p)}</div>`).join('')}</div>
    </details>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Sync history</h2></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>When</th><th>Account</th><th>Result</th><th>Games</th><th>Sessions</th><th>Played</th><th>History</th></tr></thead><tbody>
      ${syncs.map((s) => `<tr><td class="nowrap">${fmtDate(s.started_at)} ${fmtTime(s.started_at)}<div class="tiny dim">${esc(s.trigger)}${s.initial ? ' · initial import' : ''}</div></td>
        <td class="nowrap">${platDot(s.platform || 'custom')} ${esc(s.account_name || '—')}</td>
        <td>${s.status === 'ok' ? '<span class="badge good">ok</span>' : s.status === 'running' ? '<span class="badge accent pulse">running</span>' : `<span class="badge ${s.status === 'warning' ? 'warn' : 'bad'}">${esc(s.status)}</span>`}${s.error ? `<div class="tiny muted" style="max-width:260px">${esc(s.error)}</div>` : ''}</td>
        <td>${s.games_seen}${s.games_new ? ` <span class="tiny muted">(+${s.games_new})</span>` : ''}${s.details?.api ? `<div class="tiny dim">${s.details.api.calls} calls${s.details.api.rate_limited ? ` · ${s.details.api.rate_limited} rate-limited` : ''} · ${((s.duration_ms || 0) / 1000).toFixed(1)}s</div>` : ''}</td><td>${s.sessions_created ? `<a href="/sessions" data-link class="link">${s.sessions_created}</a>` : 0}</td><td>${fmtMin(s.minutes_added)}</td><td class="muted">${s.baseline_minutes ? fmtMin(s.baseline_minutes, { short: true }) : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No syncs yet.</td></tr>'}
      </tbody></table></div></div>`;
  $('#acc-add')?.addEventListener('click', () => accountModal(platforms));
  $('#acc-add2')?.addEventListener('click', () => accountModal(platforms));
  if (new URLSearchParams(location.search).get('add')) { history.replaceState({}, '', '/accounts'); accountModal(platforms); }
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sync],[data-edit],[data-toggle]');
    if (!b) return;
    try {
      if (b.dataset.sync) { await api(`/accounts/${b.dataset.sync}/sync`, { method: 'POST' }); toast('Sync started'); syncStarted(); setTimeout(() => { rerender(); watchSync(); }, 500); }
      if (b.dataset.edit) accountModal(platforms, accs.find((a) => a.id === Number(b.dataset.edit)));
      if (b.dataset.toggle) {
        const a = accs.find((x) => x.id === Number(b.dataset.toggle));
        const set = (enabled) => api(`/accounts/${a.id}`, { method: 'PATCH', body: { enabled } });
        await set(!a.enabled);
        undoToast(`${a.name} ${a.enabled ? 'paused' : 'resumed'}`, () => set(a.enabled), rerender);
        rerender();
      }
    } catch (err) { fail(err); }
  });
}
