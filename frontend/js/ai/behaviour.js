/**
 * Behaviour: turns backend state into movement and expression.
 *
 * The backend owns the *what* (state machine, timers, where the AI should be).
 * This module owns the *how* (flight paths, choreography for sleeping and
 * waking, where it looks, how fast the halo spins).
 */

import { clamp, lerp, v3, v3copy, v3dist, v3normalize } from '../core/math.js';
import { BED_APPROACH, PLACES, SLEEP_SPOT } from '../world/layout.js';

export class CompanionBehaviour {
  constructor({ entity, flight, onArrival }) {
    this.entity = entity;
    this.flight = flight;
    this.onArrival = onArrival || (() => {});

    this.state = 'IDLE';
    this.previousState = null;
    this.location = 'CENTER';
    this.targetLocation = 'CENTER';
    this.sequence = null;
    this.started = false;
    this.gazeTimer = 2;
    this.gazeTarget = [0, 0];
    this.speakingPhase = 0;
    this.speakingLevel = 0;
    this.listeningPulse = 0;
    this.awake = true;
    this.idleEmoteTimer = 6;
    this.workEmoteTimer = 4;

    // Put the entity where the backend thinks it already is.
    const start = PLACES.CENTER;
    this.flight.place(start.position[0], start.position[1], start.position[2]);
    this.flight.face(start.face, true);
  }

  /* -------------------------------------------------------------- state -- */

  /** Called with the whole state document whenever the backend changes. */
  sync(snapshot) {
    const nextState = snapshot.currentState || this.state;
    const nextTarget = snapshot.targetLocation || this.targetLocation;
    const stateChanged = nextState !== this.state;
    let targetChanged = nextTarget !== this.targetLocation;

    // First snapshot after boot: the backend remembers where the AI was, so
    // start it there instead of flying across the room on every launch.
    if (!this.started) {
      this.started = true;
      const saved = snapshot.currentLocation;
      if (saved && PLACES[saved]) {
        this.location = saved;
        const place = PLACES[saved];
        this.flight.place(place.position[0], place.position[1], place.position[2]);
        this.flight.face(place.face, true);
        this.flight.hoverAmplitude = place.hover;
        targetChanged = false;
      }
    }

    this.previousState = this.state;
    this.state = nextState;
    this.targetLocation = nextTarget;
    this.entity.setState(nextState);

    if (stateChanged) this._enterState(nextState);
    if (targetChanged && !this.sequence) this._travelTo(nextTarget);
    return stateChanged;
  }

  _enterState(state) {
    switch (state) {
      case 'SLEEPING':
        this._sleepSequence();
        break;
      case 'RESTING':
        this.sequence = null;
        this._travelTo('BED');
        this.flight.hoverAmplitude = 0.012;
        break;
      case 'WAKING':
        this._wakeSequence();
        this.entity.playEmote('stretch');
        break;
      case 'THINKING':
      case 'WORKING':
        this.sequence = null;
        this._travelTo('DESK');
        this.flight.hoverAmplitude = 0.012;
        break;
      case 'LISTENING':
        this.sequence = null;
        this._travelTo('CENTER');
        this.flight.hoverAmplitude = 0.03;
        this.entity.playEmote('nod');
        break;
      case 'SPEAKING':
        this.sequence = null;
        if (this.location !== 'CENTER' && this.targetLocation === 'CENTER') this._travelTo('CENTER');
        this.flight.hoverAmplitude = 0.026;
        this.entity.playEmote('bounce');
        break;
      case 'IDLE':
        this.sequence = null;
        this._travelTo(this.targetLocation);
        this.flight.hoverAmplitude = 0.024;
        if (Math.random() < 0.4) {
          this.entity.playEmote(['wiggle', 'bounce', 'look'][Math.floor(Math.random() * 3)]);
        }
        break;
      default:
        this.sequence = null;
        this._travelTo(this.targetLocation);
        this.flight.hoverAmplitude = 0.024;
    }
  }

  /* -------------------------------------------------------- choreography -- */

  _sleepSequence() {
    this.flight.hoverAmplitude = 0.01;
    this.sequence = {
      steps: [
        { to: BED_APPROACH.position, duration: 1.8, face: BED_APPROACH.face, arc: 0.2 },
        {
          to: SLEEP_SPOT.position,
          duration: 3.0,
          face: SLEEP_SPOT.face,
          arc: 0.02,
          slow: true,
          arrive: () => {
            this.location = 'BED';
            this.flight.hoverAmplitude = 0.004;
            this.onArrival('BED');
          },
        },
      ],
      index: 0,
    };
    this._runStep();
  }

  _wakeSequence() {
    const rose = v3(
      SLEEP_SPOT.position[0],
      SLEEP_SPOT.position[1] + 0.42,
      SLEEP_SPOT.position[2] + 0.12
    );
    this.flight.hoverAmplitude = 0.02;
    this.sequence = {
      steps: [
        { to: rose, duration: 1.7, face: [-0.2, -0.05, 1], arc: 0.05 },
        { to: BED_APPROACH.position, duration: 1.5, face: PLACES.BED.face, arc: 0.16 },
      ],
      index: 0,
    };
    this._runStep();
  }

  _runStep() {
    const seq = this.sequence;
    if (!seq || seq.index >= seq.steps.length) {
      this.sequence = null;
      return;
    }
    const step = seq.steps[seq.index];
    this.flight.flyTo(step.to, {
      duration: step.duration,
      arc: step.arc,
      face: step.face,
      wobble: step.slow ? 0.002 : undefined,
      onArrive: () => {
        step.arrive?.();
        seq.index++;
        this._runStep();
      },
    });
  }

  _travelTo(name) {
    const place = PLACES[name] || PLACES.CENTER;
    this.flight.hoverAmplitude = place.hover;
    this.flight.flyTo(place.position, {
      face: place.face,
      onArrive: () => {
        this.location = name;
        this.onArrival(name);
      },
    });
  }

  /* --------------------------------------------------------------- update - */

  update(dt, cameraPosition, screenPosition) {
    const entity = this.entity;
    const state = this.state;

    // Where the eyes go.
    this.gazeTimer -= dt;
    if (this.gazeTimer <= 0) {
      this.gazeTimer = 2.4 + Math.random() * 4.5;
      switch (state) {
        case 'WORKING':
        case 'THINKING':
          this.gazeTarget = [-0.35 + Math.random() * 0.7, 0.1 + Math.random() * 0.25];
          break;
        case 'BORED':
          this.gazeTarget = [Math.random() * 2 - 1, -0.4 - Math.random() * 0.3];
          break;
        case 'SLEEPING':
        case 'RESTING':
          this.gazeTarget = [0, -0.2];
          break;
        default:
          this.gazeTarget = [Math.random() * 1.2 - 0.6, Math.random() * 0.8 - 0.4];
      }
    }

    if ((state === 'LISTENING' || state === 'SPEAKING') && cameraPosition) {
      // Look at whoever it is talking to.
      const toCamera = v3normalize(v3(), [
        cameraPosition[0] - this.flight.position[0],
        0,
        cameraPosition[2] - this.flight.position[2],
      ]);
      const fwd = this.flight.forward;
      const side = fwd[2] * toCamera[0] - fwd[0] * toCamera[2];
      this.gazeTarget = [clamp(side * 1.6, -0.7, 0.7), -0.05];
    }

    entity.setGaze(this.gazeTarget[0], this.gazeTarget[1]);

    // Speech rhythm - a plausible envelope without any audio engine.
    if (state === 'SPEAKING') {
      this.speakingPhase += dt * 7.5;
      const syllable = Math.abs(Math.sin(this.speakingPhase)) * 0.6
        + Math.abs(Math.sin(this.speakingPhase * 0.37 + 1.1)) * 0.4;
      this.speakingLevel = lerp(this.speakingLevel, 0.35 + syllable * 0.65, clamp(dt * 12, 0, 1));
      this.listeningPulse = lerp(this.listeningPulse, 0, dt * 4);
    } else if (state === 'LISTENING') {
      this.listeningPulse += dt * 2.2;
      const level = 0.25 + Math.abs(Math.sin(this.listeningPulse)) * 0.35;
      this.speakingLevel = lerp(this.speakingLevel, level * 0.35, dt * 5);
    } else {
      this.speakingLevel = lerp(this.speakingLevel, 0, dt * 3);
      this.listeningPulse = 0;
    }
    entity.setSpeakingLevel(this.speakingLevel);

    // Little gestures while idle or focused, so it never feels frozen.
    if (!this.flight.moving) {
      if (state === 'IDLE' || state === 'BORED') {
        this.idleEmoteTimer -= dt;
        if (this.idleEmoteTimer <= 0) {
          this.idleEmoteTimer = 7 + Math.random() * 9;
          const pool = ['spin', 'stretch', 'wiggle', 'look', 'bounce', 'look'];
          entity.playEmote(pool[Math.floor(Math.random() * pool.length)]);
        }
      } else if (state === 'WORKING' || state === 'THINKING') {
        this.workEmoteTimer -= dt;
        if (this.workEmoteTimer <= 0) {
          this.workEmoteTimer = 4 + Math.random() * 5;
          entity.playEmote(Math.random() < 0.6 ? 'look' : 'nod');
        }
      }
    }

    // Face the monitor while working.
    if ((state === 'WORKING' || state === 'THINKING') && screenPosition && !this.flight.moving) {
      this.flight.face([
        screenPosition[0] - this.flight.position[0],
        (screenPosition[1] - this.flight.position[1]) * 0.35,
        screenPosition[2] - this.flight.position[2],
      ]);
    }

    this.flight.update(dt, null);
    v3copy(entity.position, this.flight.position);
    v3copy(entity.forward, this.flight.forward);
    v3copy(entity.up, this.flight.up);
    v3copy(entity.velocity, this.flight.velocity);
    entity.update(dt, cameraPosition);

    return {
      location: this.location,
      moving: this.flight.moving,
      distanceToTarget: v3dist(
        this.flight.position,
        (PLACES[this.targetLocation] || PLACES.CENTER).position
      ),
    };
  }
}
