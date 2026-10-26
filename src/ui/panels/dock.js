// =============================================================================
// PLACEHOLDER — DOCK panel. Real implementation is owned by a teammate.
// Contract: see docs/GCS-architecture.md §4.1 / ctx API §4.2.
// =============================================================================
export function createDockPanel(ctx) {
  const root = document.createElement('div');
  root.className = 'gcs-panel gcs-placeholder';
  root.innerHTML = '<div class="gcs-panel-head"><span class="gcs-panel-index">--</span>' +
    '<h2 class="gcs-panel-title">DOCK <em>PLACEHOLDER</em></h2></div>' +
    '<div class="gcs-panel-body" style="padding:14px;color:rgba(200,230,238,.5)">TODO: DOCK</div>';

  return {
    name: 'dock',
    mount(host) {
      host.appendChild(root);

    },
    update() {},
    frame() {},
  };
}
