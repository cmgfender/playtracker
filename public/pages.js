// Every page lives in its own module under pages/; this module gathers them for the router and re-exports
// the helpers app.js, insights.js and suggest.js import from here.
import { insights } from './insights.js';
import { dashboard } from './pages/dashboard.js';
import { library } from './pages/library.js';
import { game } from './pages/game.js';
import { sessions } from './pages/sessions.js';
import { stats } from './pages/stats.js';
import { wrapped } from './pages/wrapped.js';
import { duplicates } from './pages/duplicates.js';
import { accounts } from './pages/accounts.js';
import { settings } from './pages/settings.js';
import { apidocs, system } from './pages/system.js';
import { historyPage } from './pages/history.js';
import { more } from './pages/more.js';

export { hourLabel, seriesLabel, seriesName, kpi, emptyState, RARE, fmtRarity, rarityText, achIcon, logSessionModal } from './pages/shared.js';
export { layoutModal } from './pages/dashboard.js';
export const pages = { dashboard, library, game, sessions, stats, insights, wrapped, duplicates, accounts, settings, apidocs, more, system, history: historyPage };
