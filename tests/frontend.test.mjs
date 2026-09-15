/**
 * End-to-end frontend check, running the real modules against a recording
 * WebGL2 mock (see gl-mock.mjs) and a small DOM shim (dom-shim.mjs).
 *
 *   node tests/frontend.test.mjs
 *
 * This is developer tooling. The application itself needs nothing but a browser.
 * What it proves:
 *   - every module imports cleanly and the scene builds without throwing
 *   - all GLSL passes the static lint (no undeclared identifiers, matched varyings)
 *   - geometry, textures and uniforms are uploaded with sane sizes
 *   - the AI flies between all five places without ever teleporting
 *   - the sleep and wake choreography actually moves it onto and off the bed
 *   - the camera never leaves the room
 */

import { installDom } from './dom-shim.mjs';

const document = installDom();
const canvas = document.createElement('canvas');
canvas.id = 'scene';
canvas.width = 1440;
canvas.height = 900;
const originalGet = document.getElementById.bind(document);
document.getElementById = (id) => (id === 'scene' ? canvas : originalGet(id));

const { GlMock } = await import('./gl-mock.mjs');
const glMock = new GlMock();
canvas._glContext = glMock;

const { createContext, Capabilities } = await import('../frontend/js/core/gl.js');
const { Renderer } = await import('../frontend/js/core/renderer.js');
const { RoomCamera } = await import('../frontend/js/core/camera.js');
const { AiEntity } = await import('../frontend/js/ai/entity.js');
const { FlightController } = await import('../frontend/js/ai/motion.js');
const { CompanionBehaviour } = await import('../frontend/js/ai/behaviour.js');
const { Hud } = await import('../frontend/js/ui/hud.js');
const { DebugOverlay } = await import('../frontend/js/ui/debug.js');
const { buildScene } = await import('../frontend/js/world/scene.js');
const { LightRig } = await import('../frontend/js/world/lighting.js');
const { PLACES, SLEEP_SPOT, CAMERA_HOME } = await import('../frontend/js/world/layout.js');

/* --------------------------------------------------------------- harness */

let failures = 0;
const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ boot */

section('renderer');
const gl = createContext(canvas);
check(!!gl, 'WebGL2 context created (mock)');
const caps = new Capabilities(gl);
check(caps.floatBuffers === true, 'HDR float targets available', String(caps.floatBuffers));

const renderer = new Renderer(gl, caps, 'high');
renderer.resize(1440, 900, 1);
check(renderer.targetsReady, 'framebuffers complete');
check(renderer.sceneTarget.samples === 4, 'MSAA 4x on the HDR target', String(renderer.sceneTarget.samples));

section('scene build');
const progress = [];
const scene = await buildScene(renderer, (text) => progress.push(text));
check(progress.length >= 8, 'build reported progress', `${progress.length} steps`);
check(scene.stats.triangles > 12000, 'room geometry built', `${scene.stats.triangles} triangles`);
check(scene.stats.drawCalls >= 20 && scene.stats.drawCalls <= 90,
  'draw calls are batched, not per object', `${scene.stats.drawCalls}`);
check(glMock.textures.length >= 12, 'textures uploaded', `${glMock.textures.length}`);
check(glMock.problems.length === 0, 'no GL / GLSL problems', glMock.problems.slice(0, 6).join(' | ') || 'clean');

section('shaders');
const programs = glMock.programs;
check(programs.length === 6, 'six programs compiled', String(programs.length));
for (const program of programs) {
  const uniforms = [...program.uniforms.keys()];
  check(uniforms.length >= 2, `program #${program.id} exposes ${uniforms.length} uniforms`);
  check((program.varyingProblems || []).length === 0,
    `program #${program.id} varyings match`, (program.varyingProblems || []).join('; ') || 'ok');
}

/* ------------------------------------------------------------- simulate */

section('simulation');

const camera = new RoomCamera({ ...CAMERA_HOME });
camera.home = CAMERA_HOME;
camera.resize(1440, 900);

const entity = new AiEntity(renderer, scene.materials, scene.textures);
const flight = new FlightController();
const arrivals = [];
const behaviour = new CompanionBehaviour({
  entity, flight,
  onArrival: (location) => arrivals.push(location),
});
const lights = new LightRig(renderer, scene.refs);
lights.setTimeOfDay('DAY', true);
const hud = new Hud();
const debug = new DebugOverlay();
debug.setActions({ setState() {}, goTo() {}, voice() {}, setTimeOfDay() {}, resetCamera() {} });

let state = {
  currentState: 'IDLE',
  targetLocation: 'CENTER',
  energy: 88,
  mood: 0.7,
  timeOfDay: 'DAY',
  model: { name: 'local-placeholder', provider: 'none', connected: false },
};

function apply(patch) {
  state = { ...state, ...patch };
  behaviour.sync(state);
  hud.setState(state.currentState, (PLACES[state.targetLocation] || {}).label || '');
  debug.update(0.2, state, { fps: 60, drawCalls: renderer.items.length });
}

let frameCount = 0;
let maxStep = 0;
let previous = [...entity.position];
let nanFrames = 0;
const cameraBreaches = [];

function runFrames(count, dt = 1 / 60) {
  for (let i = 0; i < count; i++) {
    behaviour.update(dt, camera.position, scene.refs.screenPosition);
    lights.update(dt, entity.position);
    camera.focus(entity.position, 0.5);
    camera.update(dt);
    renderer.render(camera, frameCount * dt);
    frameCount++;

    for (const value of entity.position) if (!Number.isFinite(value)) nanFrames++;
    const step = Math.hypot(
      entity.position[0] - previous[0],
      entity.position[1] - previous[1],
      entity.position[2] - previous[2]
    );
    maxStep = Math.max(maxStep, step);
    previous = [...entity.position];

    const p = camera.position;
    const l = camera.eyeLimits;
    if (p[0] < l.minX - 0.01 || p[0] > l.maxX + 0.01 ||
        p[1] < l.minY - 0.01 || p[1] > l.maxY + 0.01 ||
        p[2] < l.minZ - 0.01 || p[2] > l.maxZ + 0.01) {
      cameraBreaches.push([...p]);
    }
  }
}

apply({ currentState: 'IDLE', targetLocation: 'CENTER' });
runFrames(120);
const idlePos = [...entity.position];
check(Math.hypot(idlePos[0] - PLACES.CENTER.position[0], idlePos[2] - PLACES.CENTER.position[2]) < 0.2,
  'starts at the centre of the room', idlePos.map((n) => n.toFixed(2)).join(', '));

/* ------------------------------------------------- visit every location */

section('movement');
for (const name of ['DESK', 'WINDOW', 'SOFA', 'CENTER', 'BED']) {
  apply({ currentState: 'IDLE', targetLocation: name });
  const before = [...entity.position];
  runFrames(300);
  const after = [...entity.position];
  const target = PLACES[name].position;
  const error = Math.hypot(after[0] - target[0], after[1] - target[1], after[2] - target[2]);
  const travelled = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  check(error < 0.12, `flies to ${name} and settles there`, `error ${error.toFixed(3)} m, travelled ${travelled.toFixed(2)} m`);
  check(arrivals.includes(name), `arrival reported for ${name}`);
}

check(maxStep < 0.06, 'no teleporting - every frame is a small step', `max ${maxStep.toFixed(4)} m/frame`);
check(nanFrames === 0, 'no NaN in the entity transform', String(nanFrames));
check(cameraBreaches.length === 0, 'camera stays inside the room',
  cameraBreaches.length ? JSON.stringify(cameraBreaches[0]) : 'ok');

/* --------------------------------------------------------- conversation */

section('voice turn');
apply({ currentState: 'LISTENING', targetLocation: 'CENTER' });
runFrames(120);
check(entity.expr.glow > 3, 'eyes brighten while listening', entity.expr.glow.toFixed(2));

apply({ currentState: 'THINKING', targetLocation: 'DESK' });
runFrames(300);
check(behaviour.location === 'DESK', 'thinking happens at the desk', behaviour.location);

apply({ currentState: 'WORKING', targetLocation: 'DESK' });
runFrames(180);
lights.setMonitorActivity(1);
runFrames(60);
check(renderer.lights.length === 8, 'eight point lights in the rig', String(renderer.lights.length));

apply({ currentState: 'SPEAKING', targetLocation: 'CENTER' });
entity.setSpeakingLevel(0.8);
runFrames(150);
check(entity.speakingLevel > 0.5, 'speech animation runs', entity.speakingLevel.toFixed(2));

apply({ currentState: 'IDLE', targetLocation: 'CENTER' });
runFrames(240);

/* --------------------------------------------------------- sleep + wake */

section('poses and emotes');
apply({ currentState: 'WORKING', targetLocation: 'DESK' });
runFrames(180);
check(entity.poseInfo.lean > 0.1, 'leans in while working', `lean ${entity.poseInfo.lean.toFixed(2)}`);

entity.playEmote('spin');
runFrames(45);
check(entity.poseInfo.spin > 1.2, 'spin emote turns the body', `spin ${entity.poseInfo.spin.toFixed(2)} rad`);
runFrames(60);
check(entity.emote === null && entity.poseInfo.spin < 0.01,
  'emote envelope finishes and settles', `spin ${entity.poseInfo.spin.toFixed(3)}`);

apply({ currentState: 'LISTENING', targetLocation: 'CENTER' });
check(entity.emote && entity.emote.name === 'nod', 'listening answers with a nod', String(entity.emote && entity.emote.name));

entity.playEmote('stretch');
runFrames(30);
check(entity.poseInfo.yawn > 0.3, 'stretch comes with a yawn', `yawn ${entity.poseInfo.yawn.toFixed(2)}`);

entity.playEmote('bounce');
runFrames(12);
check(entity.poseInfo.bounce > 0.02, 'happy bounce lifts the body', `bounce ${entity.poseInfo.bounce.toFixed(3)}`);

section('sleep and wake');
apply({ currentState: 'RESTING', targetLocation: 'BED' });
runFrames(300);
const restingPos = [...entity.position];
check(restingPos[0] > 1.2, 'resting happens over the bed', `x=${restingPos[0].toFixed(2)}`);

apply({ currentState: 'SLEEPING', targetLocation: 'BED' });
runFrames(420);
const sleepPos = [...entity.position];
const sleepError = Math.hypot(
  sleepPos[0] - SLEEP_SPOT.position[0],
  sleepPos[1] - SLEEP_SPOT.position[1],
  sleepPos[2] - SLEEP_SPOT.position[2]
);
check(sleepError < 0.1, 'settles onto the pillow', `error ${sleepError.toFixed(3)} m at y=${sleepPos[1].toFixed(2)}`);
check(entity.expr.eyeOpen < 0.2, 'eyes close', `eyeOpen=${entity.expr.eyeOpen.toFixed(2)}`);
check(entity.shell.material.emissiveStrength < 0.12, 'shell dims',
  entity.shell.material.emissiveStrength.toFixed(3));
const sleepingY = sleepPos[1];
runFrames(180);
const drift = Math.abs(entity.position[1] - sleepingY);
check(drift < 0.05, 'almost completely still while asleep', `drift ${drift.toFixed(3)} m`);

apply({ currentState: 'WAKING', targetLocation: 'BED' });
runFrames(240);
check(entity.position[1] > sleepingY + 0.25, 'rises out of the bed on wake',
  `${sleepingY.toFixed(2)} → ${entity.position[1].toFixed(2)}`);

apply({ currentState: 'LISTENING', targetLocation: 'CENTER' });
runFrames(300);
check(behaviour.location === 'CENTER', 'returns to the middle of the room', behaviour.location);
check(entity.expr.eyeOpen > 0.9, 'eyes open again', entity.expr.eyeOpen.toFixed(2));

/* ---------------------------------------------------------- time of day */

section('time of day');
for (const tod of ['SUNSET', 'NIGHT', 'DAY']) {
  lights.setTimeOfDay(tod);
  scene.setTimeOfDay(tod);
  runFrames(90);
  const env = renderer.env;
  const finite = [env.sunColor, env.skyColor, env.groundColor, env.tint]
    .every((arr) => Array.from(arr).every(Number.isFinite));
  check(finite, `${tod} lighting applied`, `exposure ${env.exposure.toFixed(2)}, ambient ${env.ambient.toFixed(2)}`);
}

/* ------------------------------------------------- restart at last spot */

section('restart with a remembered location');
{
  const entity2 = new AiEntity(renderer, scene.materials, scene.textures);
  const flight2 = new FlightController();
  const behaviour2 = new CompanionBehaviour({ entity: entity2, flight: flight2, onArrival() {} });
  behaviour2.sync({
    currentState: 'IDLE',
    currentLocation: 'WINDOW',
    targetLocation: 'WINDOW',
    energy: 74,
    mood: 0.6,
    timeOfDay: 'DAY',
    model: state.model,
  });
  const spot = PLACES.WINDOW.position;
  const mid = PLACES.CENTER.position;
  behaviour2.update(1 / 60, camera.position, scene.refs.screenPosition);
  const p = entity2.position;
  const toWindow = Math.hypot(p[0] - spot[0], p[1] - spot[1], p[2] - spot[2]);
  const toCenter = Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]);
  check(behaviour2.location === 'WINDOW', 'location restored from the backend', behaviour2.location);
  check(toWindow < 0.05, 'boots where it was last seen',
    `distance to WINDOW ${toWindow.toFixed(3)} m (CENTER is ${toCenter.toFixed(2)} m away)`);
  check(!flight2.moving, 'does not fly across the room on launch');
}

/* ---------------------------------------------------------------- output */

section('summary');
console.log(`  frames rendered : ${frameCount}`);
console.log(`  gl draw calls   : ${glMock.drawCalls}`);
console.log(`  gl state calls  : ${[...glMock.calls.values()].reduce((a, b) => a + b, 0)}`);
console.log(`  gl problems     : ${glMock.problems.length}`);
if (glMock.problems.length) glMock.problems.slice(0, 10).forEach((p) => console.log('    -', p));

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
