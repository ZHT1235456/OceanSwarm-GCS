// =============================================================================
// Inline SVG icon set for the GCS (fully offline, stroke = currentColor).
// Usage:  icons.icon('radar', 14)  -> svg markup string
//         icons.vesselIcon('scout', 14)
//         icons.sensorIcon('eoir', 12)
//         icons.glyph('M3 18 L12 4 L21 18', 16)   // custom 24x24 path
// =============================================================================

const PATHS = {
  logo:
    '<circle cx="12" cy="4.6" r="1.5"/><circle cx="4.6" cy="17.6" r="1.5"/><circle cx="19.4" cy="17.6" r="1.5"/>' +
    '<path d="M12 6.2 L6 16.2 M12 6.2 L18 16.2 M6.2 17.6 H17.8"/>',

  // --- vessels -------------------------------------------------------------
  'vessel-flagship':
    '<path d="M2.5 14.5 h19 l-2.4 4.5 H4.9 Z"/><path d="M8 14.5 V9 h8 v5.5"/><path d="M12 9 V4.5"/><path d="M10 4.5 h4"/>',
  'vessel-scout': '<path d="M4 17 L12 4.5 L20 17 L12 13.6 Z"/>',
  'vessel-env':
    '<path d="M4 17.5 h16 l-2.8-8 H6.8 Z"/><path d="M12 9.5 V4"/><circle cx="12" cy="3.1" r="1.1"/>',
  'vessel-survey':
    '<path d="M3.5 15 h5.2 l1 4.5 H4.8 Z"/><path d="M15.3 15 h5.2 l-.3 4.5 h-4.8 Z"/><path d="M3.5 15 h17"/><path d="M9 15 V9 h6 v6"/><circle cx="12" cy="5.8" r="1.6"/>',
  'vessel-patrol':
    '<path d="M5 17 V9.2 L12 4 l7 5.2 V17"/><path d="M5 17 h14"/><circle cx="12" cy="11.6" r="2.1"/>',
  'vessel-comms':
    '<path d="M12 20.5 V12"/><path d="M8.6 9.4 a5 5 0 0 1 6.8 0"/><path d="M5.8 6.4 a9 9 0 0 1 12.4 0"/><path d="M4 19 h16"/>',
  'vessel-energy':
    '<rect x="3.5" y="7.5" width="17" height="9.5" rx="1.2"/><path d="M7.5 10.5 v3.5 M12 10.5 v3.5 M16.5 10.5 v3.5"/><path d="M8 4.5 h8"/>',
  'vessel-rescue':
    '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6 v8.8 M7.6 12 h8.8"/>',

  // --- navigation ----------------------------------------------------------
  map: '<path d="M3 6 L9 4 L15 6 L21 4 V18 L15 20 L9 18 L3 20 Z"/><path d="M9 4 V18 M15 6 V20"/>',
  globe:
    '<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12 h16.8"/><path d="M12 3.6 c3 3.4 3 13.4 0 16.8 c-3-3.4-3-13.4 0-16.8 Z"/>',
  crosshair:
    '<circle cx="12" cy="12" r="6.4"/><path d="M12 2.8 V6.4 M12 17.6 V21.2 M2.8 12 H6.4 M17.6 12 H21.2"/>',
  target: '<circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="2.2"/><path d="M12 1.8 V5 M12 19 V22.2 M1.8 12 H5 M19 12 H22.2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="1.4"/><path d="M8.2 10.5 V7.8 a3.8 3.8 0 0 1 7.6 0 v2.7"/><path d="M12 14.2 v2.6"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="1.4"/><path d="M8.2 10.5 V7.8 a3.8 3.8 0 0 1 7.4-1.2"/><path d="M12 14.2 v2.6"/>',
  compass:
    '<circle cx="12" cy="12" r="8.6"/><path d="M12 3.4 L14.4 12 L12 20.6 L9.6 12 Z"/><path d="M12 3.4 V5.6"/>',
  route:
    '<circle cx="5.2" cy="18.6" r="1.7"/><circle cx="18.8" cy="5.4" r="1.7"/><path d="M6.4 17.4 C10.6 13.4 8.8 9.4 13 9.2 c2.6-.1 3.4 1.2 4.6-2.4"/>',
  pin: '<path d="M12 21 c4.4-4.6 7-7.7 7-11.1 A7 7 0 0 0 5 9.9 C5 13.3 7.6 16.4 12 21 Z"/><circle cx="12" cy="9.8" r="2.4"/>',
  anchor:
    '<circle cx="12" cy="4.6" r="1.9"/><path d="M12 6.5 V20.5"/><path d="M7.4 10.4 H16.6"/><path d="M4.4 14.4 c.6 3.6 3.7 6.1 7.6 6.1 s7-2.5 7.6-6.1"/>',

  // --- data / status -------------------------------------------------------
  link:
    '<path d="M3.6 10.4 a12 12 0 0 1 16.8 0"/><path d="M7 14 a7.6 7.6 0 0 1 10 0"/><path d="M10.2 17.4 a3.3 3.3 0 0 1 3.6 0"/><circle cx="12" cy="20.2" r=".7" fill="currentColor" stroke="none"/>',
  satellite:
    '<path d="M12 4.2 a7.8 7.8 0 0 1 7.8 7.8"/><path d="M12 8 a4 4 0 0 1 4 4"/><circle cx="12" cy="15.6" r="1.8"/><path d="M12 17.6 V21"/>',
  radar:
    '<circle cx="12" cy="13" r="8.2"/><circle cx="12" cy="13" r="4.4"/><path d="M12 13 L17.6 6.6"/><circle cx="15.2" cy="10" r=".9" fill="currentColor" stroke="none"/>',
  eoir:
    '<rect x="3.2" y="7.4" width="12.6" height="9.2" rx="1.6"/><path d="M15.8 10.4 L20.8 8 V16 L15.8 13.6"/><circle cx="8.6" cy="12" r="2.2"/>',
  sonar:
    '<path d="M4.4 5.2 a11 11 0 0 1 15.2 0"/><path d="M7 8.2 a7 7 0 0 1 10 0"/><path d="M9.8 11.4 a3.2 3.2 0 0 1 4.4 0"/><circle cx="12" cy="14.6" r="1" fill="currentColor" stroke="none"/>',
  ais: '<path d="M12 3.4 L20.8 20.4 H3.2 Z"/><path d="M12 9.4 v6"/><circle cx="12" cy="18" r=".8" fill="currentColor" stroke="none"/>',
  mesh:
    '<circle cx="12" cy="4.4" r="1.7"/><circle cx="4.6" cy="18" r="1.7"/><circle cx="19.4" cy="18" r="1.7"/><path d="M10.9 5.9 L5.7 16.5 M13.1 5.9 L18.3 16.5 M6.3 18 H17.7"/>',
  battery:
    '<rect x="2.8" y="8" width="15.6" height="8" rx="1.4"/><path d="M21.2 10.6 v2.8"/><path d="M5.2 10.4 v3.2 M8 10.4 v3.2 M10.8 10.4 v3.2"/>',
  power: '<path d="M12 3.6 V11"/><path d="M7.2 6.4 a7.2 7.2 0 1 0 9.6 0"/>',
  temp:
    '<path d="M9.6 13.6 V5.4 a2.4 2.4 0 0 1 4.8 0 V13.6 a4.4 4.4 0 1 1-4.8 0 Z"/><path d="M12 9.4 v6.2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="1.6"/><rect x="9.4" y="9.4" width="5.2" height="5.2" rx=".8"/><path d="M9 3.2 v2.4 M15 3.2 v2.4 M9 18.4 v2.4 M15 18.4 v2.4 M3.2 9 h2.4 M3.2 15 h2.4 M18.4 9 h2.4 M18.4 15 h2.4"/>',
  wave:
    '<path d="M2.6 9.6 c2.2 0 2.2-3 4.4-3 s2.2 3 4.4 3 s2.2-3 4.4-3 s2.2 3 4.4 3"/><path d="M2.6 15.6 c2.2 0 2.2-3 4.4-3 s2.2 3 4.4 3 s2.2-3 4.4-3 s2.2 3 4.4 3"/>',
  wind:
    '<path d="M3 8.4 h9.4 a2.6 2.6 0 1 0-2.6-2.6"/><path d="M3 12.4 h14.4 a2.6 2.6 0 1 1-2.6 2.6"/><path d="M3 16.4 h6.4"/>',

  // --- feedback ------------------------------------------------------------
  warning: '<path d="M12 3.6 L21.4 20 H2.6 Z"/><path d="M12 9.2 v5"/><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none"/>',
  critical:
    '<path d="M8.2 2.8 h7.6 l5.4 5.4 v7.6 l-5.4 5.4 H8.2 L2.8 15.8 V8.2 Z"/><path d="M12 7.6 v5.6"/><circle cx="12" cy="16.8" r=".9" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 10.6 V16.6"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/>',
  help: '<circle cx="12" cy="12" r="8.6"/><path d="M9.4 9.2 a2.7 2.7 0 1 1 3.7 3.4 c-.8.5-1.1 1-1.1 2"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
  check: '<path d="M4.4 12.6 L9.6 17.8 L19.6 6.4"/>',
  close: '<path d="M5.6 5.6 L18.4 18.4 M18.4 5.6 L5.6 18.4"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 6.8 V12 l3.6 2.2"/>',
  operator:
    '<circle cx="12" cy="8" r="3.6"/><path d="M4.6 20.4 c.8-4 3.8-6.2 7.4-6.2 s6.6 2.2 7.4 6.2"/>',
  shield:
    '<path d="M12 3.2 L19.6 6.2 V12 c0 4.4-3 7.6-7.6 8.8 C7.4 19.6 4.4 16.4 4.4 12 V6.2 Z"/><path d="M8.8 11.8 L11.2 14.2 L15.6 9.4"/>',
  send: '<path d="M3.6 11.4 L20.4 4.2 L14.8 20.4 L11.4 13.6 Z"/><path d="M11.4 13.6 L20.4 4.2"/>',
  bell: '<path d="M6 16.8 V11 a6 6 0 0 1 12 0 v5.8"/><path d="M4.4 16.8 h15.2"/><path d="M10 19.6 a2.2 2.2 0 0 0 4 0"/>',

  // --- controls ------------------------------------------------------------
  'chevron-left': '<path d="M14.8 5.6 L8.4 12 L14.8 18.4"/>',
  'chevron-right': '<path d="M9.2 5.6 L15.6 12 L9.2 18.4"/>',
  'chevron-down': '<path d="M5.6 9.2 L12 15.6 L18.4 9.2"/>',
  'chevron-up': '<path d="M5.6 14.8 L12 8.4 L18.4 14.8"/>',
  'arrow-up': '<path d="M12 20 V4.4 M5.6 10.8 L12 4.4 L18.4 10.8"/>',
  'zoom-in': '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 L21 21 M7.8 10.6 h5.6 M10.6 7.8 v5.6"/>',
  'zoom-out': '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 L21 21 M7.8 10.6 h5.6"/>',
  layers:
    '<path d="M12 3.6 L21 8.2 L12 12.8 L3 8.2 Z"/><path d="M3.6 12.4 L12 16.8 L20.4 12.4"/><path d="M3.6 16.4 L12 20.8 L20.4 16.4"/>',
  expand: '<path d="M4 9 V4 h5 M15 4 h5 v5 M20 15 v5 h-5 M9 20 H4 v-5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.8 v2.4 M12 18.8 v2.4 M2.8 12 h2.4 M18.8 12 h2.4 M5.5 5.5 l1.7 1.7 M16.8 16.8 l1.7 1.7 M5.5 18.5 l1.7-1.7 M16.8 7.2 l1.7-1.7"/>',
  play: '<path d="M7.2 4.8 L19.2 12 L7.2 19.2 Z"/>',
  pause: '<path d="M8.4 5 V19 M15.6 5 V19"/>',
  plus: '<path d="M12 4.8 V19.2 M4.8 12 H19.2"/>',
  minus: '<path d="M4.8 12 H19.2"/>',
  dots: '<circle cx="5.4" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M19.6 12 a7.6 7.6 0 1 1-2.2-5.4"/><path d="M19.6 3.6 V7.4 H15.8"/>',
  'map-pin': '<path d="M12 21 c4.4-4.6 7-7.7 7-11.1 A7 7 0 0 0 5 9.9 C5 13.3 7.6 16.4 12 21 Z"/><circle cx="12" cy="9.8" r="2.4"/>',
  ruler: '<path d="M3.4 14.6 L14.6 3.4 l6 6 L9.4 20.6 Z"/><path d="M7 11 l2 2 M9.6 8.4 l2 2 M12.2 5.8 l2 2 M5.8 15.8 l2 2"/>',
  wavepoint: '<circle cx="12" cy="12" r="2.4"/><path d="M12 2.8 V7.6 M12 16.4 v4.8 M2.8 12 H7.6 M16.4 12 h4.8"/>',
  swap: '<path d="M4.4 8.4 h13.2 M14 4.8 l3.6 3.6-3.6 3.6"/><path d="M19.6 15.6 H6.4 M10 12 l-3.6 3.6 3.6 3.6"/>',
};

const VESSEL_ICONS = {
  flagship: 'vessel-flagship',
  scout: 'vessel-scout',
  env: 'vessel-env',
  survey: 'vessel-survey',
  patrol: 'vessel-patrol',
  comms: 'vessel-comms',
  energy: 'vessel-energy',
  rescue: 'vessel-rescue',
};

const SENSOR_ICONS = {
  radar: 'radar',
  eoir: 'eoir',
  sonar: 'sonar',
  ais: 'ais',
  mesh: 'mesh',
};

function svg(inner, size, className, strokeWidth) {
  return (
    `<svg class="gcs-icon${className ? ` ${className}` : ''}" width="${size}" height="${size}" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`
  );
}

export function icon(name, size = 16, className = '') {
  return svg(PATHS[name] || PATHS.info, size, className, name === 'logo' ? 1.5 : 1.6);
}

/** Custom 24x24 stroked path (used for formation glyphs from meta.FORMATIONS). */
export function glyph(pathData, size = 20, className = '', strokeWidth = 1.5) {
  return svg(`<path d="${pathData}"/>`, size, className, strokeWidth);
}

export function vesselIcon(type, size = 16, className = '') {
  return icon(VESSEL_ICONS[type] || 'vessel-scout', size, className);
}

export function sensorIcon(sensorId, size = 14, className = '') {
  return icon(SENSOR_ICONS[sensorId] || 'radar', size, className);
}

/** Build an SVG DOM node (for modules that prefer nodes over markup). */
export function iconNode(name, size = 16, className = '') {
  const template = document.createElement('template');
  template.innerHTML = icon(name, size, className).trim();
  return template.content.firstChild;
}

export const ICON_NAMES = Object.keys(PATHS);
