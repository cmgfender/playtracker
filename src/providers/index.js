import { steam } from './steam.js';
import { xbox } from './xbox.js';
import { psn } from './psn.js';
import { modelFor } from '../services/model.js';

// 'custom' accounts have no remote API: playtime is pushed to
// POST /api/v1/accounts/:id/report (Playnite, scripts, Switch spreadsheets, ...).
const custom = {
  id: 'custom',
  label: 'Custom / API push',
  fields: [
    { key: 'platform_label', label: 'Platform label', type: 'text', required: false, placeholder: 'Switch, Epic, GOG, Emulator…' },
    { key: 'last_played_meaning', label: 'Your last_played_at marks the session…', type: 'select', options: ['end', 'start'], required: false, help: 'Whether the last_played_at you push is when a session ended (default) or started.' },
  ],
  notes: 'Push lifetime playtime totals to this account via the API. Deltas between reports become sessions exactly like Steam/Xbox/PlayStation syncs. Include first/last played dates and play counts if your source has them - they are used to date history.',
  push: true,
  profile: {
    history: {
      update: 'on-report',
      last_played: 'end',
      first_played: true,
      play_count: true,
      recent: { days: 14, strict: false },
      complete_library: false, // a report may cover only some games
    },
    presence: { interval_sec: 120, sync_after_sec: null },
  },
  capabilities: {
    lifetime: 'playtime_minutes / playtime_hours you push',
    recent: 'recent_minutes + recent_days (optional)',
    last_played: 'last_played_at (optional)',
    first_played: 'first_played_at (optional)',
    play_count: 'play_count (optional)',
    per_device: 'device (optional)',
    presence: 'POST /api/v1/accounts/:id/presence (optional, e.g. from Home Assistant)',
    history_anchors: 'date_added, first/last played',
    rate_limit: 'None (local)',
    limitations: ['Only as accurate as what you push; report at least daily for daily sessions.'],
  },
  async fetchLibrary() {
    return { items: null };
  },
};

export const providers = { steam, xbox, psn, custom };

export function providerInfo() {
  return Object.values(providers).map((p) => ({
    id: p.id, label: p.label, fields: p.fields, notes: p.notes, push: !!p.push, capabilities: p.capabilities,
    history_model: modelFor(p).describe(), history: p.profile?.history || null,
    presence_interval_sec: p.profile?.presence?.interval_sec || null, sync_after_session_sec: p.profile?.presence?.sync_after_sec || null,
    can_enrich: !!p.enrich,
    achievements: !!p.achievements, // achievements / trophies are read and kept for its titles
  }));
}
