/**
 * The AI: a small floating creature with a glossy shell, a dark face and two
 * expressive eyes. No body, no limbs - it reads as a digital object sitting in
 * a physical room.
 *
 * Everything is animated from a handful of expression parameters that the
 * behaviour layer sets per state, so the same rig can look asleep, curious,
 * focused or mid-sentence.
 */

import {
  roundedBoxGeometry, sphereGeometry, torusGeometry, quadGeometry,
} from '../core/geometry.js';
import {
  clamp, damp, lerp, m4basis, m4identity, m4multiply, m4trs, v3, v3normalize,
} from '../core/math.js';

const EYE_COLOURS = {
  IDLE: [0.55, 0.9, 1.0],
  BORED: [0.62, 0.78, 0.86],
  THINKING: [0.68, 0.62, 1.0],
  WORKING: [0.55, 0.95, 0.85],
  RESTING: [0.45, 0.7, 0.9],
  SLEEPING: [0.35, 0.55, 0.85],
  WAKING: [0.6, 0.88, 1.0],
  LISTENING: [0.62, 0.95, 1.0],
  SPEAKING: [1.0, 0.85, 0.6],
};

/** Per-state look: lid opening, eye shape, glow, ring speed, body emissive. */
const EXPRESSIONS = {
  IDLE:      { eyeOpen: 1.0, eyeScaleY: 1.0, eyeScaleX: 1.0, glow: 2.6, ring: 0.35, shell: 0.14, mouth: 0.0, tilt: 0.02 },
  BORED:     { eyeOpen: 0.45, eyeScaleY: 0.6, eyeScaleX: 1.05, glow: 1.5, ring: 0.12, shell: 0.08, mouth: 0.0, tilt: 0.12 },
  THINKING:  { eyeOpen: 0.7, eyeScaleY: 0.72, eyeScaleX: 0.95, glow: 3.2, ring: 0.9, shell: 0.2, mouth: 0.05, tilt: -0.16 },
  WORKING:   { eyeOpen: 0.86, eyeScaleY: 0.86, eyeScaleX: 0.92, glow: 3.4, ring: 1.35, shell: 0.22, mouth: 0.03, tilt: -0.05 },
  RESTING:   { eyeOpen: 0.28, eyeScaleY: 0.34, eyeScaleX: 1.0, glow: 1.0, ring: 0.06, shell: 0.05, mouth: 0.0, tilt: 0.2 },
  SLEEPING:  { eyeOpen: 0.04, eyeScaleY: 0.06, eyeScaleX: 1.0, glow: 0.22, ring: 0.02, shell: 0.02, mouth: 0.0, tilt: 0.26 },
  WAKING:    { eyeOpen: 0.55, eyeScaleY: 0.62, eyeScaleX: 0.9, glow: 2.0, ring: 0.5, shell: 0.12, mouth: 0.0, tilt: 0.1 },
  LISTENING: { eyeOpen: 1.12, eyeScaleY: 1.1, eyeScaleX: 1.06, glow: 4.2, ring: 0.7, shell: 0.26, mouth: 0.02, tilt: -0.02 },
  SPEAKING:  { eyeOpen: 0.82, eyeScaleY: 0.78, eyeScaleX: 1.08, glow: 4.6, ring: 1.1, shell: 0.3, mouth: 1.0, tilt: -0.04 },
};

export class AiEntity {
  constructor(renderer, materials, textures) {
    this.renderer = renderer;
    this.M = materials;

    this.position = v3(0, 1.34, 0.2);
    this.forward = v3(-0.3, 0, -1);
    this.up = v3(0, 1, 0);
    this.right = v3(1, 0, 0);
    this.velocity = v3(0, 0, 0);

    this.time = 0;
    this.blinkTimer = 3 + Math.random() * 3;
    this.blink = 0;
    this.breath = 0;
    this.state = 'IDLE';

    this.expr = { ...EXPRESSIONS.IDLE };
    this.targetExpr = { ...EXPRESSIONS.IDLE };
    this.eyeColour = EYE_COLOURS.IDLE.slice();
    this.targetEyeColour = EYE_COLOURS.IDLE.slice();
    this.gaze = [0, 0];
    this.targetGaze = [0, 0];
    this.speakingLevel = 0;
    this.ringAngle = 0;
    this.satelliteAngle = 0;
    this.settle = 0;   // 1 = fully settled (sleeping), damps all motion
    this.targetSettle = 0;

    this.matrix = m4identity(new Float32Array(16));
    this.local = m4identity(new Float32Array(16));
    this.tmp = m4identity(new Float32Array(16));
    this.tmp2 = m4identity(new Float32Array(16));

    this._build(renderer, materials, textures);
  }

  _build(renderer, M, textures) {
    const add = (mesh, material, opts) => renderer.addDynamic(mesh, material, {
      castShadow: true, dynamic: true, ...opts,
    });

    // --- body -------------------------------------------------------------
    this.shell = add(
      sphereGeometry(0.195, 34, 24, { scaleY: 1.04 }),
      { ...M.aiShell },
      { tag: 'aiShell' }
    );

    // Glossy dark face plate on the front.
    this.face = add(
      sphereGeometry(0.199, 30, 20, {
        phiStart: Math.PI / 2 - 0.92,
        phiLength: 1.84,
        thetaStart: 0.42,
        thetaLength: 1.62,
        scaleY: 1.04,
      }),
      { ...M.aiFace },
      { tag: 'aiFace' }
    );

    // --- eyes -------------------------------------------------------------
    this.eyes = [];
    this.pupils = [];
    for (const side of [-1, 1]) {
      const eye = add(
        sphereGeometry(0.043, 18, 14),
        { ...M.aiEye },
        { tag: 'aiEye', castShadow: false }
      );
      const pupil = add(
        sphereGeometry(0.019, 12, 10),
        { ...M.aiPupil },
        { tag: 'aiPupil', castShadow: false }
      );
      this.eyes.push({ item: eye, side, base: [side * 0.072, 0.036, 0.168] });
      this.pupils.push({ item: pupil, side, base: [side * 0.072, 0.036, 0.168] });
    }

    // --- "mouth": three bars that pulse while speaking --------------------
    this.bars = [];
    for (let i = 0; i < 3; i++) {
      const bar = add(
        roundedBoxGeometry(0.042, 0.012, 0.01, 0.004, 2),
        { ...M.aiEye },
        { tag: 'aiMouth', castShadow: false }
      );
      this.bars.push({ item: bar, offset: (i - 1) * 0.052 });
    }

    // --- halo ring + satellites -------------------------------------------
    this.ring = add(
      torusGeometry(0.285, 0.011, 44, 10),
      { ...M.aiRing },
      { tag: 'aiRing', castShadow: false }
    );
    this.satellites = [];
    for (let i = 0; i < 2; i++) {
      const sat = add(
        sphereGeometry(0.021, 14, 10),
        { ...M.aiCore },
        { tag: 'aiSatellite', castShadow: false }
      );
      this.satellites.push({ item: sat, phase: i * Math.PI });
    }

    // --- soft aura (billboard) --------------------------------------------
    this.aura = add(
      quadGeometry(1.15, 1.15),
      { ...M.aura },
      { tag: 'aiAura', castShadow: false, receiveShadow: false }
    );
    if (textures && textures.glow) this.aura.material.texture = textures.glow;
  }

  /* ------------------------------------------------------------- state --- */

  setState(state) {
    if (!EXPRESSIONS[state]) return;
    this.state = state;
    this.targetExpr = { ...EXPRESSIONS[state] };
    this.targetEyeColour = (EYE_COLOURS[state] || EYE_COLOURS.IDLE).slice();
    this.targetSettle = state === 'SLEEPING' ? 1 : state === 'RESTING' ? 0.6 : 0;
  }

  setGaze(x, y) {
    this.targetGaze = [clamp(x, -1, 1), clamp(y, -1, 1)];
  }

  setSpeakingLevel(level) {
    this.speakingLevel = clamp(level, 0, 1);
  }

  /* ------------------------------------------------------------ update --- */

  update(dt, cameraPosition) {
    this.time += dt;
    const live = 1 - this.settle * 0.85;

    // Ease the expression towards the state's target.
    const k = damp(this.state === 'WAKING' ? 3.2 : 4.5, dt);
    for (const key of Object.keys(this.targetExpr)) {
      this.expr[key] = lerp(this.expr[key], this.targetExpr[key], k);
    }
    for (let i = 0; i < 3; i++) {
      this.eyeColour[i] = lerp(this.eyeColour[i], this.targetEyeColour[i], k);
    }
    this.gaze[0] = lerp(this.gaze[0], this.targetGaze[0], damp(3.4, dt));
    this.gaze[1] = lerp(this.gaze[1], this.targetGaze[1], damp(3.4, dt));
    this.settle = lerp(this.settle, this.targetSettle, damp(1.8, dt));

    // Blinking - rarer and slower when resting.
    this.blinkTimer -= dt * (this.settle > 0.5 ? 0.25 : 1);
    if (this.blinkTimer <= 0) {
      this.blink = 1;
      this.blinkTimer = (2.6 + Math.random() * 4.4) / (1 - this.settle * 0.6);
    }
    this.blink = Math.max(0, this.blink - dt * 7.5);
    const blinkShape = Math.sin(this.blink * Math.PI);

    // Breathing / idle life.
    this.breath += dt * (this.settle > 0.5 ? 0.9 : 1.7);
    const breath = Math.sin(this.breath) * (0.014 + this.settle * 0.012);
    const speaking = this.expr.mouth * this.speakingLevel;

    /* ---- body basis ----------------------------------------------------- */
    // Keep the basis orthonormal: strip any forward component out of `up`,
    // then take the side vector from up x forward (right handed).
    const dot = this.up[0] * this.forward[0] + this.up[1] * this.forward[1] + this.up[2] * this.forward[2];
    this.up[0] -= this.forward[0] * dot;
    this.up[1] -= this.forward[1] * dot;
    this.up[2] -= this.forward[2] * dot;
    v3normalize(this.up, this.up);
    this.right[0] = this.up[1] * this.forward[2] - this.up[2] * this.forward[1];
    this.right[1] = this.up[2] * this.forward[0] - this.up[0] * this.forward[2];
    this.right[2] = this.up[0] * this.forward[1] - this.up[1] * this.forward[0];
    v3normalize(this.right, this.right);

    const squash = 1 + breath * 0.6 - this.settle * 0.05;
    const stretch = 1 - breath * 0.4 + this.settle * 0.03;
    m4basis(
      this.matrix,
      this.position[0], this.position[1], this.position[2],
      this.right, this.up, this.forward,
      squash, stretch, squash
    );

    /* ---- shell + face --------------------------------------------------- */
    const tilt = this.expr.tilt;
    m4trs(this.local, [0, 0, 0], [1, 1, 1], 0, tilt, Math.sin(this.time * 0.6) * 0.02 * live);
    multiplyInto(this.shell.model, this.matrix, this.local);
    this.shell.material.emissiveStrength = this.expr.shell;

    m4trs(this.local, [0, 0, 0.004], [1, 1, 1], 0, tilt * 0.6, 0);
    multiplyInto(this.face.model, this.matrix, this.local);
    this.face.material.emissiveStrength = 0.25 + this.expr.glow * 0.12;
    this.face.material.emissive = this.eyeColour;

    /* ---- eyes ----------------------------------------------------------- */
    const openY = clamp(this.expr.eyeOpen * this.expr.eyeScaleY * (1 - blinkShape * 0.94), 0.04, 1.6);
    const openX = this.expr.eyeScaleX * (1 + blinkShape * 0.1);
    const glow = this.expr.glow * (0.75 + 0.25 * Math.sin(this.time * 2.1));

    for (const eye of this.eyes) {
      const look = 0.016;
      const localPos = [
        eye.base[0] + this.gaze[0] * look,
        eye.base[1] + this.gaze[1] * look * 0.8,
        eye.base[2],
      ];
      const outward = normalOnSphere(localPos);
      m4trs(this.tmp, localPos, [1, 1, 1], Math.atan2(outward[0], outward[2]), Math.asin(clamp(-outward[1], -1, 1)), 0);
      m4trs(this.local, [0, 0, 0], [openX, openY, 0.5], 0, 0, 0);
      m4multiply(this.tmp2, this.tmp, this.local);
      multiplyInto(eye.item.model, this.matrix, this.tmp2);
      eye.item.material.emissiveStrength = glow;
      eye.item.material.emissive = this.eyeColour;
      eye.item.visible = openY > 0.05;
    }

    for (const pupil of this.pupils) {
      const look = 0.024;
      const localPos = [
        pupil.base[0] + this.gaze[0] * look,
        pupil.base[1] + this.gaze[1] * look * 0.8,
        pupil.base[2] + 0.028,
      ];
      const outward = normalOnSphere(pupil.base);
      m4trs(this.tmp, localPos, [1, 1, 1], Math.atan2(outward[0], outward[2]), Math.asin(clamp(-outward[1], -1, 1)), 0);
      m4trs(this.local, [0, 0, 0], [openX, openY, 0.6], 0, 0, 0);
      m4multiply(this.tmp2, this.tmp, this.local);
      multiplyInto(pupil.item.model, this.matrix, this.tmp2);
      pupil.item.visible = openY > 0.3;
    }

    /* ---- mouth bars ------------------------------------------------------ */
    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars[i];
      const phase = Math.sin(this.time * (9 + i * 2.4) + i * 1.7);
      const level = 0.25 + speaking * (0.75 * (0.5 + 0.5 * phase));
      const height = 0.012 * (0.35 + level * 1.6);
      m4trs(this.local, [bar.offset, -0.072 + this.gaze[1] * 0.004, 0.176], [1, clamp(level * 2.2, 0.2, 3), 1], 0, tilt, 0);
      m4trs(this.tmp, [0, 0, 0], [1, height / 0.012, 1], 0, 0, 0);
      m4multiply(this.tmp2, this.local, this.tmp);
      multiplyInto(bar.item.model, this.matrix, this.tmp2);
      bar.item.material.emissiveStrength = glow * (0.35 + speaking * 0.65);
      bar.item.material.emissive = this.eyeColour;
      bar.item.visible = this.expr.mouth > 0.02 || this.state === 'IDLE';
    }

    /* ---- ring + satellites ---------------------------------------------- */
    this.ringAngle += dt * this.expr.ring * (0.6 + live);
    this.satelliteAngle += dt * (0.5 + this.expr.ring * 0.7);
    m4trs(this.local, [0, 0.01, 0], [1, 1, 1], this.ringAngle, Math.PI / 2 + Math.sin(this.time * 0.4) * 0.22, 0.35);
    multiplyInto(this.ring.model, this.matrix, this.local);
    this.ring.material.emissiveStrength = 0.4 + this.expr.glow * 0.22;
    this.ring.material.emissive = this.eyeColour;

    for (const sat of this.satellites) {
      const a = this.satelliteAngle + sat.phase;
      const radius = 0.33 + Math.sin(this.time * 0.8 + sat.phase) * 0.02;
      m4trs(this.local,
        [Math.cos(a) * radius, 0.05 + Math.sin(a * 1.7) * 0.09, Math.sin(a) * radius],
        [1, 1, 1], 0, 0, 0);
      multiplyInto(sat.item.model, this.matrix, this.local);
      sat.item.material.emissiveStrength = 1.2 + this.expr.glow * 0.4;
      sat.item.material.emissive = this.eyeColour;
    }

    /* ---- aura billboard --------------------------------------------------- */
    if (cameraPosition) {
      const toCamera = v3(
        cameraPosition[0] - this.position[0],
        cameraPosition[1] - this.position[1],
        cameraPosition[2] - this.position[2]
      );
      v3normalize(toCamera, toCamera);
      const right = crossInto(v3(), toCamera, [0, 1, 0]);
      v3normalize(right, right);
      const up = crossInto(v3(), right, toCamera);
      const size = 0.95 + this.expr.glow * 0.06 + breath * 2;
      m4basis(this.aura.model,
        this.position[0], this.position[1], this.position[2],
        right, up, toCamera, size, size, size);
      const alpha = clamp(0.10 + this.expr.glow * 0.055, 0, 0.7) * (1 - this.settle * 0.6);
      this.aura.material.color = [
        this.eyeColour[0], this.eyeColour[1], this.eyeColour[2], alpha,
      ];
    }
  }

  /** Approximate world position for lighting and camera focus. */
  get centre() {
    return this.position;
  }
}

/* --------------------------------------------------------------- helpers */

function multiplyInto(out, a, b) {
  return m4multiply(out, a, b);
}

function crossInto(out, a, b) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  return out;
}

function normalOnSphere(p) {
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
}
