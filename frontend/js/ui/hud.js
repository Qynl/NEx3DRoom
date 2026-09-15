/**
 * The whole visible interface: a whisper of status at the bottom of the screen.
 * No chat, no buttons, no forms - the room is the UI.
 */

const LABELS = {
  IDLE: 'floating quietly',
  BORED: 'looking around',
  THINKING: 'thinking',
  WORKING: 'working',
  RESTING: 'resting',
  SLEEPING: 'sleeping',
  WAKING: 'waking up',
  LISTENING: 'listening',
  SPEAKING: 'speaking',
};

const CONNECTION_TEXT = {
  connected: '',
  connecting: 'connecting to the room…',
  reconnecting: 'reconnecting to the room…',
  offline: 'backend offline - retrying',
};

export class Hud {
  constructor(elements = {}) {
    this.dock = elements.dock || document.getElementById('dock');
    this.label = elements.label || document.getElementById('dockLabel');
    this.sub = elements.sub || document.getElementById('dockSub');
    this.levels = Array.from((elements.levels || document.getElementById('levels')).children);
    this.presence = elements.presence || document.getElementById('presence');
    this.toast = elements.toast || document.getElementById('toast');
    this.toastText = elements.toastText || document.getElementById('toastText');
    this.loading = elements.loading || document.getElementById('loading');
    this.loadingText = elements.loadingText || document.getElementById('loadingText');

    this.state = 'WAKING';
    this.time = Math.random() * 10;
    this.awakeTimer = 0;
    this.level = 0;
    this._toastTimer = null;
  }

  setLoading(text) {
    if (this.loadingText) this.loadingText.textContent = text;
  }

  hideLoading() {
    if (!this.loading) return;
    this.loading.classList.add('done');
    setTimeout(() => { this.loading.hidden = true; }, 1000);
  }

  setState(state, placeLabel) {
    if (state !== this.state) {
      this.state = state;
      if (this.dock) this.dock.dataset.state = state;
      if (this.label) this.label.textContent = LABELS[state] || state.toLowerCase();
      this.awakeTimer = ['LISTENING', 'SPEAKING', 'THINKING', 'WORKING', 'WAKING'].includes(state) ? 9 : 3.5;
      if (this.dock) this.dock.classList.add('awake');
    }
    if (placeLabel && this.sub && this.sub.textContent !== placeLabel) {
      this.sub.textContent = placeLabel;
    }
  }

  setConnection(status) {
    const text = CONNECTION_TEXT[status] || '';
    if (!text) {
      if (this.toast && !this.toast.hidden) {
        this.toast.hidden = true;
      }
      return;
    }
    if (this.toast) {
      this.toast.hidden = false;
      if (this.toastText) this.toastText.textContent = text;
    }
  }

  /** Voice level 0..1 (driven by voice events, not by a real microphone yet). */
  setLevel(value) {
    this.level = value;
  }

  update(dt) {
    this.time += dt;
    this.awakeTimer = Math.max(0, this.awakeTimer - dt);
    if (this.dock) this.dock.classList.toggle('awake', this.awakeTimer > 0);

    const active = this.state === 'LISTENING' || this.state === 'SPEAKING';
    const target = active ? this.level : 0;
    for (let i = 0; i < this.levels.length; i++) {
      const phase = Math.sin(this.time * (6 + i * 1.7) + i * 1.1);
      const centre = 1 - Math.abs(i - (this.levels.length - 1) / 2) / ((this.levels.length - 1) / 2);
      const height = 3 + Math.max(0, phase) * target * 13 * (0.35 + centre * 0.65);
      this.levels[i].style.height = `${height.toFixed(1)}px`;
    }

    if (this.presence && this.time > 7) this.presence.classList.add('faded');
  }
}
