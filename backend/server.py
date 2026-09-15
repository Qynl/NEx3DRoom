"""HTTP backend for NEx3D Room.

A tiny, dependency free server (``http.server`` from the standard library) that:

  * serves the local frontend from ``frontend/``
  * exposes the companion state and voice-event API
  * streams state changes over Server-Sent Events
  * remembers window preferences and shuts down when the app window closes

Endpoints
---------
    GET  /                      -> frontend/index.html
    GET  /api/health            -> liveness probe
    GET  /api/meta              -> version, platform, endpoints
    GET  /api/state             -> full companion state document
    POST /api/state             -> partial update (renderer telemetry / overrides)
    POST /api/voice-event       -> {"event": "user_started_speaking"} ...
    GET  /api/events            -> text/event-stream (state, location, voice, ...)
    GET  /api/config            -> configuration document
    POST /api/config            -> deep patch of the configuration
    POST /api/window-state      -> remember window size / mode
    POST /api/window-closed     -> the window went away, shut the app down
    POST /api/shutdown          -> explicit graceful shutdown
"""

from __future__ import annotations

import json
import mimetypes
import os
import posixpath
import socket
import sys
import threading
import time
import traceback
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

# Allow "python backend/server.py" as well as "python -m backend.server".
if __package__ in (None, ""):  # pragma: no cover
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from backend import __version__  # type: ignore
    from backend.brain import build_brain  # type: ignore
    from backend.config import Config  # type: ignore
    from backend.state import ALL_EVENTS, CompanionState, EventBus  # type: ignore
    from backend.storage import JsonStore, PeriodicFlusher  # type: ignore
else:
    from . import __version__
    from .brain import build_brain
    from .config import Config
    from .state import ALL_EVENTS, CompanionState, EventBus
    from .storage import JsonStore, PeriodicFlusher

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")
DATA_DIR = os.path.join(PROJECT_ROOT, "data")

TICK_HZ = 10.0
SHUTDOWN_GRACE_SECONDS = 3.0

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/wasm", ".wasm")


@dataclass
class AppContext:
    """Everything request handlers need, created once at start-up."""

    state: CompanionState
    config: Config
    bus: EventBus
    frontend_dir: str = FRONTEND_DIR
    data_dir: str = DATA_DIR
    verbose: bool = False
    exit_on_window_close: bool = True
    origin_allowed: Optional[str] = None
    shutdown_requested: threading.Event = None  # type: ignore[assignment]
    _shutdown_timer: Optional[threading.Timer] = None


def create_context(
    data_dir: str = DATA_DIR,
    verbose: bool = False,
    exit_on_window_close: bool = True,
) -> AppContext:
    os.makedirs(data_dir, exist_ok=True)
    config = Config(os.path.join(data_dir, "config.json"))
    store = JsonStore(
        os.path.join(data_dir, "state.json"),
        defaults={"energy": 88.0, "mood": 0.7},
    )
    bus = EventBus()
    brain = build_brain(config.get("brain") or {})
    state = CompanionState(store=store, brain=brain, bus=bus)
    return AppContext(
        state=state,
        config=config,
        bus=bus,
        data_dir=data_dir,
        verbose=verbose,
        exit_on_window_close=exit_on_window_close,
        shutdown_requested=threading.Event(),
    )


class RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "NEx3DRoom/" + __version__
    sys_version = ""
    timeout = 45

    # ------------------------------------------------------------- plumbing
    @property
    def ctx(self) -> AppContext:
        return self.server.ctx  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        if self.ctx.verbose:
            sys.stderr.write(
                "%s - %s\n" % (self.address_string(), fmt % args)
            )

    # ------------------------------------------------------------- responses
    def _send_bytes(
        self,
        payload: bytes,
        status: int = 200,
        content_type: str = "application/octet-stream",
        extra_headers: Optional[Dict[str, str]] = None,
        cache: str = "no-cache",
    ) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            if extra_headers:
                for key, value in extra_headers.items():
                    self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_json(self, obj: Any, status: int = 200) -> None:
        payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        self._send_bytes(payload, status, "application/json; charset=utf-8")

    def _send_error_json(self, status: int, message: str, **extra: Any) -> None:
        body = {"ok": False, "error": message}
        body.update(extra)
        self._send_json(body, status)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 1_000_000:
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    # -------------------------------------------------------------- routing
    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        self._route("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _route(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"
        started = time.perf_counter()
        try:
            if path.startswith("/api/"):
                self._route_api(method, path, parsed)
            elif method == "GET":
                self._route_static(path)
            else:
                self._send_error_json(405, "method not allowed")
        except Exception as exc:  # pragma: no cover - defensive
            self.ctx.state.bus.publish(
                "error", {"message": str(exc), "path": path}
            )
            if self.ctx.verbose:
                traceback.print_exc()
            try:
                self._send_error_json(500, "internal error: %s" % exc)
            except Exception:
                self.close_connection = True
        finally:
            if self.ctx.verbose:
                sys.stderr.write(
                    "[http] %s %s (%.1f ms)\n"
                    % (method, path, (time.perf_counter() - started) * 1000)
                )

    # ------------------------------------------------------------------ api
    def _route_api(self, method: str, path: str, parsed) -> None:
        if path == "/api/events" and method == "GET":
            return self._handle_sse()

        if method == "GET":
            if path == "/api/state":
                return self._send_json(self.ctx.state.snapshot())
            if path == "/api/health":
                return self._send_json(
                    {
                        "ok": True,
                        "version": __version__,
                        "uptime": round(time.time() - self.ctx.state.started_at, 2),
                        "listeners": self.ctx.bus.listener_count,
                        "time": time.time(),
                    }
                )
            if path == "/api/config":
                return self._send_json(self.ctx.config.all())
            if path == "/api/meta":
                return self._send_json(self._meta())
            return self._send_error_json(404, "unknown endpoint " + path)

        if method == "POST":
            try:
                body = self._read_json()
            except ValueError as exc:
                return self._send_error_json(400, "bad JSON body: %s" % exc)

            if path == "/api/voice-event":
                return self._handle_voice_event(body)
            if path == "/api/state":
                try:
                    return self._send_json(self.ctx.state.apply_patch(body))
                except ValueError as exc:
                    return self._send_error_json(400, str(exc))
            if path == "/api/config":
                return self._send_json(self.ctx.config.patch(body))
            if path == "/api/window-state":
                return self._handle_window_state(body)
            if path == "/api/window-closed":
                return self._handle_window_closed()
            if path == "/api/shutdown":
                self.request_shutdown("api")
                return self._send_json({"ok": True, "shutdown": True})
            return self._send_error_json(404, "unknown endpoint " + path)

        self._send_error_json(405, "method not allowed")

    def _meta(self) -> Dict[str, Any]:
        return {
            "name": "NEx3D Room",
            "version": __version__,
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "endpoints": [
                "GET /api/state",
                "POST /api/state",
                "POST /api/voice-event",
                "GET /api/events",
                "GET /api/config",
                "POST /api/config",
                "POST /api/window-state",
                "POST /api/window-closed",
                "POST /api/shutdown",
            ],
            "voiceEvents": list(ALL_EVENTS),
            "model": self.ctx.state.snapshot()["model"],
            "serverTime": time.time(),
        }

    def _handle_voice_event(self, body: Dict[str, Any]) -> None:
        try:
            snapshot = self.ctx.state.handle_voice_event(body)
        except ValueError as exc:
            return self._send_error_json(
                400, str(exc), expected=list(ALL_EVENTS)
            )
        self._send_json({"ok": True, "event": body.get("event"), "state": snapshot})

    def _handle_window_state(self, body: Dict[str, Any]) -> None:
        window = dict(self.ctx.config.get("window") or {})
        changed = False
        for key, cast in (("width", int), ("height", int), ("x", int), ("y", int)):
            if isinstance(body.get(key), (int, float)):
                value = cast(body[key])
                if key in ("width", "height") and value < 320:
                    continue
                if window.get(key) != value:
                    window[key] = value
                    changed = True
        if isinstance(body.get("mode"), str) and body["mode"] in (
            "windowed",
            "maximized",
            "fullscreen",
        ):
            if window.get("mode") != body["mode"]:
                window["mode"] = body["mode"]
                changed = True
        if changed:
            self.ctx.config.set("window", window)
        self._send_json({"ok": True, "window": window, "remembered": changed})

    def _handle_window_closed(self) -> None:
        self._cancel_pending_shutdown()
        if self.ctx.exit_on_window_close:
            self._send_json({"ok": True, "closing": True})
            timer = threading.Timer(
                SHUTDOWN_GRACE_SECONDS, self._grace_close_expired
            )
            timer.daemon = True
            self.ctx._shutdown_timer = timer  # type: ignore[attr-defined]
            timer.start()
        else:
            self._send_json({"ok": True, "closing": False, "keepAlive": True})

    def _grace_close_expired(self) -> None:
        # If a renderer reconnected during the grace period (a reload) we stay up.
        if self.ctx.bus.listener_count == 0:
            self.request_shutdown("window closed")

    def _cancel_pending_shutdown(self) -> None:
        timer = getattr(self.ctx, "_shutdown_timer", None)
        if timer is not None:
            timer.cancel()
            self.ctx._shutdown_timer = None  # type: ignore[attr-defined]

    def request_shutdown(self, reason: str) -> None:
        if self.ctx.shutdown_requested.is_set():
            return
        self.ctx.state.save()
        self.ctx.config.save()
        self.ctx.shutdown_requested.set()
        self.bus_log("shutdown", {"reason": reason})
        server = self.server
        threading.Thread(
            target=self._shutdown_server, args=(server,), daemon=True
        ).start()

    @staticmethod
    def _shutdown_server(server) -> None:
        time.sleep(0.15)
        try:
            server.shutdown()
        except Exception:
            pass

    def bus_log(self, event: str, data: Dict[str, Any]) -> None:
        self.ctx.bus.publish(event, data)

    # ------------------------------------------------------------------ sse
    def _handle_sse(self) -> None:
        self._cancel_pending_shutdown()
        channel = self.ctx.bus.subscribe()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            self._sse_write(
                "hello",
                {
                    "ok": True,
                    "version": __version__,
                    "state": self.ctx.state.snapshot(),
                    "time": time.time(),
                },
            )
            heartbeat = time.time()
            while not self.ctx.shutdown_requested.is_set():
                try:
                    event, data = channel.get(timeout=1.0)
                    self._sse_write(event, data)
                except Exception:
                    if time.time() - heartbeat > 15.0:
                        heartbeat = time.time()
                        self._sse_write("ping", {"t": time.time()})
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.ctx.bus.unsubscribe(channel)
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

    def _sse_write(self, event: str, data: Dict[str, Any]) -> None:
        payload = "event: %s\ndata: %s\n\n" % (
            event,
            json.dumps(data, separators=(",", ":")),
        )
        raw = payload.encode("utf-8")
        chunk = b"%x\r\n%s\r\n" % (len(raw), raw)
        self.wfile.write(chunk)
        self.wfile.flush()

    # --------------------------------------------------------------- static
    def _route_static(self, path: str) -> None:
        if path == "/" or path == "":
            path = "/index.html"
            self._cancel_pending_shutdown()

        safe = posixpath.normpath(path).lstrip("/")
        if safe.startswith("..") or "\\" in safe:
            return self._send_error_json(400, "bad path")

        full = os.path.realpath(os.path.join(self.ctx.frontend_dir, safe))
        root = os.path.realpath(self.ctx.frontend_dir)
        if not (full == root or full.startswith(root + os.sep)):
            return self._send_error_json(403, "forbidden")

        if not os.path.isfile(full):
            if path.endswith("/"):
                candidate = os.path.join(full, "index.html")
                if os.path.isfile(candidate):
                    full = candidate
                else:
                    return self._send_error_json(404, "not found: " + path)
            else:
                return self._send_error_json(404, "not found: " + path)

        try:
            with open(full, "rb") as handle:
                payload = handle.read()
        except OSError as exc:
            return self._send_error_json(500, "cannot read file: %s" % exc)

        content_type, _ = mimetypes.guess_type(full)
        if content_type is None:
            content_type = "application/octet-stream"
        if content_type.startswith("text/") or content_type in (
            "application/javascript",
            "application/json",
            "image/svg+xml",
        ):
            content_type += "; charset=utf-8"

        # Local app: never serve a stale cached copy after an update.
        self._send_bytes(payload, 200, content_type, cache="no-cache")


class NEx3DServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, ctx: AppContext) -> None:
        super().__init__(address, handler)
        self.ctx = ctx

    def handle_error(self, request, client_address) -> None:  # pragma: no cover
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        if self.ctx.verbose:
            traceback.print_exc()


class SimulationLoop(threading.Thread):
    """Drives the companion's timers even when nobody is watching."""

    def __init__(self, state: CompanionState, hz: float = TICK_HZ) -> None:
        super().__init__(name="nex3d-simulation", daemon=True)
        self.state = state
        self.interval = 1.0 / hz
        self._stop = threading.Event()
        self._last = time.time()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        while not self._stop.is_set():
            now = time.time()
            dt = now - self._last
            self._last = now
            try:
                self.state.tick(dt)
            except Exception:  # pragma: no cover - never kill the loop
                traceback.print_exc()
            self._stop.wait(self.interval)


def pick_port(preferred: int, host: str) -> int:
    """Return ``preferred`` if free, otherwise the next free port."""
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, port))
            except OSError:
                if port == preferred:
                    continue
                raise
            return int(probe.getsockname()[1])
    return preferred


def serve(
    host: str = "127.0.0.1",
    port: int = 8737,
    data_dir: str = DATA_DIR,
    verbose: bool = False,
    exit_on_window_close: bool = True,
    block: bool = True,
) -> NEx3DServer:
    """Create, start and (optionally) block on the server."""
    ctx = create_context(data_dir, verbose=verbose, exit_on_window_close=exit_on_window_close)
    port = pick_port(port, host)
    httpd = NEx3DServer((host, port), RequestHandler, ctx)
    ctx.origin_allowed = "http://%s:%d" % (host, port)

    loop = SimulationLoop(ctx.state)
    loop.start()
    flusher = PeriodicFlusher([ctx.state.store])
    flusher.start()

    thread = threading.Thread(target=httpd.serve_forever, name="nex3d-http", daemon=True)
    thread.start()

    host_for_url = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    url = "http://%s:%d/" % (host_for_url, port)
    if verbose:
        print("[server] listening on %s" % url)

    if block:
        try:
            while not ctx.shutdown_requested.wait(0.25):
                pass
        except KeyboardInterrupt:
            pass
        finally:
            shutdown(httpd, loop, flusher, ctx)
    return httpd


def shutdown(
    httpd: NEx3DServer,
    loop: Optional[SimulationLoop],
    flusher: Optional[PeriodicFlusher],
    ctx: AppContext,
) -> None:
    try:
        ctx.state.save()
        ctx.config.save()
    finally:
        if loop:
            loop.stop()
        if flusher:
            flusher.stop()
            flusher.flush()
        httpd.shutdown()
        httpd.server_close()


def main(argv=None) -> int:  # pragma: no cover - CLI
    import argparse

    parser = argparse.ArgumentParser(
        prog="backend.server",
        description="NEx3D Room local backend (standard library only).",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8737)
    parser.add_argument("--data-dir", default=DATA_DIR)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--keep-alive",
        action="store_true",
        help="do not exit when the app window closes",
    )
    args = parser.parse_args(argv)

    serve(
        host=args.host,
        port=args.port,
        data_dir=args.data_dir,
        verbose=args.verbose,
        exit_on_window_close=not args.keep_alive,
        block=True,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
