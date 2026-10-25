import crypto from 'node:crypto';

const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pw, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class Auth {
  /** envName: the variable envPassword came from (VESTIGO_PASSWORD, or PLAYTRACKER_PASSWORD on older installs). */
  constructor({ db, settings, envPassword, envName }) {
    this.db = db;
    this.settings = settings;
    this.envPassword = envPassword || null;
    this.envName = this.envPassword ? envName || 'VESTIGO_PASSWORD' : null;
  }

  enabled() {
    return !!(this.envPassword || this.settings.get('password_hash'));
  }

  passwordSource() {
    return this.envPassword ? 'env' : this.settings.get('password_hash') ? 'settings' : null;
  }

  /** The environment variable that sets the password, or null. */
  passwordEnv() {
    return this.envName;
  }

  checkPassword(pw) {
    if (this.envPassword) return safeEqual(pw, this.envPassword);
    const h = this.settings.get('password_hash');
    return h ? verifyPassword(String(pw), h) : true;
  }

  setPassword(pw) {
    if (this.envPassword) throw Object.assign(new Error(`Password is set via the ${this.envName} environment variable`), { status: 400 });
    if (!pw) {
      this.settings.set({ password_hash: '' });
    } else {
      if (String(pw).length < 6) throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400 });
      this.settings.set({ password_hash: hashPassword(String(pw)) });
    }
    this.db.prepare('DELETE FROM login_sessions').run();
  }

  createLoginSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO login_sessions(token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha(token), now, now + SESSION_DAYS * 86_400_000);
    this.db.prepare('DELETE FROM login_sessions WHERE expires_at < ?').run(now);
    return { token, maxAge: SESSION_DAYS * 86_400 };
  }

  destroyLoginSession(token) {
    if (token) this.db.prepare('DELETE FROM login_sessions WHERE token_hash = ?').run(sha(token));
  }

  // tokens are looked up by the hash of the whole token, so pt_ tokens from PlayTracker keep working
  createToken(name) {
    const token = `vg_${crypto.randomBytes(24).toString('base64url')}`;
    const r = this.db.prepare('INSERT INTO api_tokens(name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)').run(String(name || 'API token').slice(0, 80), sha(token), token.slice(0, 7), Date.now());
    return { id: Number(r.lastInsertRowid), token };
  }

  /** Returns { ok, via } for a request. */
  identify(req, cookies, url) {
    const header = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1] || req.headers['x-api-key'] || url.searchParams.get('api_key');
    if (bearer) {
      const row = this.db.prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(sha(String(bearer).trim()));
      if (row) {
        this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
        return { ok: true, via: 'token' };
      }
      if (this.enabled()) return { ok: false, via: 'token' };
    }
    if (!this.enabled()) return { ok: true, via: 'open' };
    const c = cookies.pt_session;
    if (c) {
      const row = this.db.prepare('SELECT expires_at FROM login_sessions WHERE token_hash = ?').get(sha(c));
      if (row && row.expires_at > Date.now()) return { ok: true, via: 'cookie' };
    }
    return { ok: false, via: null };
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    let v = part.slice(i + 1).trim();
    // a cookie we cannot decode (set by another app on this host) is kept as it is
    try { v = decodeURIComponent(v); } catch { /* malformed %-escape */ }
    out[part.slice(0, i).trim()] = v;
  }
  return out;
}
