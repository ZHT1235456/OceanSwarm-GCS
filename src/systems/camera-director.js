// =============================================================================
// Camera director — decides how the observation camera follows the operation.
//
//   fleet : the camera rides with the swarm centroid (inherited cinematic
//           behaviour); the operator can still orbit/zoom around the formation.
//   lock  : the camera locks onto one hull and pans with it, keeping the
//           current orbit offset (selection focus / "跟随目标").
//   free  : the camera stays in world space (used by base / reef presets).
// =============================================================================
import * as THREE from 'three';

export function createCameraDirector({ camera, controls, fleet, boats }) {
  const state = {
    mode: 'fleet',
    lockId: null,
    lerp: 1 - Math.exp(-0.12), // per-call base, replaced by dt-aware factor
  };
  const desiredTarget = new THREE.Vector3();
  const shift = new THREE.Vector3();
  const boatDelta = new THREE.Vector3();
  const lastBoatPos = new THREE.Vector3();
  let hasLastBoatPos = false;

  const boatById = () => (state.lockId ? boats.find((b) => b.id === state.lockId) : null);

  function focusFleet() {
    state.mode = 'fleet';
    state.lockId = null;
    hasLastBoatPos = false;
  }

  function focusVessel(id) {
    const boat = boats.find((b) => b.id === id);
    if (!boat) return;
    state.mode = 'lock';
    state.lockId = id;
    lastBoatPos.copy(boat.group.position);
    hasLastBoatPos = true;
  }

  function setMode(mode) {
    if (mode === 'free') {
      state.mode = 'free';
      hasLastBoatPos = false;
      return;
    }
    if (mode === 'lock') {
      if (state.lockId) state.mode = 'lock';
      else state.mode = 'fleet';
      return;
    }
    focusFleet();
  }

  /** Let presets re-aim without fighting the director. */
  function applyPreset(presetFn) {
    if (typeof presetFn === 'function') presetFn();
    if (state.mode === 'lock') {
      const boat = boatById();
      if (boat) {
        lastBoatPos.copy(boat.group.position);
        hasLastBoatPos = true;
      }
    }
  }

  function update(dt) {
    const smooth = 1 - Math.exp(-Math.max(dt, 0) * 2.4);

    if (state.mode === 'fleet') {
      // ride with the swarm centroid (fleet.delta is the live centroid delta)
      camera.position.add(fleet.delta);
      controls.target.add(fleet.delta);
      controls.update();
      return;
    }

    if (state.mode === 'lock') {
      const boat = boatById();
      if (!boat) {
        focusFleet();
        return;
      }
      // pan target (and camera by the same amount, preserving user orbit)
      desiredTarget.copy(boat.group.position);
      desiredTarget.y = Math.max(desiredTarget.y, 3) + 2.4;
      shift.copy(desiredTarget).sub(controls.target);
      const pan = Math.min(1, smooth * 1.8);
      controls.target.addScaledVector(shift, pan);
      camera.position.addScaledVector(shift, pan);

      // keep up with the hull's own motion
      if (hasLastBoatPos) {
        boatDelta.copy(boat.group.position).sub(lastBoatPos);
        camera.position.add(boatDelta);
        controls.target.add(boatDelta);
      }
      lastBoatPos.copy(boat.group.position);
      hasLastBoatPos = true;
      controls.update();
      return;
    }

    // free
    controls.update();
  }

  return {
    state,
    update,
    focusFleet,
    focusVessel,
    setMode,
    applyPreset,
    getMode: () => state.mode,
    getLockId: () => state.lockId,
  };
}
