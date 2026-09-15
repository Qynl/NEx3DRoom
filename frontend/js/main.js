/**
 * NEx3D Room - application entry point.
 *
 * Boots the renderer, builds the room, connects to the local backend and runs
 * the frame loop. Everything the user sees is driven by the AI's state.
 */

import { Capabilities, createContext } from './core/gl.js';
import { Renderer } from './core/renderer.js';
import { RoomCamera } from './core/camera.js';
import { clamp } from './core/math.js';
import { createScreenTexture } from './core/textures.js';
import { AiEntity } from './ai/entity.js';
import { FlightController } from './ai/motion.js';
import { CompanionBehaviour } from './ai/behaviour.js';
import { Hud } from './ui/hud.js';
import { DebugOverlay } from './ui/debug.js';
import { Backend } from './net.js';
import { buildScene } from './world/scene.js';
import { LightRig, TIME_OF_DAY } from './world/lighting.js';
import { CAMERA_HOME, PLACES } from './world/layout.js';

function defaultConfig() {
  return {
    graphics: { quality: 'high', pixelRatioCap: 1.75, shadows: true, bloom: true, msaa: true, cameraDrift: true },
    timeOfDay: 'DAY',
  };
}

const hud = new Hud();
const debug = new DebugOverlay();

const canvas = document.getElementById('scene');
const boot = {
  ready: false,
  error: null,
  startedAt: performance.now(),
};

async function main() {
  hud.setLoading('starting the renderer…');

  const gl = createContext(canvas);
  if (!gl) {
    fail('WebGL 2 is not available in this window. Update your graphics driver or browser and try again.');
    return;
  }
  const caps = new Capabilities(gl);

  let config = defaultConfig();
  try {
    const response = await fetch('api/config', { cache: 'no-store' });
    if (response.ok) config = { ...config, ...(await response.json()) };
  } catch (error) {
    /* The backend may still be waking up; defaults are fine. */
  }

  const graphics = config.graphics || {};
  const renderer = new Renderer(gl, caps, graphics.quality || 'high');
  renderer.bloomEnabled = graphics.bloom !== false && renderer.bloomEnabled;
  renderer.shadowEnabled = graphics.shadows !== false && renderer.shadowEnabled;
  if (graphics.msaa === false) renderer.msaaSamples = 0;

  const pixelRatioCap = graphics.pixelRatioCap || 1.75;

  const camera = new RoomCamera({
    ...CAMERA_HOME,
    drift: graphics.cameraDrift !== false,
  });
  camera.home = CAMERA_HOME;

  resize();

  /* ---------------------------------------------------------- the world -- */
  const scene = await buildScene(renderer, (text) => hud.setLoading(text));

  const screen = createScreenTexture(320, 200);
  if (scene.refs.screen) {
    const texture = renderer.createTexture(screen.canvas, { clamp: true, mips: false, minFilter: gl.LINEAR });
    scene.refs.screen.material.maps = { albedo: texture };
    scene.refs.screen.material.emissive = [0.55, 0.85, 1.0];
    scene.refs.screen.material.emissiveStrength = 0;
    scene.refs.screenTexture = texture;
    scene.refs.screenDraw = screen;
  }

  const lights = new LightRig(renderer, scene.refs);
  lights.setTimeOfDay(config.timeOfDay || 'DAY', true);
  scene.setTimeOfDay(config.timeOfDay || 'DAY');

  /* ------------------------------------------------------------- the AI -- */
  const entity = new AiEntity(renderer, scene.materials, scene.textures);
  const flight = new FlightController();
  const behaviour = new CompanionBehaviour({
    entity,
    flight,
    refs: scene.refs,
    renderer,
    onArrival: (location) => {
      backend.reportArrival(location);
      debug.logLine(`arrived at ${location}`);
    },
  });

  /* ---------------------------------------------------------- the backend - */
  const backend = new Backend({
    onState: (state) => applyState(state),
    onStatus: (status) => {
      hud.setConnection(status);
      debug.logLine(`backend ${status}`);
    },
    onEvent: (kind, data) => {
      if (kind === 'state') debug.logLine(`${data.from} → ${data.to} (${data.reason || '-'})`);
      else if (kind === 'wander') debug.logLine(`wandering to ${data.targetLocation}`);
      else if (kind === 'voice') debug.logLine(`voice: ${data.event}`);
    },
  });

  let currentState = null;
  let previousState = null;

  function applyState(state) {
    currentState = state;
    behaviour.sync(state);
    hud.setState(state.currentState, (PLACES[state.targetLocation] || {}).label || '');
    if (state.timeOfDay && state.timeOfDay !== activeTimeOfDay) setTimeOfDay(state.timeOfDay);
    previousState = state.currentState;
  }

  let activeTimeOfDay = config.timeOfDay || 'DAY';
  function setTimeOfDay(name, push = true) {
    if (!TIME_OF_DAY[name]) return;
    activeTimeOfDay = name;
    lights.setTimeOfDay(name);
    scene.setTimeOfDay(name);
    if (currentState) currentState.timeOfDay = name;
    if (push) backend.patch({ timeOfDay: name });
  }

  await backend.init();
  hud.setState(currentState?.currentState || 'IDLE', 'centre of the room');

  /* -------------------------------------------------------------- input -- */
  let dragging = null;
  let lastPointer = { x: 0, y: 0 };
  let cursorTimer = 0;

  canvas.addEventListener('pointerdown', (event) => {
    dragging = event.button === 2 ? 'pan' : 'orbit';
    lastPointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    document.body.classList.add('dragging');
    wake();
  });

  canvas.addEventListener('pointermove', (event) => {
    cursorTimer = 0;
    document.body.classList.remove('hidden-cursor');
    if (!dragging) return;
    const dx = event.clientX - lastPointer.x;
    const dy = event.clientY - lastPointer.y;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (dragging === 'pan') camera.pan(dx, dy);
    else camera.orbit(dx, dy);
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    document.body.classList.remove('dragging');
    try { canvas.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    camera.zoom(event.deltaY);
    wake();
  }, { passive: false });

  function wake() {
    // Any deliberate input tells the companion you are there.
    backend.voiceEvent('user_interaction');
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'F1') {
      event.preventDefault();
      debug.toggle();
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      toggleFullscreen();
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      camera.reset();
      return;
    }
    if (event.key === '1') setTimeOfDay('DAY');
    if (event.key === '2') setTimeOfDay('SUNSET');
    if (event.key === '3') setTimeOfDay('NIGHT');
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      reportWindowMode('maximized');
    } else {
      document.documentElement.requestFullscreen?.().then(
        () => reportWindowMode('fullscreen'),
        () => reportWindowMode('windowed')
      );
    }
  }

  /* -------------------------------------------------------- window state -- */
  let resizeTimer = null;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, pixelRatioCap);
    const width = Math.max(320, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(240, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    renderer.resize(width, height, dpr);
    camera.resize(width, height);
  }

  window.addEventListener('resize', () => {
    resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      backend.patch({});
      reportWindowState();
    }, 400);
  });

  function reportWindowState() {
    const mode = document.fullscreenElement ? 'fullscreen'
      : window.innerWidth >= screen.width - 24 ? 'maximized' : 'windowed';
    backend.post('api/window-state', {
      width: window.outerWidth || window.innerWidth,
      height: window.outerHeight || window.innerHeight,
      mode,
    });
  }
  function reportWindowMode(mode) {
    backend.post('api/window-state', { mode });
  }
  reportWindowState();

  window.addEventListener('pagehide', () => backend.notifyWindowClosed());

  /* --------------------------------------------------------------- loop -- */
  const frames = { count: 0, time: 0, fps: 60, frameMs: 16.7, smoothed: 16.7 };
  let last = performance.now();
  let screenTimer = 0;
  let telemetryTimer = 0;
  let monitorActivity = 0;

  function frame(now) {
    const dt = clamp((now - last) / 1000, 0.0005, 0.1);
    last = now;

    frames.count++;
    frames.time += dt;
    frames.frameMs = dt * 1000;
    frames.smoothed = frames.smoothed * 0.9 + frames.frameMs * 0.1;
    if (frames.time >= 0.5) {
      frames.fps = frames.count / frames.time;
      frames.count = 0;
      frames.time = 0;
    }

    const state = currentState || { currentState: 'IDLE', targetLocation: 'CENTER' };
    const busy = state.currentState === 'WORKING' || state.currentState === 'THINKING';
    const wantMonitor = busy ? 1 : state.currentState === 'SPEAKING' ? 0.45 : 0.05;
    monitorActivity += (wantMonitor - monitorActivity) * clamp(dt * 2.2, 0, 1);
    // The screen flickers with the companion's typing so the desk feels alive.
    const typingFlicker = entity.activity === 'typing'
      ? 0.85 + Math.abs(Math.sin(now / 90)) * 0.15
      : monitorActivity;
    lights.setMonitorActivity(Math.max(monitorActivity, typingFlicker));

    // The monitor redraws slowly - it is a background detail, not a game.
    screenTimer -= dt;
    if (screenTimer <= 0) {
      screenTimer = monitorActivity > 0.2 ? 0.13 : 0.6;
      screen.advance(dt * 6);
      screen.draw(monitorActivity, now / 1000);
      if (scene.refs.screenTexture) {
        renderer.updateTexture(scene.refs.screenTexture, screen.canvas);
      }
      if (scene.refs.screen) {
        scene.refs.screen.material.emissiveStrength = monitorActivity * 1.9;
      }
    }

    const info = behaviour.update(dt, camera.position, scene.refs.screenPosition);
    lights.setAiLight(entity.eyeColour, 0.5 + entity.expr.glow * 0.35, 2.3);
    lights.update(dt, entity.position);

    // A gentle nod toward the AI, but the frame stays on the whole room.
    camera.focus(entity.position, busy ? 0.1 : 0.18);
    camera.update(dt);

    const stats = renderer.render(camera, now / 1000);

    cursorTimer += dt;
    if (cursorTimer > 3.5) document.body.classList.add('hidden-cursor');

    hud.setLevel(
      state.currentState === 'SPEAKING' ? entity.speakingLevel
        : state.currentState === 'LISTENING' ? 0.4 + Math.sin(now / 260) * 0.25
        : 0
    );
    hud.update(dt);

    telemetryTimer -= dt;
    if (telemetryTimer <= 0) {
      telemetryTimer = 5;
      backend.patch({
        fps: Math.round(frames.fps),
        frameMs: Number(frames.smoothed.toFixed(2)),
        drawCalls: stats.drawCalls,
        triangles: Math.round(stats.triangles),
      });
    }

    debug.update(dt, currentState, {
      fps: frames.fps,
      frameMs: frames.smoothed,
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
      gpu: caps.renderer.slice(0, 34),
      connection: backend.status,
      mode: backend.mode,
      latency: backend.latency,
      camera: `${camera.position[0].toFixed(1)}, ${camera.position[1].toFixed(1)}, ${camera.position[2].toFixed(1)}`,
    });

    window.__nex.frameCount = (window.__nex.frameCount || 0) + 1;
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------- dev handle -- */
  window.__nex = {
    version: '0.1.0',
    ready: true,
    bootMs: Math.round(performance.now() - boot.startedAt),
    frameCount: 0,
    get state() { return currentState; },
    get stats() {
      return {
        fps: frames.fps,
        frameMs: frames.smoothed,
        drawCalls: renderer.items.length + renderer.transparent.length,
        triangles: scene.stats.triangles,
        connection: backend.status,
        gpu: caps.renderer,
        position: Array.from(entity.position),
        location: behaviour.location,
        target: behaviour.targetLocation,
      };
    },
    get entity() { return entity; },
    get flight() { return flight; },
    get camera() { return camera; },
    get renderer() { return renderer; },
    get behaviour() { return behaviour; },
    setTimeOfDay: (name) => setTimeOfDay(name),
    voice: (event) => backend.voiceEvent(event),
    setState: (name) => backend.patch({ currentState: name }),
    goTo: (name) => backend.patch({ targetLocation: name }),
    emote: (name) => entity.playEmote(name),
    task: (name) => backend.patch({ task: name, currentState: 'WORKING' }),
    toggleDebug: () => debug.toggle(),
  };

  debug.setActions({
    setState: (name) => backend.patch({ currentState: name }),
    goTo: (name) => backend.patch({ targetLocation: name }),
    voice: (event) => backend.voiceEvent(event),
    setTimeOfDay: (name) => setTimeOfDay(name),
    resetCamera: () => camera.reset(),
    emote: (name) => entity.playEmote(name),
    task: (name) => backend.patch({ task: name, currentState: 'WORKING' }),
  });

  resize();
  requestAnimationFrame(frame);
  hud.hideLoading();
  boot.ready = true;
  debug.logLine(`ready in ${Math.round(performance.now() - boot.startedAt)} ms`);
  debug.logLine(`${scene.stats.triangles.toLocaleString()} triangles, ${window.__nex.stats.drawCalls} draw calls`);
}

function fail(message) {
  boot.error = message;
  const loading = document.getElementById('loading');
  if (loading) {
    loading.classList.remove('done');
    loading.hidden = false;
    const text = document.getElementById('loadingText');
    if (text) {
      text.textContent = message;
      text.style.maxWidth = '30ch';
      text.style.lineHeight = '1.7';
    }
  }
  console.error(message);
}

window.__nex = { ready: false, boot };

main().catch((error) => {
  console.error(error);
  fail('The room could not start: ' + (error && error.message ? error.message : error));
});
