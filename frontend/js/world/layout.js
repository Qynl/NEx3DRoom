/**
 * The room's dimensions and the AI's named places. One source of truth so the
 * renderer, the movement system and the camera all agree on the geometry.
 *
 * Units are metres. Origin = centre of the floor.
 *   -X wall : desk + shelving
 *   +X wall : bed + nightstand
 *   -Z wall : window + curtains
 *   +Z wall : sofa + wall art
 */

export const ROOM = {
  width: 5.4,        // X
  depth: 4.2,        // Z
  height: 2.72,      // Y
  wallThickness: 0.12,
  get minX() { return -this.width / 2; },
  get maxX() { return this.width / 2; },
  get minZ() { return -this.depth / 2; },
  get maxZ() { return this.depth / 2; },
};

export const WINDOW = {
  centerX: 0.55,
  width: 2.1,
  sill: 0.82,
  height: 1.44,
  get top() { return this.sill + this.height; },
  get left() { return this.centerX - this.width / 2; },
  get right() { return this.centerX + this.width / 2; },
};

export const DESK = {
  centerX: -ROOM.width / 2 + 0.36,
  centerZ: -0.62,
  width: 1.72,     // along Z
  depth: 0.66,     // along X
  height: 0.74,
  thickness: 0.045,
};

export const BED = {
  headX: ROOM.width / 2 - 0.06,
  centerZ: 0.66,
  length: 2.02,    // along X
  width: 1.54,     // along Z
  baseHeight: 0.30,
  mattressTop: 0.52,
  get centerX() { return this.headX - this.length / 2; },
  get minX() { return this.headX - this.length; },
  get pillowX() { return this.headX - 0.36; },
};

export const SOFA = {
  centerX: -0.92,
  centerZ: ROOM.depth / 2 - 0.46,
  width: 2.06,     // along X
  depth: 0.92,     // along Z
  seatHeight: 0.42,
  backHeight: 0.82,
};

export const RUG = { centerX: -0.72, centerZ: 0.72, width: 2.72, depth: 1.92 };
export const TABLE = { centerX: -0.86, centerZ: 0.62, width: 1.06, depth: 0.56, height: 0.40 };

/**
 * Where the AI can be. Each place has a hover point plus the direction it
 * should face while it is there, so it always looks at something meaningful.
 */
export const PLACES = {
  CENTER: {
    position: [0.05, 1.34, 0.22],
    face: [-0.4, -0.05, -1],
    hover: 0.028,
    label: 'centre of the room',
  },
  DESK: {
    position: [DESK.centerX + DESK.depth / 2 + 0.62, 1.14, DESK.centerZ + 0.06],
    face: [-1, -0.08, 0.05],
    hover: 0.014,
    label: 'the desk',
  },
  BED: {
    position: [BED.pillowX - 0.06, BED.mattressTop + 0.55, BED.centerZ],
    face: [-0.25, -0.1, 1],
    hover: 0.006,
    label: 'the bed',
  },
  WINDOW: {
    position: [WINDOW.centerX - 0.05, 1.52, ROOM.minZ + 0.62],
    face: [0.05, -0.05, -1],
    hover: 0.03,
    label: 'the window',
  },
  SOFA: {
    position: [SOFA.centerX + 0.28, 1.16, SOFA.centerZ - 0.92],
    face: [0.1, -0.12, 1],
    hover: 0.022,
    label: 'the sofa',
  },
};

/** Sleeping spot: right above the pillow, settling down onto it. */
export const SLEEP_SPOT = {
  position: [BED.pillowX - 0.02, BED.mattressTop + 0.20, BED.centerZ + 0.02],
  face: [-0.3, -0.15, 1],
};

/** Pre-bed staging point used by the sleep choreography. */
export const BED_APPROACH = {
  position: [BED.centerX + 0.1, 1.25, BED.centerZ],
  face: [0.2, -0.2, 0.4],
};

export const CAMERA_HOME = {
  target: [-0.35, 1.12, -0.18],
  yaw: 0.94,
  pitch: 0.15,
  distance: 3.0,
};
