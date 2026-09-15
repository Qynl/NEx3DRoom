/**
 * F1 developer overlay. Hidden by default; it exists so the room can be
 * inspected and driven by hand while developing (state transitions, voice
 * events, time of day, renderer stats).
 */

import { PLACES } from '../world/layout.js';

const STATES = ['IDLE', 'BORED', 'LISTENING', 'THINKING', 'WORKING', 'SPEAKING', 'RESTING', 'SLEEPING', 'WAKING'];
const EMOTES = ['spin', 'stretch', 'wiggle', 'nod', 'bounce', 'look', 'shake', 'happy', 'sigh', 'scan', 'peek'];
const VOICE_EVENTS = [
  'user_started_speaking',
  'user_finished_speaking',
  'ai_started_thinking',
  'ai_started_speaking',
  'ai_finished_speaking',
];

export class DebugOverlay {
  constructor(elements = {}) {
    this.root = elements.root || document.getElementById('debug');
    this.grid = elements.grid || document.getElementById('debugGrid');
    this.statesRow = elements.states || document.getElementById('debugStates');
    this.placesRow = elements.places || document.getElementById('debugPlaces');
    this.voiceRow = elements.voice || document.getElementById('debugVoice');
    this.emotesRow = elements.emotes || document.getElementById('debugEmotes');
    this.log = elements.log || document.getElementById('debugLog');
    this.visible = false;
    this.actions = {};
    this.snapshot = null;
    this.stats = {};
    this.refreshTimer = 0;
    this.lines = [];
    this._build();
  }

  setActions(actions) {
    this.actions = actions || {};
    this._buildButtons();
  }

  _build() {
    if (!this.root) return;
    this.root.hidden = true;
    this._buildButtons();
  }

  _buildButtons() {
    if (!this.root) return;
    const make = (label, active, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (active) button.classList.add('active');
      button.addEventListener('click', onClick);
      return button;
    };

    if (this.statesRow) {
      this.statesRow.textContent = '';
      for (const state of STATES) {
        this.statesRow.appendChild(make(state.toLowerCase(), this.snapshot?.currentState === state, () => {
          this.actions.setState?.(state);
          this.logLine(`state -> ${state}`);
        }));
      }
    }

    if (this.placesRow) {
      this.placesRow.textContent = '';
      for (const name of Object.keys(PLACES)) {
        this.placesRow.appendChild(make(name.toLowerCase(), this.snapshot?.targetLocation === name, () => {
          this.actions.goTo?.(name);
          this.logLine(`travel -> ${name}`);
        }));
      }
      this.placesRow.appendChild(make('reset camera', false, () => this.actions.resetCamera?.()));
      for (const tod of ['DAY', 'SUNSET', 'NIGHT']) {
        this.placesRow.appendChild(make(tod.toLowerCase(), this.snapshot?.timeOfDay === tod, () => {
          this.actions.setTimeOfDay?.(tod);
          this.logLine(`time -> ${tod}`);
        }));
      }
    }

    if (this.voiceRow) {
      this.voiceRow.textContent = '';
      for (const event of VOICE_EVENTS) {
        this.voiceRow.appendChild(make(event.replace(/_/g, ' '), false, () => {
          this.actions.voice?.(event);
          this.logLine(`voice: ${event}`);
        }));
      }
      this.voiceRow.appendChild(make('interaction', false, () => this.actions.voice?.('user_interaction')));
    }

    if (this.emotesRow) {
      this.emotesRow.textContent = '';
      for (const emote of EMOTES) {
        this.emotesRow.appendChild(make(emote, false, () => {
          this.actions.emote?.(emote);
          this.logLine(`emote: ${emote}`);
        }));
      }
    }
  }

  toggle(force) {
    this.visible = force === undefined ? !this.visible : !!force;
    if (this.root) this.root.hidden = !this.visible;
    return this.visible;
  }

  logLine(text) {
    if (!this.log) return;
    const time = new Date();
    const stamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;
    const row = document.createElement('div');
    const span = document.createElement('span');
    span.className = 't';
    span.textContent = stamp + ' ';
    row.appendChild(span);
    row.appendChild(document.createTextNode(text));
    this.log.prepend(row);
    while (this.log.childElementCount > 14) this.log.lastChild.remove();
  }

  update(dt, snapshot, stats) {
    this.snapshot = snapshot;
    this.stats = stats;
    if (!this.visible) return;
    this.refreshTimer -= dt;
    if (this.refreshTimer > 0) return;
    this.refreshTimer = 0.15;
    this._render();
  }

  _render() {
    const s = this.snapshot || {};
    const stats = this.stats || {};
    const model = s.model || {};
    const rows = [
      ['fps', stats.fps ? stats.fps.toFixed(0) : '-', stats.fps > 50 ? 'good' : stats.fps > 30 ? 'warn' : 'bad'],
      ['frame', stats.frameMs ? stats.frameMs.toFixed(1) + ' ms' : '-'],
      ['draw calls', String(stats.drawCalls ?? '-')],
      ['triangles', stats.triangles ? (stats.triangles / 1000).toFixed(0) + 'k' : '-'],
      ['gpu', stats.gpu || '-'],
      ['state', s.currentState || '-'],
      ['activity', s.activity || '-'],
      ['location', `${s.currentLocation || '-'} → ${s.targetLocation || '-'}`],
      ['energy', s.energy !== undefined ? s.energy.toFixed(0) + '%' : '-'],
      ['mood', s.mood !== undefined ? `${(s.mood * 100).toFixed(0)}% ${s.moodLabel || ''}` : '-'],
      ['voice', [s.isListening && 'listening', s.isSpeaking && 'speaking', s.isThinking && 'thinking'].filter(Boolean).join('+') || 'idle'],
      ['turn', s.turn ? `${s.turn.phase} ${s.turn.elapsed.toFixed(1)}s` : 'none'],
      ['time of day', s.timeOfDay || '-'],
      ['backend', stats.connection || '-'],
      ['transport', stats.mode || '-'],
      ['latency', stats.latency !== undefined ? stats.latency + ' ms' : '-'],
      ['model', `${model.name || '-'} (${model.provider || '-'})`],
      ['model link', model.connected ? 'connected' : 'placeholder'],
      ['camera', stats.camera || '-'],
      ['uptime', s.uptime ? s.uptime.toFixed(0) + 's' : '-'],
    ];

    const html = rows
      .map(([key, value, cls]) => `<dt>${key}</dt><dd${cls ? ` class="${cls}"` : ''}>${value}</dd>`)
      .join('');
    if (this.grid && this.grid.innerHTML !== html) this.grid.innerHTML = html;
  }
}
