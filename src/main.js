import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { generateProceduralHeightmap, loadHeightmap } from './utils/heightmap.js'
import { TerrainBuilder } from './utils/terrain.js'
import { FPSController } from './utils/controller.js'

// ── UI helpers ───────────────────────────────────────────────────────────────
const loadingEl   = document.getElementById('loading')
const loadingBar  = document.getElementById('loading-bar')
const loadingText = document.getElementById('loading-status')
const posX        = document.getElementById('pos-x')
const posY        = document.getElementById('pos-y')
const posZ        = document.getElementById('pos-z')
const speedFill   = document.getElementById('speed-fill')

function setProgress(pct, msg) {
  loadingBar.style.width = pct + '%'
  loadingText.textContent = msg
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {

  // 1 ── Init Rapier WASM ────────────────────────────────────────────────────
  setProgress(10, 'LOADING RAPIER PHYSICS...')
  await RAPIER.init()

  // 2 ── Load heightmap ──────────────────────────────────────────────────────
  setProgress(25, 'LOADING HEIGHTMAP...')
  let heightData
  try {
    // Put your Blender-exported PNG at /public/heightmap.png
    heightData = await loadHeightmap('/heightmap.png', 101)
    console.log('✅ Loaded heightmap.png')
  } catch {
    console.log('ℹ️  No heightmap.png — using procedural terrain')
    heightData = generateProceduralHeightmap(101)
  }

  // 3 ── Build terrain data ──────────────────────────────────────────────────
  setProgress(40, 'BUILDING TERRAIN...')
  const terrainBuilder = new TerrainBuilder({
    heights:      heightData.heights,
    size:         heightData.size,
    worldSize:    200,   // metres — must match your Blender plane size
    heightScale:  14,    // max height in metres (Blender Strength × 5)
    heightOffset: 0,
  })

  // 4 ── Three.js renderer ───────────────────────────────────────────────────
  setProgress(55, 'INITIALIZING RENDERER...')
  const canvas   = document.getElementById('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled   = true
  renderer.shadowMap.type      = THREE.PCFSoftShadowMap
  renderer.toneMapping         = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.85
  renderer.setClearColor(0x87ceeb)

  const scene  = new THREE.Scene()
  scene.fog    = new THREE.Fog(0x87ceeb, 80, 220)
  scene.background = new THREE.Color(0x87ceeb)

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500)

  // 5 ── Lighting ────────────────────────────────────────────────────────────
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.8)
  sun.position.set(80, 120, 60)
  sun.castShadow = true
  sun.shadow.mapSize.width  = 2048
  sun.shadow.mapSize.height = 2048
  sun.shadow.camera.near   = 1
  sun.shadow.camera.far    = 400
  sun.shadow.camera.left   = -130
  sun.shadow.camera.right  =  130
  sun.shadow.camera.top    =  130
  sun.shadow.camera.bottom = -130
  sun.shadow.bias = -0.001
  scene.add(sun)
  scene.add(new THREE.AmbientLight(0x4488bb, 0.6))
  scene.add(new THREE.HemisphereLight(0x87ceeb, 0x3d5e34, 0.4))

  // 6 ── Terrain mesh ────────────────────────────────────────────────────────
  const terrainMesh = terrainBuilder.buildMesh()
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

  // 7 ── Clouds ──────────────────────────────────────────────────────────────
  addClouds(scene)

  // 8 ── Rapier physics world ────────────────────────────────────────────────
  setProgress(65, 'BUILDING PHYSICS WORLD...')
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 })

  // Terrain heightfield collider
  const { nrows, ncols, heights, scale } = terrainBuilder.buildRapierHeightfield(RAPIER)
  const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  world.createCollider(
    RAPIER.ColliderDesc
      .heightfield(nrows, ncols, heights, new RAPIER.Vector3(scale.x, scale.y, scale.z))
      .setFriction(0.9),
    terrainBody
  )

  // 9 ── FPS controller ──────────────────────────────────────────────────────
  setProgress(80, 'SPAWNING PLAYER...')
  const player = new FPSController({ world, RAPIER, camera })

  // Show the "Click to Enter" overlay
  const overlay = document.getElementById('click-to-play')
  if (overlay) overlay.style.display = 'flex'

  // 10 ── Done loading ───────────────────────────────────────────────────────
  setProgress(100, 'READY')
  await new Promise(r => setTimeout(r, 500))
  loadingEl.classList.add('hidden')

  // 11 ── Game loop ──────────────────────────────────────────────────────────
  const MAX_SPEED = player.MOVE_SPEED * player.SPRINT_MULT
  let prevTime = performance.now()

  function loop() {
    requestAnimationFrame(loop)

    const now = performance.now()
    const dt  = Math.min((now - prevTime) / 1000, 0.05)
    prevTime  = now

    // Step Rapier physics then update player
    world.step()
    const { position, speed } = player.update(dt)

    // HUD
    posX.textContent = `X: ${position.x.toFixed(1)}`
    posY.textContent = `Y: ${position.y.toFixed(1)}`
    posZ.textContent = `Z: ${position.z.toFixed(1)}`
    speedFill.style.width = Math.min(100, (speed / MAX_SPEED) * 100) + '%'

    renderer.render(scene, camera)
  }

  loop()

  // 12 ── Handle window resize ───────────────────────────────────────────────
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })
}

// ── Helper: add simple cloud puffs ───────────────────────────────────────────
function addClouds(scene) {
  const geo = new THREE.SphereGeometry(1, 7, 7)
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })

  for (let i = 0; i < 40; i++) {
    const cloud = new THREE.Group()
    const puffs = 3 + Math.floor(Math.random() * 4)

    for (let p = 0; p < puffs; p++) {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 1.5,
        (Math.random() - 0.5) * 4
      )
      const s = 3 + Math.random() * 5
      mesh.scale.set(s, s * 0.6, s)
      cloud.add(mesh)
    }

    cloud.position.set(
      (Math.random() - 0.5) * 300,
      50 + Math.random() * 40,
      (Math.random() - 0.5) * 300
    )
    scene.add(cloud)
  }
}

main().catch(console.error)