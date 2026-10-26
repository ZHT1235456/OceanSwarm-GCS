// =============================================================================
// Water surface normal map loader.
//
// Poly Haven is the sky; the water micro-relief comes from the classic three.js
// "water normals" photo texture (1024 x 1024, the normal map used by the
// official webgl_shaders_ocean example). It is shipped locally in
// public/textures/ so the scene stays offline-capable, just like the HDR sky.
//
// The ocean shader tiles it through two stretched, slowly drifting coordinate
// systems; the fine ripple structure is what sells the water surface, while the
// large swell continues to come from the shared CPU/GPU wave field.
// =============================================================================
import * as THREE from 'three';
import { WORLD } from '../config.js';

function normalUrl() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}${WORLD.water.normalMapPath}`;
}

/**
 * Load the local tiled water normal map.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @returns {Promise<THREE.Texture>}
 */
export async function loadWaterNormalTexture(renderer) {
  const texture = await new THREE.TextureLoader().loadAsync(normalUrl());
  texture.name = 'water-normals';
  // Normal maps carry direction data, not colour: keep the bytes untouched.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  return texture;
}
