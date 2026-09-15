/**
 * A cinematic orbit camera that stays inside the room and gently keeps the AI
 * in frame. Drag to look around, wheel to move closer, right drag to shift.
 */

import {
  clamp, damp, lerp, m4identity, m4lookAt, m4perspective, v3,
} from './math.js';

export class RoomCamera {
  constructor(options = {}) {
    // Where the point of interest may go.
    this.bounds = options.bounds || { minX: -2.0, maxX: 2.0, minY: 0.5, maxY: 2.2, minZ: -1.5, maxZ: 1.5 };
    // Where the eye itself may go - a little beyond the focus box so the view
    // can sit in a corner of the room without clipping through the walls.
    this.eyeLimits = options.eyeLimits || { minX: -2.44, maxX: 2.44, minY: 0.34, maxY: 2.5, minZ: -1.84, maxZ: 1.84 };

    this.yaw = options.yaw ?? 0.94;
    this.pitch = options.pitch ?? 0.15;
    this.distance = options.distance ?? 3.0;
    this.fov = options.fov ?? (48 * Math.PI) / 180;
    this.near = 0.05;
    this.far = 60;

    this.targetYaw = this.yaw;
    this.targetPitch = this.pitch;
    this.targetDistance = this.distance;

    this.target = v3(-0.35, 1.12, -0.18);
    this.desiredTarget = v3(-0.35, 1.12, -0.18);
    this.position = v3(1.9, 1.55, 1.5);

    this.view = m4identity(new Float32Array(16));
    this.projection = m4identity(new Float32Array(16));
    this.aspect = 16 / 9;

    this.drift = true;
    this.driftTime = 0;
    this.idleTime = 0;
    this.userOverride = 0;
    this._up = v3(0, 1, 0);
    this._tmp = v3();
    this.shake = 0;
  }

  resize(width, height) {
    this.aspect = Math.max(0.2, width / Math.max(1, height));
    // Slightly wider FOV on narrow windows so the room never feels cropped.
    const wide = this.aspect >= 1.5 ? 1 : 1 + (1.5 - this.aspect) * 0.22;
    m4perspective(this.projection, this.fov * clamp(wide, 1, 1.35), this.aspect, this.near, this.far);
  }

  /* -------------------------------------------------------------- input */

  orbit(dx, dy) {
    this.targetYaw -= dx * 0.0042;
    this.targetPitch = clamp(this.targetPitch + dy * 0.0035, -0.42, 1.12);
    this.userOverride = 5.5;
    this.idleTime = 0;
  }

  zoom(delta) {
    this.targetDistance = clamp(this.targetDistance * (1 + delta * 0.0011), 0.85, 5.4);
    this.userOverride = 5.5;
    this.idleTime = 0;
  }

  pan(dx, dy) {
    const scale = this.distance * 0.0016;
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw);
    this.desiredTarget[0] = clamp(this.desiredTarget[0] + (-dx * cosY) * scale, this.bounds.minX, this.bounds.maxX);
    this.desiredTarget[2] = clamp(this.desiredTarget[2] + (dx * sinY) * scale, this.bounds.minZ, this.bounds.maxZ);
    this.desiredTarget[1] = clamp(this.desiredTarget[1] + dy * scale, this.bounds.minY, this.bounds.maxY);
    this.userOverride = 5.5;
    this.idleTime = 0;
  }

  /** Gently pull the framing towards a point of interest (usually the AI). */
  focus(point, weight = 0.55) {
    const w = clamp(weight * (1 - clamp(this.userOverride / 5.5, 0, 1) * 0.75), 0, 1);
    this.desiredTarget[0] = lerp(this.desiredTarget[0], clamp(point[0], this.bounds.minX, this.bounds.maxX), w * 0.06);
    this.desiredTarget[1] = lerp(this.desiredTarget[1], clamp(point[1], this.bounds.minY, this.bounds.maxY), w * 0.06);
    this.desiredTarget[2] = lerp(this.desiredTarget[2], clamp(point[2], this.bounds.minZ, this.bounds.maxZ), w * 0.06);
  }

  reset() {
    this.targetYaw = this.home?.yaw ?? 0.94;
    this.targetPitch = this.home?.pitch ?? 0.15;
    this.targetDistance = this.home?.distance ?? 3.0;
    const t = this.home?.target;
    this.desiredTarget = t ? v3(t[0], t[1], t[2]) : v3(-0.35, 1.12, -0.18);
    this.userOverride = 0;
  }

  /* -------------------------------------------------------------- update */

  update(dt) {
    this.idleTime += dt;
    this.userOverride = Math.max(0, this.userOverride - dt);

    if (this.drift && this.userOverride <= 0) {
      this.driftTime += dt;
      const sway = Math.sin(this.driftTime * 0.13) * 0.055 + Math.sin(this.driftTime * 0.047) * 0.03;
      const lift = Math.sin(this.driftTime * 0.09 + 1.3) * 0.022;
      this.targetYaw += (sway - (this.driftYaw || 0)) * 0.02;
      this.targetPitch = clamp(this.targetPitch + (lift - (this.driftPitch || 0)) * 0.02, -0.42, 1.12);
      this.driftYaw = sway;
      this.driftPitch = lift;
    }

    this.yaw += (this.targetYaw - this.yaw) * damp(7, dt);
    this.pitch += (this.targetPitch - this.pitch) * damp(7, dt);
    this.distance += (this.targetDistance - this.distance) * damp(6, dt);
    const follow = damp(2.4, dt);
    this.target[0] += (this.desiredTarget[0] - this.target[0]) * follow;
    this.target[1] += (this.desiredTarget[1] - this.target[1]) * follow;
    this.target[2] += (this.desiredTarget[2] - this.target[2]) * follow;

    const cosP = Math.cos(this.pitch);
    let px = this.target[0] + Math.sin(this.yaw) * cosP * this.distance;
    let py = this.target[1] + Math.sin(this.pitch) * this.distance;
    let pz = this.target[2] + Math.cos(this.yaw) * cosP * this.distance;

    // Keep the eye inside the room: slide back towards the target if outside.
    const box = this.eyeLimits;
    const limX = [box.minX, box.maxX];
    const limY = [box.minY, box.maxY];
    const limZ = [box.minZ, box.maxZ];
    let t = 1;
    const pairs = [
      [px, this.target[0], limX],
      [py, this.target[1], limY],
      [pz, this.target[2], limZ],
    ];
    for (const [value, origin, lim] of pairs) {
      const delta = value - origin;
      if (Math.abs(delta) < 1e-5) continue;
      if (value > lim[1]) t = Math.min(t, (lim[1] - origin) / delta);
      else if (value < lim[0]) t = Math.min(t, (lim[0] - origin) / delta);
    }
    t = clamp(t, 0.25, 1);
    px = this.target[0] + (px - this.target[0]) * t;
    py = this.target[1] + (py - this.target[1]) * t;
    pz = this.target[2] + (pz - this.target[2]) * t;
    // The scaling above keeps the framing sane; this guarantees the eye never
    // ends up outside the room even when the target sits near a wall.
    px = clamp(px, limX[0], limX[1]);
    py = clamp(py, limY[0], limY[1]);
    pz = clamp(pz, limZ[0], limZ[1]);

    this.position[0] = px;
    this.position[1] = py;
    this.position[2] = pz;

    m4lookAt(this.view, this.position, this.target, this._up);
    return this;
  }

  /** Screen space ray for picking / hover effects. */
  screenRay(nx, ny) {
    const tanHalf = Math.tan(this.fov / 2);
    const forward = v3(
      this.target[0] - this.position[0],
      this.target[1] - this.position[1],
      this.target[2] - this.position[2]
    );
    const len = Math.hypot(forward[0], forward[1], forward[2]) || 1;
    forward[0] /= len; forward[1] /= len; forward[2] /= len;
    const right = v3(forward[2], 0, -forward[0]);
    const rl = Math.hypot(right[0], right[2]) || 1;
    right[0] /= rl; right[2] /= rl;
    const up = v3(
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0]
    );
    const dir = v3(
      forward[0] + right[0] * nx * tanHalf * this.aspect + up[0] * ny * tanHalf,
      forward[1] + right[1] * nx * tanHalf * this.aspect + up[1] * ny * tanHalf,
      forward[2] + right[2] * nx * tanHalf * this.aspect + up[2] * ny * tanHalf
    );
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return { origin: this.position, direction: v3(dir[0] / dl, dir[1] / dl, dir[2] / dl) };
  }
}
