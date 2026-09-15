/**
 * The task director: turns a named task ("search", "reading", ...) into a small
 * piece of theatre. Each task is a sequence of phases; a phase flies the
 * companion somewhere, makes it face something, runs an activity and drives the
 * physical props (screen mode, calculator digits, written lines, drawer, pins,
 * a carried book) so every chore has visible, human-feeling feedback.
 */

import { clamp, lerp, m4basis, m4identity, v3 } from '../core/math.js';
import { DESK_WORK, PLACES, ROOM, SOFA } from '../world/layout.js';

const SPOTS = {
  deskWork: DESK_WORK,
  shelfGrab: { position: [-1.95, 1.45, -0.6], face: [-1, 0, 0] },
  sofaSit: { position: [SOFA.centerX + 0.2, 0.98, SOFA.centerZ - 0.12], face: [0, 0, -1] },
  boardStand: { position: [0.6, 1.3, ROOM.maxZ - 0.7], face: [0, 0, 1] },
  cabinetStand: { position: [ROOM.minX + 0.75, 1.1, 0.62], face: [-1, 0, 0] },
  windowStand: { position: PLACES.WINDOW.position, face: PLACES.WINDOW.face },
  center: { position: PLACES.CENTER.position, face: PLACES.CENTER.face },
};

export class TaskDirector {
  constructor({ entity, flight, refs, renderer, onDone }) {
    this.entity = entity;
    this.flight = flight;
    this.refs = refs;
    this.renderer = renderer;
    this.onDone = onDone || (() => {});
    this.script = null;
    this.index = 0;
    this.hold = 0;
    this.name = null;
    this.calcValue = 0;
    this.calcTimer = 0;
    this.pageProgress = 0;
    this.bookT = 0;
    this._bookMatrix = m4identity(new Float32Array(16));
  }

  get active() { return this.script !== null; }

  /** Build and start a task. Returns true if the task is known. */
  setTask(name) {
    const build = TASKS[name];
    if (!build) return false;
    this.name = name;
    this.script = build(this);
    this.index = 0;
    this.hold = 0;
    this.calcValue = 0;
    this.pageProgress = 0;
    this._enterPhase();
    return true;
  }

  stop() {
    this._clearProps();
    this.script = null;
    this.name = null;
    this.entity.setActivity('none');
  }

  _enterPhase() {
    const phase = this.script[this.index];
    if (!phase) return;
    const spot = typeof phase.at === 'string' ? SPOTS[phase.at] : phase.at;
    if (spot) {
      this.flight.flyTo(spot.position, { face: spot.face, duration: phase.travel || 1.6 });
    }
    if (phase.screen && this.refs.screenDraw) this.refs.screenDraw.setMode(phase.screen);
    if (phase.activity) this.entity.setActivity(phase.activity);
    if (phase.emote) this.entity.playEmote(phase.emote);
    this.hold = 0;
  }

  _clearProps() {
    const r = this.refs;
    if (r.book) r.book.visible = false;
    if (r.drawer) r.drawer.model[12] = r.drawerClosedX;
    if (r.pins) r.pins.forEach((p) => { p.visible = false; });
    if (r.calcScreen) r.calcScreen.material.emissiveStrength = 0;
    if (r.screenDraw) r.screenDraw.setMode('code');
  }

  update(dt) {
    if (!this.script) return false;
    const phase = this.script[this.index];
    if (!phase) { this._finish(); return false; }

    // Fly there first, then hold and perform.
    if (!this.flight.moving) {
      this.hold += dt;
      if (phase.face) this.flight.face(phase.face);
      if (phase.tick) phase.tick(this, dt, this.hold);
      if (this.hold >= (phase.hold || 1)) {
        this.index++;
        this._enterPhase();
      }
    }
    // Keep a carried book glued in front of the body.
    this._updateBook(dt);
    return true;
  }

  _updateBook(dt) {
    const r = this.refs;
    if (!r.book) return;
    if (!r.book.visible) return;
    this.bookT += dt * 3;
    const e = this.entity;
    const open = 0.5 + Math.sin(this.bookT * 0.4) * 0.04;
    m4basis(
      this._bookMatrix,
      e.position[0] + e.forward[0] * 0.17,
      e.position[1] + e.up[1] * -0.06 + e.forward[1] * 0.17,
      e.position[2] + e.forward[2] * 0.17,
      e.right, e.up, e.forward, open, open, open
    );
    r.book.model.set(this._bookMatrix);
  }

  _finish() {
    const name = this.name;
    this.stop();
    this.onDone(name);
  }
}

/* ============================================================ the tasks ==== */

const TASKS = {
  // 🔎 to the PC, search animation, lean in, then return.
  search: () => [
    { at: 'deskWork', face: DESK_WORK.face, activity: 'typing', screen: 'search', hold: 3.5 },
    { at: 'center', activity: 'none', screen: 'code', hold: 0.6, emote: 'nod' },
  ],

  // 📖 grab a book from the shelf, sit down and read it.
  reading: (d) => [
    { at: 'shelfGrab', hold: 1.0, emote: 'peek', tick: (self) => { self.refs.book.visible = true; } },
    {
      at: 'sofaSit', activity: 'reading', hold: 4.5,
      tick: (self) => { self.refs.book.visible = true; },
    },
    { at: 'center', activity: 'none', hold: 0.5, tick: (self) => { self.refs.book.visible = false; } },
  ],

  // 📝 write in the notebook, lines visibly appearing.
  writing: () => [
    {
      at: 'deskWork', face: [-1, -0.5, 0], activity: 'typing', hold: 4.5,
      tick: (self, dt) => {
        self.pageProgress = clamp(self.pageProgress + dt / 4, 0, 1);
        self.refs.page.draw(self.pageProgress);
        self.renderer.updateTexture(self.refs.pageTexture, self.refs.page.canvas);
      },
    },
    { at: 'center', activity: 'none', hold: 0.5, emote: 'happy' },
  ],

  // 🧮 tap the calculator, digits appearing.
  calculating: () => [
    {
      at: 'deskWork', face: [-1, -0.45, 0.2], activity: 'typing', hold: 3.5,
      tick: (self, dt) => {
        self.calcTimer -= dt;
        if (self.calcTimer <= 0) {
          self.calcTimer = 0.35;
          self.calcValue += 1 + Math.floor(Math.random() * 9);
          self.refs.calc.draw(self.calcValue);
          self.renderer.updateTexture(self.refs.calcTexture, self.refs.calc.canvas);
          self.refs.calcScreen.material.emissiveStrength = 1.2;
        }
      },
    },
    { at: 'center', activity: 'none', hold: 0.5, emote: 'nod' },
  ],

  // 💡 pace, stop at the window, look out, then a sudden turn.
  thinking: () => [
    { at: 'center', activity: 'pondering', hold: 1.4 },
    { at: 'windowStand', activity: 'watching', hold: 2.2 },
    { at: 'center', hold: 0.8, emote: 'spin', activity: 'none' },
  ],

  // 🎵 lounge on the sofa and sway to a beat.
  music: () => [
    { at: 'sofaSit', activity: 'lounging', hold: 4.0, emote: 'happy' },
    { at: 'center', activity: 'none', hold: 0.5 },
  ],

  // 🗺️ pin notes onto the board, one by one.
  planning: () => [
    {
      at: 'boardStand', hold: 4.0, activity: 'none',
      tick: (self, dt, t) => {
        const n = Math.min(self.refs.pins.length, Math.floor(t / 0.8) + 1);
        self.refs.pins.forEach((p, i) => { p.visible = i < n; });
        if (Math.floor(t / 0.8) !== Math.floor((t - dt) / 0.8)) self.entity.playEmote('nod');
      },
    },
    { at: 'center', hold: 0.5, emote: 'happy' },
  ],

  // 🌦️ check the sky at the window.
  weather: () => [
    { at: 'windowStand', activity: 'watching', hold: 2.5 },
    { at: 'center', activity: 'none', hold: 0.5 },
  ],

  // 🗃️ open the cabinet and rifle through it.
  filing: () => [
    {
      at: 'cabinetStand', hold: 3.5, activity: 'reading',
      tick: (self, dt, t) => {
        const open = clamp(t / 0.6, 0, 1);
        const rifle = t > 0.8 ? Math.abs(Math.sin(t * 5)) * 0.1 : 0;
        self.refs.drawer.model[12] = self.refs.drawerClosedX + open * 0.22;
        self.entity.setGaze(0, -0.4 + rifle);
      },
    },
    { at: 'center', activity: 'none', hold: 0.5, tick: (self) => { self.refs.drawer.model[12] = self.refs.drawerClosedX; } },
  ],

  // 🛋️ stay put and answer where it is.
  casual: () => [
    { hold: 1.6, activity: 'none', emote: 'nod', tick: (self) => self.entity.setActivity('none') },
  ],

  // ⏳ work, get up to think, come back and re-type.
  long: () => [
    { at: 'deskWork', face: DESK_WORK.face, activity: 'typing', screen: 'code', hold: 3.0 },
    { at: 'center', activity: 'pondering', screen: 'code', hold: 1.6, emote: 'look' },
    { at: 'deskWork', face: DESK_WORK.face, activity: 'typing', screen: 'search', hold: 3.0 },
    { at: 'center', activity: 'none', hold: 0.6, emote: 'happy' },
  ],
};

export const TASK_NAMES = Object.keys(TASKS);
