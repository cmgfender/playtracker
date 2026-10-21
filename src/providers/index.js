import { steam } from './steam.js';
import { xbox } from './xbox.js';
import { psn } from './psn.js';

// 'custom' accounts have no remote API: playtime is pushed to
// POST /api/v1/accounts/:id/report (Playnite, scripts, Switch spreadsheets, ...).
const custom = {
  id: 'custom',
  label: 'Custom / API push',
  fields: [
    { key: 'platform_label', label: 'Platform label', type: 'text', required: false, placeholder: 'Switch, Epic, GOG, Emulator…' },
  ],
  notes: 'Push lifetime playtime totals to this account via the API. Deltas between reports become sessions exactly like Steam/Xbox/PlayStation syncs.',
  push: true,
  async fetchLibrary() {
    return { items: null };
  },
};

export const providers = { steam, xbox, psn, custom };

export function providerInfo() {
  return Object.values(providers).map((p) => ({ id: p.id, label: p.label, fields: p.fields, notes: p.notes, push: !!p.push }));
}
