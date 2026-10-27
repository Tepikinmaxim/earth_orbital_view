/**
 * Terra — interactive 3D Earth scene (three.js)
 *
 * Features:
 * - Photoreal Earth: day/night blending shader with soft terminator,
 *   warm twilight band, ocean sun glint, cloud shadows
 * - Clouds layer (drifting, lit by the sun, dark on the night side)
 * - Atmospheric glow (fresnel rim + outer back-side halo)
 * - Star field with twinkle
 * - Sun sprite that follows the computed sun direction
 * - Moon on an inclined orbit with realistic phase lighting + earthshine
 * - City markers: glowing star + HTML label (CSS2D), camera fly-to and follow
 * - Lighting modes: Day / Night / Live (real subsolar point from UTC clock)
 * - Seasons: axial tilt + solar declination (summer +23.44°, winter −23.44°)
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export type LightingMode = 'day' | 'night' | 'live'
export type Season = 'winter' | 'spring' | 'summer' | 'autumn'

export interface TerraSettings {
  lighting: LightingMode
  season: Season
  clouds: boolean
  cityLights: boolean
  atmosphere: boolean
  stars: boolean
  showSun: boolean
  showMoon: boolean
  rotationSpeed: number // 0..3
}

export function seasonFromDate(d: Date): Season {
  const m = d.getMonth()
  if (m >= 2 && m <= 4) return 'spring'
  if (m >= 5 && m <= 7) return 'summer'
  if (m >= 8 && m <= 10) return 'autumn'
  return 'winter'
}

export const DEFAULT_SETTINGS: TerraSettings = {
  lighting: 'live',
  season: seasonFromDate(new Date()),
  clouds: true,
  cityLights: true,
  atmosphere: true,
  stars: true,
  showSun: true,
  showMoon: true,
  rotationSpeed: 1,
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const AXIAL_TILT = 23.44 * (Math.PI / 180)
const BASE_SPIN = 0.03 // rad/s at 1.0x
const SEASON_OFFSET: Record<Season, number> = {
  summer: 0,
  autumn: Math.PI / 2,
  winter: Math.PI,
  spring: -Math.PI / 2,
}
const SEASON_DECLINATION: Record<Season, number> = {
  summer: 23.44,
  winter: -23.44,
  spring: 0,
  autumn: 0,
}

const SUN_DISTANCE = 60

const MOON_ORBIT_RADIUS = 3.4
const MOON_RADIUS = 0.27
const MOON_ORBIT_SPEED = 0.05 // рад/с — полный виток ≈ 2 минуты
const MOON_START_ANGLE = Math.PI - 0.85 // видна слева от планеты сразу после загрузки
const MARKER_FLARE_SIZE = 0.105
const FORWARD_Z = new THREE.Vector3(0, 0, 1)

/* ------------------------------------------------------------------ */
/* Solar position helpers                                              */
/* ------------------------------------------------------------------ */

/** Subsolar point (geographic) for a given UTC date. */
function subsolarPoint(date: Date): { lat: number; lon: number } {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  const doy = (date.getTime() - start) / 86400000
  const lat = -23.44 * Math.cos(((2 * Math.PI) / 365.24) * (doy + 10))
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  let lon = (12 - utcHours) * 15 // east positive
  lon = ((lon + 540) % 360) - 180
  return { lat, lon }
}

/** Direction on the unit sphere (Earth-fixed texture frame) for lat/lon. */
export function latLonToVec3(latDeg: number, lonDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const rad = Math.PI / 180
  const psi = (lonDeg + 180) * rad
  const latR = latDeg * rad
  return out
    .set(
      -Math.cos(psi) * Math.cos(latR),
      Math.sin(latR),
      Math.sin(psi) * Math.cos(latR)
    )
    .normalize()
}

/** Direction (in the Earth-fixed texture frame) for lat/lon. */
function sunDirEarthFixed(
  latDeg: number,
  lonDeg: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const rad = Math.PI / 180
  const psi = (lonDeg + 180) * rad
  const latR = latDeg * rad
  return out
    .set(
      -Math.cos(psi) * Math.cos(latR),
      Math.sin(latR),
      Math.sin(psi) * Math.cos(latR)
    )
    .normalize()
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const COMMON_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const EARTH_FRAG = /* glsl */ `
  uniform sampler2D uDayMap;
  uniform sampler2D uNightMap;
  uniform sampler2D uCloudMap;
  uniform sampler2D uWaterMap;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform float uCloudShift;
  uniform float uCloudsOn;
  uniform float uLightsOn;
  uniform float uAtmosphereOn;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(uCamPos - vPosW);
    vec3 L = normalize(uSunDir);
    float ndl = dot(N, L);

    // cloud shadow (clouds drift relative to the surface)
    vec2 cloudUv = vec2(vUv.x + uCloudShift, vUv.y);
    float cloudShadow = uCloudsOn > 0.5 ? texture2D(uCloudMap, cloudUv).a : 0.0;

    vec3 dayCol = texture2D(uDayMap, vUv).rgb;
    dayCol *= (1.0 - cloudShadow * 0.38);

    float dayLight = clamp(ndl, 0.0, 1.0);
    float dayMix = smoothstep(-0.18, 0.22, ndl);

    // city lights fade out as day arrives
    vec3 nightCol = texture2D(uNightMap, vUv).rgb;
    vec3 lights = nightCol * uLightsOn * (1.0 - dayMix) * 2.2;

    vec3 color = dayCol * dayMix * (0.22 + 0.78 * dayLight) + lights;

    // faint moonlit blue on the night side
    color += vec3(0.016, 0.024, 0.052) * (1.0 - dayMix);

    // warm twilight band along the terminator
    float twilight = smoothstep(0.30, 0.02, abs(ndl));
    color += vec3(1.0, 0.45, 0.18) * twilight * 0.11;

    // ocean sun glint
    float water = texture2D(uWaterMap, vUv).r;
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 42.0) * water * dayLight;
    color += vec3(1.0, 0.95, 0.82) * spec * 0.55;

    // atmospheric fresnel rim on the sphere itself
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.6);
    float rimLight = clamp(ndl * 0.65 + 0.45, 0.08, 1.0);
    color += vec3(0.30, 0.55, 1.0) * fres * rimLight * 0.7 * uAtmosphereOn;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const CLOUD_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float a = tex.a * uOpacity;
    if (a < 0.004) discard;

    vec3 N = normalize(vNormalW);
    float ndl = dot(N, normalize(uSunDir));
    float brightness = smoothstep(-0.12, 0.30, ndl);
    vec3 col = mix(vec3(0.045, 0.065, 0.12), vec3(1.02, 1.01, 0.99), brightness);

    // slight warm tint near the terminator
    float twilight = smoothstep(0.26, 0.02, abs(ndl));
    col += vec3(0.55, 0.22, 0.08) * twilight * 0.25;

    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const MOON_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(uCamPos - vPosW);
    vec3 L = normalize(uSunDir);
    float ndl = dot(N, L);

    float dayMix = smoothstep(-0.08, 0.16, ndl);
    vec3 albedo = texture2D(uMap, vUv).rgb;

    vec3 col = albedo * dayMix * (0.32 + 0.68 * clamp(ndl, 0.0, 1.0));
    // пепельное свечение: ночная сторона чуть подсвечена отражённым от Земли светом
    col += albedo * vec3(0.05, 0.07, 0.13) * (1.0 - dayMix) * 0.55;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const GLOW_VERT = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vNormalW;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uIntensity;
  varying vec3 vNormalV;
  varying vec3 vNormalW;
  void main() {
    float d = dot(normalize(vNormalV), vec3(0.0, 0.0, 1.0));
    float glow = pow(clamp(-d, 0.0, 1.0), 2.4);
    float sunFace = clamp(dot(normalize(vNormalW), normalize(uSunDir)) * 0.7 + 0.5, 0.10, 1.0);
    vec3 col = mix(vec3(0.10, 0.30, 0.95), vec3(0.45, 0.70, 1.0), glow);
    gl_FragColor = vec4(col * glow * sunFace * uIntensity, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aPhase;
  uniform float uTime;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    float tw = 0.72 + 0.28 * sin(uTime * (0.4 + aPhase * 1.6) + aPhase * 40.0);
    vAlpha = tw;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * tw * (320.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const STAR_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = smoothstep(0.5, 0.06, d) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`

/* ------------------------------------------------------------------ */
/* City markers                                                        */
/* ------------------------------------------------------------------ */

interface CityMarker {
  id: string
  name: string
  group: THREE.Group
  flare: THREE.Sprite
  core: THREE.Mesh
  ring: THREE.Sprite
  labelObj: CSS2DObject
  base: THREE.Vector3
  phase: number
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/* ------------------------------------------------------------------ */
/* Texture helpers                                                     */
/* ------------------------------------------------------------------ */

function makeGlowTexture(stops: Array<[number, string]>, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [offset, color] of stops) g.addColorStop(offset, color)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Яркая «звёздочка» с 4 лучами для метки города. */
function makeStarFlareTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const c = size / 2

  // мягкое круглое свечение (красная звезда: раскалённо-белый центр → красный ореол)
  const g = ctx.createRadialGradient(c, c, 0, c, c, c)
  g.addColorStop(0.0, 'rgba(255,255,255,1)')
  g.addColorStop(0.07, 'rgba(255,232,232,0.95)')
  g.addColorStop(0.22, 'rgba(255,96,96,0.45)')
  g.addColorStop(0.5, 'rgba(255,42,42,0.12)')
  g.addColorStop(1.0, 'rgba(255,20,20,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  // четыре луча — тонкие вытянутые градиенты
  const drawRay = (rot: number, len: number, w: number, alpha: number) => {
    ctx.save()
    ctx.translate(c, c)
    ctx.rotate(rot)
    ctx.scale(1, w)
    const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, len)
    rg.addColorStop(0, `rgba(255,255,255,${alpha})`)
    rg.addColorStop(0.25, `rgba(255,170,170,${alpha * 0.55})`)
    rg.addColorStop(1, 'rgba(255,70,70,0)')
    ctx.fillStyle = rg
    ctx.fillRect(-len, -len, len * 2, len * 2)
    ctx.restore()
  }
  drawRay(0, c * 0.98, 0.045, 0.95)
  drawRay(Math.PI / 2, c * 0.98, 0.045, 0.95)
  drawRay(Math.PI / 4, c * 0.55, 0.05, 0.45)
  drawRay(-Math.PI / 4, c * 0.55, 0.05, 0.45)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Пульсирующее кольцо-«пинг» вокруг метки. */
function makeRingPulseTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const c = size / 2
  ctx.strokeStyle = 'rgba(255,84,84,0.95)'
  ctx.lineWidth = 3
  ctx.shadowColor = 'rgba(255,40,40,0.9)'
  ctx.shadowBlur = 7
  ctx.beginPath()
  ctx.arc(c, c, c - 9, 0, Math.PI * 2)
  ctx.stroke()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/* ------------------------------------------------------------------ */
/* Scene factory                                                       */
/* ------------------------------------------------------------------ */

export interface TerraCallbacks {
  onProgress?(loaded: number, total: number): void
  onReady?(): void
}

export interface TerraDebug {
  getSun(): number[]
  getTarget(): number[]
  getLighting(): LightingMode
  getCam(): number[]
  getMoon(): { visible: boolean; pos: number[] }
  lookAtSun(): number[]
}

export interface TerraController {
  setSettings(s: TerraSettings): void
  dispose(): void
  addCityMarker(id: string, name: string, lat: number, lon: number): void
  removeCityMarker(id: string): void
  clearCityMarkers(): void
  focusCity(id: string): void
  __debug: TerraDebug
}

export function createTerraScene(
  container: HTMLElement,
  callbacks: TerraCallbacks = {}
): TerraController {
  /* ----- renderer / scene / camera -------------------------------- */
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.touchAction = 'none'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(
    42,
    container.clientWidth / container.clientHeight,
    0.1,
    500
  )

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.06
  controls.rotateSpeed = 0.55
  controls.zoomSpeed = 0.7
  controls.enablePan = false
  controls.minDistance = 1.45
  controls.maxDistance = 16

  // adaptive initial distance: pull back on narrow/portrait screens
  const isPortrait = container.clientWidth / Math.max(container.clientHeight, 1) < 0.9
  const DEFAULT_CAMERA_POS = new THREE.Vector3(0, isPortrait ? 0.7 : 0.55, isPortrait ? 4.6 : 3.35)
  camera.position.copy(DEFAULT_CAMERA_POS)
  camera.lookAt(0, 0, 0)

  /* ----- textures -------------------------------------------------- */
  const manager = new THREE.LoadingManager()
  manager.onProgress = (url, loaded, total) => callbacks.onProgress?.(loaded, total)
  manager.onLoad = () => callbacks.onReady?.()
  // Fallback in case onLoad does not fire (cached/errored edge cases)
  setTimeout(() => callbacks.onReady?.(), 12000)

  const loader = new THREE.TextureLoader(manager)
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())

  const dayMap = loader.load('/textures/earth-day.jpg')
  const nightMap = loader.load('/textures/earth-night.jpg')
  const cloudMap = loader.load('/textures/clouds.png')
  const waterMap = loader.load('/textures/earth-water.png')
  for (const t of [dayMap, nightMap, cloudMap]) {
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = maxAniso
  }
  cloudMap.wrapS = THREE.RepeatWrapping
  waterMap.anisotropy = maxAniso

  /* ----- earth ------------------------------------------------------ */
  const tiltGroup = new THREE.Group()
  const spinGroup = new THREE.Group()
  tiltGroup.add(spinGroup)
  scene.add(tiltGroup)

  const earthMat = new THREE.ShaderMaterial({
    vertexShader: COMMON_VERT,
    fragmentShader: EARTH_FRAG,
    uniforms: {
      uDayMap: { value: dayMap },
      uNightMap: { value: nightMap },
      uCloudMap: { value: cloudMap },
      uWaterMap: { value: waterMap },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uCamPos: { value: new THREE.Vector3() },
      uCloudShift: { value: 0 },
      uCloudsOn: { value: 1 },
      uLightsOn: { value: 1 },
      uAtmosphereOn: { value: 1 },
    },
  })
  const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), earthMat)
  spinGroup.add(earthMesh)

  /* ----- clouds ------------------------------------------------------ */
  const cloudMat = new THREE.ShaderMaterial({
    vertexShader: COMMON_VERT,
    fragmentShader: CLOUD_FRAG,
    uniforms: {
      uMap: { value: cloudMap },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
  })
  const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 64), cloudMat)
  cloudMesh.renderOrder = 1
  spinGroup.add(cloudMesh)

  /* ----- atmosphere halo --------------------------------------------- */
  const glowMat = new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uIntensity: { value: 2.0 },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const glowMesh = new THREE.Mesh(new THREE.SphereGeometry(1.16, 96, 64), glowMat)
  glowMesh.renderOrder = 2
  scene.add(glowMesh)

  /* ----- city-label overlay (CSS2D) ------------------------------------ */
  const labelRenderer = new CSS2DRenderer()
  labelRenderer.setSize(container.clientWidth, container.clientHeight)
  const labelDom = labelRenderer.domElement
  labelDom.style.position = 'absolute'
  labelDom.style.top = '0'
  labelDom.style.left = '0'
  labelDom.style.pointerEvents = 'none'
  labelDom.style.zIndex = '15'
  container.appendChild(labelDom)

  /* ----- moon ----------------------------------------------------------- */
  const moonTex = loader.load('/textures/moon.jpg')
  moonTex.colorSpace = THREE.SRGBColorSpace
  moonTex.anisotropy = maxAniso
  const moonMat = new THREE.ShaderMaterial({
    vertexShader: COMMON_VERT,
    fragmentShader: MOON_FRAG,
    uniforms: {
      uMap: { value: moonTex },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uCamPos: { value: new THREE.Vector3() },
    },
  })
  const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 64, 48), moonMat)
  moonMesh.position.set(MOON_ORBIT_RADIUS, 0, 0)
  const moonPivot = new THREE.Group()
  moonPivot.rotation.x = 0.15 // наклон орбиты ≈ 9°
  moonPivot.rotation.z = 0.06
  moonPivot.add(moonMesh)
  scene.add(moonPivot)

  /* ----- city markers ------------------------------------------------------ */
  const starFlareTex = makeStarFlareTexture()
  const ringPulseTex = makeRingPulseTexture()
  const markersRoot = new THREE.Group()
  spinGroup.add(markersRoot)
  const cityMarkers = new Map<string, CityMarker>()

  function addCityMarker(id: string, name: string, lat: number, lon: number) {
    if (cityMarkers.has(id)) return
    const base = latLonToVec3(lat, lon, new THREE.Vector3())

    const group = new THREE.Group()
    group.position.copy(base).multiplyScalar(1.004)
    group.quaternion.setFromUnitVectors(FORWARD_Z, base)

    const flare = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: starFlareTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      })
    )
    flare.scale.setScalar(MARKER_FLARE_SIZE)
    flare.position.z = 0.01
    flare.renderOrder = 10
    group.add(flare)

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.0085, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe2e2, transparent: true, opacity: 0 })
    )
    core.renderOrder = 11
    group.add(core)

    const ring = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: ringPulseTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      })
    )
    ring.position.z = 0.012
    ring.renderOrder = 12
    group.add(ring)

    const labelEl = document.createElement('div')
    labelEl.className = 'terra-city-label'
    labelEl.innerHTML = `<i></i><span>${escapeHtml(name)}</span>`
    const labelObj = new CSS2DObject(labelEl)
    group.add(labelObj)

    markersRoot.add(group)
    cityMarkers.set(id, {
      id,
      name,
      group,
      flare,
      core,
      ring,
      labelObj,
      base: base.clone(),
      phase: Math.random() * Math.PI * 2,
    })
  }

  function removeCityMarker(id: string) {
    const m = cityMarkers.get(id)
    if (!m) return
    if (followId === id) followId = null
    if (flyAnim && flyAnim.id === id) flyAnim = null
    markersRoot.remove(m.group)
    m.labelObj.element.remove()
    m.flare.material.dispose()
    m.ring.material.dispose()
    m.core.geometry.dispose()
    ;(m.core.material as THREE.Material).dispose()
    cityMarkers.delete(id)
  }

  function clearCityMarkers() {
    for (const id of Array.from(cityMarkers.keys())) removeCityMarker(id)
  }

  function focusCity(id: string) {
    const m = cityMarkers.get(id)
    if (!m) return
    m.group.getWorldPosition(tmpDir)
    flyAnim = {
      id,
      fromDir: camera.position.clone().normalize(),
      fromDist: camera.position.length(),
      toDist: THREE.MathUtils.clamp(camera.position.length(), 2.0, 2.7),
      start: performance.now(),
    }
    controls.enabled = false
    followId = null
  }

  /* ----- stars -------------------------------------------------------- */
  const STAR_COUNT = 3200
  const starGeo = new THREE.BufferGeometry()
  {
    const pos = new Float32Array(STAR_COUNT * 3)
    const col = new Float32Array(STAR_COUNT * 3)
    const size = new Float32Array(STAR_COUNT)
    const phase = new Float32Array(STAR_COUNT)
    const palette = [
      [1.0, 1.0, 1.0],
      [0.82, 0.88, 1.0],
      [1.0, 0.93, 0.80],
      [1.0, 0.85, 0.72],
      [0.90, 0.95, 1.0],
    ]
    for (let i = 0; i < STAR_COUNT; i++) {
      // uniform direction on sphere, radius 70..115
      const u = Math.random() * 2 - 1
      const theta = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      const r = 70 + Math.random() * 45
      pos[i * 3] = s * Math.cos(theta) * r
      pos[i * 3 + 1] = u * r
      pos[i * 3 + 2] = s * Math.sin(theta) * r
      const c = palette[Math.floor(Math.random() * palette.length)]
      const dim = 0.55 + Math.random() * 0.45
      col[i * 3] = c[0] * dim
      col[i * 3 + 1] = c[1] * dim
      col[i * 3 + 2] = c[2] * dim
      size[i] = 0.5 + Math.pow(Math.random(), 3) * 2.4
      phase[i] = Math.random()
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
  }
  const starMat = new THREE.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const starPoints = new THREE.Points(starGeo, starMat)
  scene.add(starPoints)

  /* ----- sun sprites --------------------------------------------------- */
  const sunCoreTex = makeGlowTexture([
    [0.0, 'rgba(255,255,255,1)'],
    [0.10, 'rgba(255,250,230,1)'],
    [0.22, 'rgba(255,222,140,0.95)'],
    [0.42, 'rgba(255,185,80,0.38)'],
    [0.70, 'rgba(255,150,50,0.10)'],
    [1.0, 'rgba(255,140,40,0)'],
  ])
  const sunHaloTex = makeGlowTexture([
    [0.0, 'rgba(255,235,190,0.55)'],
    [0.35, 'rgba(255,200,120,0.18)'],
    [0.70, 'rgba(255,170,80,0.05)'],
    [1.0, 'rgba(255,160,70,0)'],
  ], 256)
  const sunCore = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunCoreTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  )
  sunCore.scale.setScalar(7.5)
  const sunHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunHaloTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.85,
    })
  )
  sunHalo.scale.setScalar(20)
  const sunGroup = new THREE.Group()
  sunGroup.add(sunCore, sunHalo)
  scene.add(sunGroup)

  /* ----- state --------------------------------------------------------- */
  let settings: TerraSettings = { ...DEFAULT_SETTINGS }
  let disposed = false

  const sunWorld = new THREE.Vector3(1, 0.15, 0.25).normalize() // smoothed, world space
  const sunTarget = new THREE.Vector3(1, 0, 0)
  const sunFixed = new THREE.Vector3(1, 0, 0) // earth-fixed
  const tmpQ = new THREE.Quaternion()
  const tmpQStep = new THREE.Quaternion()
  const tmpQFull = new THREE.Quaternion()
  const tmpV = new THREE.Vector3()

  let tiltAzimuth = Math.atan2(camera.position.z, camera.position.x)
  let cloudDrift = 0
  let spinAngle = 0
  let clockTime = performance.now()

  // double-click reset animation
  let resetAnim: { from: THREE.Vector3; start: number } | null = null

  // луна и метки городов
  let moonAngle = MOON_START_ANGLE
  let followId: string | null = null
  let flyAnim: {
    id: string
    fromDir: THREE.Vector3
    fromDist: number
    toDist: number
    start: number
  } | null = null
  const prevFollowDir = new THREE.Vector3()
  const tmpDir = new THREE.Vector3()
  const tmpQFly = new THREE.Quaternion()
  const tmpQFlyPart = new THREE.Quaternion()

  function applySeasonTilt(azimuth: number) {
    // tilt the Y axis toward horizontal direction d=(cos a, 0, sin a)
    const axis = tmpV.set(Math.sin(azimuth), 0, -Math.cos(azimuth)).clone()
    tiltGroup.quaternion.setFromAxisAngle(axis, AXIAL_TILT)
  }

  function computeSunTarget(): THREE.Vector3 {
    const now = new Date()
    if (settings.lighting === 'day') {
      return sunTarget.copy(camera.position).normalize()
    }
    if (settings.lighting === 'night') {
      return sunTarget.copy(camera.position).normalize().negate()
    }
    // live / season: declination by season (or real), longitude from real clock
    const { lon } = subsolarPoint(now)
    const lat =
      settings.lighting === 'live' && settings.season === seasonFromDate(now)
        ? subsolarPoint(now).lat
        : SEASON_DECLINATION[settings.season]
    sunDirEarthFixed(lat, lon, sunFixed)
    spinGroup.getWorldQuaternion(tmpQ)
    return sunTarget.copy(sunFixed).applyQuaternion(tmpQ)
  }

  /* ----- events --------------------------------------------------------- */
  const onDblClick = () => {
    followId = null
    flyAnim = null
    controls.enabled = true
    resetAnim = { from: camera.position.clone(), start: performance.now() }
  }
  renderer.domElement.addEventListener('dblclick', onDblClick)

  // любое взаимодействие с камерой отключает слежение за городом
  const onControlsStart = () => {
    followId = null
  }
  controls.addEventListener('start', onControlsStart)

  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    labelRenderer.setSize(w, h)
  })
  resizeObserver.observe(container)

  /* ----- main loop ------------------------------------------------------- */
  const DEFAULT_SMOOTHED = sunWorld.clone()

  function tick(nowMs: number) {
    if (disposed) return
    requestAnimationFrame(tick)

    const dt = Math.min((nowMs - clockTime) / 1000, 0.1)
    clockTime = nowMs
    const t = nowMs / 1000

    // -- spin
    const speed = settings.rotationSpeed
    spinAngle += BASE_SPIN * speed * dt
    spinGroup.rotation.y = spinAngle

    // -- cloud drift (relative to the surface)
    cloudDrift += (0.0026 + BASE_SPIN * speed * 0.16) * dt
    cloudMesh.rotation.y = cloudDrift
    earthMat.uniforms.uCloudShift.value = -cloudDrift / (Math.PI * 2)

    // -- axial tilt (cosmetic lean, follows camera azimuth + season)
    const camAz = Math.atan2(camera.position.z, camera.position.x)
    const targetAz = camAz + SEASON_OFFSET[settings.season]
    let dAz = targetAz - tiltAzimuth
    while (dAz > Math.PI) dAz -= Math.PI * 2
    while (dAz < -Math.PI) dAz += Math.PI * 2
    tiltAzimuth += dAz * (1 - Math.exp(-dt * 2.5))
    applySeasonTilt(tiltAzimuth)

    // -- sun direction (smoothed, spherical — never passes through zero)
    computeSunTarget()
    const sunK = 1 - Math.exp(-dt * 3.2)
    const sunAngle = sunWorld.angleTo(sunTarget)
    if (sunAngle < 1e-4) {
      sunWorld.copy(sunTarget)
    } else {
      tmpQFull.setFromUnitVectors(sunWorld, sunTarget)
      tmpQStep.identity().slerp(tmpQFull, sunK)
      sunWorld.applyQuaternion(tmpQStep).normalize()
    }

    earthMat.uniforms.uSunDir.value.copy(sunWorld)
    cloudMat.uniforms.uSunDir.value.copy(sunWorld)
    glowMat.uniforms.uSunDir.value.copy(sunWorld)
    earthMat.uniforms.uCamPos.value.copy(camera.position)

    // -- sun sprite
    sunGroup.position.copy(sunWorld).multiplyScalar(SUN_DISTANCE)

    // -- moon orbit
    moonAngle += MOON_ORBIT_SPEED * dt
    moonPivot.rotation.y = moonAngle
    moonMat.uniforms.uSunDir.value.copy(sunWorld)
    moonMat.uniforms.uCamPos.value.copy(camera.position)

    // -- city markers: pulse + gating по видимой стороне
    for (const m of cityMarkers.values()) {
      m.group.getWorldPosition(tmpDir)
      const facing = tmpDir.dot(camera.position) // > 1.0 → город на видимой стороне
      const vis = THREE.MathUtils.clamp((facing - 1.0) / 0.1, 0, 1)
      const pulse = 1 + 0.14 * Math.sin(t * 2.6 + m.phase)
      m.flare.scale.setScalar(MARKER_FLARE_SIZE * pulse)
      m.flare.material.opacity = vis
      ;(m.core.material as THREE.MeshBasicMaterial).opacity = vis
      const p = (t * 0.5 + m.phase * 0.13) % 1
      m.ring.scale.setScalar(0.045 + p * 0.17)
      m.ring.material.opacity = vis * (1 - p) * 0.5
      m.labelObj.visible = vis > 0.35
    }

    // -- camera fly-to-city
    if (flyAnim) {
      const m = cityMarkers.get(flyAnim.id)
      if (!m) {
        flyAnim = null
        controls.enabled = true
      } else {
        const k = Math.min((nowMs - flyAnim.start) / 1100, 1)
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
        m.group.getWorldPosition(tmpDir)
        tmpDir.normalize()
        tmpQFly.setFromUnitVectors(flyAnim.fromDir, tmpDir)
        tmpQFlyPart.identity().slerp(tmpQFly, e)
        const dist = THREE.MathUtils.lerp(flyAnim.fromDist, flyAnim.toDist, e)
        camera.position.copy(flyAnim.fromDir).applyQuaternion(tmpQFlyPart).multiplyScalar(dist)
        controls.target.set(0, 0, 0)
        if (k >= 1) {
          prevFollowDir.copy(tmpDir)
          followId = flyAnim.id
          flyAnim = null
          controls.enabled = true
        }
      }
    } else if (followId) {
      // слежение: камера вращается вместе с Землёй, город остаётся в центре
      const m = cityMarkers.get(followId)
      if (!m) {
        followId = null
      } else {
        m.group.getWorldPosition(tmpDir)
        tmpDir.normalize()
        const ang = prevFollowDir.angleTo(tmpDir)
        if (ang > 1e-7) {
          tmpQFly.setFromUnitVectors(prevFollowDir, tmpDir)
          camera.position.applyQuaternion(tmpQFly)
          prevFollowDir.copy(tmpDir)
        }
      }
    }

    // -- double-click reset animation
    if (resetAnim) {
      const k = Math.min((nowMs - resetAnim.start) / 900, 1)
      const e = 1 - Math.pow(1 - k, 3)
      camera.position.lerpVectors(resetAnim.from, DEFAULT_CAMERA_POS, e)
      controls.target.set(0, 0, 0)
      if (k >= 1) resetAnim = null
    }

    starMat.uniforms.uTime.value = t
    controls.update()
    renderer.render(scene, camera)
    labelRenderer.render(scene, camera)
  }
  requestAnimationFrame((ms) => {
    clockTime = ms
    tick(ms)
  })

  /* ----- settings API ------------------------------------------------------ */
  function setSettings(s: TerraSettings) {
    settings = { ...s }
    cloudMat.uniforms.uOpacity.value = s.clouds ? 1 : 0
    cloudMesh.visible = s.clouds
    earthMat.uniforms.uCloudsOn.value = s.clouds ? 1 : 0
    earthMat.uniforms.uLightsOn.value = s.cityLights ? 1 : 0
    earthMat.uniforms.uAtmosphereOn.value = s.atmosphere ? 1 : 0
    glowMesh.visible = s.atmosphere
    starPoints.visible = s.stars
    sunCore.visible = s.showSun
    sunHalo.visible = s.showSun
    moonPivot.visible = s.showMoon
  }
  setSettings(settings)

  function dispose() {
    disposed = true
    renderer.domElement.removeEventListener('dblclick', onDblClick)
    controls.removeEventListener('start', onControlsStart)
    clearCityMarkers()
    resizeObserver.disconnect()
    controls.dispose()
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = (mesh as unknown as { material?: THREE.Material }).material
      if (mat) {
        const m = mat as THREE.Material & { map?: THREE.Texture }
        m.map?.dispose()
        mat.dispose()
      }
    })
    dayMap.dispose()
    nightMap.dispose()
    cloudMap.dispose()
    waterMap.dispose()
    sunCoreTex.dispose()
    sunHaloTex.dispose()
    moonTex.dispose()
    starFlareTex.dispose()
    ringPulseTex.dispose()
    renderer.dispose()
    if (renderer.domElement.parentElement === container) {
      container.removeChild(renderer.domElement)
    }
    if (labelDom.parentElement === container) {
      container.removeChild(labelDom)
    }
  }

  // adaptive distance already applied above

  return {
    setSettings,
    dispose,
    addCityMarker,
    removeCityMarker,
    clearCityMarkers,
    focusCity,
    __debug: {
      getSun: () => sunWorld.toArray(),
      getTarget: () => sunTarget.toArray(),
      getLighting: () => settings.lighting,
      getCam: () => camera.position.toArray(),
      getMoon: () => ({
        visible: moonPivot.visible,
        pos: moonMesh.getWorldPosition(new THREE.Vector3()).toArray().map((n) => +n.toFixed(2)),
      }),
      lookAtSun: () => {
        const perp = new THREE.Vector3(0, 1, 0).cross(sunWorld)
        if (perp.lengthSq() < 0.01) perp.set(1, 0, 0)
        perp.normalize()
        camera.position
          .copy(sunWorld)
          .multiplyScalar(-2.5)
          .addScaledVector(perp, 6.0)
        controls.target.copy(sunWorld).multiplyScalar(24)
        return camera.position.toArray()
      },
    },
  }
}
