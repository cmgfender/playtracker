import { icon, api, state, plural, NAV_GROUPS, navItems, applyBadges } from '../app.js';

// =====================================================================
// More (mobile)
// =====================================================================
const MORE_DESC = {
  '/insights': 'When, what and how you play', '/duplicates': 'Merge editions, fix double counting', '/history': 'Date play from before tracking', '/accounts': 'Steam, Xbox, PlayStation, custom',
  '/settings': 'Schedule, import/export, security', '/system': 'Error log, API usage, diagnostics', '/api': 'Tokens, push endpoint, docs',
};
/** The phone's More tab: the sidebar's groups (minus the tabs), Year in review on top, and what needs a look counted on each row. */
export async function more(view, stale) {
  const accs = await api('/accounts').catch(() => []);
  if (stale()) return;
  const paused = accs.filter((a) => !a.enabled).length;
  const counts = {
    '/duplicates': '<span class="badge accent hide" data-count="dupes"></span>',
    '/system': '<span class="badge bad hide" data-count="errors"></span>',
  };
  // Accounts says how many and how many are paused instead of describing itself
  const desc = { ...MORE_DESC, ...(accs.length ? { '/accounts': `${plural(accs.length, 'account')}${paused ? ` · ${paused} paused` : ''}` } : {}) };
  const items = navItems().filter((n) => !n.tab);
  const year = items.find((n) => n.path === '/wrapped');
  const row = (n) => `<a class="item more-row" href="${n.href}" data-link><span class="mi">${icon(n.icon, 'ic-18')}</span><span class="grow"><span class="ttl">${n.label}</span><span class="sub">${desc[n.path] || ''}</span></span>${counts[n.path] || ''}${icon('chevR', 'ic-16 chev')}</a>`;
  view.innerHTML = `<div class="page-h"><h1>More</h1></div>
    <a class="more-feature" href="${year.href}" data-link><span class="mi">${icon('trail', 'ic-18')}</span><span class="grow"><span class="ttl">Year in review</span><span class="sub">The trail you left in ${state.latestYear}</span></span>${icon('chevR', 'ic-16 chev')}</a>
    ${NAV_GROUPS.map((g) => [g, items.filter((n) => n.group === g && n !== year)]).filter(([, list]) => list.length).map(([g, list], i) => `<section class="more-sec" aria-labelledby="mg-${i}"><h2 class="nav-group" id="mg-${i}">${g}</h2><div class="card pad-0">${list.map(row).join('')}</div></section>`).join('')}
    ${state.authEnabled ? `<button class="btn" style="margin-top:16px;width:100%" data-action="logout">${icon('logout')}Log out</button>` : ''}`;
  applyBadges();
}
