/**
 * Talks to the local Python backend.
 *
 * Primary channel is Server-Sent Events (instant state pushes). If the stream
 * ever drops, the client falls back to polling and keeps retrying, so the room
 * survives a backend restart without a reload.
 */

const POLL_INTERVAL = 1500;

export class Backend {
  constructor(handlers = {}) {
    this.onState = handlers.onState || (() => {});
    this.onStatus = handlers.onStatus || (() => {});
    this.onEvent = handlers.onEvent || (() => {});
    this.source = null;
    this.pollTimer = null;
    this.status = 'connecting';
    this.latency = 0;
    this.lastMessage = 0;
    this.requests = 0;
    this.errors = 0;
    this.mode = 'idle';
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  /* --------------------------------------------------------------- boot -- */

  async init() {
    const state = await this.fetchState();
    if (state) this.onState(state, 'init');
    this.connect();
    return state;
  }

  async fetchState() {
    const started = performance.now();
    try {
      const response = await fetch('api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      this.latency = Math.round(performance.now() - started);
      this.lastMessage = performance.now();
      this.requests++;
      this.setStatus('connected');
      return data;
    } catch (error) {
      this.errors++;
      this.setStatus('offline');
      return null;
    }
  }

  /* ---------------------------------------------------------------- sse -- */

  connect() {
    if (typeof EventSource === 'undefined') {
      this.startPolling();
      return;
    }
    this.stopPolling();
    this.mode = 'stream';
    try {
      this.source = new EventSource('api/events');
    } catch (error) {
      this.startPolling();
      return;
    }

    this.source.addEventListener('hello', (event) => this._handle('hello', event));
    this.source.addEventListener('snapshot', (event) => this._handle('snapshot', event));
    this.source.addEventListener('state', (event) => this._handle('state', event));
    this.source.addEventListener('location', (event) => this._handle('location', event));
    this.source.addEventListener('wander', (event) => this._handle('wander', event));
    this.source.addEventListener('voice', (event) => this._handle('voice', event));
    this.source.addEventListener('timeOfDay', (event) => this._handle('timeOfDay', event));
    this.source.addEventListener('ping', () => {
      this.lastMessage = performance.now();
      this.setStatus('connected');
    });

    this.source.onopen = () => {
      this.setStatus('connected');
      this.stopPolling();
    };

    this.source.onerror = () => {
      this.errors++;
      this.setStatus('reconnecting');
      // EventSource reconnects by itself; poll in the meantime so the room
      // never freezes while it works that out.
      this.startPolling();
    };
  }

  _handle(kind, event) {
    this.lastMessage = performance.now();
    this.setStatus('connected');
    let data = {};
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    this.onEvent(kind, data);
    if (kind === 'hello' && data.state) this.onState(data.state, 'hello');
    if (kind === 'snapshot') this.onState(data, 'snapshot');
  }

  /* ----------------------------------------------------------- polling -- */

  startPolling() {
    if (this.pollTimer) return;
    this.mode = this.mode === 'stream' ? 'stream+poll' : 'poll';
    this.pollTimer = setInterval(async () => {
      const state = await this.fetchState();
      if (state) this.onState(state, 'poll');
    }, POLL_INTERVAL);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.mode === 'stream+poll') this.mode = 'stream';
  }

  /* -------------------------------------------------------------- writes -- */

  async post(path, body) {
    const started = performance.now();
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      this.latency = Math.round(performance.now() - started);
      this.requests++;
      if (!response.ok) {
        this.errors++;
        return { ok: false, status: response.status };
      }
      return await response.json();
    } catch (error) {
      this.errors++;
      this.setStatus('offline');
      return { ok: false, error: String(error) };
    }
  }

  patch(values) {
    return this.post('api/state', values);
  }

  voiceEvent(event, extra = {}) {
    return this.post('api/voice-event', { event, ...extra });
  }

  reportArrival(location) {
    return this.post('api/state', { arrivedAt: location });
  }

  setConfig(patch) {
    return this.post('api/config', patch);
  }

  /** Fired when the window goes away so the desktop app can shut itself down. */
  notifyWindowClosed() {
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('api/window-closed', new Blob(['{}'], { type: 'application/json' }));
        return;
      }
    } catch (error) { /* ignore */ }
    this.post('api/window-closed', {});
  }

  close() {
    this.stopPolling();
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }
}
