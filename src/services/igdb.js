// Optional game metadata from IGDB (igdb.com, run by Twitch): genres, themes, modes,
// perspectives, franchises, developers, publishers, release dates, ratings and typical times
// to beat. Nothing here runs until a Twitch client id and secret are set (Settings, or
// VESTIGO_IGDB_CLIENT_ID / VESTIGO_IGDB_CLIENT_SECRET); without them every IGDB part of the UI
// stays hidden.
//
// Matching, per game: a Steam copy's app id is looked up among IGDB's external ids (exact);
// otherwise the title is searched and the best candidate taken only when its name (or one of
// its alternative names) is the same title once normalized, preferring main games, the
// platforms owned here and well-known entries. A game with no safe match is marked 'none' and
// tried again later; a match chosen by hand (PUT /games/:id/meta) is never replaced.
//
// IGDB allows 4 requests a second: requests here are spaced to ~3 a second, one at a time, and
// title searches go 10 to a request (multiquery). Details are refreshed every 30 days.
// Field lists use `*` plus expansions of long-standing fields, so a field IGDB renames later
// does not turn every request into a 400.

import { env } from '../env.js';
import { tx } from '../db.js';
import { normalizeTitle } from './titles.js';
import { httpJson, spacer, ProviderError } from '../providers/http.js';

const DAY = 86_400_000;
const API = 'https://api.igdb.com/v4';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const TAG_KINDS = ['genre', 'theme', 'mode', 'perspective', 'franchise', 'developer', 'publisher'];
const REFRESH_AFTER = 30 * DAY;     // details of a matched game
const RETRY_NONE_AFTER = 14 * DAY;  // a game nothing matched
const MAX_TRIES = 6;                // ... at most this many times
const SEARCH_PER_REQUEST = 10;      // multiquery limit
const IDS_PER_REQUEST = 200;
// IGDB platform ids of the platforms tracked here (a candidate on one of them is preferred)
const PLATFORM_IDS = { steam: [6, 14, 3], xbox: [49, 169, 12, 11], psn: [48, 167, 9, 46, 8] };
const COVER = (id) => `https://images.igdb.com/igdb/image/upload/t_cover_big/${id}.jpg`;

const DETAIL_FIELDS = 'fields *, genres.name, themes.name, game_modes.name, player_perspectives.name, franchises.name, involved_companies.developer, involved_companies.publisher, involved_companies.company.name, cover.image_id, alternative_names.name';
const SEARCH_FIELDS = 'fields *, alternative_names.name';

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const names = (list) => [...new Set((list || []).map((x) => (typeof x === 'object' ? x?.name : null)).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];

/** Tags of an IGDB game record: { genre: [...], theme: [...], ... }. */
export function tagsOf(g) {
  const companies = (role) => names((g.involved_companies || []).filter((c) => c && c[role]).map((c) => c.company));
  return {
    genre: names(g.genres), theme: names(g.themes), mode: names(g.game_modes), perspective: names(g.player_perspectives),
    franchise: names([...(g.franchises || []), ...(g.franchise && typeof g.franchise === 'object' ? [g.franchise] : [])]),
    developer: companies('developer'), publisher: companies('publisher'),
  };
}

/** Is an IGDB candidate the main game (not a DLC, bundle, episode, mod...)? Field names changed over time. */
const isMain = (c) => {
  const t = c.game_type ?? c.category;
  return t == null || [0, 4, 8, 9, 10, 11].includes(typeof t === 'object' ? t.id : t); // main, standalone, remake, remaster, expanded, port
};

/**
 * The best IGDB candidate for a title, or null when none is safely the same game: the name (or
 * an alternative name) must equal the title once normalized. Ties prefer main games, the
 * platforms the game is owned on here, and more ratings.
 */
export function pickMatch(title, candidates, platforms = []) {
  const want = normalizeTitle(title);
  if (!want) return null;
  const wantedPlatforms = new Set(platforms.flatMap((p) => PLATFORM_IDS[p] || []));
  let best = null;
  for (const c of candidates || []) {
    if (!c?.id || !c.name) continue;
    const exact = normalizeTitle(c.name) === want;
    const alt = !exact && (c.alternative_names || []).some((a) => normalizeTitle(a?.name) === want);
    if (!exact && !alt) continue;
    const plats = (c.platforms || []).map((p) => (typeof p === 'object' ? p.id : p));
    const score = (exact ? 4 : 2) + (isMain(c) ? 3 : 0) + (plats.some((p) => wantedPlatforms.has(p)) ? 2 : 0) + Math.min(1, Math.log10(1 + (c.total_rating_count || c.rating_count || 0)) / 3);
    if (!best || score > best.score) best = { c, score };
  }
  return best ? best.c : null;
}

export class Igdb {
  /** opts.api / opts.tokenUrl: other endpoints (tests); opts.spacing: ms between requests. */
  constructor({ db, settings, log, api = API, tokenUrl = TOKEN_URL, spacing = 320 } = {}) {
    this.db = db;
    this.settings = settings;
    this.log = log;
    this.api = api;
    this.tokenUrl = tokenUrl;
    this.gap = spacer(spacing);
    this.state = { running: false, phase: null, done: 0, total: 0, started_at: null, last_run_at: null, last_error: null, last_counts: null };
  }

  creds() {
    const id = env('IGDB_CLIENT_ID') || this.settings.get('igdb_client_id') || '';
    const secret = env('IGDB_CLIENT_SECRET') || this.settings.get('igdb_client_secret') || '';
    return { id: String(id).trim(), secret: String(secret).trim(), fromEnv: !!env('IGDB_CLIENT_ID') };
  }

  configured() { const c = this.creds(); return !!(c.id && c.secret) && this.settings.get('igdb_enabled') !== false; }

  /** An app access token (client credentials), kept until a day before it expires. */
  async token(force = false) {
    const { id, secret } = this.creds();
    if (!id || !secret) throw new ProviderError('IGDB is not set up: add a Twitch client id and secret', { auth: true });
    const kept = this.settings.get('igdb_token');
    if (!force && kept?.access_token && kept.client_id === id && kept.expires_at - Date.now() > DAY) return kept.access_token;
    const u = new URL(this.tokenUrl);
    u.searchParams.set('client_id', id); u.searchParams.set('client_secret', secret); u.searchParams.set('grant_type', 'client_credentials');
    let r;
    try { r = await httpJson(u.toString(), { method: 'POST' }, { retries: 1 }); } catch (err) {
      if (err.status === 400 || err.status === 401 || err.status === 403) throw new ProviderError('Twitch refused the IGDB client id / secret: check them at dev.twitch.tv/console/apps', { status: err.status, auth: true });
      throw err;
    }
    if (!r?.access_token) throw new ProviderError('Twitch returned no access token for IGDB', { auth: true });
    this.settings.set({ igdb_token: { access_token: r.access_token, client_id: id, expires_at: Date.now() + (Number(r.expires_in) || 3600) * 1000 } });
    return r.access_token;
  }

  /** POST an Apicalypse query to an IGDB endpoint; a rejected token is renewed once. */
  async query(endpoint, body, { again = true } = {}) {
    await this.gap();
    const tok = await this.token();
    try {
      return await httpJson(`${this.api}/${endpoint}`, { method: 'POST', headers: { 'Client-ID': this.creds().id, Authorization: `Bearer ${tok}`, Accept: 'application/json', 'Content-Type': 'text/plain' }, body }, { retries: 2, maxRetryWaitS: 10 });
    } catch (err) {
      if (again && (err.status === 401 || err.status === 403)) { await this.token(true); return this.query(endpoint, body, { again: false }); }
      throw err;
    }
  }

  /** Search titles, 10 to a request: Map(key -> candidates). */
  async search(items) {
    const out = new Map();
    for (const part of chunks(items, SEARCH_PER_REQUEST)) {
      const body = part.map((x, i) => `query games "q${i}" { ${SEARCH_FIELDS}; search ${quote(x.title)}; limit 8; };`).join('\n');
      const res = await this.query('multiquery', body);
      for (const r of res || []) {
        const i = Number(String(r.name).slice(1));
        if (part[i]) out.set(part[i].key, r.result || []);
      }
    }
    return out;
  }

  /** IGDB games for Steam app ids: Map(appid -> igdb game id). */
  async bySteam(appids) {
    const out = new Map();
    for (const part of chunks(appids, IDS_PER_REQUEST)) {
      const rows = await this.query('external_games', `fields *; where uid = (${part.map(quote).join(',')}); limit 500;`);
      for (const x of rows || []) {
        const src = x.external_game_source ?? x.category;
        if ((typeof src === 'object' ? src?.id : src) !== 1 || !x.game) continue; // 1 = Steam
        out.set(String(x.uid), typeof x.game === 'object' ? x.game.id : x.game);
      }
    }
    return out;
  }

  /** Details for IGDB ids: Map(id -> record), each with ttb (seconds) when IGDB has it. */
  async details(ids) {
    const out = new Map();
    for (const part of chunks(ids, IDS_PER_REQUEST)) {
      for (const g of await this.query('games', `${DETAIL_FIELDS}; where id = (${part.join(',')}); limit 500;`) || []) out.set(g.id, g);
      // typical times to beat (a newer endpoint: an install of IGDB without it just has none)
      try {
        for (const t of await this.query('game_time_to_beats', `fields *; where game_id = (${part.join(',')}); limit 500;`) || []) {
          const g = out.get(typeof t.game_id === 'object' ? t.game_id.id : t.game_id);
          if (g) g.ttb = t;
        }
      } catch (err) { if (err.status !== 404 && err.status !== 400) throw err; }
    }
    return out;
  }

  // ---------------------------------------------------------------- storing
  store(gameId, rec, matchedBy, { locked = false } = {}) {
    const db = this.db;
    const now = Date.now();
    const min = (s) => (Number(s) > 0 ? Math.round(Number(s) / 60) : null);
    tx(db, () => {
      if (!rec) {
        db.prepare(`INSERT INTO game_meta(game_id, igdb_id, matched_by, locked, fetched_at, tries) VALUES (?, NULL, ?, ?, ?, 1)
          ON CONFLICT(game_id) DO UPDATE SET igdb_id = NULL, matched_by = excluded.matched_by, locked = excluded.locked, name = NULL, slug = NULL, url = NULL, summary = NULL,
            release_date = NULL, rating = NULL, rating_count = NULL, ttb_main = NULL, ttb_extra = NULL, ttb_complete = NULL, cover_image = NULL, fetched_at = excluded.fetched_at, tries = game_meta.tries + 1`)
          .run(gameId, matchedBy, locked ? 1 : 0, now);
        db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(gameId);
        return;
      }
      const cover = rec.cover && typeof rec.cover === 'object' ? rec.cover.image_id : null;
      const rating = rec.total_rating ?? rec.aggregated_rating ?? rec.rating ?? null;
      db.prepare(`INSERT INTO game_meta(game_id, igdb_id, matched_by, locked, name, slug, url, summary, release_date, rating, rating_count, ttb_main, ttb_extra, ttb_complete, cover_image, tries, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(game_id) DO UPDATE SET igdb_id = excluded.igdb_id, matched_by = excluded.matched_by, locked = excluded.locked, name = excluded.name, slug = excluded.slug, url = excluded.url,
          summary = excluded.summary, release_date = excluded.release_date, rating = excluded.rating, rating_count = excluded.rating_count, ttb_main = excluded.ttb_main,
          ttb_extra = excluded.ttb_extra, ttb_complete = excluded.ttb_complete, cover_image = excluded.cover_image, tries = 0, fetched_at = excluded.fetched_at`)
        .run(gameId, rec.id, matchedBy, locked ? 1 : 0, rec.name ?? null, rec.slug ?? null, rec.url ?? null, typeof rec.summary === 'string' ? rec.summary.slice(0, 4000) : null,
          Number(rec.first_release_date) > 0 ? Number(rec.first_release_date) * 1000 : null, rating != null ? Math.round(rating * 10) / 10 : null,
          rec.total_rating_count ?? rec.rating_count ?? null, min(rec.ttb?.hastily), min(rec.ttb?.normally), min(rec.ttb?.completely), cover, now);
      db.prepare('DELETE FROM game_tags WHERE game_id = ?').run(gameId);
      const ins = db.prepare('INSERT OR IGNORE INTO game_tags(game_id, kind, name) VALUES (?, ?, ?)');
      for (const [kind, list] of Object.entries(tagsOf(rec))) for (const n of list) ins.run(gameId, kind, n.slice(0, 120));
      // a cover only where the game has none (yours are never replaced)
      if (cover) db.prepare('UPDATE games SET cover_url = ? WHERE id = ? AND (cover_url IS NULL OR cover_url = \'\')').run(COVER(cover), gameId);
    });
  }

  /** Games to look at now, most played first. */
  candidates(limit, now = Date.now()) {
    return this.db.prepare(`SELECT g.id, g.title, m.igdb_id, m.matched_by, m.locked, m.fetched_at,
        (SELECT GROUP_CONCAT(platform) FROM entries e WHERE e.game_id = g.id) platforms,
        (SELECT MIN(CAST(ext_id AS INTEGER)) FROM entries e WHERE e.game_id = g.id AND e.platform = 'steam' AND ext_id GLOB '[0-9]*') steam_appid,
        (SELECT COALESCE(SUM(playtime_min), 0) FROM entries e WHERE e.game_id = g.id AND e.excluded = 0) minutes
      FROM games g LEFT JOIN game_meta m ON m.game_id = g.id
      WHERE m.game_id IS NULL
        OR (m.igdb_id IS NULL AND m.locked = 0 AND m.tries < ? AND m.fetched_at < ?)
        OR (m.igdb_id IS NOT NULL AND m.fetched_at < ?)
      ORDER BY m.game_id IS NOT NULL, minutes DESC, g.id LIMIT ?`).all(MAX_TRIES, now - RETRY_NONE_AFTER, now - REFRESH_AFTER, limit);
  }

  /** How far matching has got: { total, matched, unmatched, pending, by: { steam, title, manual } }. */
  coverage() {
    const r = this.db.prepare(`SELECT COUNT(*) total, COUNT(m.game_id) looked, SUM(m.igdb_id IS NOT NULL) matched,
        SUM(m.matched_by = 'steam') steam, SUM(m.matched_by = 'title') title, SUM(m.matched_by = 'manual') manual
      FROM games g LEFT JOIN game_meta m ON m.game_id = g.id`).get();
    return { total: r.total, matched: r.matched || 0, unmatched: (r.looked || 0) - (r.matched || 0), pending: r.total - (r.looked || 0), by: { steam: r.steam || 0, title: r.title || 0, manual: r.manual || 0 } };
  }

  status() {
    const c = this.creds();
    return { configured: this.configured(), credentials: !!(c.id && c.secret), from_env: c.fromEnv, enabled: this.settings.get('igdb_enabled') !== false, ...this.state, coverage: this.coverage() };
  }

  /**
   * One pass: match the games not looked up yet (Steam ids first, then titles), refresh old
   * details, retry earlier misses now and then. At most `limit` games a pass; another pass
   * follows while there is more. Returns the counts.
   */
  async run({ limit = 300, now = Date.now() } = {}) {
    if (!this.configured() || this.state.running) return null;
    const list = this.candidates(limit, now);
    if (!list.length) { this.state.last_run_at = Date.now(); return { looked: 0 }; }
    Object.assign(this.state, { running: true, phase: 'matching', done: 0, total: list.length, started_at: Date.now(), last_error: null });
    const counts = { looked: list.length, matched: 0, by_steam: 0, by_title: 0, none: 0, refreshed: 0 };
    try {
      const ids = new Map(); // game id -> [igdb id, how]
      const refresh = list.filter((g) => g.igdb_id != null);
      for (const g of refresh) ids.set(g.id, [g.igdb_id, g.matched_by]);
      const fresh = list.filter((g) => g.igdb_id == null && !g.locked);
      const steam = fresh.filter((g) => g.steam_appid);
      if (steam.length) {
        const found = await this.bySteam(steam.map((g) => String(g.steam_appid)));
        for (const g of steam) { const id = found.get(String(g.steam_appid)); if (id) ids.set(g.id, [id, 'steam']); }
      }
      const rest = fresh.filter((g) => !ids.has(g.id));
      for (const part of chunks(rest, SEARCH_PER_REQUEST * 5)) {
        const found = await this.search(part.map((g) => ({ key: g.id, title: g.title })));
        for (const g of part) {
          const m = pickMatch(g.title, found.get(g.id), String(g.platforms || '').split(','));
          if (m) ids.set(g.id, [m.id, 'title']); else this.store(g.id, null, 'none');
          if (!m) counts.none++;
        }
        this.state.done += part.length;
      }
      this.state.phase = 'details';
      const want = [...new Set([...ids.values()].map(([id]) => id))];
      const recs = want.length ? await this.details(want) : new Map();
      for (const [gameId, [igdbId, how]] of ids) {
        const rec = recs.get(igdbId);
        if (!rec) { this.store(gameId, null, 'none'); counts.none++; continue; }
        this.store(gameId, rec, how, { locked: how === 'manual' });
        if (refresh.some((g) => g.id === gameId)) counts.refreshed++;
        else { counts.matched++; counts[how === 'steam' ? 'by_steam' : 'by_title']++; }
      }
      this.state.done = list.length;
      this.state.last_counts = counts;
      if (counts.matched || counts.none) this.log?.info(`IGDB: ${counts.matched} games matched (${counts.by_steam} by Steam id, ${counts.by_title} by title), ${counts.none} without a match${counts.refreshed ? `, ${counts.refreshed} refreshed` : ''}`);
      return counts;
    } catch (err) {
      this.state.last_error = { at: Date.now(), message: err.message };
      this.log?.warn(`IGDB lookup failed: ${err.message}`);
      throw err;
    } finally {
      Object.assign(this.state, { running: false, phase: null, last_run_at: Date.now() });
    }
  }

  /** Match one game by hand (an IGDB id), or say it has none (null). Locked against later matching. */
  async setMatch(gameId, igdbId) {
    if (igdbId == null) { this.store(gameId, null, 'manual', { locked: true }); return null; }
    const rec = (await this.details([igdbId])).get(igdbId);
    if (!rec) throw new ProviderError(`IGDB has no game ${igdbId}`, { status: 404 });
    this.store(gameId, rec, 'manual', { locked: true });
    return rec;
  }

  /** Candidates for a title (the Wrong game? dialog): [{ id, name, year, platforms, cover_url, url }]. */
  async lookup(title) {
    const found = (await this.search([{ key: 'x', title }])).get('x') || [];
    return found.map((c) => ({ id: c.id, name: c.name, year: c.first_release_date ? new Date(c.first_release_date * 1000).getUTCFullYear() : null, main: isMain(c), url: c.url || null }));
  }

  /** Background: a pass soon after start, then whenever there is something to do (checked hourly). */
  start() {
    const go = async () => {
      // a pass at a time, and passes back to back while a big library is being matched
      for (let i = 0; i < 50 && this.configured() && !this.stopped; i++) {
        let c;
        try { c = await this.run(); } catch { return; }
        if (!c || !c.looked) return;
      }
    };
    this.kick = () => { if (!this.state.running) go().catch(() => {}); };
    this.first = setTimeout(this.kick, 90_000);
    this.first.unref?.();
    this.timer = setInterval(this.kick, 3600_000);
    this.timer.unref?.();
  }

  stop() { this.stopped = true; clearTimeout(this.first); clearInterval(this.timer); }
}

/** A game's metadata for the API: null when IGDB has not been asked (or is not set up). */
export function gameMeta(db, gameId) {
  const m = db.prepare('SELECT * FROM game_meta WHERE game_id = ?').get(gameId);
  if (!m) return null;
  const tags = Object.fromEntries(TAG_KINDS.map((k) => [k, []]));
  for (const t of db.prepare('SELECT kind, name FROM game_tags WHERE game_id = ? ORDER BY kind, name').all(gameId)) tags[t.kind]?.push(t.name);
  return {
    igdb_id: m.igdb_id, matched_by: m.matched_by, locked: !!m.locked, name: m.name, url: m.url, summary: m.summary, release_date: m.release_date,
    rating: m.rating, rating_count: m.rating_count, time_to_beat: m.ttb_main || m.ttb_extra || m.ttb_complete ? { main: m.ttb_main, extra: m.ttb_extra, complete: m.ttb_complete } : null,
    genres: tags.genre, themes: tags.theme, modes: tags.mode, perspectives: tags.perspective, franchises: tags.franchise, developers: tags.developer, publishers: tags.publisher,
    fetched_at: m.fetched_at,
  };
}
