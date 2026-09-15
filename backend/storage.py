"""Tiny atomic JSON file store.

Everything the companion remembers lives in plain JSON files inside ``data/``
next to the application. No database, no cloud, no third party packages.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from typing import Any, Dict, Optional


class JsonStore:
    """Read/write a single JSON document with atomic, crash safe saves."""

    def __init__(self, path: str, defaults: Optional[Dict[str, Any]] = None) -> None:
        self.path = path
        self._defaults: Dict[str, Any] = dict(defaults or {})
        self._lock = threading.RLock()
        self._data: Dict[str, Any] = {}
        self._dirty = False
        self.load()

    # ------------------------------------------------------------------ load
    @property
    def directory(self) -> str:
        return os.path.dirname(os.path.abspath(self.path))

    def load(self) -> Dict[str, Any]:
        with self._lock:
            data = dict(self._defaults)
            try:
                with open(self.path, "r", encoding="utf-8") as handle:
                    loaded = json.load(handle)
                if isinstance(loaded, dict):
                    data.update(loaded)
            except FileNotFoundError:
                pass
            except (OSError, ValueError):
                # Corrupt or partially written file: keep the defaults rather
                # than crashing the whole application on boot.
                try:
                    os.replace(self.path, self.path + ".corrupt")
                except OSError:
                    pass
            self._data = data
            return dict(self._data)

    # ------------------------------------------------------------------ read
    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._data.get(key, default)

    def all(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._data)

    # ----------------------------------------------------------------- write
    def update(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._data.update(patch)
            self._dirty = True
            return dict(self._data)

    def set(self, key: str, value: Any) -> None:
        self.update({key: value})

    def save(self) -> bool:
        """Write the document atomically (temp file + os.replace)."""
        with self._lock:
            if not self._dirty:
                return False
            payload = dict(self._data)
            self._dirty = False

        directory = self.directory
        try:
            os.makedirs(directory, exist_ok=True)
            handle, tmp_path = tempfile.mkstemp(
                prefix=".tmp-", suffix=".json", dir=directory
            )
            try:
                with os.fdopen(handle, "w", encoding="utf-8") as stream:
                    json.dump(payload, stream, indent=2, sort_keys=True)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(tmp_path, self.path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
            return True
        except OSError:
            # A read-only disk must never take the companion down.
            self._dirty = True
            return False


class PeriodicFlusher(threading.Thread):
    """Background thread that periodically flushes dirty stores to disk."""

    def __init__(self, stores, interval: float = 3.0) -> None:
        super().__init__(name="nex3d-flusher", daemon=True)
        self._stores = list(stores)
        self._interval = interval
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:  # pragma: no cover - trivial loop
        while not self._stop.wait(self._interval):
            self.flush()

    def flush(self) -> None:
        for store in self._stores:
            try:
                store.save()
            except Exception:
                pass


def now() -> float:
    """Monotonic-ish wall clock in seconds (float)."""
    return time.time()
