/**
 * Everything that lives in the room: desk, bed, sofa, plants, props.
 * Built once at start-up and merged into a handful of draw calls.
 */

import {
  boxGeometry, cylinderGeometry, latheGeometry, leafGeometry, mergeMeshes,
  planeGeometry, quadGeometry, roundedBoxGeometry, sphereGeometry, transformMesh,
} from '../core/geometry.js';
import { m4identity, m4trs, makeRandom } from '../core/math.js';
import { BED, DESK, RUG, ROOM, SOFA, TABLE } from './layout.js';

const T = (x, y, z, yaw = 0, pitch = 0, roll = 0, sx = 1, sy = 1, sz = 1) =>
  m4trs(new Float32Array(16), [x, y, z], [sx, sy, sz], yaw, pitch, roll);

const I = () => m4identity(new Float32Array(16));

export function buildFurniture(builder, M) {
  const refs = {};
  buildDesk(builder, M, refs);
  buildChair(builder, M);
  buildBed(builder, M, refs);
  buildNightstand(builder, M, refs);
  buildSofa(builder, M);
  buildCoffeeTable(builder, M);
  buildRug(builder, M);
  buildShelving(builder, M);
  buildFloorLamp(builder, M, refs);
  buildBigPlant(builder, M);
  buildContactShadows(builder, M);
  return refs;
}

/* ------------------------------------------------------------------ desk -- */

function buildDesk(builder, M, refs) {
  const { centerX: cx, centerZ: cz, width, depth, height, thickness } = DESK;
  const topY = height - thickness / 2;

  // Top.
  builder.add(boxGeometry(depth, thickness, width), T(cx, topY, cz), M.walnut, { tag: 'deskTop' });

  // Two rectangular steel frames.
  const frameParts = [];
  for (const sign of [-1, 1]) {
    const z = cz + sign * (width / 2 - 0.09);
    frameParts.push(transformMesh(boxGeometry(0.04, height - thickness, 0.04), T(cx - depth / 2 + 0.08, (height - thickness) / 2, z)));
    frameParts.push(transformMesh(boxGeometry(0.04, height - thickness, 0.04), T(cx + depth / 2 - 0.08, (height - thickness) / 2, z)));
    frameParts.push(transformMesh(boxGeometry(depth - 0.16, 0.04, 0.04), T(cx, 0.08, z)));
    frameParts.push(transformMesh(boxGeometry(0.04, 0.04, width - 0.36), T(cx - depth / 2 + 0.08, height - thickness - 0.06, cz)));
  }
  frameParts.push(transformMesh(boxGeometry(0.04, 0.04, width - 0.36), T(cx + depth / 2 - 0.08, height - thickness - 0.06, cz)));
  builder.add(mergeMeshes(frameParts), I(), M.metalBlack, { tag: 'deskFrame' });

  // Cable tray.
  builder.add(roundedBoxGeometry(0.14, 0.07, 0.7, 0.02, 3), T(cx - 0.16, height - 0.13, cz + 0.1), M.plastic, { tag: 'cableTray', castShadow: false });

  /* ------------------------------------------------------------- monitor */
  const mx = cx - depth / 2 + 0.2;
  const monitorParts = [
    transformMesh(roundedBoxGeometry(0.06, 0.014, 0.24, 0.006, 3), T(mx, height + 0.007, cz)),
    transformMesh(boxGeometry(0.05, 0.3, 0.05), T(mx + 0.01, height + 0.16, cz)),
  ];
  builder.add(mergeMeshes(monitorParts), I(), M.metalBrushed, { tag: 'monitorStand' });

  const panelY = height + 0.34;
  builder.add(
    roundedBoxGeometry(0.05, 0.37, 0.64, 0.012, 3),
    T(mx + 0.02, panelY, cz, 0, 0, 0),
    M.plastic,
    { tag: 'monitorBody' }
  );

  refs.screen = builder.addDynamic(
    quadGeometry(0.6, 0.335),
    { ...M.screenOff, maps: {} },
    { tag: 'monitorScreen', castShadow: false }
  );
  refs.screen.model = T(mx + 0.047, panelY - 0.1675, cz, Math.PI / 2);
  refs.screenPosition = [mx + 0.1, panelY, cz];

  /* ------------------------------------------------- keyboard, mouse, cup */
  builder.add(roundedBoxGeometry(0.14, 0.022, 0.44, 0.008, 3), T(cx + 0.14, height + 0.011, cz - 0.02), M.plastic, { tag: 'keyboard' });
  builder.add(roundedBoxGeometry(0.062, 0.026, 0.105, 0.024, 4), T(cx + 0.16, height + 0.013, cz + 0.34), M.plastic, { tag: 'mouse' });
  builder.add(
    latheGeometry([[0, 0], [0.037, 0], [0.038, 0.004], [0.036, 0.09], [0.04, 0.098], [0.033, 0.096], [0.031, 0.006], [0, 0.006]], 18),
    T(cx + 0.2, height, cz - 0.52),
    M.ceramic,
    { tag: 'mug' }
  );
  builder.add(
    cylinderGeometry(0.008, 0.008, 0.05, 8),
    T(cx + 0.21, height + 0.11, cz - 0.52, 0, 0, 0.25),
    M.bookA,
    { tag: 'stirrer', castShadow: false }
  );

  // Notebook + pen.
  builder.add(roundedBoxGeometry(0.19, 0.014, 0.26, 0.004, 3), T(cx + 0.1, height + 0.007, cz + 0.62, 0, 0.22, 0), M.bookD, { tag: 'notebook' });

  /* ------------------------------------------------------------ desk lamp */
  const lx = cx - depth / 2 + 0.16;
  const lz = cz + width / 2 - 0.2;
  const lampParts = [
    transformMesh(cylinderGeometry(0.075, 0.085, 0.018, 20), T(lx, height + 0.009, lz)),
    transformMesh(cylinderGeometry(0.012, 0.012, 0.34, 10), T(lx, height + 0.18, lz, 0, 0, 0.22)),
    transformMesh(cylinderGeometry(0.012, 0.012, 0.3, 10), T(lx + 0.16, height + 0.4, lz, 0, 0, -0.95)),
  ];
  builder.add(mergeMeshes(lampParts), I(), M.metalBlack, { tag: 'deskLampArm' });

  refs.deskLampShade = builder.addDynamic(
    latheGeometry([[0, 0.075], [0.055, 0.06], [0.075, 0], [0.068, -0.004], [0.05, 0.055], [0, 0.068]], 20),
    { ...M.lampShade },
    { tag: 'deskLampShade', castShadow: false }
  );
  refs.deskLampShade.model = T(lx + 0.29, height + 0.33, lz, 0, 0, -0.5);
  refs.deskLampPosition = [lx + 0.3, height + 0.3, lz];

  /* --------------------------------------------------------- desk plantlet */
  const potProfile = [[0, 0], [0.052, 0], [0.048, 0.005], [0.062, 0.085], [0.066, 0.09], [0.058, 0.088], [0.044, 0.006], [0, 0.006]];
  builder.add(latheGeometry(potProfile, 18), T(cx - 0.06, height, cz + width / 2 - 0.62), M.terracotta, { tag: 'deskPot' });
  const leaves = [];
  const random = makeRandom(17);
  for (let i = 0; i < 9; i++) {
    const yaw = random() * Math.PI * 2;
    const tilt = 0.5 + random() * 0.7;
    const len = 0.075 + random() * 0.05;
    leaves.push(transformMesh(
      leafGeometry(len, 0.05, 0.5, 5, 4),
      T(cx - 0.06, height + 0.085, cz + width / 2 - 0.62, yaw, tilt, 0, 1, 1, 1)
    ));
  }
  builder.add(mergeMeshes(leaves), I(), M.leaf, { tag: 'deskPlant', castShadow: false });
}

/* ----------------------------------------------------------------- chair -- */

function buildChair(builder, M) {
  const x = DESK.centerX + 0.72;
  const z = DESK.centerZ + 0.08;
  const yaw = -Math.PI / 2 + 0.34;
  const parts = [];

  // Five star base.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(transformMesh(
      boxGeometry(0.05, 0.03, 0.26),
      T(Math.sin(a) * 0.13, 0.045, Math.cos(a) * 0.13, a)
    ));
    parts.push(transformMesh(
      sphereGeometry(0.026, 10, 8),
      T(Math.sin(a) * 0.25, 0.026, Math.cos(a) * 0.25)
    ));
  }
  parts.push(transformMesh(cylinderGeometry(0.032, 0.042, 0.34, 14), T(0, 0.22, 0)));
  builder.add(mergeMeshes(parts.map((m) => transformMesh(m, T(x, 0, z, yaw)))), I(), M.metalBlack, { tag: 'chairBase' });

  const soft = [];
  soft.push(transformMesh(roundedBoxGeometry(0.46, 0.08, 0.46, 0.035, 4), T(0, 0.43, 0)));
  soft.push(transformMesh(roundedBoxGeometry(0.1, 0.52, 0.44, 0.05, 4), T(-0.2, 0.72, 0, 0, 0, 0.14)));
  builder.add(mergeMeshes(soft.map((m) => transformMesh(m, T(x, 0, z, yaw)))), I(), M.chairSeat, { tag: 'chairSeat' });

  const arms = [];
  for (const s of [-1, 1]) {
    arms.push(transformMesh(roundedBoxGeometry(0.05, 0.035, 0.26, 0.014, 3), T(0.02, 0.63, s * 0.24)));
    arms.push(transformMesh(boxGeometry(0.035, 0.18, 0.035), T(0.02, 0.54, s * 0.24)));
  }
  builder.add(mergeMeshes(arms.map((m) => transformMesh(m, T(x, 0, z, yaw)))), I(), M.plastic, { tag: 'chairArms' });
}

/* ------------------------------------------------------------------- bed -- */

function buildBed(builder, M, refs) {
  const { centerX: cx, centerZ: cz, length, width, headX, pillowX, mattressTop } = BED;

  // Frame + legs.
  const frameParts = [transformMesh(roundedBoxGeometry(length - 0.04, 0.2, width, 0.02, 3), T(cx, 0.14, cz))];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      frameParts.push(transformMesh(
        cylinderGeometry(0.026, 0.022, 0.1, 10),
        T(cx + sx * (length / 2 - 0.14), 0.05, cz + sz * (width / 2 - 0.12))
      ));
    }
  }
  builder.add(mergeMeshes(frameParts), I(), M.walnut, { tag: 'bedFrame' });

  // Headboard.
  builder.add(
    roundedBoxGeometry(0.09, 1.0, width + 0.04, 0.035, 4),
    T(headX - 0.045, 0.62, cz),
    M.walnut,
    { tag: 'headboard' }
  );

  // Mattress.
  builder.add(
    roundedBoxGeometry(length - 0.14, 0.24, width - 0.06, 0.075, 6),
    T(cx - 0.02, 0.36, cz),
    M.pillow,
    { tag: 'mattress' }
  );

  // Duvet, slightly larger than the mattress so it drapes.
  builder.add(
    roundedBoxGeometry(length * 0.72, 0.14, width + 0.05, 0.065, 6),
    T(cx - length * 0.13, mattressTop + 0.05, cz),
    M.duvet,
    { tag: 'duvet' }
  );

  // Folded blanket at the foot.
  builder.add(
    roundedBoxGeometry(0.46, 0.06, width + 0.1, 0.03, 5),
    T(cx - length * 0.42, mattressTop + 0.11, cz),
    M.blanket,
    { tag: 'blanket' }
  );

  // Pillows.
  for (const s of [-1, 1]) {
    builder.add(
      roundedBoxGeometry(0.36, 0.135, 0.6, 0.062, 6),
      T(pillowX, mattressTop + 0.075, cz + s * 0.34, 0, 0, 0.12),
      M.pillow,
      { tag: 'pillow' }
    );
  }

  refs.pillowTop = [pillowX, mattressTop + 0.14, cz];
}

/* ----------------------------------------------------------- nightstand -- */

function buildNightstand(builder, M, refs) {
  const x = BED.headX - 0.3;
  const z = BED.centerZ - BED.width / 2 - 0.36;

  const body = [];
  body.push(transformMesh(roundedBoxGeometry(0.44, 0.42, 0.4, 0.014, 3), T(0, 0.3, 0)));
  body.push(transformMesh(boxGeometry(0.4, 0.008, 0.36), T(0, 0.512, 0)));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      body.push(transformMesh(cylinderGeometry(0.016, 0.012, 0.1, 8), T(sx * 0.17, 0.05, sz * 0.15)));
    }
  }
  builder.add(mergeMeshes(body.map((m) => transformMesh(m, T(x, 0, z)))), I(), M.walnut, { tag: 'nightstand' });
  builder.add(roundedBoxGeometry(0.3, 0.008, 0.02, 0.003, 2), T(x, 0.34, z - 0.2), M.brass, { tag: 'drawerPull', castShadow: false });

  // Lamp.
  builder.add(latheGeometry([[0, 0], [0.075, 0], [0.07, 0.012], [0.03, 0.05], [0.024, 0.24], [0.03, 0.26], [0.036, 0.27]], 20),
    T(x, 0.52, z), M.ceramic, { tag: 'lampBase' });

  refs.nightLampShade = builder.addDynamic(
    latheGeometry([[0, 0.13], [0.1, 0.1], [0.135, 0], [0.126, -0.004], [0.094, 0.094], [0, 0.122]], 22),
    { ...M.lampShade },
    { tag: 'nightLampShade', castShadow: false }
  );
  refs.nightLampShade.model = T(x, 0.79, z);
  refs.nightLampPosition = [x, 0.84, z];

  // A small stack of books.
  builder.add(roundedBoxGeometry(0.2, 0.032, 0.15, 0.004, 2), T(x + 0.02, 0.532, z + 0.1, 0, 0.3, 0), M.bookB, { tag: 'bedBook' });
}

/* ----------------------------------------------------------------- sofa -- */

function buildSofa(builder, M) {
  const { centerX: cx, centerZ: cz, width, depth } = SOFA;

  const frame = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      frame.push(transformMesh(cylinderGeometry(0.026, 0.02, 0.14, 10), T(sx * (width / 2 - 0.14), 0.07, sz * (depth / 2 - 0.12))));
    }
  }
  builder.add(mergeMeshes(frame.map((m) => transformMesh(m, T(cx, 0, cz)))), I(), M.walnut, { tag: 'sofaLegs' });

  const soft = [];
  soft.push(transformMesh(roundedBoxGeometry(width, 0.26, depth, 0.05, 5), T(0, 0.27, 0)));
  soft.push(transformMesh(roundedBoxGeometry(width - 0.04, 0.56, 0.2, 0.07, 5), T(0, 0.62, depth / 2 - 0.1)));
  for (const s of [-1, 1]) {
    soft.push(transformMesh(roundedBoxGeometry(0.22, 0.36, depth, 0.07, 5), T(s * (width / 2 - 0.11), 0.52, 0)));
  }
  builder.add(mergeMeshes(soft.map((m) => transformMesh(m, T(cx, 0, cz)))), I(), M.sofa, { tag: 'sofaBody' });

  const cushions = [];
  for (let i = -1; i <= 1; i++) {
    cushions.push(transformMesh(roundedBoxGeometry(0.6, 0.15, 0.66, 0.06, 5), T(i * 0.62, 0.46, -0.06)));
    cushions.push(transformMesh(roundedBoxGeometry(0.58, 0.4, 0.14, 0.06, 5), T(i * 0.62, 0.72, depth / 2 - 0.2, -0.12)));
  }
  builder.add(mergeMeshes(cushions.map((m) => transformMesh(m, T(cx, 0, cz)))), I(), M.sofa, { tag: 'sofaCushions' });

  // Throw pillows.
  builder.add(roundedBoxGeometry(0.36, 0.36, 0.11, 0.05, 5), T(cx - 0.72, 0.66, cz + 0.16, 0.2, 0.1, 0.25), M.cushion, { tag: 'throwPillow' });
  builder.add(roundedBoxGeometry(0.32, 0.32, 0.1, 0.05, 5), T(cx + 0.76, 0.63, cz + 0.18, -0.16, -0.14, -0.2), M.cushionAlt, { tag: 'throwPillow2' });

  // Folded throw over the arm.
  builder.add(roundedBoxGeometry(0.5, 0.035, 0.42, 0.016, 4), T(cx - width / 2 + 0.16, 0.72, cz - 0.12, 0, 0, 0.06), M.blanket, { tag: 'throw' });
}

/* --------------------------------------------------------- coffee table -- */

function buildCoffeeTable(builder, M) {
  const { centerX: cx, centerZ: cz, width, depth, height } = TABLE;
  builder.add(roundedBoxGeometry(width, 0.04, depth, 0.016, 4), T(cx, height, cz), M.walnut, { tag: 'tableTop' });
  builder.add(roundedBoxGeometry(width - 0.2, 0.02, depth - 0.16, 0.008, 3), T(cx, 0.16, cz), M.walnut, { tag: 'tableShelf' });

  const legs = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      legs.push(transformMesh(cylinderGeometry(0.02, 0.016, height, 10), T(sx * (width / 2 - 0.08), height / 2, sz * (depth / 2 - 0.07))));
    }
  }
  builder.add(mergeMeshes(legs.map((m) => transformMesh(m, T(cx, 0, cz)))), I(), M.metalBlack, { tag: 'tableLegs' });

  // Bowl, books, candle.
  builder.add(latheGeometry([[0, 0.055], [0.05, 0.05], [0.11, 0.02], [0.125, 0], [0.115, 0.004], [0.098, 0.02], [0.045, 0.045], [0, 0.048]], 22),
    T(cx + 0.24, height + 0.02, cz + 0.02), M.ceramic, { tag: 'bowl' });
  builder.add(roundedBoxGeometry(0.24, 0.03, 0.18, 0.004, 2), T(cx - 0.24, height + 0.035, cz - 0.04, 0, 0.18, 0), M.bookC, { tag: 'tableBook1' });
  builder.add(roundedBoxGeometry(0.22, 0.026, 0.16, 0.004, 2), T(cx - 0.23, height + 0.063, cz - 0.03, 0, -0.1, 0), M.bookA, { tag: 'tableBook2' });
  builder.add(cylinderGeometry(0.036, 0.036, 0.1, 16), T(cx - 0.02, height + 0.07, cz + 0.14), M.ceramic, { tag: 'candle' });
}

/* ------------------------------------------------------------------ rug --- */

function buildRug(builder, M) {
  builder.add(
    roundedBoxGeometry(RUG.width, 0.016, RUG.depth, 0.008, 3),
    T(RUG.centerX, 0.008, RUG.centerZ),
    M.rug,
    { tag: 'rug', castShadow: false }
  );
}

/* ------------------------------------------------------------- shelving --- */

function buildShelving(builder, M) {
  const x = ROOM.minX + 0.13;
  const z0 = -1.42, z1 = 0.14;
  const length = z1 - z0;
  const cz = (z0 + z1) / 2;

  for (const y of [1.52, 1.94]) {
    builder.add(roundedBoxGeometry(0.24, 0.032, length, 0.006, 3), T(x, y, cz), M.walnut, { tag: 'shelf' });
    const brackets = [];
    for (const s of [-1, 1]) {
      brackets.push(transformMesh(boxGeometry(0.2, 0.018, 0.018), T(x, y - 0.03, cz + s * (length / 2 - 0.16))));
      brackets.push(transformMesh(boxGeometry(0.018, 0.12, 0.018), T(x - 0.08, y - 0.08, cz + s * (length / 2 - 0.16))));
    }
    builder.add(mergeMeshes(brackets), I(), M.metalBlack, { tag: 'shelfBrackets', castShadow: false });
  }

  // Books on the lower shelf, a small object on the upper one.
  const random = makeRandom(88);
  const bookMats = [M.bookA, M.bookB, M.bookC, M.bookD];
  let z = z0 + 0.12;
  const books = [];
  while (z < z0 + length * 0.62) {
    const w = 0.028 + random() * 0.03;
    const h = 0.17 + random() * 0.07;
    const lean = random() > 0.88 ? 0.16 : 0;
    books.push({
      mesh: roundedBoxGeometry(0.15, h, w, 0.004, 2),
      matrix: T(x, 1.536 + h / 2, z, 0, 0, lean),
      material: bookMats[Math.floor(random() * bookMats.length)],
    });
    z += w + 0.006;
  }
  for (const book of books) {
    builder.add(book.mesh, book.matrix, book.material, { tag: 'shelfBook' });
  }

  // Horizontal stack.
  builder.add(roundedBoxGeometry(0.17, 0.028, 0.22, 0.004, 2), T(x, 1.55, z1 - 0.34, 0, 0.1, 0), M.bookD, { tag: 'shelfStack1' });
  builder.add(roundedBoxGeometry(0.16, 0.024, 0.2, 0.004, 2), T(x, 1.576, z1 - 0.33, 0, -0.06, 0), M.bookB, { tag: 'shelfStack2' });

  // Upper shelf decor: a small vase and a framed photo.
  builder.add(latheGeometry([[0, 0], [0.04, 0], [0.055, 0.03], [0.045, 0.12], [0.032, 0.16], [0.036, 0.17], [0.03, 0.166], [0.04, 0.12], [0.05, 0.03], [0, 0.004]], 20),
    T(x + 0.01, 1.956, z0 + 0.3), M.terracotta, { tag: 'vase' });
  builder.add(roundedBoxGeometry(0.02, 0.16, 0.12, 0.004, 2), T(x + 0.06, 2.036, z0 + 0.62, 0, 0.2, 0), M.metalBlack, { tag: 'photoFrame' });
  builder.add(roundedBoxGeometry(0.06, 0.09, 0.06, 0.008, 3), T(x, 2.0, z1 - 0.3), M.ceramic, { tag: 'shelfObject' });
}

/* ------------------------------------------------------------ floor lamp -- */

function buildFloorLamp(builder, M, refs) {
  const x = -2.16, z = 1.42;
  const parts = [
    transformMesh(cylinderGeometry(0.14, 0.15, 0.022, 22), T(x, 0.011, z)),
    transformMesh(cylinderGeometry(0.016, 0.016, 1.42, 12), T(x, 0.72, z)),
  ];
  builder.add(mergeMeshes(parts), I(), M.brass, { tag: 'floorLampStem' });

  refs.floorLampShade = builder.addDynamic(
    latheGeometry([[0, 0.26], [0.17, 0.22], [0.21, 0], [0.2, -0.004], [0.163, 0.214], [0, 0.252]], 26),
    { ...M.lampShade },
    { tag: 'floorLampShade', castShadow: false }
  );
  refs.floorLampShade.model = T(x, 1.44, z);
  refs.floorLampPosition = [x, 1.5, z];
}

/* ------------------------------------------------------------- big plant -- */

function buildBigPlant(builder, M) {
  const x = 2.12, z = -1.5;
  const potProfile = [
    [0, 0], [0.15, 0], [0.16, 0.01], [0.21, 0.34], [0.225, 0.38], [0.215, 0.385],
    [0.2, 0.345], [0.15, 0.012], [0, 0.012],
  ];
  builder.add(latheGeometry(potProfile, 26), T(x, 0, z), M.terracotta, { tag: 'plantPot' });
  builder.add(cylinderGeometry(0.195, 0.195, 0.02, 22), T(x, 0.36, z), M.soil, { tag: 'plantSoil', castShadow: false });

  const random = makeRandom(4711);
  const stems = [];
  const leaves = [];
  const leafCount = 11;
  for (let i = 0; i < leafCount; i++) {
    const yaw = (i / leafCount) * Math.PI * 2 + random() * 0.4;
    const tilt = 0.35 + random() * 0.75;
    const stemLen = 0.34 + random() * 0.34;
    const leafLen = 0.2 + random() * 0.13;
    const stemTop = [
      Math.sin(yaw) * Math.sin(tilt) * stemLen,
      0.37 + Math.cos(tilt) * stemLen,
      Math.cos(yaw) * Math.sin(tilt) * stemLen,
    ];
    stems.push(transformMesh(
      cylinderGeometry(0.007, 0.011, stemLen, 6),
      T(x + stemTop[0] / 2, 0.37 + stemTop[1] / 2 - 0.01, z + stemTop[2] / 2, yaw, tilt, 0)
    ));
    leaves.push(transformMesh(
      leafGeometry(leafLen, leafLen * 0.72, 0.42 + random() * 0.3, 7, 5),
      T(x + stemTop[0], 0.37 + stemTop[1], z + stemTop[2], yaw + Math.PI, tilt * 0.72, 0)
    ));
  }
  builder.add(mergeMeshes(stems), I(), M.leafDeep, { tag: 'plantStems', castShadow: false });
  builder.add(mergeMeshes(leaves), I(), M.leaf, { tag: 'plantLeaves' });
}

/* ------------------------------------------------------ contact shadows -- */

function buildContactShadows(builder, M) {
  const blobs = [
    { x: BED.centerX, z: BED.centerZ, w: BED.length + 0.5, d: BED.width + 0.5, a: 0.5 },
    { x: SOFA.centerX, z: SOFA.centerZ, w: SOFA.width + 0.4, d: SOFA.depth + 0.4, a: 0.5 },
    { x: DESK.centerX, z: DESK.centerZ, w: DESK.depth + 0.5, d: DESK.width + 0.4, a: 0.42 },
    { x: TABLE.centerX, z: TABLE.centerZ, w: TABLE.width + 0.4, d: TABLE.depth + 0.4, a: 0.36 },
    { x: DESK.centerX + 0.72, z: DESK.centerZ + 0.08, w: 0.8, d: 0.8, a: 0.4 },
    { x: 2.12, z: -1.5, w: 0.8, d: 0.8, a: 0.44 },
    { x: -2.16, z: 1.42, w: 0.62, d: 0.62, a: 0.34 },
  ];
  for (const blob of blobs) {
    const material = { ...M.contactShadow, color: [0, 0, 0, blob.a] };
    const item = builder.addDynamic(planeGeometry(blob.w, blob.d), material, {
      tag: 'contactShadow', castShadow: false, receiveShadow: false, sortKey: -1,
    });
    item.model = T(blob.x, 0.014, blob.z);
  }
}
