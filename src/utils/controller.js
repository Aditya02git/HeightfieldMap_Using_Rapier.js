import * as THREE from 'three'

/**
 * FPS Character Controller
 * ─────────────────────────
 * Wraps a Rapier kinematic capsule + character controller.
 * Handles keyboard input, mouse look, jump, sprint, gravity.
 *
 * Usage:
 *   const controller = new FPSController({ world, RAPIER, camera })
 *   // in game loop:
 *   const { position, speed } = controller.update(dt)
 */
export class FPSController {
  constructor({ world, RAPIER, camera }) {
    this.world  = world
    this.RAPIER = RAPIER
    this.camera = camera

    // ── Input state ──────────────────────────────────────────────
    this.keys    = {}
    this.yaw     = 0      // horizontal look (radians)
    this.pitch   = 0      // vertical look (radians)
    this.locked  = false  // pointer lock active?

    // ── Physics state ────────────────────────────────────────────
    this.velY         = 0
    this.isGrounded   = false
    this.jumpCooldown = 0

    // ── Tuning ───────────────────────────────────────────────────
    this.MOVE_SPEED   = 8      // m/s walk
    this.SPRINT_MULT  = 1.8    // sprint multiplier
    this.JUMP_FORCE   = 9      // m/s upward on jump
    this.GRAVITY      = -25    // m/s² downward
    this.EYE_HEIGHT   = 1.2    // camera offset above body centre
    this.SENSITIVITY  = 0.002  // mouse sensitivity

    // ── Temp vectors (reused every frame, no GC pressure) ────────
    this._fwd  = new THREE.Vector3()
    this._rgt  = new THREE.Vector3()
    this._mov  = new THREE.Vector3()

    this._initPhysics()
    this._initInput()
  }

  // ── Physics setup ──────────────────────────────────────────────
  _initPhysics() {
    const { RAPIER, world } = this

    // Kinematic position-based body (we drive it manually)
    const rbDesc = RAPIER.RigidBodyDesc
      .kinematicPositionBased()
      .setTranslation(0, 30, 0)   // spawn high so it falls onto terrain

    this.body = world.createRigidBody(rbDesc)

    // Capsule: half-height 0.5m, radius 0.4m → standing height ~1.8m
    const colDesc = RAPIER.ColliderDesc
      .capsule(0.5, 0.4)
      .setFriction(0.5)
      .setRestitution(0.0)

    this.collider = world.createCollider(colDesc, this.body)

    // Rapier character controller — handles slope, steps, sliding
    this.controller = world.createCharacterController(0.05)
    this.controller.setSlideEnabled(true)
    this.controller.setMaxSlopeClimbAngle(50 * Math.PI / 180)
    this.controller.setMinSlopeSlideAngle(30 * Math.PI / 180)
    this.controller.enableAutostep(0.5, 0.2, true)
    this.controller.enableSnapToGround(0.5)
  }

  // ── Input setup ────────────────────────────────────────────────
  _initInput() {
    // Keyboard
    window.addEventListener('keydown', e => {
      this.keys[e.code] = true
      if (e.code === 'Space') e.preventDefault()
    })
    window.addEventListener('keyup', e => {
      this.keys[e.code] = false
    })

    // Mouse look
    window.addEventListener('mousemove', e => {
      if (!this.locked) return
      this.yaw   -= e.movementX * this.SENSITIVITY
      this.pitch -= e.movementY * this.SENSITIVITY
      // Clamp pitch so you can't look fully upside-down
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch))
    })

    // Pointer lock
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === document.body

      // Show / hide "Click to Enter" overlay
      const overlay = document.getElementById('click-to-play')
      if (overlay) overlay.style.display = this.locked ? 'none' : 'flex'
    })

    // "Click to Enter" button
    const overlay = document.getElementById('click-to-play')
    if (overlay) {
      overlay.addEventListener('click', () => {
        document.body.requestPointerLock()
      })
    }
  }

  /**
   * Call every frame inside your render loop.
   * @param {number} dt  Delta time in seconds
   * @returns {{ position: THREE.Vector3, speed: number, grounded: boolean }}
   */
  update(dt) {
    // ── Cooldowns ───────────────────────────────────────────────
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt

    // ── Build horizontal movement vector ────────────────────────
    const sprint = this.keys['ShiftLeft'] || this.keys['ShiftRight']
    const speed  = this.MOVE_SPEED * (sprint ? this.SPRINT_MULT : 1.0)

    // Forward and right relative to where the player is looking (yaw only)
    this._fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    this._rgt.set( Math.cos(this.yaw), 0, -Math.sin(this.yaw))

    this._mov.set(0, 0, 0)
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    this._mov.addScaledVector(this._fwd,  1)
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  this._mov.addScaledVector(this._fwd, -1)
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  this._mov.addScaledVector(this._rgt, -1)
    if (this.keys['KeyD'] || this.keys['ArrowRight']) this._mov.addScaledVector(this._rgt,  1)

    if (this._mov.lengthSq() > 0.001) {
      this._mov.normalize().multiplyScalar(speed)
    }

    // ── Vertical velocity (gravity + jump) ──────────────────────
    this.velY += this.GRAVITY * dt

    if (this.isGrounded && this.velY < 0) {
      this.velY = -2  // small downward to keep snap-to-ground working
    }

    if (this.keys['Space'] && this.isGrounded && this.jumpCooldown <= 0) {
      this.velY         = this.JUMP_FORCE
      this.jumpCooldown = 0.4
    }

    // ── Ask Rapier controller to resolve the movement ────────────
    const desired = {
      x: this._mov.x * dt,
      y: this.velY   * dt,
      z: this._mov.z * dt,
    }

    this.controller.computeColliderMovement(this.collider, desired)

    const corrected    = this.controller.computedMovement()
    this.isGrounded    = this.controller.computedGrounded()

    // Move kinematic body
    const cur = this.body.translation()
    this.body.setNextKinematicTranslation({
      x: cur.x + corrected.x,
      y: cur.y + corrected.y,
      z: cur.z + corrected.z,
    })

    // ── Sync camera ─────────────────────────────────────────────
    const pos = this.body.translation()
    this.camera.position.set(pos.x, pos.y + this.EYE_HEIGHT, pos.z)
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.y     = this.yaw
    this.camera.rotation.x     = this.pitch

    // ── Return state for HUD / other systems ────────────────────
    return {
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      speed:    this._mov.length(),
      grounded: this.isGrounded,
    }
  }

  /** Teleport the player to a world position */
  setPosition(x, y, z) {
    this.body.setNextKinematicTranslation({ x, y, z })
    this.velY = 0
  }

  /** Current world position */
  getPosition() {
    return this.body.translation()
  }
}