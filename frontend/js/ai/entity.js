/**
 * The AI: a small floating companion styled after the concept art - a glossy
 * white egg head with a dark glass visor, two warm amber oval eyes and a smile,
 * little ear pods and a rounded body pod. No arms, no legs: it hovers.
 *
 * The glowing face is drawn on a tiny canvas (eyes + smile) and projected onto
 * the visor, so it can blink, look around, talk, doze and wake just like the
 * reference. A handful of expression parameters drive everything.
 */

import {
  cylinderGeometry, quadGeometry, sphereGeometry,
} from '../core/geometry.js';
import { createFaceTexture } from '../core/textures.js';
import {
  clamp, damp, lerp, m4basis, m4identity, m4multiply, m4trs, v3, v3normalize,
} from '../core/math.js';

// Warm amber palette (the reference's friendly orange glow), varied per state.
const EYE_COLOURS = {
  IDLE: [1.0, 0.66, 0.30],
  BORED: [0.94, 0.60, 0.30],
  THINKING: [1.0, 0.72, 0.38],
  WORKING: [1.0, 0.76, 0.42],
  RESTING: [0.94, 0.60, 0.30],
  SLEEPING: [0.80, 0.50, 0.28],
  WAKING: [1.0, 0.68, 0.34],
  LISTENING: [1.0, 0.78, 0.46],
  SPEAKING: [1.0, 0.80, 0.50],
};

/** Per-state look: lid opening, eye shape, glow, body emissive, mouth, tilt. */
const EXPRESSIONS = {
  IDLE:      { eyeOpen: 1.0, eyeScaleY: 1.0, eyeScaleX: 1.0, glow: 2.6, shell: 0.05, mouth: 0.0, tilt: 0.02 },
  BORED:     { eyeOpen: 0.45, eyeScaleY: 0.6, eyeScaleX: 1.05, glow: 1.5, shell: 0.03, mouth: 0.0, tilt: 0.12 },
  THINKING:  { eyeOpen: 0.7, eyeScaleY: 0.72, eyeScaleX: 0.95, glow: 3.2, shell: 0.06, mouth: 0.05, tilt: -0.16 },
  WORKING:   { eyeOpen: 0.86, eyeScaleY: 0.86, eyeScaleX: 0.92, glow: 3.4, shell: 0.07, mouth: 0.03, tilt: -0.05 },
  RESTING:   { eyeOpen: 0.28, eyeScaleY: 0.34, eyeScaleX: 1.0, glow: 1.0, shell: 0.02, mouth: 0.0, tilt: 0.2 },
  SLEEPING:  { eyeOpen: 0.04, eyeScaleY: 0.06, eyeScaleX: 1.0, glow: 0.22, shell: 0.01, mouth: 0.0, tilt: 0.26 },
  WAKING:    { eyeOpen: 0.55, eyeScaleY: 0.62, eyeScaleX: 0.9, glow: 2.0, shell: 0.04, mouth: 0.0, tilt: 0.1 },
  LISTENING: { eyeOpen: 1.12, eyeScaleY: 1.1, eyeScaleX: 1.06, glow: 4.2, shell: 0.08, mouth: 0.02, tilt: -0.02 },
  SPEAKING:  { eyeOpen: 0.82, eyeScaleY: 0.78, eyeScaleX: 1.08, glow: 4.6, shell: 0.09, mouth: 1.0, tilt: -0.04 },
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
    this.settle = 0;   // 1 = fully settled (sleeping), damps all motion
    this.targetSettle = 0;
    this.faceTimer = 0;

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

    // --- glossy white egg head --------------------------------------------
    this.shell = add(
      sphereGeometry(0.19, 34, 24, { scaleY: 1.04 }),
      { ...M.aiShell },
      { tag: 'aiShell' }
    );

    // --- dark glass visor on the front ------------------------------------
    this.face = add(
      sphereGeometry(0.19, 30, 20),
      { ...M.aiFace },
      { tag: 'aiFace', castShadow: false }
    );

    // --- glowing face (canvas: eyes + smile) ------------------------------
    this.faceDraw = createFaceTexture(256);
    this.faceTexture = renderer.createTexture(this.faceDraw.canvas, {
      clamp: true, mips: false, minFilter: renderer.gl.LINEAR,
    });
    this.faceScreen = add(
      quadGeometry(0.28, 0.22),
      {
        program: 'unlit', blend: 'alpha', texture: this.faceTexture,
        color: [1, 1, 1, 1], depthWrite: false, cull: false,
      },
      { tag: 'aiScreen', castShadow: false, receiveShadow: false }
    );

    // --- ear pods ----------------------------------------------------------
    this.ears = [];
    for (const side of [-1, 1]) {
      const ear = add(
        cylinderGeometry(0.052, 0.052, 0.035, 20),
        { ...M.aiShell },
        { tag: 'aiEar', castShadow: false }
      );
      const cap = add(
        cylinderGeometry(0.028, 0.028, 0.045, 16),
        { ...M.aiFace },
        { tag: 'aiEarCap', castShadow: false }
      );
      this.ears.push({ ear, cap, side });
    }

    // --- neck + rounded body pod -------------------------------------------
    this.neck = add(
      cylinderGeometry(0.05, 0.06, 0.07, 16),
      { ...M.aiFace },
      { tag: 'aiNeck', castShadow: false }
    );
    this.body = add(
      sphereGeometry(0.125, 26, 18),
      { ...M.aiShell },
      { tag: 'aiBody' }
    );

    // --- soft warm aura (billboard) ----------------------------------------
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

    const tilt = this.expr.tilt;
    const sway = Math.sin(this.time * 0.6) * 0.02 * live;

    /* ---- head + visor + screen ------------------------------------------ */
    m4trs(this.local, [0, 0, 0], [1, 1, 1], 0, tilt, sway);
    multiplyInto(this.shell.model, this.matrix, this.local);
    this.shell.material.emissiveStrength = this.expr.shell;

    m4trs(this.local, [0, 0, 0.10], [0.95, 0.8, 0.55], 0, tilt * 0.7, sway * 0.7);
    multiplyInto(this.face.model, this.matrix, this.local);
    this.face.material.emissiveStrength = 0.2 + this.expr.glow * 0.1;

    m4trs(this.local, [0, 0, 0.208], [1, 1, 1], 0, tilt * 0.7, sway * 0.7);
    multiplyInto(this.faceScreen.model, this.matrix, this.local);

    /* ---- ears ------------------------------------------------------------ */
    for (const e of this.ears) {
      m4trs(this.local, [e.side * 0.183, 0.005, 0], [1, 1, 1], 0, 0, Math.PI / 2);
      multiplyInto(e.ear.model, this.matrix, this.local);
      m4trs(this.local, [e.side * 0.19, 0.005, 0], [1, 1, 1], 0, 0, Math.PI / 2);
      multiplyInto(e.cap.model, this.matrix, this.local);
    }

    /* ---- neck + body ----------------------------------------------------- */
    m4trs(this.local, [0, -0.21, 0], [1, 1, 1], 0, tilt * 0.3, 0);
    multiplyInto(this.neck.model, this.matrix, this.local);
    m4trs(this.local, [0, -0.315, 0], [0.9, 0.85, 0.72], 0, tilt * 0.25, sway * 0.5);
    multiplyInto(this.body.model, this.matrix, this.local);
    this.body.material.emissiveStrength = this.expr.shell * 0.8;

    /* ---- face canvas ----------------------------------------------------- */
    this.faceTimer -= dt;
    if (this.faceTimer <= 0) {
      this.faceTimer = 1 / 30;
      this.faceDraw.draw({
        open: clamp(this.expr.eyeOpen * this.expr.eyeScaleY, 0, 1.6),
        scaleX: this.expr.eyeScaleX,
        scaleY: this.expr.eyeScaleY,
        gazeX: this.gaze[0],
        gazeY: this.gaze[1],
        blink: blinkShape,
        speaking: speaking,
        glow: this.expr.glow,
        colour: this.eyeColour,
      });
      this.renderer.updateTexture(this.faceTexture, this.faceDraw.canvas);
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
        this.position[0], this.position[1] - 0.1, this.position[2],
        right, up, toCamera, size, size, size);
      const alpha = clamp(0.10 + this.expr.glow * 0.05, 0, 0.6) * (1 - this.settle * 0.6);
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
