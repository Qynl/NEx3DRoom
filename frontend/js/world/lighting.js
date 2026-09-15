/**
 * Time of day and the light rig.
 *
 * Eight point lights is the budget: pendant, ceiling panel, desk lamp, floor
 * lamp, nightstand lamp, monitor, window bounce and the AI itself. Everything
 * transitions smoothly instead of snapping when the time of day changes.
 */

import { clamp, damp, lerp } from '../core/math.js';

export const TIME_OF_DAY = {
  DAY: {
    sunDir: [0.42, 0.72, -0.62],
    sunColor: [3.5, 3.05, 2.45],
    skyColor: [0.44, 0.45, 0.50],
    groundColor: [0.24, 0.19, 0.14],
    ambient: 0.66,
    envIntensity: 1.05,
    exposure: 1.02,
    fogColor: [0.09, 0.10, 0.12],
    fogDensity: 0.016,
    shadowStrength: 0.9,
    lamps: 0.10,
    deskLamp: 0.30,
    windowBounce: 1.15,
    skyIntensity: 1.35,
    poolColor: [1.0, 0.93, 0.78],
    poolAlpha: 0.30,
    tint: [1, 1, 1],
  },
  SUNSET: {
    sunDir: [0.62, 0.22, -0.76],
    sunColor: [4.6, 2.15, 1.05],
    skyColor: [0.36, 0.26, 0.26],
    groundColor: [0.18, 0.12, 0.10],
    ambient: 0.40,
    envIntensity: 0.85,
    exposure: 1.06,
    fogColor: [0.10, 0.075, 0.07],
    fogDensity: 0.020,
    shadowStrength: 0.85,
    lamps: 0.75,
    deskLamp: 0.85,
    windowBounce: 0.55,
    skyIntensity: 1.15,
    poolColor: [1.0, 0.62, 0.34],
    poolAlpha: 0.34,
    tint: [1.02, 0.98, 0.95],
  },
  NIGHT: {
    sunDir: [0.36, 0.6, -0.72],
    sunColor: [0.20, 0.26, 0.44],
    skyColor: [0.075, 0.09, 0.135],
    groundColor: [0.05, 0.045, 0.045],
    ambient: 0.20,
    envIntensity: 0.34,
    exposure: 1.18,
    fogColor: [0.035, 0.04, 0.055],
    fogDensity: 0.026,
    shadowStrength: 0.6,
    lamps: 1.0,
    deskLamp: 1.0,
    windowBounce: 0.10,
    skyIntensity: 0.30,
    poolColor: [0.42, 0.55, 0.85],
    poolAlpha: 0.10,
    tint: [0.96, 0.98, 1.04],
  },
};

const WARM = [1.0, 0.72, 0.44];

export class LightRig {
  constructor(renderer, refs) {
    this.renderer = renderer;
    this.refs = refs;
    this.timeOfDay = 'DAY';
    this.current = clonePreset(TIME_OF_DAY.DAY);
    this.target = clonePreset(TIME_OF_DAY.DAY);
    this.monitorActivity = 0;
    this.desiredMonitor = 0;
    this.aiLight = { color: [0.5, 0.9, 1.0], intensity: 0.9, range: 2.4 };
  }

  setTimeOfDay(name, instant = false) {
    const preset = TIME_OF_DAY[name] || TIME_OF_DAY.DAY;
    this.timeOfDay = TIME_OF_DAY[name] ? name : 'DAY';
    this.target = clonePreset(preset);
    if (instant) this.current = clonePreset(preset);
    return this.timeOfDay;
  }

  /** `activity` is 0..1 (the desk monitor wakes up when the AI works). */
  setMonitorActivity(value) {
    this.desiredMonitor = clamp(value, 0, 1);
  }

  setAiLight(color, intensity, range = 2.4) {
    this.aiLight.color = color;
    this.aiLight.intensity = intensity;
    this.aiLight.range = range;
  }

  update(dt, aiPosition) {
    const c = this.current;
    const t = this.target;
    const k = damp(1.6, dt);

    lerpArray(c.sunDir, t.sunDir, k);
    lerpArray(c.sunColor, t.sunColor, k);
    lerpArray(c.skyColor, t.skyColor, k);
    lerpArray(c.groundColor, t.groundColor, k);
    lerpArray(c.fogColor, t.fogColor, k);
    lerpArray(c.tint, t.tint, k);
    c.ambient = lerp(c.ambient, t.ambient, k);
    c.envIntensity = lerp(c.envIntensity, t.envIntensity, k);
    c.exposure = lerp(c.exposure, t.exposure, k);
    c.fogDensity = lerp(c.fogDensity, t.fogDensity, k);
    c.shadowStrength = lerp(c.shadowStrength, t.shadowStrength, k);
    c.lamps = lerp(c.lamps, t.lamps, k);
    c.deskLamp = lerp(c.deskLamp, t.deskLamp, k);
    c.windowBounce = lerp(c.windowBounce, t.windowBounce, k);
    c.skyIntensity = lerp(c.skyIntensity, t.skyIntensity, k);
    c.poolAlpha = lerp(c.poolAlpha, t.poolAlpha, k);
    lerpArray(c.poolColor, t.poolColor, k);
    this.monitorActivity = lerp(this.monitorActivity, this.desiredMonitor, damp(3.2, dt));

    const env = this.renderer.env;
    env.sunDir.set(c.sunDir);
    env.sunColor.set(c.sunColor);
    env.skyColor.set(c.skyColor);
    env.groundColor.set(c.groundColor);
    env.fogColor.set(c.fogColor);
    env.tint.set(c.tint);
    env.ambient = c.ambient;
    env.envIntensity = c.envIntensity;
    env.exposure = c.exposure;
    env.fogDensity = c.fogDensity;
    env.shadowStrength = c.shadowStrength;

    const refs = this.refs;
    const lamp = c.lamps;

    // 0 - pendant over the coffee table
    this.renderer.setLight(0, refs.pendantPosition, scale(WARM, 2.6 * (0.35 + lamp * 0.65)), 4.4, 0.09);
    // 1 - warm under-shelf glow (the cozy kitchen-strip look)
    this.renderer.setLight(1, refs.shelfStripPosition || refs.ceilingPosition, scale([1.0, 0.7, 0.44], 2.0 * (0.45 + lamp * 0.55)), 3.2, 0.3);
    // 2 - desk lamp
    this.renderer.setLight(2, refs.deskLampPosition, scale(WARM, 1.5 * c.deskLamp), 2.6, 0.05);
    // 3 - floor lamp
    this.renderer.setLight(3, refs.floorLampPosition, scale(WARM, 2.0 * lamp), 4.0, 0.2);
    // 4 - nightstand lamp
    this.renderer.setLight(4, refs.nightLampPosition, scale(WARM, 1.1 * lamp), 2.8, 0.1);
    // 5 - monitor
    this.renderer.setLight(5, refs.screenPosition, scale([0.42, 0.72, 0.95], 1.5 * this.monitorActivity), 2.2, 0.25);
    // 6 - window bounce (daylight spilling in)
    this.renderer.setLight(6, refs.windowPosition, scale([0.72, 0.82, 1.0], 1.6 * c.windowBounce), 5.0, 1.2);
    // 7 - the AI itself
    if (aiPosition) {
      this.renderer.setLight(7, aiPosition, scale(this.aiLight.color, this.aiLight.intensity), this.aiLight.range, 0.18);
    }
    this.renderer.lights.length = 8;

    // Emissive fixtures follow the same curve.
    if (refs.pendantBulb) refs.pendantBulb.material.emissiveStrength = 2.2 + lamp * 4.5;
    if (refs.ceilingPanel) refs.ceilingPanel.material.emissiveStrength = 0.5 + lamp * 0.7;
    if (refs.shelfStrip) refs.shelfStrip.material.emissiveStrength = 1.4 + lamp * 3.2;
    setShade(refs.deskLampShade, c.deskLamp);
    setShade(refs.floorLampShade, lamp);
    setShade(refs.nightLampShade, lamp * 0.9);

    if (refs.skyPanel) refs.skyPanel.setIntensity(c.skyIntensity);
    if (refs.lightPool) {
      refs.lightPool.material.color = [c.poolColor[0], c.poolColor[1], c.poolColor[2], c.poolAlpha];
    }

    return c;
  }
}

function setShade(item, level) {
  if (!item) return;
  item.material.emissiveStrength = 0.05 + level * 1.5;
}

function scale(rgb, factor) {
  return [rgb[0] * factor, rgb[1] * factor, rgb[2] * factor];
}

function lerpArray(out, target, k) {
  for (let i = 0; i < out.length; i++) out[i] = lerp(out[i], target[i], k);
  return out;
}

function clonePreset(preset) {
  const out = {};
  for (const key of Object.keys(preset)) {
    out[key] = Array.isArray(preset[key]) ? preset[key].slice() : preset[key];
  }
  return out;
}
