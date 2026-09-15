/**
 * Task props: the physical objects the companion uses while it works, each with
 * visible feedback (digits appearing, lines being written, a drawer sliding,
 * pins landing, a book being carried). Built once; driven by the task director.
 */

import {
  planeGeometry, quadGeometry, roundedBoxGeometry, sphereGeometry,
} from '../core/geometry.js';
import { makeCanvas } from '../core/textures.js';
import { makeRandom, m4trs } from '../core/math.js';
import { DESK, ROOM } from './layout.js';

const T = (x, y, z, yaw = 0, pitch = 0, roll = 0) =>
  m4trs(new Float32Array(16), [x, y, z], [1, 1, 1], yaw, pitch, roll);

/* Tiny canvas that shows a running calculation. */
function createCalcTexture(w = 96, h = 48) {
  const canvas = makeCanvas(w, h);
  return {
    canvas,
    draw(value) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0c1410';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#9fe8b0';
      ctx.font = '16px monospace';
      ctx.fillText(String(value), 8, h - 12);
      return canvas;
    },
  };
}

/* Tiny canvas that fills with handwritten lines as the companion writes. */
function createPageTexture(w = 128, h = 160) {
  const canvas = makeCanvas(w, h);
  return {
    canvas,
    draw(progress) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#efe9dc';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(120,110,90,0.35)';
      ctx.lineWidth = 1;
      for (let y = 18; y < h - 8; y += 14) {
        ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(w - 8, y); ctx.stroke();
      }
      const lines = Math.floor(progress * 9);
      ctx.strokeStyle = '#3a4a8c';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < lines; i++) {
        const y = 16 + i * 14;
        ctx.beginPath(); ctx.moveTo(10, y);
        ctx.lineTo(10 + (w - 26) * (0.6 + ((i * 37) % 40) / 100), y);
        ctx.stroke();
      }
      return canvas;
    },
  };
}

export function buildProps(builder, M, renderer) {
  const refs = {};
  const cx = DESK.centerX, dh = DESK.height, cz = DESK.centerZ;

  /* ------------------------------------------------------- calculator ---- */
  builder.add(roundedBoxGeometry(0.1, 0.02, 0.13, 0.006, 2), T(cx + 0.26, dh + 0.01, cz + 0.34), M.plastic, { tag: 'calcBody' });
  const keys = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    keys.push(roundedBoxGeometry(0.02, 0.008, 0.02, 0.003, 1));
  }
  refs.calcScreen = builder.addDynamic(planeGeometry(0.07, 0.03), { ...M.screenOff, maps: {} }, { tag: 'calcScreen', castShadow: false });
  refs.calcScreen.model = T(cx + 0.26, dh + 0.021, cz + 0.30);
  refs.calc = createCalcTexture();
  refs.calcTexture = renderer.createTexture(refs.calc.canvas, { clamp: true, mips: false, minFilter: renderer.gl.LINEAR });
  refs.calcScreen.material.maps = { albedo: refs.calcTexture };
  refs.calcScreen.material.emissive = [0.6, 1.0, 0.7];
  refs.calcScreen.material.emissiveStrength = 0;
  refs.calcPos = [cx + 0.26, dh + 0.02, cz + 0.34];

  /* ---------------------------------------------------- notebook page ---- */
  refs.page = createPageTexture();
  refs.pageTexture = renderer.createTexture(refs.page.canvas, { clamp: true, mips: false, minFilter: renderer.gl.LINEAR });
  refs.pageItem = builder.addDynamic(planeGeometry(0.16, 0.2), { ...M.screenOff, maps: {} }, { tag: 'notebookPage', castShadow: false });
  refs.pageItem.model = T(cx + 0.1, dh + 0.016, cz + 0.62);
  refs.pageItem.material.maps = { albedo: refs.pageTexture };
  refs.pageItem.material.emissive = [1, 1, 1];
  refs.pageItem.material.emissiveStrength = 0.12;
  refs.pagePos = [cx + 0.1, dh + 0.02, cz + 0.62];

  /* ---------------------------------------------------- filing cabinet --- */
  const fx = ROOM.minX + 0.28, fz = 0.62;
  builder.add(roundedBoxGeometry(0.42, 0.72, 0.5, 0.012, 3), T(fx - 0.05, 0.36, fz), M.metalBrushed, { tag: 'cabinet' });
  refs.drawer = builder.addDynamic(roundedBoxGeometry(0.05, 0.26, 0.44, 0.01, 2), { ...M.metalBlack }, { tag: 'cabinetDrawer' });
  refs.drawer.model = T(fx + 0.16, 0.5, fz);
  refs.drawerClosedX = fx + 0.16;
  refs.cabinetPos = [fx + 0.2, 0.5, fz];

  /* ----------------------------------------------------------- pin board -- */
  const bx = 0.6, by = 1.5, bz = ROOM.maxZ - 0.03;
  builder.add(roundedBoxGeometry(0.96, 0.66, 0.03, 0.008, 2), T(bx, by, bz + 0.012), M.walnut, { tag: 'boardFrame', castShadow: false });
  builder.add(quadGeometry(0.9, 0.6), T(bx, by, bz, Math.PI), M.cork, { tag: 'board', castShadow: false });
  refs.pins = [];
  const random = makeRandom(12);
  for (let i = 0; i < 5; i++) {
    const pin = builder.addDynamic(sphereGeometry(0.016, 10, 8), { ...M.jarBerry }, { tag: 'pin', castShadow: false });
    pin.model = T(bx - 0.34 + random() * 0.68, by - 0.2 + random() * 0.4, bz - 0.02);
    pin.visible = false;
    refs.pins.push(pin);
  }
  refs.boardPos = [bx, by, bz - 0.2];

  /* ----------------------------------------------------------- held book -- */
  refs.book = builder.addDynamic(roundedBoxGeometry(0.17, 0.02, 0.23, 0.006, 2), { ...M.bookA }, { tag: 'heldBook', castShadow: false });
  refs.book.visible = false;

  return refs;
}
