/**
 * Every texture in the room is generated at start-up from noise functions and
 * canvas drawing. Nothing is downloaded, nothing is loaded from disk.
 *
 * Each material texture is returned as { albedo, rough, normal } canvases so the
 * renderer can upload them straight to the GPU.
 */

import { clamp, makeRandom } from './math.js';

/* ---------------------------------------------------------------- noise -- */

const PERM = (() => {
  const random = makeRandom(90210);
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
})();

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function grad(hash, x, y) {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return x - y;
    case 2: return -x + y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/** Tileable 2D Perlin noise on an integer period. */
export function noise2D(x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const X = ((xi % period) + period) % period;
  const Y = ((yi % period) + period) % period;
  const X1 = (X + 1) % period, Y1 = (Y + 1) % period;
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[X] + Y];
  const ab = PERM[PERM[X] + Y1];
  const ba = PERM[PERM[X1] + Y];
  const bb = PERM[PERM[X1] + Y1];
  const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
  const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v);
}

const lerp = (a, b, t) => a + (b - a) * t;

export function fbm(x, y, period, octaves = 4, gain = 0.5, lacunarity = 2) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2D(x * freq, y * freq, Math.max(1, Math.round(period * freq))) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / (norm || 1);
}

/* --------------------------------------------------------------- canvas -- */

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function putPixels(canvas, data) {
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(canvas.width, canvas.height);
  image.data.set(data);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Height field -> tangent space normal map canvas. */
export function heightToNormal(height, size, strength = 2.0) {
  const out = makeCanvas(size, size);
  const data = new Uint8ClampedArray(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      data[i] = ((dx / l) * 0.5 + 0.5) * 255;
      data[i + 1] = ((dy / l) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return putPixels(out, data);
}

/* --------------------------------------------------------------- wood ---- */

export function woodTexture(opts = {}) {
  const {
    size = 512,
    planks = 4,
    base = '#8a5a34',
    dark = '#4a2d18',
    light = '#b5814f',
    grain = 1.0,
    roughness = 0.55,
    roughVariation = 0.22,
    seed = 7,
  } = opts;
  const random = makeRandom(seed);
  const baseRgb = hexToRgb(base), darkRgb = hexToRgb(dark), lightRgb = hexToRgb(light);
  const albedoData = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const roughData = new Uint8ClampedArray(size * size * 4);

  // Per plank colour and offset so the floor never looks tiled.
  const plankTint = [];
  for (let p = 0; p < planks * 2; p++) {
    plankTint.push(0.82 + random() * 0.36);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const plankIndex = Math.floor(v * planks);
      const plankV = (v * planks) % 1;
      const tint = plankTint[(plankIndex * 3) % plankTint.length];

      // Long grain running along the plank.
      const warp = fbm(u * 3 + plankIndex * 11.3, v * 12, 8, 3) * 0.6;
      const rings = Math.sin((u * 26 + warp * 6 + plankIndex * 5.1) * Math.PI) * 0.5 + 0.5;
      const fine = fbm(u * 90, v * 340 + plankIndex * 31, 16, 3, 0.55) * 0.5 + 0.5;
      const pore = Math.pow(fine, 3.0);

      let shade = 0.62 + rings * 0.30 * grain + pore * 0.22 * grain;
      shade *= tint;

      // Darker seams between planks, and a subtle bevel highlight.
      const seam = plankV < 0.008 || plankV > 0.992 ? 0.42 : 1;
      const bevel = plankV < 0.05 ? 0.9 + plankV * 2 : plankV > 0.95 ? 0.9 + (1 - plankV) * 2 : 1;
      shade *= seam * clamp(bevel, 0.85, 1.06);

      // Occasional knot.
      const knot = fbm(u * 6 + 3.7, v * 6 + plankIndex * 2.2, 4, 2);
      if (knot > 0.62) shade *= 0.72 + (0.62 - knot) * 0.4;

      const mixToLight = clamp((shade - 0.85) * 2.2, 0, 1);
      const mixToDark = clamp((0.72 - shade) * 2.4, 0, 1);
      let r = lerp(baseRgb[0], lightRgb[0], mixToLight);
      let g = lerp(baseRgb[1], lightRgb[1], mixToLight);
      let b = lerp(baseRgb[2], lightRgb[2], mixToLight);
      r = lerp(r, darkRgb[0], mixToDark);
      g = lerp(g, darkRgb[1], mixToDark);
      b = lerp(b, darkRgb[2], mixToDark);

      const i = (y * size + x) * 4;
      albedoData[i] = r; albedoData[i + 1] = g; albedoData[i + 2] = b; albedoData[i + 3] = 255;

      const h = clamp(pore * 0.5 + (seam < 1 ? -0.5 : 0) + rings * 0.12, -1, 1);
      height[y * size + x] = h;

      const rough = clamp(roughness + pore * roughVariation - rings * 0.06, 0.05, 1) * 255;
      roughData[i] = rough; roughData[i + 1] = rough; roughData[i + 2] = rough; roughData[i + 3] = 255;
    }
  }

  return {
    albedo: putPixels(makeCanvas(size, size), albedoData),
    rough: putPixels(makeCanvas(size, size), roughData),
    normal: heightToNormal(height, size, 1.6),
  };
}

/* -------------------------------------------------------------- fabric --- */

export function fabricTexture(opts = {}) {
  const {
    size = 256,
    base = '#7c6a58',
    weave = 0.5,
    fuzz = 0.55,
    roughness = 0.86,
    seed = 21,
  } = opts;
  const baseRgb = hexToRgb(base);
  const albedoData = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const roughData = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const threads = 34;
      const warp = Math.sin(u * threads * Math.PI * 2) * 0.5 + 0.5;
      const weft = Math.sin(v * threads * Math.PI * 2) * 0.5 + 0.5;
      const checker = ((Math.floor(u * threads) + Math.floor(v * threads)) % 2) === 0;
      const pattern = checker ? warp : weft;
      const lint = fbm(u * 130, v * 130, 32, 4, 0.6) * 0.5 + 0.5;
      const slub = fbm(u * 18 + 5, v * 18, 8, 3) * 0.5 + 0.5;

      const shade = 0.78 + pattern * 0.2 * weave + lint * 0.16 * fuzz + slub * 0.1;
      const i = (y * size + x) * 4;
      albedoData[i] = clamp(baseRgb[0] * shade, 0, 255);
      albedoData[i + 1] = clamp(baseRgb[1] * shade, 0, 255);
      albedoData[i + 2] = clamp(baseRgb[2] * shade, 0, 255);
      albedoData[i + 3] = 255;

      height[y * size + x] = pattern * 0.6 + lint * 0.4;
      const rough = clamp(roughness + lint * 0.1 - pattern * 0.05, 0.1, 1) * 255;
      roughData[i] = rough; roughData[i + 1] = rough; roughData[i + 2] = rough; roughData[i + 3] = 255;
    }
  }
  return {
    albedo: putPixels(makeCanvas(size, size), albedoData),
    rough: putPixels(makeCanvas(size, size), roughData),
    normal: heightToNormal(height, size, 1.1),
  };
}

/* ------------------------------------------------------------- plaster --- */

export function plasterTexture(opts = {}) {
  const { size = 256, base = '#d8cfc2', roughness = 0.9, seed = 5 } = opts;
  const baseRgb = hexToRgb(base);
  const albedoData = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const roughData = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const broad = fbm(u * 6, v * 6, 6, 4) * 0.5 + 0.5;
      const fine = fbm(u * 70 + 11, v * 70, 32, 3) * 0.5 + 0.5;
      const shade = 0.94 + broad * 0.05 + fine * 0.05;
      const i = (y * size + x) * 4;
      albedoData[i] = clamp(baseRgb[0] * shade, 0, 255);
      albedoData[i + 1] = clamp(baseRgb[1] * shade, 0, 255);
      albedoData[i + 2] = clamp(baseRgb[2] * shade, 0, 255);
      albedoData[i + 3] = 255;
      height[y * size + x] = broad * 0.5 + fine * 0.5;
      const rough = clamp(roughness + fine * 0.06, 0.2, 1) * 255;
      roughData[i] = rough; roughData[i + 1] = rough; roughData[i + 2] = rough; roughData[i + 3] = 255;
    }
  }
  return {
    albedo: putPixels(makeCanvas(size, size), albedoData),
    rough: putPixels(makeCanvas(size, size), roughData),
    normal: heightToNormal(height, size, 0.55),
  };
}

/* ----------------------------------------------------------------- rug --- */

export function rugTexture(opts = {}) {
  const { size = 512, base = '#5d4a44', accent = '#a8896a' } = opts;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const baseRgb = hexToRgb(base), accentRgb = hexToRgb(accent);
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const pile = fbm(u * 160, v * 160, 40, 3) * 0.5 + 0.5;
      const border = Math.min(u, v, 1 - u, 1 - v);
      const band = border < 0.045 || (border > 0.075 && border < 0.085) ? 1 : 0;
      const i = (y * size + x) * 4;
      const shade = 0.86 + pile * 0.3;
      const mix = band * 0.85;
      data[i] = clamp(lerp(baseRgb[0], accentRgb[0], mix) * shade, 0, 255);
      data[i + 1] = clamp(lerp(baseRgb[1], accentRgb[1], mix) * shade, 0, 255);
      data[i + 2] = clamp(lerp(baseRgb[2], accentRgb[2], mix) * shade, 0, 255);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { albedo: canvas };
}

/* ------------------------------------------------------------ wall art --- */

export function artTexture(seed = 3, palette = ['#2f3d4a', '#c98a4b', '#e8dfd2']) {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const random = makeRandom(seed * 977);
  const gradient = ctx.createLinearGradient(0, 0, size * 0.4, size);
  gradient.addColorStop(0, palette[2]);
  gradient.addColorStop(1, palette[0]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 7; i++) {
    ctx.globalAlpha = 0.12 + random() * 0.3;
    ctx.fillStyle = palette[Math.floor(random() * palette.length)];
    const w = size * (0.1 + random() * 0.5);
    const h = size * (0.06 + random() * 0.4);
    const x = random() * size * 0.8;
    const y = random() * size * 0.85;
    if (random() > 0.5) {
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }
  ctx.globalAlpha = 1;
  // Canvas tooth.
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (random() - 0.5) * 12;
    image.data[i] = clamp(image.data[i] + n, 0, 255);
    image.data[i + 1] = clamp(image.data[i + 1] + n, 0, 255);
    image.data[i + 2] = clamp(image.data[i + 2] + n, 0, 255);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/* -------------------------------------------------------- soft glow disc -- */

export function radialGlow(size = 128, exponent = 2.4) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / c, dy = (y + 0.5 - c) / c;
      const r = clamp(Math.hypot(dx, dy), 0, 1);
      const a = Math.pow(1 - r, exponent);
      const i = (y * size + x) * 4;
      data.data[i] = 255;
      data.data[i + 1] = 255;
      data.data[i + 2] = 255;
      data.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** Soft round blob used for fake contact shadows under furniture. */
export function contactShadow(size = 128) {
  return radialGlow(size, 3.2);
}

/* ------------------------------------------------------- monitor screen -- */

/**
 * The desk monitor. Redrawn a few times per second while the AI works:
 * a plausible mix of code, a waveform and a progress bar.
 */
export function createScreenTexture(width = 320, height = 200) {
  const canvas = makeCanvas(width, height);
  const random = makeRandom(4242);
  let scroll = 0;
  const lines = Array.from({ length: 14 }, () => ({
    indent: Math.floor(random() * 4),
    blocks: Array.from({ length: 2 + Math.floor(random() * 5) }, () => 8 + Math.floor(random() * 46)),
    hue: random(),
  }));

  return {
    canvas,
    /** activity: 0 = standby, 1 = busy */
    draw(activity = 1, t = 0) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = activity > 0.05 ? '#0a1016' : '#04070a';
      ctx.fillRect(0, 0, width, height);

      if (activity <= 0.05) {
        // Standby: a single slowly breathing dot.
        const pulse = 0.35 + 0.35 * Math.sin(t * 1.4);
        ctx.fillStyle = `rgba(120, 200, 235, ${pulse})`;
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 3.2, 0, Math.PI * 2);
        ctx.fill();
        return canvas;
      }

      const a = clamp(activity, 0, 1);
      ctx.globalAlpha = a;

      // "Code"
      const lineH = 11;
      const offset = (scroll * lineH) % (lines.length * lineH);
      ctx.font = '9px monospace';
      for (let i = 0; i < lines.length + 2; i++) {
        const line = lines[(i + Math.floor(scroll)) % lines.length];
        const y = 16 + i * lineH - (offset % lineH);
        if (y < 6 || y > height - 34) continue;
        let x = 12 + line.indent * 9;
        for (const w of line.blocks) {
          const colour = line.hue > 0.72 ? '#e0a86a'
            : line.hue > 0.4 ? '#7fd4e8'
            : line.hue > 0.2 ? '#9aa7b4' : '#5f7f8c';
          ctx.fillStyle = colour;
          ctx.fillRect(x, y, w, 4);
          x += w + 5;
          if (x > width - 20) break;
        }
      }

      // Waveform
      ctx.strokeStyle = `rgba(127, 228, 255, ${0.55 * a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let x = 0; x <= width; x += 3) {
        const v = Math.sin(x * 0.08 + t * 3.2) * 6 * Math.sin(x * 0.011 + t)
                + Math.sin(x * 0.21 - t * 5.1) * 2.4;
        const y = height - 24 + v;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Progress bar
      const progress = (Math.sin(t * 0.35) * 0.5 + 0.5);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(12, height - 10, width - 24, 3);
      ctx.fillStyle = `rgba(127, 228, 255, ${0.85 * a})`;
      ctx.fillRect(12, height - 10, (width - 24) * progress, 3);

      ctx.globalAlpha = 1;
      return canvas;
    },
    advance(amount = 1) { scroll += amount * 0.35; },
  };
}

/* ------------------------------------------------------------ sky / IBL -- */

/* -------------------------------------------------------------- marble --- */

export function marbleTexture(opts = {}) {
  const { size = 256, base = '#e8e4dd', vein = '#8f8a83', roughness = 0.22, seed = 21 } = opts;
  const baseRgb = hexToRgb(base);
  const veinRgb = hexToRgb(vein);
  const albedoData = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const roughData = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Ridged fbm gives the soft grey veins running through the stone.
      const warp = fbm(u * 3 + 7.3, v * 3 + 2.1, 4, 3);
      const ridge = Math.abs(Math.sin((u * 2.2 + v * 1.4 + warp * 1.6) * Math.PI * 2));
      const veinAmt = Math.pow(1 - clamp(ridge * 1.6, 0, 1), 3.0);
      const fine = fbm(u * 40 + seed, v * 40, 8, 3) * 0.5 + 0.5;
      const mottle = 0.96 + fine * 0.05;
      const t = clamp(veinAmt * (0.5 + fine * 0.5), 0, 1);
      const i = (y * size + x) * 4;
      albedoData[i] = clamp((baseRgb[0] * (1 - t) + veinRgb[0] * t) * mottle, 0, 255);
      albedoData[i + 1] = clamp((baseRgb[1] * (1 - t) + veinRgb[1] * t) * mottle, 0, 255);
      albedoData[i + 2] = clamp((baseRgb[2] * (1 - t) + veinRgb[2] * t) * mottle, 0, 255);
      albedoData[i + 3] = 255;
      height[y * size + x] = 1 - veinAmt * 0.6 + fine * 0.2;
      const rough = clamp(roughness + veinAmt * 0.2 + fine * 0.05, 0.05, 1) * 255;
      roughData[i] = rough; roughData[i + 1] = rough; roughData[i + 2] = rough; roughData[i + 3] = 255;
    }
  }
  return {
    albedo: putPixels(makeCanvas(size, size), albedoData),
    rough: putPixels(makeCanvas(size, size), roughData),
    normal: heightToNormal(height, size, 0.5),
  };
}

/* -------------------------------------------------------------- rattan --- */

export function rattanTexture(opts = {}) {
  const { size = 256, base = '#b98a52', dark = '#7a5527', roughness = 0.7, seed = 9 } = opts;
  const baseRgb = hexToRgb(base);
  const darkRgb = hexToRgb(dark);
  const albedoData = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  const roughData = new Uint8ClampedArray(size * size * 4);
  const weave = 10; // strands across
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const a = Math.sin((u + v) * Math.PI * weave);
      const b = Math.sin((u - v) * Math.PI * weave);
      const strand = Math.max(a, b);
      const over = a > b ? 1 : 0;
      const gap = clamp(strand, 0, 1);
      const fine = fbm(u * 60 + seed, v * 60, 8, 2) * 0.5 + 0.5;
      const shade = 0.72 + gap * 0.3 + over * 0.06 + fine * 0.06;
      const t = clamp(1 - gap, 0, 1) * 0.7;
      const i = (y * size + x) * 4;
      albedoData[i] = clamp((baseRgb[0] * (1 - t) + darkRgb[0] * t) * shade, 0, 255);
      albedoData[i + 1] = clamp((baseRgb[1] * (1 - t) + darkRgb[1] * t) * shade, 0, 255);
      albedoData[i + 2] = clamp((baseRgb[2] * (1 - t) + darkRgb[2] * t) * shade, 0, 255);
      albedoData[i + 3] = 255;
      height[y * size + x] = gap * 0.8 + over * 0.2;
      const rough = clamp(roughness + (1 - gap) * 0.2, 0.2, 1) * 255;
      roughData[i] = rough; roughData[i + 1] = rough; roughData[i + 2] = rough; roughData[i + 3] = 255;
    }
  }
  return {
    albedo: putPixels(makeCanvas(size, size), albedoData),
    rough: putPixels(makeCanvas(size, size), roughData),
    normal: heightToNormal(height, size, 1.4),
  };
}

/* ------------------------------------------------------ AI face screen --- */

/**
 * A small transparent canvas that draws the companion's glowing face - two
 * warm vertical-oval eyes and a smile - so the dark visor reads like the little
 * robot screen from the concept art. Everything is parameter driven so the same
 * canvas can blink, look around, talk, doze and wake.
 */
export function createFaceTexture(size = 256) {
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  function oval(x, y, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(o) {
    const col = o.colour || [1, 0.68, 0.32];
    const rgb = `rgb(${Math.round(col[0]*255)},${Math.round(col[1]*255)},${Math.round(col[2]*255)})`;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = rgb;
    ctx.strokeStyle = rgb;
    ctx.shadowColor = rgb;
    ctx.shadowBlur = size * 0.05 * (0.6 + (o.glow || 2) * 0.16);
    ctx.lineCap = 'round';

    const gx = (o.gazeX || 0) * size * 0.045;
    const gy = (o.gazeY || 0) * size * 0.035;
    const eyeY = c - size * 0.075 + gy;
    const eyeX = size * 0.175;
    const open = o.open === undefined ? 1 : o.open;
    const sx = (o.scaleX || 1);
    const sy = (o.scaleY || 1);
    const blink = o.blink || 0;
    const openY = Math.max(0.04, open * sy * (1 - blink * 0.94));

    const happy = o.happy || 0;
    const surprised = o.surprised || 0;
    const squint = o.squint || 0;
    const openEff = openY * (1 - squint * 0.55);
    const rx = size * 0.062 * sx * (1 + blink * 0.1) * (1 + surprised * 0.35);
    const ry = size * 0.095 * Math.max(0.04, openEff) * (1 + surprised * 0.3);

    if (openEff < 0.16) {
      // Dozing: closed eyes as soft downward arcs.
      ctx.lineWidth = size * 0.035;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(c + s * eyeX + gx, eyeY - size * 0.02, size * 0.062, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
    } else if (happy > 0.5) {
      // Delighted: eyes become upward arcs.
      ctx.lineWidth = size * 0.045;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(c + s * eyeX + gx, eyeY + size * 0.03, size * 0.07, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    } else {
      for (const s of [-1, 1]) oval(c + s * eyeX + gx, eyeY, rx, ry);
    }

    // Mouth: smile -> open while speaking -> little "o" when surprised.
    const mouthY = c + size * 0.16 + gy * 0.5;
    const speak = o.speaking || 0;
    if (surprised > 0.4) {
      oval(c + gx * 0.5, mouthY, size * 0.045, size * 0.06 * surprised);
    } else if (speak > 0.12) {
      const openM = size * 0.05 + speak * size * 0.05;
      const wide = happy > 0.5 ? 1.35 : 1;
      oval(c + gx * 0.5, mouthY, size * 0.055 * wide, openM);
    } else {
      ctx.lineWidth = size * 0.042;
      ctx.beginPath();
      const r = size * 0.115 * (1 + happy * 0.25);
      const y0 = mouthY - size * 0.055 - happy * size * 0.02;
      ctx.arc(c + gx * 0.5, y0, r, Math.PI * (0.18 - happy * 0.06), Math.PI * (0.82 + happy * 0.06));
      ctx.stroke();
    }
    return canvas;
  }

  return { canvas, draw };
}

export const SKY_PRESETS = {
  DAY: {
    zenith: [0.34, 0.55, 0.95],
    horizon: [0.86, 0.90, 0.96],
    ground: [0.30, 0.26, 0.22],
    sunDir: [0.36, 0.62, -0.70],
    sunColor: [7.5, 6.9, 5.9],
    sunSize: 0.9965,
    exposure: 1.0,
  },
  SUNSET: {
    zenith: [0.16, 0.20, 0.42],
    horizon: [0.95, 0.46, 0.22],
    ground: [0.24, 0.16, 0.13],
    sunDir: [0.55, 0.17, -0.82],
    sunColor: [8.2, 3.6, 1.5],
    sunSize: 0.9975,
    exposure: 1.08,
  },
  NIGHT: {
    zenith: [0.020, 0.030, 0.062],
    horizon: [0.055, 0.070, 0.110],
    ground: [0.030, 0.030, 0.036],
    sunDir: [0.30, 0.55, -0.78],
    sunColor: [0.55, 0.66, 1.05],
    sunSize: 0.9988,
    exposure: 1.22,
  },
};

const CUBE_DIRS = [
  (s, t) => [1, t, -s],
  (s, t) => [-1, t, s],
  (s, t) => [s, 1, -t],
  (s, t) => [s, -1, t],
  (s, t) => [s, t, 1],
  (s, t) => [-s, t, -1],
];

/** Build the six HDR faces of the image based lighting cube map. */
export function skyCubeFaces(preset, size = 64, mix = null) {
  const a = SKY_PRESETS[preset] || SKY_PRESETS.DAY;
  const b = mix ? (SKY_PRESETS[mix] || a) : a;
  const w = mix ? 0 : 1; // 1 = fully `a`
  const faces = [];
  const sunLen = Math.hypot(...a.sunDir) || 1;
  const sun = a.sunDir.map((v) => v / sunLen);

  for (let f = 0; f < 6; f++) {
    const data = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const t = 1 - 2 * ((y + 0.5) / size);
      for (let x = 0; x < size; x++) {
        const s = 2 * ((x + 0.5) / size) - 1;
        const dir = CUBE_DIRS[f](s, t);
        const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        const dx = dir[0] / l, dy = dir[1] / l, dz = dir[2] / l;

        const up = clamp(dy, 0, 1);
        const h = Math.pow(1 - up, 5.0);
        let r = lerp(a.zenith[0], a.horizon[0], h);
        let g = lerp(a.zenith[1], a.horizon[1], h);
        let bl = lerp(a.zenith[2], a.horizon[2], h);
        if (dy < 0) {
          const down = clamp(-dy, 0, 1);
          r = lerp(r, a.ground[0], down);
          g = lerp(g, a.ground[1], down);
          bl = lerp(bl, a.ground[2], down);
        }

        const d = dx * sun[0] + dy * sun[1] + dz * sun[2];
        if (d > a.sunSize) {
          const k = (d - a.sunSize) / (1 - a.sunSize);
          const glow = Math.pow(k, 1.6) * 6 + Math.pow(k, 24) * 90;
          r += a.sunColor[0] * glow * 0.08;
          g += a.sunColor[1] * glow * 0.08;
          bl += a.sunColor[2] * glow * 0.08;
        }

        if (w < 1) {
          r = lerp(b.zenith[0], r, w);
          g = lerp(b.zenith[1], g, w);
          bl = lerp(b.zenith[2], bl, w);
        }

        const i = (y * size + x) * 4;
        data[i] = Math.max(0, r);
        data[i + 1] = Math.max(0, g);
        data[i + 2] = Math.max(0, bl);
        data[i + 3] = 1;
      }
    }
    faces.push(data);
  }
  return faces;
}
