// =============================================================================
// OceanSwarm GCS — event stream (ring buffer).
//
// Events are the operational log the duty officer reads: command dispatch and
// acknowledgements, alarm raise / escalate / clear, mission phase changes, link
// state and system notices. Field names and text style follow
// docs/GCS-design-system.md §7.4 / §8; the buffer is bounded so a long soak
// cannot grow memory without bound.
// =============================================================================

import { round1, safeNumber } from './format.js';

const EVENT_LIMIT = 400;
const SNAPSHOT_LIMIT = 120;
const SEVERITIES = new Set(['info', 'success', 'warning', 'critical', 'command']);
const CATEGORIES = new Set(['command', 'alarm', 'mission', 'link', 'system']);

export function createEventLog({ clock, limit = EVENT_LIMIT, snapshotLimit = SNAPSHOT_LIMIT } = {}) {
  const buffer = []; // chronological, oldest first
  let counter = 0;

  function add(input = {}) {
    const met = safeNumber(input.met, clock ? clock.metOffset : 0);
    const severity = SEVERITIES.has(input.severity) ? input.severity : 'info';
    const category = CATEGORIES.has(input.category) ? input.category : 'system';
    const detail = input.detail === undefined || input.detail === null ? null : String(input.detail);
    const entry = {
      id: `EV-${String(++counter).padStart(4, '0')}`,
      t: round1(met),
      metText: clock ? clock.metText(met) : '',
      clockText: clock ? clock.clockText(met) : '',
      severity,
      category,
      sourceId: input.sourceId === undefined ? null : input.sourceId,
      sourceLabel: String(input.sourceLabel || '系统'),
      text: String(input.text || ''),
    };
    if (detail !== null && detail !== '') entry.detail = detail;
    if (input.ackMs !== undefined && Number.isFinite(input.ackMs)) entry.ackMs = Math.max(0, Math.round(input.ackMs));
    buffer.push(entry);
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    return entry;
  }

  return {
    add,
    /** Snapshot view: newest first, bounded. Always a fresh array. */
    list() {
      const count = Math.min(snapshotLimit, buffer.length);
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = buffer[buffer.length - 1 - i];
      return out;
    },
    /** Internal access (debug / self-test only). */
    raw() {
      return buffer.slice();
    },
    size() {
      return buffer.length;
    },
    clear() {
      buffer.length = 0;
    },
    limits: { limit, snapshotLimit },
  };
}
