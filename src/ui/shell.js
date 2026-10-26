// =============================================================================
// GCS shell — creates the static region host elements once. Panels mount into
// their host; nothing else in the app may change this structure.
// =============================================================================
export function createShell(mount = document.body) {
  const root = document.createElement('div');
  root.id = 'gcs-root';
  root.innerHTML = `
    <div class="gcs-vignette" aria-hidden="true"></div>
    <header id="gcs-topbar" class="gcs-host gcs-topbar-host"></header>
    <aside id="gcs-left" class="gcs-host gcs-rail gcs-rail--left"></aside>
    <main id="gcs-center">
      <section id="gcs-viewport">
        <div id="gcs-map" hidden></div>
        <div id="gcs-hud"></div>
        <div class="gcs-viewport-frame" aria-hidden="true"></div>
      </section>
      <footer id="gcs-dock" class="gcs-host gcs-dock-host"></footer>
    </main>
    <aside id="gcs-right" class="gcs-host gcs-rail gcs-rail--right"></aside>
    <div id="gcs-overlays"></div>
    <div class="gcs-clean-hint" aria-hidden="true">
      <span class="gcs-clean-hint-key">H</span> 退出纯净视景
    </div>
  `;
  mount.appendChild(root);
  const byId = (id) => root.querySelector(`#${id}`);
  return {
    root,
    hosts: {
      topbar: byId('gcs-topbar'),
      left: byId('gcs-left'),
      center: byId('gcs-center'),
      viewport: byId('gcs-viewport'),
      hud: byId('gcs-hud'),
      map: byId('gcs-map'),
      dock: byId('gcs-dock'),
      right: byId('gcs-right'),
      overlays: byId('gcs-overlays'),
    },
  };
}
