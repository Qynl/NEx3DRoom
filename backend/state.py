"""The companion's mind: persistent state, timers, and the behaviour routine.

Everything the 3D room needs to know about the AI is computed here, on the
Python side, so the behaviour survives a reload of the renderer and stays
coherent over time. Standard library only.

Public surface used by ``backend/server.py``:

* :meth:`CompanionState.snapshot`  -> full state document (GET /api/state)
* :meth:`CompanionState.apply_patch`-> partial update (POST /api/state)
* :meth:`CompanionState.handle_voice_event` (POST /api/voice-event)
* :meth:`CompanionState.subscribe`  -> queue of change events (GET /api/events)
* :meth:`CompanionState.tick`       -> called ~10x per second by the server
"""

from __future__ import annotations

import json
import os
import random
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from .brain import (
    PHASE_SPEAKING,
    PHASE_THINKING,
    PHASE_WORKING,
    Brain,
    PlaceholderBrain,
    Turn,
)
from .storage import JsonStore

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

STATES: Tuple[str, ...] = (
    "IDLE",
    "BORED",
    "THINKING",
    "WORKING",
    "RESTING",
    "SLEEPING",
    "WAKING",
    "LISTENING",
    "SPEAKING",
)

LOCATIONS: Tuple[str, ...] = ("CENTER", "DESK", "BED", "WINDOW", "SOFA")

TIME_OF_DAY: Tuple[str, ...] = ("DAY", "SUNSET", "NIGHT")

#: The five voice events specified for the voice-first architecture.
VOICE_EVENTS: Tuple[str, ...] = (
    "user_started_speaking",
    "user_finished_speaking",
    "ai_started_thinking",
    "ai_started_speaking",
    "ai_finished_speaking",
)

#: Optional extras that make development and future hardware easier. They are
#: additive - a client that only ever sends the five events above still gets a
#: fully working companion.
EXTRA_EVENTS: Tuple[str, ...] = (
    "user_interaction",   # any deliberate user input (mouse, key, proximity)
    "task_assigned",      # jump straight into WORKING
    "teleport_hint",      # dev only: re-seat the companion instantly
    "system_reset",       # dev only: back to a fresh IDLE
)

ALL_EVENTS: Tuple[str, ...] = VOICE_EVENTS + EXTRA_EVENTS

#: The chores the companion knows how to perform. Each one maps to a
#: hand-choreographed routine in the renderer (see frontend/js/ai/tasks.js).
TASKS: Tuple[str, ...] = (
    "search",        # to the PC, search animation on screen, lean in, return
    "reading",       # grab a book from the shelf, sit and read it
    "writing",       # write in the desk notebook, lines appearing
    "calculating",   # tap the desk calculator, digits appearing
    "thinking",      # pace, pause at the window, look out, sudden turn
    "music",         # lounge on the sofa and sway to a beat
    "planning",      # pin notes onto the wall board
    "weather",       # check the sky at the window
    "filing",        # open the cabinet and rifle through it
    "casual",        # stay put and answer where it is
    "long",          # work at the desk, get up to think, come back, re-type
)

#: Where each state wants to be physically.
STATE_LOCATION: Dict[str, str] = {
    "IDLE": "CENTER",
    "BORED": "WINDOW",
    "THINKING": "DESK",
    "WORKING": "DESK",
    "RESTING": "BED",
    "SLEEPING": "BED",
    "WAKING": "BED",
    "LISTENING": "CENTER",
    "SPEAKING": "CENTER",
}

#: Rough energy drain per second for each awake state.
ENERGY_DRAIN: Dict[str, float] = {
    "IDLE": 0.30,
    "BORED": 0.45,
    "THINKING": 0.80,
    "WORKING": 0.95,
    "LISTENING": 0.55,
    "SPEAKING": 0.65,
    "WAKING": 0.40,
}

#: Recovery per second while resting.
ENERGY_RECOVERY = {"RESTING": 2.6, "SLEEPING": 5.2}

#: Seconds a companion lingers in a state before the routine pushes it onward.
BORED_AFTER_IDLE = 90.0
RESTING_AFTER_BORED = 150.0
SLEEPING_AFTER_RESTING = 120.0
WAKING_DURATION = 3.5
ARRIVAL_TIMEOUT = 30.0

MOOD_LABELS = (
    (0.80, "radiant"),
    (0.62, "content"),
    (0.45, "calm"),
    (0.30, "quiet"),
    (0.15, "tired"),
    (0.00, "sleepy"),
)


def mood_label(mood: float) -> str:
    for threshold, label in MOOD_LABELS:
        if mood >= threshold:
            return label
    return "sleepy"


# ---------------------------------------------------------------------------
# Change notifications (Server-Sent Events)
# ---------------------------------------------------------------------------


class EventBus:
    """Fan-out of small JSON messages to every connected listener."""

    def __init__(self, maxsize: int = 64) -> None:
        self._queues: List["threading.Queue"] = []  # type: ignore[name-defined]
        self._lock = threading.Lock()
        self._maxsize = maxsize

    def subscribe(self):
        import queue

        channel: "queue.Queue" = queue.Queue(maxsize=self._maxsize)
        with self._lock:
            self._queues.append(channel)
        return channel

    def unsubscribe(self, channel) -> None:
        with self._lock:
            if channel in self._queues:
                self._queues.remove(channel)

    def publish(self, event: str, data: Dict[str, Any]) -> None:
        message = (event, data)
        with self._lock:
            targets = list(self._queues)
        for channel in targets:
            try:
                channel.put_nowait(message)
            except Exception:
                # A slow client must never block the simulation.
                pass

    @property
    def listener_count(self) -> int:
        with self._lock:
            return len(self._queues)


# ---------------------------------------------------------------------------
# The companion
# ---------------------------------------------------------------------------


class CompanionState:
    """Authoritative model of the AI living in the room."""

    def __init__(
        self,
        store: Optional[JsonStore] = None,
        brain: Optional[Brain] = None,
        bus: Optional[EventBus] = None,
    ) -> None:
        self.store = store or JsonStore(
            os.path.join("data", "state.json"),
            defaults={"energy": 88.0, "mood": 0.7},
        )
        self.bus = bus or EventBus()
        self.brain = brain or PlaceholderBrain()
        self._lock = threading.RLock()
        self._turn: Optional[Turn] = None
        self._wake_reason: Optional[str] = None
        self._pending_after_wake: Optional[str] = None
        self._next_wander_at = 0.0
        self._last_saved_at = 0.0
        self._travel_started_at = 0.0
        self.telemetry: Dict[str, Any] = {}
        self._dirty = False
        self.started_at = time.time()
        self._restore()

    # ------------------------------------------------------------------ boot
    def _restore(self) -> None:
        data = self.store.all()

        state = str(data.get("currentState", "IDLE")).upper()
        if state not in STATES:
            state = "IDLE"
        location = str(data.get("currentLocation", "CENTER")).upper()
        if location not in LOCATIONS:
            location = "CENTER"
        tod = str(data.get("timeOfDay", "DAY")).upper()
        if tod not in TIME_OF_DAY:
            tod = "DAY"

        energy = _clamp(float(data.get("energy", 88.0)), 0.0, 100.0)
        mood = _clamp(float(data.get("mood", 0.7)), 0.0, 1.0)

        # Offline bookkeeping: time passed while the app was closed still
        # counts, gently.
        saved_at = float(data.get("savedAt", 0.0) or 0.0)
        elapsed = max(0.0, time.time() - saved_at) if saved_at else 0.0
        if elapsed:
            if state in ("SLEEPING", "RESTING"):
                energy = _clamp(energy + min(elapsed * 0.5, 45.0), 0, 100)
            else:
                energy = _clamp(energy - min(elapsed * 0.12, 30.0), 0, 100)

        # It was asleep when you left - it wakes up when you come back.
        woke_up = False
        if state in ("SLEEPING", "RESTING"):
            state = "WAKING"
            woke_up = True

        self.state = state
        self.energy = energy
        self.mood = mood
        self.location = location
        self.target_location = STATE_LOCATION.get(state, location)
        self.time_of_day = tod
        saved_task = str(data.get("task", "") or "").lower()
        self.task = saved_task if saved_task in TASKS else None
        self.last_interaction = float(data.get("lastInteraction", 0.0) or 0.0)
        self.state_entered_at = time.time()
        self.interactions = int(data.get("interactions", 0) or 0)
        self.sleep_cycles = int(data.get("sleepCycles", 0) or 0)
        self.turns_completed = int(data.get("turnsCompleted", 0) or 0)
        self.wake_count = int(data.get("wakeCount", 0) or 0)
        self.boot_count = int(data.get("bootCount", 0) or 0) + 1
        self.woke_up_on_boot = woke_up
        self._was_sleeping = state == "SLEEPING"
        self._next_wander_at = time.time() + random.uniform(20.0, 45.0)
        self._dirty = True

    # ------------------------------------------------------------- snapshots
    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            now = time.time()
            listening = self.state == "LISTENING"
            speaking = self.state == "SPEAKING"
            thinking = self.state in ("THINKING", "WORKING")
            brain_info = self.brain.describe()
            turn_info = None
            if self._turn is not None:
                turn_info = {
                    "id": self._turn.turn_id,
                    "phase": self._turn.phase,
                    "elapsed": round(time.time() - self._turn.started_at, 2),
                }
            return {
                # ---- the documented core -------------------------------
                "currentState": self.state,
                "energy": round(self.energy, 2),
                "mood": round(self.mood, 3),
                "currentLocation": self.location,
                "targetLocation": self.target_location,
                "lastInteraction": round(self.last_interaction, 3),
                "isListening": listening,
                "isSpeaking": speaking,
                "isThinking": thinking,
                # ---- supporting detail ---------------------------------
                "moodLabel": mood_label(self.mood),
                "stateSince": round(self.state_entered_at, 3),
                "stateSeconds": round(now - self.state_entered_at, 2),
                "timeOfDay": self.time_of_day,
                "secondsSinceInteraction": round(now - self.last_interaction, 2)
                if self.last_interaction
                else None,
                "activity": self._activity_label(),
                "task": self.task,
                "turn": turn_info,
                "model": {
                    "name": brain_info.get("name"),
                    "provider": brain_info.get("provider"),
                    "connected": bool(brain_info.get("available"))
                    and brain_info.get("provider") != "none",
                    "note": brain_info.get("note", ""),
                },
                "counters": {
                    "interactions": self.interactions,
                    "sleepCycles": self.sleep_cycles,
                    "turnsCompleted": self.turns_completed,
                    "wakeCount": self.wake_count,
                    "bootCount": self.boot_count,
                },
                "listeners": self.bus.listener_count,
                "uptime": round(now - self.started_at, 2),
                "serverTime": round(now, 3),
                "states": list(STATES),
                "locations": list(LOCATIONS),
                "voiceEvents": list(VOICE_EVENTS),
            }

    def _activity_label(self) -> str:
        return {
            "IDLE": "floating quietly",
            "BORED": "looking around restlessly",
            "THINKING": "considering something",
            "WORKING": "focused on a task",
            "RESTING": "resting near the bed",
            "SLEEPING": "asleep",
            "WAKING": "waking up",
            "LISTENING": "listening to you",
            "SPEAKING": "speaking",
        }.get(self.state, "idle")

    # ------------------------------------------------------------- mutations
    def _set_state(self, new_state: str, reason: str = "") -> bool:
        new_state = new_state.upper()
        if new_state not in STATES:
            return False
        if new_state == self.state:
            return False
        previous = self.state
        self.state = new_state
        self.state_entered_at = time.time()

        if previous == "SLEEPING" and new_state != "SLEEPING":
            self.wake_count += 1
        if previous != "SLEEPING" and new_state == "SLEEPING":
            self.sleep_cycles += 1
            self._was_sleeping = True

        # Cancel an in-flight turn when we leave the conversational path.
        if new_state not in ("THINKING", "WORKING", "SPEAKING") and self._turn:
            self.brain.cancel(self._turn)
            self._turn = None

        self.target_location = STATE_LOCATION.get(new_state, self.target_location)
        self._dirty = True
        self.bus.publish(
            "state",
            {
                "from": previous,
                "to": new_state,
                "reason": reason,
                "targetLocation": self.target_location,
                "at": self.state_entered_at,
            },
        )
        self._emit()
        return True

    def _emit(self) -> None:
        """Push the whole document to listeners (small, and only on change)."""
        self.bus.publish("snapshot", self.snapshot())

    def _touch(self) -> None:
        self.last_interaction = time.time()
        self.interactions += 1
        self._dirty = True

    # ------------------------------------------------------------- HTTP: POST
    def apply_patch(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        """Apply a partial update coming from the renderer."""
        if not isinstance(patch, dict):
            raise ValueError("patch must be an object")

        with self._lock:
            # Renderer telemetry (arrival reports, fps, ...).
            arrived_at = patch.get("arrivedAt") or patch.get("location")
            if isinstance(arrived_at, str) and arrived_at.upper() in LOCATIONS:
                self._report_arrival(arrived_at.upper())

            if "fps" in patch or "frameMs" in patch or "drawCalls" in patch:
                self.telemetry = {
                    "fps": patch.get("fps"),
                    "frameMs": patch.get("frameMs"),
                    "drawCalls": patch.get("drawCalls"),
                    "triangles": patch.get("triangles"),
                    "reportedAt": time.time(),
                }
                self._dirty = True

            if isinstance(patch.get("timeOfDay"), str):
                tod = patch["timeOfDay"].upper()
                if tod in TIME_OF_DAY and tod != self.time_of_day:
                    self.time_of_day = tod
                    self._dirty = True
                    self.bus.publish("timeOfDay", {"timeOfDay": tod})

            if isinstance(patch.get("currentState"), str):
                self._set_state(patch["currentState"], reason="patch")

            requested_task = patch.get("task")
            if requested_task is None or requested_task == "":
                if "task" in patch:
                    self.task = None
                    self._dirty = True
            elif isinstance(requested_task, str) and requested_task.lower() in TASKS:
                self.task = requested_task.lower()
                self._dirty = True

            if isinstance(patch.get("targetLocation"), str):
                loc = patch["targetLocation"].upper()
                if loc in LOCATIONS:
                    self.target_location = loc
                    self._dirty = True

            if patch.get("interaction"):
                self._touch()

            if isinstance(patch.get("energy"), (int, float)):
                self.energy = _clamp(float(patch["energy"]), 0, 100)
                self._dirty = True

            if isinstance(patch.get("mood"), (int, float)):
                self.mood = _clamp(float(patch["mood"]), 0, 1)
                self._dirty = True

            return self.snapshot()

    def _report_arrival(self, location: str) -> None:
        if location == self.location:
            return
        self.location = location
        self._dirty = True
        self.bus.publish("location", {"location": location})

    # ------------------------------------------------------- HTTP: voice event
    def handle_voice_event(
        self, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Handle one of the documented voice events.

        ``{"event": "user_started_speaking"}`` and friends. Unknown events raise
        ``ValueError`` so the API can answer with a helpful 400.
        """
        if not isinstance(payload, dict):
            raise ValueError("body must be a JSON object")
        event = str(payload.get("event", "")).strip()
        if not event:
            raise ValueError("missing 'event' field")
        if event not in ALL_EVENTS:
            raise ValueError(
                "unknown event '%s' (expected one of: %s)"
                % (event, ", ".join(ALL_EVENTS))
            )

        with self._lock:
            handler = getattr(self, "_on_" + event, None)
            if handler:
                handler(payload)
            self._dirty = True
            self.bus.publish(
                "voice",
                {"event": event, "state": self.state, "at": time.time()},
            )
            self._emit()
            return self.snapshot()

    # -- individual events -------------------------------------------------
    def _on_user_started_speaking(self, payload: Dict[str, Any]) -> None:
        self._touch()
        self._wake_reason = "speech"
        if self.state in ("SLEEPING", "RESTING"):
            self._pending_after_wake = "LISTENING"
            self._set_state("WAKING", reason="user_started_speaking")
        elif self.state == "WAKING":
            self._pending_after_wake = "LISTENING"
        else:
            self._pending_after_wake = None
            self._set_state("LISTENING", reason="user_started_speaking")

    def _on_user_finished_speaking(self, payload: Dict[str, Any]) -> None:
        self._touch()
        if self.state == "WAKING":
            # Finish waking up, then start thinking.
            self._pending_after_wake = "THINKING"
            return
        if self.state in ("SLEEPING", "RESTING"):
            self._pending_after_wake = "THINKING"
            self._set_state("WAKING", reason="user_finished_speaking")
            return
        self._start_turn(trigger="voice")

    def _on_ai_started_thinking(self, payload: Dict[str, Any]) -> None:
        if self._turn is None:
            self._start_turn(trigger="api")
        else:
            self._set_state("THINKING", reason="ai_started_thinking")

    def _on_task_assigned(self, payload: Dict[str, Any]) -> None:
        self._touch()
        requested = str(payload.get("task", "") or "").lower()
        self.task = requested if requested in TASKS else random.choice(TASKS)
        self._start_turn(trigger="task")
        self._set_state("WORKING", reason="task_assigned")
        if self._turn:
            self._turn.enter(PHASE_WORKING, self._turn.phase_budget or 8.0)

    def _on_ai_started_speaking(self, payload: Dict[str, Any]) -> None:
        self._set_state("SPEAKING", reason="ai_started_speaking")

    def _on_ai_finished_speaking(self, payload: Dict[str, Any]) -> None:
        if self._turn is not None:
            self.turns_completed += 1
            self.brain.cancel(self._turn)
            self._turn = None
        self.task = None
        self._set_state("IDLE", reason="ai_finished_speaking")
        self._next_wander_at = time.time() + random.uniform(25.0, 55.0)

    def _on_user_interaction(self, payload: Dict[str, Any]) -> None:
        self._touch()
        if self.state in ("SLEEPING", "RESTING"):
            self._pending_after_wake = "IDLE"
            self._set_state("WAKING", reason="user_interaction")

    def _on_teleport_hint(self, payload: Dict[str, Any]) -> None:
        loc = str(payload.get("location", "")).upper()
        if loc in LOCATIONS:
            self.location = loc
            self.target_location = loc

    def _on_system_reset(self, payload: Dict[str, Any]) -> None:
        self.energy = 92.0
        self.mood = 0.75
        self._turn = None
        self._set_state("IDLE", reason="system_reset")
        self.location = "CENTER"
        self.target_location = "CENTER"

    # ------------------------------------------------------------- turn logic
    def _start_turn(self, trigger: str = "voice") -> None:
        if self.task is None:
            self.task = random.choice(TASKS)
        self._turn = self.brain.begin_turn(
            {
                "trigger": trigger,
                "location": self.location,
                "energy": self.energy,
                "mood": self.mood,
            }
        )
        self._set_state("THINKING", reason="turn:" + trigger)

    # ------------------------------------------------------------------- tick
    def tick(self, dt: float = 0.1) -> None:
        """Advance timers. Called by the server roughly 10x per second."""
        dt = max(0.001, min(dt, 1.0))
        now = time.time()
        changed = False

        with self._lock:
            in_state = now - self.state_entered_at

            # ---- energy & mood -------------------------------------------
            if self.state in ENERGY_RECOVERY:
                self.energy = _clamp(
                    self.energy + ENERGY_RECOVERY[self.state] * dt, 0, 100
                )
            else:
                drain = ENERGY_DRAIN.get(self.state, 0.3)
                self.energy = _clamp(self.energy - drain * dt, 0, 100)

            recent = 0.0
            if self.last_interaction:
                recent = max(0.0, 1.0 - (now - self.last_interaction) / 90.0)
            if self.state == "SLEEPING":
                target_mood = 0.35 + 0.35 * (self.energy / 100.0)
            else:
                target_mood = _clamp(
                    0.22 + 0.45 * (self.energy / 100.0) + 0.28 * recent, 0.0, 1.0
                )
            self.mood += (target_mood - self.mood) * min(1.0, dt * 0.25)

            # ---- brain phases --------------------------------------------
            if self._turn is not None and self.state in (
                "THINKING",
                "WORKING",
                "SPEAKING",
            ):
                before = self._turn.phase
                self.brain.poll(self._turn)
                phase = self._turn.phase
                if phase != before:
                    if phase == PHASE_WORKING:
                        self._set_state("WORKING", reason="brain")
                    elif phase == PHASE_SPEAKING:
                        self._set_state("SPEAKING", reason="brain")
                    elif self._turn.is_finished():
                        self.turns_completed += 1
                        self._turn = None
                        self._set_state("IDLE", reason="turn complete")
                        self._next_wander_at = now + random.uniform(30.0, 60.0)

            # ---- the resting routine --------------------------------------
            if self.state == "IDLE":
                limit = BORED_AFTER_IDLE
                if self.energy < 30.0:
                    limit *= 0.5
                if in_state > limit:
                    self._set_state("BORED", reason="inactivity")
                elif now >= self._next_wander_at and self.energy > 25.0:
                    self.target_location = _weighted_choice(
                        [("CENTER", 3), ("WINDOW", 3), ("SOFA", 2), ("DESK", 1)]
                    )
                    self._next_wander_at = now + random.uniform(45.0, 95.0)
                    self.bus.publish(
                        "wander", {"targetLocation": self.target_location}
                    )
                    self._emit()
            elif self.state == "BORED":
                limit = RESTING_AFTER_BORED
                if self.energy < 25.0:
                    limit = 20.0
                if in_state > limit:
                    self._set_state("RESTING", reason="tired")
                elif now >= self._next_wander_at:
                    self.target_location = _weighted_choice(
                        [("WINDOW", 3), ("SOFA", 3), ("CENTER", 2)]
                    )
                    self._next_wander_at = now + random.uniform(20.0, 40.0)
                    self._emit()
            elif self.state == "RESTING":
                limit = SLEEPING_AFTER_RESTING
                if self.energy >= 99.0:
                    limit = 30.0
                if in_state > limit:
                    self._set_state("SLEEPING", reason="sleep pressure")
            elif self.state == "WAKING":
                if in_state > WAKING_DURATION:
                    follow_up = self._pending_after_wake or "IDLE"
                    self._pending_after_wake = None
                    self._wake_reason = None
                    if follow_up == "THINKING":
                        self._start_turn(trigger="voice")
                    else:
                        self._set_state(follow_up, reason="woke up")
            elif self.state == "LISTENING":
                # Nobody said anything for a while -> go back to drifting.
                if in_state > 45.0:
                    self._set_state("IDLE", reason="listening timeout")
            elif self.state == "SPEAKING":
                if in_state > 90.0:  # safety net for a lost event
                    self._set_state("IDLE", reason="speaking timeout")
            elif self.state == "THINKING":
                if in_state > 60.0:  # safety net
                    self._set_state("IDLE", reason="thinking timeout")
            elif self.state == "WORKING":
                if in_state > 180.0:  # safety net
                    self._set_state("SPEAKING", reason="work timeout")

            # ---- travel watchdog ------------------------------------------
            # Arm the clock the first time we notice a trip, then give the
            # renderer ARRIVAL_TIMEOUT seconds to report that it arrived. If it
            # never does (window hidden, tab throttled, renderer crashed) we
            # complete the trip ourselves so the model cannot desync from the
            # room forever. The clock must NOT be re-armed once it has expired,
            # otherwise the timeout is pushed forward on every tick.
            if self.target_location != self.location:
                travel = self._travel_started_at
                if travel == 0.0:
                    self._travel_started_at = now
                elif now - travel > ARRIVAL_TIMEOUT:
                    self._report_arrival(self.target_location)
                    self._travel_started_at = 0.0
            else:
                self._travel_started_at = 0.0

            # ---- persistence ----------------------------------------------
            if now - self._last_saved_at > 5.0 and self._dirty:
                self.save()

    # ------------------------------------------------------------- persistence
    def save(self) -> bool:
        with self._lock:
            self.store.update(
                {
                    "currentState": self.state,
                    "energy": round(self.energy, 2),
                    "mood": round(self.mood, 3),
                    "currentLocation": self.location,
                    "targetLocation": self.target_location,
                    "timeOfDay": self.time_of_day,
                    "task": self.task,
                    "lastInteraction": round(self.last_interaction, 3),
                    "interactions": self.interactions,
                    "sleepCycles": self.sleep_cycles,
                    "turnsCompleted": self.turns_completed,
                    "wakeCount": self.wake_count,
                    "bootCount": self.boot_count,
                    "savedAt": time.time(),
                    "version": 1,
                }
            )
            self._dirty = False
            self._last_saved_at = time.time()
        return self.store.save()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _clamp(value: float, lo: float, hi: float) -> float:
    return lo if value < lo else hi if value > hi else value


def _weighted_choice(options: List[Tuple[str, int]]) -> str:
    total = sum(weight for _, weight in options)
    roll = random.uniform(0, total)
    for name, weight in options:
        roll -= weight
        if roll <= 0:
            return name
    return options[-1][0]
