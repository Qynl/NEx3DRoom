#!/usr/bin/env python3
"""NEx3D Room - launcher.

Starts the local backend, opens the 3D room in a dedicated chrome-less window
and keeps everything running until you close the window.

    python run.py                # normal desktop launch
    python run.py --no-window    # backend only (headless / development)
    python run.py --fullscreen   # start in fullscreen
    python run.py --verbose      # log every HTTP request

Python 3.8+ and nothing else. No pip, no npm, no network.
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from backend import __version__, APP_NAME            # noqa: E402
from backend.config import Config                    # noqa: E402
from backend.server import (                          # noqa: E402
    DATA_DIR,
    PeriodicFlusher,
    SimulationLoop,
    create_context,
    pick_port,
    NEx3DServer,
    RequestHandler,
)
from backend.window import open_app_window           # noqa: E402

BANNER = r"""
  _   _ _____ __  __ ____  ____   ____
 | \ | | ____\ \/ /|___ \|___ \ |  _ \ _ __ ___   ___   ___  _ __ ___
 |  \| |  _|  \  /   __) | __) || |_) | '__/ _ \ / _ \ / _ \| '_ ` _ \
 | |\  | |___ /  \  / __/ / __/ |  _ <| | | (_) | (_) | (_) | | | | | |
 |_| \_|_____/_/\_\/_____|_____||_| \_\_|  \___/ \___/ \___/|_| |_| |_|
"""


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=APP_NAME,
        description="Local 3D AI companion room. Standard library only.",
    )
    parser.add_argument("--host", default=None, help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="port (default 8737)")
    parser.add_argument("--data-dir", default=DATA_DIR, help="where local state is stored")
    parser.add_argument("--no-window", action="store_true", help="backend only, no window")
    parser.add_argument("--fullscreen", action="store_true", help="start fullscreen")
    parser.add_argument("--windowed", action="store_true", help="start in a normal window")
    parser.add_argument("--engine", default=None, help="force a browser engine (edge/chrome)")
    parser.add_argument("--kiosk", action="store_true", help="kiosk mode (no window chrome at all)")
    parser.add_argument("--keep-alive", action="store_true",
                        help="keep the backend running after the window closes")
    parser.add_argument("--verbose", action="store_true", help="log HTTP traffic")
    parser.add_argument("--reset-state", action="store_true",
                        help="forget saved companion state on start")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    os.makedirs(args.data_dir, exist_ok=True)
    if args.reset_state:
        state_path = os.path.join(args.data_dir, "state.json")
        if os.path.exists(state_path):
            os.replace(state_path, state_path + ".bak")

    config = Config(os.path.join(args.data_dir, "config.json"))
    host = args.host or config.get("server.host", "127.0.0.1")
    port = pick_port(args.port or int(config.get("server.port", 8737)), host)

    ctx = create_context(
        data_dir=args.data_dir,
        verbose=args.verbose,
        exit_on_window_close=not args.keep_alive,
    )
    # Reuse the config instance we already read (keeps one source of truth).
    ctx.config = config

    httpd = NEx3DServer((host, port), RequestHandler, ctx)
    loop = SimulationLoop(ctx.state)
    flusher = PeriodicFlusher([ctx.state.store])
    loop.start()
    flusher.start()
    http_thread = threading.Thread(
        target=httpd.serve_forever, name="nex3d-http", daemon=True
    )
    http_thread.start()

    display_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    url = "http://%s:%d/" % (display_host, port)

    print(BANNER)
    print("  %s v%s" % (APP_NAME, __version__))
    print("  local server : %s" % url)
    print("  state files  : %s" % os.path.abspath(args.data_dir))
    print("  press Ctrl+C to quit\n")

    window_prefs = dict(config.get("window") or {})
    if args.fullscreen or args.kiosk:
        window_prefs["mode"] = "fullscreen"
    elif args.windowed:
        window_prefs["mode"] = "windowed"

    extra: list = ["--kiosk"] if args.kiosk else []
    extra.extend(list(config.get("browser.extraArgs") or []))

    browser = None
    description = "no window (--no-window)"
    if not args.no_window and config.get("server.openWindow", True):
        browser, description = open_app_window(
            url,
            window_prefs,
            profile_dir=(
                os.path.join(args.data_dir, "browser-profile")
                if config.get("browser.dedicatedProfile", True)
                else None
            ),
            engine_preference=args.engine or config.get("browser.engine", "auto"),
            extra_args=extra,
            verbose=args.verbose,
        )
        print("  window       : %s" % description)
        if window_prefs.get("remember"):
            # Keep the profile directory warm; window size itself is reported
            # by the renderer through POST /api/window-state.
            pass
    else:
        print("  window       : %s" % description)

    try:
        while not ctx.shutdown_requested.is_set():
            if browser is not None and browser.poll() is not None:
                # The window was closed - shut the app down with it.
                if not args.keep_alive:
                    print("\n[app] window closed, shutting down")
                    break
                browser = None
            time.sleep(0.25)
    except KeyboardInterrupt:
        print("\n[app] interrupted, shutting down")
    finally:
        try:
            ctx.state.save()
            config.save()
        finally:
            loop.stop()
            flusher.stop()
            flusher.flush()
            httpd.shutdown()
            httpd.server_close()
            if browser is not None and browser.poll() is None:
                browser.terminate()
                try:
                    browser.wait(timeout=2.0)
                except Exception:
                    try:
                        browser.kill()
                    except Exception:
                        pass
        print("[app] bye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
