// =============================================================================
// Selection & waypoint FX — world-space markers that tie the GCS UI to the
// three.js scene:
//   · a pulsing aqua ring under the selected hull (with slow rotation),
//   · an amber mission marker for a commanded waypoint (ring + light column),
//   · a thin vector line from the selected hull to its commanded waypoint.
// Pure additive meshes, no textures, no post-processing.
// =============================================================================
import * as THREE from 'three';

const SELECT_COLOR = 0x5ff3e4;
const WAYPOINT_COLOR = 0xffb257;
const LINE_COLOR = 0x9fd6e8;

function makeRing(inner, outer, color, opacity = 0.85) {
  const geo = new THREE.RingGeometry(inner, outer, 64, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 5;
  return mesh;
}

export function createSelectionFx({ scene, boats }) {
  const group = new THREE.Group();
  group.name = 'gcs-selection-fx';
  scene.add(group);

  // --- selection ring --------------------------------------------------------
  const selectGroup = new THREE.Group();
  const selectOuter = makeRing(0.92, 1.0, SELECT_COLOR, 0.9);
  const selectInner = makeRing(0.62, 0.68, SELECT_COLOR, 0.34);
  selectGroup.add(selectOuter, selectInner);
  selectGroup.visible = false;
  group.add(selectGroup);

  // --- waypoint beacon -------------------------------------------------------
  const wpGroup = new THREE.Group();
  const wpRing = makeRing(0.86, 1.0, WAYPOINT_COLOR, 0.8);
  const wpInner = makeRing(0.34, 0.42, WAYPOINT_COLOR, 0.5);
  const beamMat = new THREE.MeshBasicMaterial({
    color: WAYPOINT_COLOR,
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const beamGeo = new THREE.CylinderGeometry(0.7, 1.4, 120, 10, 1, true);
  beamGeo.translate(0, 60, 0);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  wpGroup.add(wpRing, wpInner, beam);
  wpGroup.visible = false;
  group.add(wpGroup);

  // --- waypoint vector line --------------------------------------------------
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    fog: false,
  });
  const line = new THREE.Line(lineGeo, lineMat);
  line.visible = false;
  line.frustumCulled = false;
  group.add(line);

  let selectedId = null;
  let waypoint = null; // {x, z}
  let timeAcc = 0;

  const boatById = (id) => (id ? boats.find((b) => b.id === id) : null);

  function setSelected(id) {
    selectedId = boatById(id) ? id : null;
    selectGroup.visible = false;
    if (!selectedId) return;
  }

  function setWaypoint(x, z, label = null) {
    if (x == null || z == null || !Number.isFinite(x) || !Number.isFinite(z)) {
      waypoint = null;
      wpGroup.visible = false;
      line.visible = false;
      return;
    }
    waypoint = { x, z, label };
    wpGroup.position.set(x, 0.25, z);
    wpGroup.visible = true;
  }

  function update(dt = 0, nowMs = performance.now()) {
    timeAcc += dt || 0;
    const pulse = 0.5 + 0.5 * Math.sin(timeAcc * 2.1);

    const boat = boatById(selectedId);
    if (boat) {
      const p = boat.group.position;
      const len = boat.length || 14;
      const radius = Math.max(9, len * 0.72);
      selectGroup.position.set(p.x, 0.35, p.z);
      selectGroup.scale.setScalar(radius);
      selectGroup.visible = true;
      selectOuter.rotation.y = timeAcc * 0.35;
      selectOuter.material.opacity = 0.55 + pulse * 0.35;
      selectInner.rotation.y = -timeAcc * 0.5;
      selectInner.material.opacity = 0.16 + pulse * 0.2;
      selectInner.scale.setScalar(1 + pulse * 0.06);
    } else {
      selectGroup.visible = false;
    }

    if (waypoint) {
      const s = 1 + Math.sin(timeAcc * 2.4) * 0.05;
      wpRing.scale.setScalar(16 * s);
      wpInner.scale.setScalar(16 * s);
      wpRing.rotation.y = timeAcc * 0.4;
      beamMat.opacity = 0.1 + 0.08 * (0.5 + 0.5 * Math.sin(timeAcc * 1.7));
      // update the vector line from the selected hull to the waypoint
      if (boat) {
        const a = lineGeo.attributes.position;
        const p = boat.group.position;
        a.setXYZ(0, p.x, 2.2, p.z);
        a.setXYZ(1, waypoint.x, 1.2, waypoint.z);
        a.needsUpdate = true;
        line.visible = true;
      } else {
        line.visible = false;
      }
    } else {
      line.visible = false;
    }
  }

  function dispose() {
    scene.remove(group);
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }

  return {
    group,
    update,
    setSelected,
    setWaypoint,
    getSelected: () => selectedId,
    getWaypoint: () => waypoint,
    dispose,
  };
}
