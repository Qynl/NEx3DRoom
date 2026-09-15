/**
 * The room shell: floor, walls, ceiling, the window with its curtains, doors,
 * skirting, wall art and the ceiling light.
 *
 * Walls are single sided and face inwards, so pulling the camera back gives a
 * natural "cutaway" view of the room instead of a wall in your face.
 */

import {
  boxGeometry, curtainGeometry, cylinderGeometry, latheGeometry,
  mergeMeshes, planeGeometry, quadGeometry, roundedBoxGeometry,
  sphereGeometry, transformMesh,
} from '../core/geometry.js';
import { m4identity, m4trs } from '../core/math.js';
import { ROOM, WINDOW } from './layout.js';

const T = (x, y, z, yaw = 0, pitch = 0, roll = 0, sx = 1, sy = 1, sz = 1) =>
  m4trs(new Float32Array(16), [x, y, z], [sx, sy, sz], yaw, pitch, roll);

/** Wall made of four quads around a rectangular opening. */
function wallWithOpening(width, height, opening) {
  const hw = width / 2;
  const parts = [];
  if (opening.y0 > 0) parts.push(quadGeometry(width, opening.y0));
  if (opening.y1 < height) {
    parts.push(transformMesh(quadGeometry(width, height - opening.y1), T(0, opening.y1, 0)));
  }
  const leftW = opening.x0 + hw;
  if (leftW > 0.001) {
    parts.push(transformMesh(
      quadGeometry(leftW, opening.y1 - opening.y0),
      T(-hw + leftW / 2, opening.y0, 0)
    ));
  }
  const rightW = hw - opening.x1;
  if (rightW > 0.001) {
    parts.push(transformMesh(
      quadGeometry(rightW, opening.y1 - opening.y0),
      T(hw - rightW / 2, opening.y0, 0)
    ));
  }
  return mergeMeshes(parts);
}

export function buildShell(builder, M) {
  const { width, depth, height, minX, maxX, minZ, maxZ } = ROOM;

  /* ------------------------------------------------------------- surfaces */
  builder.add(planeGeometry(width, depth, 1, 1), m4identity(new Float32Array(16)), M.floor, {
    tag: 'floor', receiveShadow: true, castShadow: false,
  });

  builder.add(
    planeGeometry(width, depth, 1, 1),
    T(0, height, 0, 0, Math.PI, 0),
    M.ceiling,
    { tag: 'ceiling', castShadow: false }
  );

  // Back wall holds the window.
  const opening = {
    x0: WINDOW.left,
    x1: WINDOW.right,
    y0: WINDOW.sill,
    y1: WINDOW.top,
  };
  builder.add(wallWithOpening(width, height, opening), T(0, 0, minZ), M.wall, {
    tag: 'wallBack', castShadow: false,
  });

  // Left wall holds the door.
  builder.add(
    wallWithOpening(depth, height, { x0: 0.72, x1: 1.68, y0: 0, y1: 2.08 }),
    T(minX, 0, 0, Math.PI / 2),
    M.wall,
    { tag: 'wallLeft', castShadow: false }
  );

  // Right wall is the accent wall behind the bed.
  builder.add(quadGeometry(depth, height), T(maxX, 0, 0, -Math.PI / 2), M.accentWall, {
    tag: 'wallRight', castShadow: false,
  });

  // Front wall behind the sofa.
  builder.add(quadGeometry(width, height), T(0, 0, maxZ, Math.PI), M.wall, {
    tag: 'wallFront', castShadow: false,
  });

  /* ------------------------------------------------------------ skirting */
  const skirt = 0.09;
  const skirtGeo = boxGeometry(1, skirt, 0.022);
  const skirts = [
    transformMesh(boxGeometry(width, skirt, 0.022), T(0, skirt / 2, minZ + 0.011)),
    transformMesh(boxGeometry(width, skirt, 0.022), T(0, skirt / 2, maxZ - 0.011)),
    transformMesh(boxGeometry(0.022, skirt, depth), T(minX + 0.011, skirt / 2, 0)),
    transformMesh(boxGeometry(0.022, skirt, depth), T(maxX - 0.011, skirt / 2, 0)),
  ];
  void skirtGeo;
  builder.add(mergeMeshes(skirts), m4identity(new Float32Array(16)), M.skirting, {
    tag: 'skirting', castShadow: false,
  });

  /* -------------------------------------------------------------- window */
  buildWindow(builder, M);

  /* ---------------------------------------------------------------- door */
  buildDoor(builder, M);

  /* ------------------------------------------------------------ wall art */
  buildWallArt(builder, M);

  /* ------------------------------------------------------ ceiling lights */
  return buildCeilingLight(builder, M);
}

function buildWindow(builder, M) {
  const { minZ } = ROOM;
  const frameDepth = 0.14;
  const frameWidth = 0.075;
  const z = minZ + frameDepth / 2;

  const pieces = [];
  // Outer frame.
  pieces.push(transformMesh(
    boxGeometry(WINDOW.width + frameWidth * 2, frameWidth, frameDepth),
    T(WINDOW.centerX, WINDOW.sill - frameWidth / 2, z)
  ));
  pieces.push(transformMesh(
    boxGeometry(WINDOW.width + frameWidth * 2, frameWidth, frameDepth),
    T(WINDOW.centerX, WINDOW.top + frameWidth / 2, z)
  ));
  pieces.push(transformMesh(
    boxGeometry(frameWidth, WINDOW.height, frameDepth),
    T(WINDOW.left - frameWidth / 2, WINDOW.sill + WINDOW.height / 2, z)
  ));
  pieces.push(transformMesh(
    boxGeometry(frameWidth, WINDOW.height, frameDepth),
    T(WINDOW.right + frameWidth / 2, WINDOW.sill + WINDOW.height / 2, z)
  ));
  // Mullions: one vertical, one horizontal.
  pieces.push(transformMesh(
    boxGeometry(0.045, WINDOW.height, 0.06),
    T(WINDOW.centerX, WINDOW.sill + WINDOW.height / 2, minZ + 0.05)
  ));
  pieces.push(transformMesh(
    boxGeometry(WINDOW.width, 0.045, 0.06),
    T(WINDOW.centerX, WINDOW.sill + WINDOW.height * 0.58, minZ + 0.05)
  ));
  builder.add(mergeMeshes(pieces), m4identity(new Float32Array(16)), M.metalBlack, {
    tag: 'windowFrame',
  });

  // Sill.
  builder.add(
    boxGeometry(WINDOW.width + 0.24, 0.05, 0.24),
    T(WINDOW.centerX, WINDOW.sill - 0.025, minZ + 0.11),
    M.oak,
    { tag: 'windowSill' }
  );

  // Glass.
  const glass = builder.addDynamic(
    quadGeometry(WINDOW.width, WINDOW.height),
    { ...M.windowGlass },
    { tag: 'windowGlass', castShadow: false, receiveShadow: false }
  );
  glass.model = T(WINDOW.centerX, WINDOW.sill, minZ + 0.03);

  // Rod + curtains.
  builder.add(
    cylinderGeometry(0.017, 0.017, WINDOW.width + 0.9, 12),
    T(WINDOW.centerX, WINDOW.top + 0.24, minZ + 0.17, 0, 0, Math.PI / 2),
    M.brass,
    { tag: 'curtainRod' }
  );
  const curtainHeight = WINDOW.top + 0.2 - 0.06;
  const curtain = curtainGeometry(0.74, curtainHeight, 7, 0.055, 30, 10);
  builder.add(
    curtain,
    T(WINDOW.left - 0.24, 0.06, minZ + 0.17),
    M.curtain,
    { tag: 'curtainLeft', castShadow: false }
  );
  const curtainRight = curtainGeometry(0.74, curtainHeight, 7, 0.055, 30, 10);
  builder.add(
    transformMesh(curtainRight, T(WINDOW.right + 0.24, 0.06, minZ + 0.17)),
    m4identity(new Float32Array(16)),
    M.curtain,
    { tag: 'curtainRight', castShadow: false }
  );

  // What is "outside": a bright panel a little behind the glass.
  return glass;
}

function buildDoor(builder, M) {
  const { minX } = ROOM;
  const doorZ = 1.2;
  const doorW = 0.96;
  const doorH = 2.08;
  const x = minX + 0.02;

  const frame = [];
  frame.push(transformMesh(boxGeometry(0.06, doorH + 0.06, 0.14), T(x + 0.05, (doorH + 0.06) / 2, doorZ - doorW / 2 - 0.03, Math.PI / 2)));
  frame.push(transformMesh(boxGeometry(0.06, doorH + 0.06, 0.14), T(x + 0.05, (doorH + 0.06) / 2, doorZ + doorW / 2 + 0.03, Math.PI / 2)));
  frame.push(transformMesh(boxGeometry(0.06, 0.06, doorW + 0.12), T(x + 0.05, doorH + 0.03, doorZ, Math.PI / 2)));
  builder.add(mergeMeshes(frame), m4identity(new Float32Array(16)), M.skirting, {
    tag: 'doorFrame',
  });

  builder.add(
    roundedBoxGeometry(0.05, doorH - 0.03, doorW - 0.02, 0.012, 3),
    T(x + 0.045, (doorH - 0.03) / 2, doorZ),
    M.walnut,
    { tag: 'door' }
  );
  builder.add(
    sphereGeometry(0.032, 12, 10),
    T(x + 0.1, 1.02, doorZ - doorW / 2 + 0.12),
    M.brass,
    { tag: 'doorHandle' }
  );
}

function buildWallArt(builder, M) {
  const { maxZ } = ROOM;
  const z = maxZ - 0.035;
  const specs = [
    { x: -1.42, y: 1.66, w: 0.62, h: 0.82 },
    { x: -0.62, y: 1.72, w: 0.46, h: 0.46 },
  ];
  specs.forEach((spec, i) => {
    const frame = [];
    const depth = 0.045;
    frame.push(transformMesh(boxGeometry(spec.w + 0.05, 0.025, depth), T(spec.x, spec.y - spec.h / 2 - 0.012, z)));
    frame.push(transformMesh(boxGeometry(spec.w + 0.05, 0.025, depth), T(spec.x, spec.y + spec.h / 2 + 0.012, z)));
    frame.push(transformMesh(boxGeometry(0.025, spec.h, depth), T(spec.x - spec.w / 2 - 0.012, spec.y, z)));
    frame.push(transformMesh(boxGeometry(0.025, spec.h, depth), T(spec.x + spec.w / 2 + 0.012, spec.y, z)));
    frame.push(transformMesh(boxGeometry(spec.w, spec.h, 0.012), T(spec.x, spec.y, z + 0.012)));
    builder.add(mergeMeshes(frame), m4identity(new Float32Array(16)), M.walnut, {
      tag: 'artFrame' + i, castShadow: false,
    });

    const canvas = builder.addDynamic(
      quadGeometry(spec.w, spec.h),
      { ...M.art(i) },
      { tag: 'artCanvas' + i, castShadow: false }
    );
    canvas.model = T(spec.x, spec.y - spec.h / 2, z - 0.006, Math.PI);
  });
}

function buildCeilingLight(builder, M) {
  const { height } = ROOM;
  // Recessed panel: soft, always-on fill from above.
  const panel = builder.addDynamic(
    roundedBoxGeometry(1.15, 0.03, 0.46, 0.012, 3),
    { ...M.bulb, emissiveStrength: 1.2 },
    { tag: 'ceilingPanel', castShadow: false }
  );
  panel.model = T(0.55, height - 0.02, 0.1);

  // Pendant over the coffee table.
  const px = -0.86, pz = 0.62;
  builder.add(
    cylinderGeometry(0.006, 0.006, height - 2.02, 8),
    T(px, (height + 2.02) / 2, pz),
    M.metalBlack,
    { tag: 'pendantCord', castShadow: false }
  );
  // Woven rattan lantern, like the concept's pendant.
  builder.add(
    sphereGeometry(0.24, 22, 14, { scaleY: 0.92 }),
    T(px, 2.0, pz),
    M.rattan,
    { tag: 'pendantShade', castShadow: false }
  );
  const bulb = builder.addDynamic(
    sphereGeometry(0.055, 14, 10),
    { ...M.bulb },
    { tag: 'pendantBulb', castShadow: false }
  );
  bulb.model = T(px, 1.96, pz);
  return { panel, bulb, position: [px, 1.94, pz] };
}
