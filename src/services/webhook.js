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
  await post(url, text, { event: error ? 'sync.failed' : 'sync.completed', text, account: { id: account.id, platform: account.platform, name: account.name }, result, error });
}

/** POST the weekly summary (see digest.js): chat text for Discord / Slack, JSON with the numbers for others. */
export async function sendSummary(url, summary, text) {
  await post(url, text, { event: 'summary.weekly', text, summary });
}

const DISCORD_MAX = 1900; // Discord refuses a message over 2000 characters

/** `text` in at most `max` characters: cut at the end of a line where one is near, and marked as cut. */
export function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const line = cut.lastIndexOf('\n');
  return `${line > max / 2 ? cut.slice(0, line + 1) : cut}…`;
}

async function post(url, text, json) {
  let body;
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) body = { content: clip(text, DISCORD_MAX), username: 'Vestigo' };
  else if (/hooks\.slack\.com/.test(url)) body = { text };
  else body = json;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}
