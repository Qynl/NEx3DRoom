/**
 * Flight: the AI never teleports. Every move is a cubic Bezier with a proper
 * acceleration curve, a little organic wobble, banking into turns and a smooth
 * re-orientation at the end.
 */

import {
  clamp, damp, easeFlight, easeInOutSine, lerp, v3, v3add, v3copy, v3dist,
  v3lerp, v3normalize, v3scale, v3sub,
} from '../core/math.js';

export class FlightController {
  constructor() {
    this.position = v3(0, 1.34, 0.2);
    this.velocity = v3(0, 0, 0);
    this.forward = v3(-0.3, 0, -0.95);
    this.up = v3(0, 1, 0);

    this.path = null;
    this.desiredForward = v3(-0.3, 0, -0.95);
    this.hoverBase = 1.34;
    this.hoverAmplitude = 0.024;
    this.hoverSpeed = 1.1;
    this.phase = Math.random() * Math.PI * 2;
    this.time = 0;
    this.bank = 0;
    this._prevDir = v3(0, 0, 0);
    this._tmpA = v3();
    this._tmpB = v3();
    this._tmpC = v3();
    this.onArrive = null;
    this.arrivals = 0;
  }

  get moving() {
    return this.path !== null;
  }

  get remaining() {
    return this.path ? Math.max(0, this.path.duration - this.path.elapsed) : 0;
  }

  /** Place the entity somewhere without animating (used once at start-up). */
  place(x, y, z) {
    this.position[0] = x;
    this.position[1] = y;
    this.position[2] = z;
    this.hoverBase = y;
    this.path = null;
    this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
  }

  face(direction, immediate = false) {
    const target = v3normalize(v3(), direction);
    if (immediate) v3copy(this.forward, target);
    this.desiredForward = target;
  }

  flyTo(to, options = {}) {
    const target = Array.isArray(to) ? v3(to[0], to[1], to[2]) : v3(to[0], to[1], to[2]);
    const from = this.position;
    const dist = v3dist(from, target);

    if (dist < 0.015 && !options.force) {
      this.path = null;
      this.onArrive?.(target);
      return this;
    }

    const duration = options.duration ?? clamp(0.8 + dist * 0.62, 0.9, 4.4);
    const arc = options.arc ?? clamp(0.16 + dist * 0.13, 0.18, 0.8);

    const dir = v3normalize(v3(), v3sub(v3(), target, from));

    // Leave along the current velocity when already moving so paths chain
    // smoothly instead of snapping to a new heading.
    const p1 = v3();
    const speed = Math.hypot(this.velocity[0], this.velocity[1], this.velocity[2]);
    if (speed > 0.08) {
      v3scale(this._tmpA, this.velocity, Math.min(0.42, duration * 0.3));
      v3add(p1, from, this._tmpA);
      p1[1] += arc * 0.55;
    } else {
      v3scale(this._tmpA, dir, dist * 0.3);
      v3add(p1, from, this._tmpA);
      p1[1] += arc;
    }

    const p2 = v3();
    v3scale(this._tmpA, dir, dist * 0.34);
    v3sub(p2, target, this._tmpA);
    p2[1] += (options.flat ? arc * 0.15 : arc * 0.7);

    this.path = {
      p0: v3(from[0], from[1], from[2]),
      p1, p2,
      p3: target,
      elapsed: 0,
      duration,
      ease: options.ease || easeFlight,
      wobble: options.wobble ?? clamp(dist * 0.02, 0.004, 0.05),
      flat: !!options.flat,
      onArrive: options.onArrive || null,
      tag: options.tag || '',
    };
    this.onArrive = options.onArrive || null;
    if (options.face) this.face(options.face);
    return this;
  }

  /** Straight, slow move - used for settling onto the pillow. */
  descendTo(to, duration = 2.6, face = null) {
    return this.flyTo(to, { duration, arc: 0.02, ease: easeInOutSine, flat: true, face, wobble: 0.002 });
  }

  update(dt, desiredFace = null) {
    this.time += dt;
    this.phase += dt * this.hoverSpeed;

    if (this.path) {
      const path = this.path;
      path.elapsed += dt;
      const raw = clamp(path.elapsed / path.duration, 0, 1);
      const t = path.ease(raw);

      bezier(this._tmpA, path.p0, path.p1, path.p2, path.p3, t);

      // Organic wobble, perpendicular to the direction of travel.
      if (path.wobble > 0) {
        const dir = v3normalize(this._tmpB, v3sub(this._tmpB, path.p3, path.p0));
        const side = v3normalize(this._tmpC, v3(this.dirZ(dir), 0, -dir[0]));
        const amount = Math.sin(this.time * 2.1) * path.wobble * Math.sin(Math.PI * raw);
        this._tmpA[0] += side[0] * amount;
        this._tmpA[2] += side[2] * amount;
        this._tmpA[1] += Math.sin(this.time * 3.3) * path.wobble * 0.5 * Math.sin(Math.PI * raw);
      }

      // Instantaneous velocity from the previous position.
      const invDt = dt > 0 ? 1 / dt : 0;
      this.velocity[0] = (this._tmpA[0] - this.position[0]) * invDt;
      this.velocity[1] = (this._tmpA[1] - this.position[1]) * invDt;
      this.velocity[2] = (this._tmpA[2] - this.position[2]) * invDt;
      v3copy(this.position, this._tmpA);

      if (raw >= 1) {
        this.path = null;
        this.velocity[0] *= 0.1;
        this.velocity[1] *= 0.1;
        this.velocity[2] *= 0.1;
        this.arrivals++;
        this.hoverBase = this.position[1];
        const callback = path.onArrive || this.onArrive;
        this.onArrive = null;
        callback?.(path.p3, path.tag);
      }
    } else {
      // Hover in place: a gentle bob around the arrival height, no drift.
      const bob = Math.sin(this.phase) * this.hoverAmplitude;
      this.velocity[0] *= 0.86;
      this.velocity[2] *= 0.86;
      this.velocity[1] = Math.cos(this.phase) * this.hoverAmplitude * this.hoverSpeed;
      this.position[1] = lerp(this.position[1], this.hoverBase + bob, damp(6, dt));
    }

    /* ---- orientation ---------------------------------------------------- */
    const speed = Math.hypot(this.velocity[0], this.velocity[2]);
    let targetForward;
    if (this.path && speed > 0.06) {
      const moveDir = v3normalize(v3(), v3(this.velocity[0], 0, this.velocity[2]));
      const wanted = desiredFace || this.desiredForward;
      targetForward = wanted
        ? v3normalize(v3(), v3lerp(v3(), moveDir, v3normalize(v3(), wanted), 0.42))
        : moveDir;
    } else {
      targetForward = v3normalize(v3(), desiredFace || this.desiredForward || this.forward);
    }

    const turn = damp(this.path ? 2.6 : 3.4, dt);
    const prev = v3copy(v3(), this.forward);
    v3lerp(this.forward, this.forward, targetForward, turn);
    v3normalize(this.forward, this.forward);

    // Bank into the turn.
    const crossY = prev[2] * this.forward[0] - prev[0] * this.forward[2];
    this.bank = lerp(this.bank, clamp(crossY * 5.5, -0.26, 0.26), damp(3, dt));
    const right = v3normalize(this._tmpB, v3(this.forward[2], 0, -this.forward[0]));
    v3normalize(this.up, v3(
      right[0] * -this.bank,
      1,
      right[2] * -this.bank
    ));

    return this;
  }

  dirZ(dir) {
    return dir[2];
  }

  /** Height above the hover baseline is kept stable when not flying. */
  setHoverBase(y) {
    this.hoverBase = y;
  }
}

function bezier(out, p0, p1, p2, p3, t) {
  const it = 1 - t;
  const a = it * it * it;
  const b = 3 * it * it * t;
  const c = 3 * it * t * t;
  const d = t * t * t;
  out[0] = a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0];
  out[1] = a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1];
  out[2] = a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2];
  return out;
}
