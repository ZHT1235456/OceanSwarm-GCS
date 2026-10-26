// =============================================================================
// HDRI sky loader.
//
// The atmosphere is a locally stored Poly Haven panorama:
//   "Kloppenheim 06 (Pure Sky)" — 2K equirectangular HDR (2048 x 1024 RGBE).
// The file lives in public/hdr/ and is served from the app itself, so the
// scene never touches the network at runtime and works offline.
//
// The loaded texture is reused by three consumers so that the visible sky,
// the sea reflections and the metal/glass environment all describe the same
// atmosphere:
//   * sky dome shader        — direct equirectangular lookup (core/sky.js)
//   * ocean shader           — reflection + horizon haze lookup (core/ocean.js)
//   * PMREM environment map  — image-based lighting for metal / glass
// =============================================================================
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WORLD } from '../config.js';

function hdrUrl() {
  const base = (import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${base}${WORLD.sky.hdrPath}`;
}

/**
 * Load the local 2K HDR panorama and derive an IBL environment from it.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @returns {Promise<{url: string, texture: THREE.Texture, envMap: THREE.Texture, envTarget: THREE.WebGLRenderTarget}>}
 */
export async function loadHdrSky(renderer) {
  const url = hdrUrl();
  const loader = new HDRLoader();
  const texture = await loader.loadAsync(url);
  texture.name = 'kloppenheim-06-puresky-2k';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  // Horizontal wrap is essential: u = atan2(z, x)/2pi + 0.5 wraps at azimuth
  // +/-180 degrees, and with ClampToEdge + mipmaps that seam shows up as a
  // blurry vertical band in the sky.
  texture.wrapS = THREE.RepeatWrapping;
  // The 2048 px panorama is stretched over the full 360 degrees, so mipmaps +
  // anisotropy are essential to keep the horizon clean while the camera orbits.
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envTarget = pmrem.fromEquirectangular(texture);
  pmrem.dispose();

  return { url, texture, envMap: envTarget.texture, envTarget };
}
