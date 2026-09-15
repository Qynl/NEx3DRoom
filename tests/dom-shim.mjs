/**
 * A very small DOM + Canvas2D shim so the renderer modules can be exercised in
 * Node. Only the surface this project actually touches is implemented, but the
 * 2D context really rasterises: fillRect, gradients, paths and ImageData all
 * write into a real pixel buffer, so generated textures can be inspected.
 */

class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : !!force;
    if (want) this.set.add(name); else this.set.delete(name);
    return want;
  }
}

export class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList();
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.hidden = false;
    this.textContent = '';
    this._innerHTML = '';
    this.listeners = new Map();
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') this.children = [];
  }
  get childElementCount() { return this.children.length; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  appendChild(child) { this.children.push(child); return child; }
  prepend(child) { this.children.unshift(child); return child; }
  remove() { /* no parent tracking needed */ }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

/* -------------------------------------------------------------- canvas --- */

function parseColour(value) {
  if (typeof value !== 'string') return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const rgba = /rgba?\(([^)]+)\)/i.exec(value.trim());
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => parseFloat(p));
    return [parts[0] | 0, parts[1] | 0, parts[2] | 0, Math.round((parts[3] ?? 1) * 255)];
  }
  return [0, 0, 0, 255];
}

class Gradient {
  constructor(kind, coords) {
    this.kind = kind;
    this.coords = coords;
    this.stops = [];
  }
  addColorStop(offset, colour) {
    this.stops.push({ offset, colour: parseColour(colour) || [0, 0, 0, 255] });
  }
  sample(x, y) {
    if (!this.stops.length) return [0, 0, 0, 255];
    let t;
    if (this.kind === 'linear') {
      const [x0, y0, x1, y1] = this.coords;
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy || 1;
      t = ((x - x0) * dx + (y - y0) * dy) / len2;
    } else {
      const [, , , , x1, y1, r1] = this.coords;
      t = Math.hypot(x - x1, y - y1) / (r1 || 1);
    }
    t = Math.max(0, Math.min(1, t));
    const stops = this.stops;
    if (t <= stops[0].offset) return stops[0].colour;
    if (t >= stops[stops.length - 1].offset) return stops[stops.length - 1].colour;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (t >= a.offset && t <= b.offset) {
        const f = (t - a.offset) / ((b.offset - a.offset) || 1);
        return [
          a.colour[0] + (b.colour[0] - a.colour[0]) * f,
          a.colour[1] + (b.colour[1] - a.colour[1]) * f,
          a.colour[2] + (b.colour[2] - a.colour[2]) * f,
          a.colour[3] + (b.colour[3] - a.colour[3]) * f,
        ];
      }
    }
    return stops[stops.length - 1].colour;
  }
}

export class Context2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.globalAlpha = 1;
    this.font = '10px sans-serif';
    this.lineWidth = 1;
    this.path = [];
    this.current = null;
    this._stack = [];
  }

  _colourAt(x, y) {
    if (this.fillStyle && typeof this.fillStyle === 'object' && this.fillStyle.sample) {
      return this.fillStyle.sample(x, y);
    }
    return parseColour(this.fillStyle) || [0, 0, 0, 255];
  }

  _setPixel(x, y, colour) {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const i = (y * this.canvas.width + x) * 4;
    const a = (colour[3] / 255) * this.globalAlpha;
    this.data[i] = this.data[i] * (1 - a) + colour[0] * a;
    this.data[i + 1] = this.data[i + 1] * (1 - a) + colour[1] * a;
    this.data[i + 2] = this.data[i + 2] * (1 - a) + colour[2] * a;
    this.data[i + 3] = Math.min(255, this.data[i + 3] + a * 255);
  }

  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }

  getImageData(x, y, w, h) {
    const out = this.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const src = ((y + row) * this.canvas.width + (x + col)) * 4;
        const dst = (row * w + col) * 4;
        out.data[dst] = this.data[src];
        out.data[dst + 1] = this.data[src + 1];
        out.data[dst + 2] = this.data[src + 2];
        out.data[dst + 3] = this.data[src + 3];
      }
    }
    return out;
  }

  putImageData(image, x = 0, y = 0) {
    for (let row = 0; row < image.height; row++) {
      for (let col = 0; col < image.width; col++) {
        const dst = ((y + row) * this.canvas.width + (x + col)) * 4;
        const src = (row * image.width + col) * 4;
        if (dst < 0 || dst >= this.data.length) continue;
        this.data[dst] = image.data[src];
        this.data[dst + 1] = image.data[src + 1];
        this.data[dst + 2] = image.data[src + 2];
        this.data[dst + 3] = image.data[src + 3];
      }
    }
  }

  fillRect(x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvas.width, Math.ceil(x + w));
    const y1 = Math.min(this.canvas.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this._setPixel(px, py, this._colourAt(px + 0.5, py + 0.5));
    }
  }

  clearRect(x, y, w, h) {
    const previous = this.fillStyle;
    this.fillStyle = 'rgba(0,0,0,0)';
    const alpha = this.globalAlpha;
    this.globalAlpha = 1;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvas.width, Math.ceil(x + w));
    const y1 = Math.min(this.canvas.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * this.canvas.width + px) * 4;
        this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
      }
    }
    this.fillStyle = previous;
    this.globalAlpha = alpha;
  }

  createLinearGradient(x0, y0, x1, y1) { return new Gradient('linear', [x0, y0, x1, y1]); }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { return new Gradient('radial', [x0, y0, r0, x1, y1, r1]); }

  beginPath() { this.path = []; this.current = []; }
  moveTo(x, y) { this.current = [{ x, y }]; this.path.push(this.current); }
  lineTo(x, y) {
    if (!this.current) this.moveTo(x, y);
    else this.current.push({ x, y });
  }
  closePath() {
    if (this.current && this.current.length) this.current.push(this.current[0]);
  }
  arc(cx, cy, r, start, end) {
    const points = 24;
    if (!this.current) { this.current = []; this.path.push(this.current); }
    for (let i = 0; i <= points; i++) {
      const a = start + ((end - start) * i) / points;
      this.current.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  }
  ellipse(cx, cy, rx, ry, rot, start, end) {
    const points = 24;
    if (!this.current) { this.current = []; this.path.push(this.current); }
    for (let i = 0; i <= points; i++) {
      const a = start + ((end - start) * i) / points;
      const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
      this.current.push({
        x: cx + x * Math.cos(rot) - y * Math.sin(rot),
        y: cy + x * Math.sin(rot) + y * Math.cos(rot),
      });
    }
  }
  fill() {
    for (const poly of this.path) {
      if (poly.length < 3) continue;
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      for (const p of poly) {
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      }
      for (let y = Math.max(0, Math.floor(minY)); y < Math.min(this.canvas.height, Math.ceil(maxY)); y++) {
        for (let x = Math.max(0, Math.floor(minX)); x < Math.min(this.canvas.width, Math.ceil(maxX)); x++) {
          if (pointInPolygon(x + 0.5, y + 0.5, poly)) this._setPixel(x, y, this._colourAt(x + 0.5, y + 0.5));
        }
      }
    }
  }
  stroke() {
    for (const poly of this.path) {
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
        for (let s = 0; s <= steps; s++) {
          const x = Math.round(a.x + ((b.x - a.x) * s) / steps);
          const y = Math.round(a.y + ((b.y - a.y) * s) / steps);
          this._setPixel(x, y, parseColour(this.strokeStyle) || [0, 0, 0, 255]);
        }
      }
    }
  }
  save() { this._stack.push({ fill: this.fillStyle, alpha: this.globalAlpha, stroke: this.strokeStyle }); }
  restore() {
    const state = this._stack.pop();
    if (state) {
      this.fillStyle = state.fill;
      this.globalAlpha = state.alpha;
      this.strokeStyle = state.stroke;
    }
  }
  translate() {}
  scale() {}
  fillText() {}
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

class Canvas extends Element {
  constructor() {
    super('canvas');
    this._width = 300;
    this._height = 150;
    this._ctx = null;
  }
  get width() { return this._width; }
  set width(value) {
    this._width = value;
    if (this._ctx) this._ctx.data = new Uint8ClampedArray(this._width * this._height * 4);
  }
  get height() { return this._height; }
  set height(value) {
    this._height = value;
    if (this._ctx) this._ctx.data = new Uint8ClampedArray(this._width * this._height * 4);
  }
  getContext(kind) {
    if (kind === '2d') {
      if (!this._ctx) this._ctx = new Context2D(this);
      return this._ctx;
    }
    return this._glContext || null;
  }
}

/* ------------------------------------------------------------- document -- */

const elements = new Map();

export function installDom() {
  const document = {
    createElement(tag) {
      return tag === 'canvas' ? new Canvas() : new Element(tag);
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const el = new Element('div', id);
        if (id === 'levels') {
          for (let i = 0; i < 7; i++) el.appendChild(new Element('i'));
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    documentElement: new Element('html'),
    body: new Element('body'),
    fullscreenElement: null,
    addEventListener() {},
    exitFullscreen() {},
  };
  globalThis.document = document;
  if (!globalThis.window) globalThis.window = {};
  try { globalThis.window.devicePixelRatio = 1; } catch (error) { /* ignore */ }
  try { globalThis.window.addEventListener = () => {}; } catch (error) { /* ignore */ }
  if (!globalThis.navigator || !globalThis.navigator.sendBeacon) {
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { ...(globalThis.navigator || {}), sendBeacon: () => true },
        configurable: true,
      });
    } catch (error) {
      /* Node's navigator is read-only; the app only uses sendBeacon. */
    }
  }
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  return document;
}

export { Canvas };
