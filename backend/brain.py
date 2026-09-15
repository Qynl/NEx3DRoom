"""The companion's "brain" - deliberately a placeholder.

This module is the single integration point for a local language model.
Nothing here talks to the network today; ``PlaceholderBrain`` just produces a
deterministic timeline so the state machine can run its full
``THINKING -> WORKING -> SPEAKING -> IDLE`` loop and the room feels alive.

Swapping in Ollama later means adding an ``OllamaBrain`` implementation of the
same three methods (``begin_turn`` / ``poll`` / ``cancel``) and passing it to
:class:`backend.state.CompanionState`. The rest of the application - HTTP API,
voice events, 3D behaviour - does not change.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Turn model
# ---------------------------------------------------------------------------

PHASE_THINKING = "thinking"
PHASE_WORKING = "working"
PHASE_SPEAKING = "speaking"
PHASE_DONE = "done"


@dataclass
class Turn:
    """One conversational turn owned by a brain."""

    turn_id: str
    phase: str = PHASE_THINKING
    started_at: float = field(default_factory=time.time)
    phase_started_at: float = field(default_factory=time.time)
    phase_budget: float = 0.0
    transcript: List[Dict[str, Any]] = field(default_factory=list)
    meta: Dict[str, Any] = field(default_factory=dict)

    def enter(self, phase: str, budget: float) -> None:
        self.phase = phase
        self.phase_budget = budget
        self.phase_started_at = time.time()

    def elapsed_in_phase(self) -> float:
        return time.time() - self.phase_started_at

    def is_finished(self) -> bool:
        return self.phase == PHASE_DONE


class Brain:
    """Interface every brain implementation satisfies."""

    name = "base"
    provider = "none"
    available = False

    def describe(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "provider": self.provider,
            "available": self.available,
            "note": "",
        }

    def begin_turn(self, context: Dict[str, Any]) -> Turn:  # pragma: no cover
        raise NotImplementedError

    def poll(self, turn: Turn) -> Turn:  # pragma: no cover
        raise NotImplementedError

    def cancel(self, turn: Turn) -> None:  # pragma: no cover
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Placeholder implementation (what actually ships)
# ---------------------------------------------------------------------------


class PlaceholderBrain(Brain):
    """Offline stand-in that mimics the *shape* of a real model turn.

    Timings are intentionally short so the behaviour loop is observable while
    developing, and can be stretched from ``config.json`` without code changes.
    """

    name = "local-placeholder"
    provider = "none"
    available = True

    def __init__(self, timings: Optional[Dict[str, float]] = None) -> None:
        self.timings: Dict[str, float] = {
            "thinking_min": 1.6,
            "thinking_max": 3.4,
            "working_min": 6.0,
            "working_max": 12.0,
            "speaking_min": 3.0,
            "speaking_max": 5.5,
        }
        if timings:
            self.timings.update(
                {k: float(v) for k, v in timings.items() if k in self.timings}
            )
        self._counter = 0

    def describe(self) -> Dict[str, Any]:
        info = super().describe()
        info["note"] = (
            "No language model is connected. Set brain.provider = 'ollama' in "
            "data/config.json once a local model is available."
        )
        return info

    # -- helpers ----------------------------------------------------------
    def _budget(self, key: str) -> float:
        lo = self.timings[f"{key}_min"]
        hi = self.timings[f"{key}_max"]
        return random.uniform(lo, hi)

    # -- Brain API --------------------------------------------------------
    def begin_turn(self, context: Dict[str, Any]) -> Turn:
        self._counter += 1
        turn = Turn(turn_id=f"t{self._counter}-{int(time.time())}")
        turn.meta["context"] = {
            "trigger": context.get("trigger", "voice"),
            "location": context.get("location", "CENTER"),
            "energy": context.get("energy", 100.0),
        }
        turn.enter(PHASE_THINKING, self._budget("thinking"))
        return turn

    def poll(self, turn: Turn) -> Turn:
        if turn.is_finished():
            return turn
        if turn.elapsed_in_phase() < turn.phase_budget:
            return turn
        if turn.phase == PHASE_THINKING:
            turn.enter(PHASE_WORKING, self._budget("working"))
        elif turn.phase == PHASE_WORKING:
            turn.enter(PHASE_SPEAKING, self._budget("speaking"))
        elif turn.phase == PHASE_SPEAKING:
            turn.enter(PHASE_DONE, 0.0)
        return turn

    def cancel(self, turn: Turn) -> None:
        turn.enter(PHASE_DONE, 0.0)


class OllamaBrain(Brain):
    """Reserved slot for a local Ollama model. NOT IMPLEMENTED ON PURPOSE.

    Intended shape once implemented::

        POST http://127.0.0.1:11434/api/chat
        {"model": "llama3.2", "messages": [...], "stream": true}

    Everything would go through ``urllib.request`` from the standard library,
    streamed into ``turn.transcript`` while ``poll()`` advances the phase.
    """

    name = "ollama"
    provider = "ollama"
    available = False

    def __init__(self, model: str = "llama3.2", host: str = "http://127.0.0.1:11434"):
        self.model = model
        self.host = host.rstrip("/")

    def describe(self) -> Dict[str, Any]:
        info = super().describe()
        info["note"] = "Configured but not implemented yet - placeholder is used."
        info["model"] = self.model
        info["host"] = self.host
        return info

    def begin_turn(self, context: Dict[str, Any]) -> Turn:
        raise NotImplementedError(
            "Ollama integration is intentionally not implemented in this build."
        )

    def poll(self, turn: Turn) -> Turn:
        raise NotImplementedError

    def cancel(self, turn: Turn) -> None:
        turn.enter(PHASE_DONE, 0.0)


def build_brain(settings: Optional[Dict[str, Any]] = None) -> Brain:
    """Factory driven by ``data/config.json``.

    ``{"brain": {"provider": "ollama", "model": "llama3.2"}}`` will be honoured
    the moment an OllamaBrain exists; until then the placeholder always wins so
    the app never breaks on a missing model.
    """
    settings = settings or {}
    provider = str(settings.get("provider", "placeholder")).lower()
    if provider == "ollama":
        try:
            return OllamaBrain(
                model=str(settings.get("model", "llama3.2")),
                host=str(settings.get("host", "http://127.0.0.1:11434")),
            )
        except Exception:
            pass
    return PlaceholderBrain(settings.get("timings"))
