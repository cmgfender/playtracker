import { fmtMinutes } from '../util.js';
import { providers } from '../providers/index.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** POST a sync summary. Discord / Slack-compatible webhooks get a chat message; others get JSON. */
export async function sendWebhook(url, { account, result, error }) {
  // the account as the user named it; the platform's label when it has no name (never its id)
  const who = account.name || providers[account.platform]?.label || 'an account';
  let text;
  if (error) {
    text = `Vestigo · sync failed for ${who}: ${error}`;
  } else {
    const lines = (result.new_sessions || []).slice(0, 15).map((s) => `• ${s.title} — ${fmtMinutes(s.minutes)}`);
    text = `Vestigo · ${who} synced — ${plural(result.sessions_created, 'session')}, ${fmtMinutes(result.minutes_added)} played` +
      (lines.length ? `\n${lines.join('\n')}` : '');
  }
  let body;
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) body = { content: text.slice(0, 1900), username: 'Vestigo' };
  else if (/hooks\.slack\.com/.test(url)) body = { text };
  else body = { event: error ? 'sync.failed' : 'sync.completed', text, account: { id: account.id, platform: account.platform, name: account.name }, result, error };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
