/**
 * The view outside the window. One textured quad, repainted when the time of
 * day changes - it is what sells "there is a world out there".
 */

import { quadGeometry } from '../core/geometry.js';
import { m4trs } from '../core/math.js';
import { ROOM, WINDOW } from './layout.js';

export function createSkyPanel(renderer, materials) {
  const width = 5.2;
  const height = 3.6;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');

  const material = {
    albedo: [1, 1, 1],
    roughness: 1,
    metallic: 0,
    emissive: [1, 1, 1],
    emissiveStrength: 1.35,
    name: 'skyPanel',
    maps: {},
  };

  const texture = renderer.createTexture(canvas, { clamp: true, mips: true });
  material.maps.albedo = texture;

  const item = renderer.addDynamic(quadGeometry(width, height), material, {
    tag: 'skyPanel',
    castShadow: false,
    receiveShadow: false,
  });
  item.model = m4trs(
    new Float32Array(16),
    [WINDOW.centerX, WINDOW.sill + WINDOW.height / 2 - 0.25, ROOM.minZ - 0.55],
    [1, 1, 1], 0, 0, 0
  );

  const palettes = {
    DAY: {
      top: '#4b86c8',
      mid: '#a9cbe8',
      horizon: '#e7eff4',
      sun: null,
      cloud: 'rgba(255,255,255,0.85)',
      far: '#8fa8b8',
      near: '#5d7a63',
      windowLights: 0,
      stars: 0,
    },
    SUNSET: {
      top: '#2b3760',
      mid: '#d1663c',
      horizon: '#ffcf94',
      sun: { x: 0.62, y: 0.62, r: 26, colour: 'rgba(255,222,170,0.95)' },
      cloud: 'rgba(255,186,140,0.55)',
      far: '#3d3a52',
      near: '#2a2b33',
      windowLights: 0.5,
      stars: 0.15,
    },
    NIGHT: {
      top: '#05070f',
      mid: '#0d1428',
      horizon: '#1c2740',
      sun: { x: 0.28, y: 0.26, r: 14, colour: 'rgba(226,236,255,0.9)' },
      cloud: 'rgba(40,52,80,0.5)',
      far: '#0a0e1a',
      near: '#070910',
      windowLights: 1,
      stars: 1,
    },
  };

  function draw(tod = 'DAY') {
    const p = palettes[tod] || palettes.DAY;
    const w = canvas.width, h = canvas.height;
    const horizon = h * 0.68;

    const gradient = ctx.createLinearGradient(0, 0, 0, horizon);
    gradient.addColorStop(0, p.top);
    gradient.addColorStop(0.62, p.mid);
    gradient.addColorStop(1, p.horizon);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, horizon);

    // Stars.
    if (p.stars > 0) {
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let i = 0; i < 160 * p.stars; i++) {
        const x = rnd() * w;
        const y = rnd() * horizon * 0.85;
        const a = 0.25 + rnd() * 0.75;
        ctx.fillStyle = `rgba(220,232,255,${a})`;
        ctx.fillRect(x, y, rnd() > 0.9 ? 2 : 1, rnd() > 0.9 ? 2 : 1);
      }
    }

    // Sun / moon.
    if (p.sun) {
      const sx = p.sun.x * w, sy = p.sun.y * horizon;
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, p.sun.r * 5);
      glow.addColorStop(0, p.sun.colour);
      glow.addColorStop(0.25, p.sun.colour.replace(/[\d.]+\)$/, '0.35)'));
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, p.sun.r * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.sun.colour;
      ctx.beginPath();
      ctx.arc(sx, sy, p.sun.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Clouds.
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < 7; i++) {
      const cx = ((i * 97) % w) + 30;
      const cy = horizon * (0.16 + ((i * 37) % 40) / 100);
      const rw = 46 + ((i * 53) % 70);
      const rh = 12 + ((i * 17) % 12);
      ctx.fillStyle = p.cloud;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + rw * 0.45, cy + 4, rw * 0.6, rh * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Distant skyline.
    ctx.fillStyle = p.far;
    let x = -20;
    let step = 0;
    while (x < w + 20) {
      const bw = 26 + ((step * 47) % 54);
      const bh = 26 + ((step * 83) % 90);
      ctx.fillRect(x, horizon - bh, bw, bh);
      if (p.windowLights > 0) {
        for (let wy = horizon - bh + 8; wy < horizon - 8; wy += 12) {
          for (let wx = x + 5; wx < x + bw - 6; wx += 10) {
            if (((wx * 7 + wy * 13 + step * 29) % 11) < 4 * p.windowLights) {
              ctx.fillStyle = 'rgba(255,206,138,0.75)';
              ctx.fillRect(wx, wy, 4, 5);
              ctx.fillStyle = p.far;
            }
          }
        }
      }
      x += bw + 6;
      step++;
    }

    // Ground / tree line.
    ctx.fillStyle = p.near;
    ctx.fillRect(0, horizon, w, h - horizon);
    ctx.beginPath();
    for (let i = 0; i <= 26; i++) {
      const tx = (i / 26) * w;
      const ty = horizon - 8 - Math.abs(Math.sin(i * 1.7)) * 26 - (i % 3) * 5;
      if (i === 0) ctx.moveTo(tx, horizon);
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx + w / 52, horizon);
    }
    ctx.closePath();
    ctx.fill();

    renderer.updateTexture(texture, canvas);
  }

  draw('DAY');

  return {
    item,
    material,
    set(tod) { draw(tod); },
    setIntensity(value) { material.emissiveStrength = value; },
  };
}
