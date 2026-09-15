"""Application configuration (window preferences, graphics, behaviour).

Stored in ``data/config.json``. Edited by the app itself (so window size and
time-of-day survive a restart) or by hand - it is plain JSON.
"""

from __future__ import annotations

import copy
import os
from typing import Any, Dict, Optional

from .storage import JsonStore

DEFAULTS: Dict[str, Any] = {
    "window": {
        # "windowed" | "maximized" | "fullscreen"
        "mode": "maximized",
        "width": 1440,
        "height": 900,
        "x": None,
        "y": None,
        "remember": True,
    },
    "browser": {
        # Brave is the preferred engine; "auto" accepts any Chromium browser.
        "engine": "brave",
        "dedicatedProfile": True,
        "extraArgs": [],
    },
    "server": {
        "host": "127.0.0.1",
        "port": 8737,
        "openWindow": True,
    },
    "graphics": {
        "quality": "high",
        "pixelRatioCap": 1.75,
        "shadows": True,
        "bloom": True,
        "msaa": True,
        "cameraDrift": True,
    },
    "behaviour": {
        "boredAfterIdle": 90.0,
        "restingAfterBored": 150.0,
        "sleepingAfterResting": 120.0,
        "wander": True,
    },
    "brain": {
        "provider": "placeholder",
        "model": "",
        "host": "http://127.0.0.1:11434",
        "timings": None,
    },
    "audio": {
        "enabled": False,
        "volume": 0.7,
    },
    "timeOfDay": "DAY",
    "dev": {
        "overlay": False,
        "verboseLog": False,
    },
}


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for key, value in patch.items():
        if (
            key in out
            and isinstance(out[key], dict)
            and isinstance(value, dict)
        ):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


class Config:
    """Deep-mergeable JSON configuration."""

    def __init__(self, path: Optional[str] = None) -> None:
        self.path = path or os.path.join("data", "config.json")
        self._store = JsonStore(self.path, defaults=copy.deepcopy(DEFAULTS))
        # Fill in any keys that a newer version of the app expects.
        merged = _deep_merge(copy.deepcopy(DEFAULTS), self._store.all())
        if merged != self._store.all():
            self._store.update(merged)

    def all(self) -> Dict[str, Any]:
        return self._store.all()

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self._store.all()
        for part in dotted.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def patch(self, values: Dict[str, Any]) -> Dict[str, Any]:
        merged = _deep_merge(self._store.all(), values or {})
        self._store.update(merged)
        self._store.save()
        return merged

    def set(self, dotted: str, value: Any) -> Dict[str, Any]:
        root: Dict[str, Any] = {}
        node = root
        parts = dotted.split(".")
        for part in parts[:-1]:
            node[part] = {}
            node = node[part]
        node[parts[-1]] = value
        return self.patch(root)

    def save(self) -> bool:
        return self._store.save()
