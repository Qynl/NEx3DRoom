"""Open the companion in a real, chrome-less application window.

There is no third party GUI toolkit here (that would mean pip), so we reuse the
Chromium engine that every modern desktop already has and launch it in
``--app`` mode: a dedicated window, no address bar, no tabs, its own taskbar
entry. It is the same trick that packaged desktop apps such as Slack or VS Code
insiders use for their windowed web views.

Order of preference:
    1. Brave           (the default choice for this project)
    2. Microsoft Edge  (ships with Windows 10/11)
    3. Google Chrome
    4. Chromium / any other Chromium family binary on PATH
    5. ``webbrowser.open`` as a last resort (opens in the default browser)

Set ``{"browser": {"engine": "auto"}}`` in ``data/config.json`` to go back to
whatever is installed, or ``"edge"`` / ``"chrome"`` to pin another one.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

IS_WINDOWS = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"


@dataclass
class BrowserEngine:
    name: str
    executable: str
    supports_app_mode: bool = True
    extra_flags: List[str] = field(default_factory=list)


def _windows_candidates() -> List[Tuple[str, str]]:
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LocalAppData", r"C:\Users\Public\AppData\Local")
    return [
        # Brave first: it is the preferred engine for this project.
        ("Brave", os.path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")),
        ("Brave", os.path.join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")),
        ("Brave", os.path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")),
        ("Microsoft Edge", os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe")),
        ("Microsoft Edge", os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe")),
        ("Microsoft Edge", os.path.join(local, "Microsoft", "Edge", "Application", "msedge.exe")),
        ("Google Chrome", os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe")),
        ("Google Chrome", os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe")),
        ("Google Chrome", os.path.join(local, "Google", "Chrome", "Application", "chrome.exe")),
    ]


def _mac_candidates() -> List[Tuple[str, str]]:
    return [
        ("Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
        (
            "Microsoft Edge",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ),
        ("Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ("Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ]


def _registry_lookup(names: Tuple[str, ...]) -> Optional[str]:
    """Ask Windows where a browser lives (App Paths registry key)."""
    if not IS_WINDOWS:
        return None
    for name in names:
        for hive in ("HKLM", "HKCU"):
            key = (
                r"%s\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%s"
                % (hive, name)
            )
            try:
                out = subprocess.run(
                    ["reg", "query", key, "/ve"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except (OSError, subprocess.SubprocessError):
                return None
            if out.returncode != 0:
                continue
            for line in out.stdout.splitlines():
                if "REG_SZ" in line:
                    path = line.split("REG_SZ", 1)[1].strip()
                    if path and os.path.exists(path):
                        return path
    return None


def find_browser(preferred: str = "auto") -> Optional[BrowserEngine]:
    """Locate a browser that can host an app window."""
    candidates: List[Tuple[str, str]] = []
    if IS_WINDOWS:
        candidates = _windows_candidates()
    elif IS_MAC:
        candidates = _mac_candidates()
    else:
        candidates = [
            ("Brave", "/usr/bin/brave"),
            ("Brave", "/usr/bin/brave-browser"),
            ("Google Chrome", "/usr/bin/google-chrome"),
            ("Google Chrome", "/usr/bin/google-chrome-stable"),
            ("Chromium", "/usr/bin/chromium"),
            ("Chromium", "/usr/bin/chromium-browser"),
            ("Microsoft Edge", "/usr/bin/microsoft-edge"),
        ]

    ordered = candidates
    if preferred and preferred != "auto":
        wanted = preferred.lower()
        ordered = [c for c in candidates if wanted in c[0].lower()] or candidates

    for name, path in ordered:
        if path and os.path.exists(path):
            return BrowserEngine(name=name, executable=path)

    # PATH lookup (handy on Linux and for portable installs on Windows).
    for exe in ("brave", "brave-browser", "msedge", "chrome", "google-chrome",
                "google-chrome-stable", "chromium", "chromium-browser",
                "microsoft-edge"):
        found = shutil.which(exe)
        if found:
            return BrowserEngine(name=exe, executable=found)

    # Windows registry fallback.
    reg = _registry_lookup(("brave.exe", "msedge.exe", "chrome.exe"))
    if reg:
        return BrowserEngine(name="Microsoft Edge", executable=reg)

    return None


def build_command(
    engine: BrowserEngine,
    url: str,
    window: Dict[str, Any],
    profile_dir: Optional[str] = None,
    extra_args: Optional[List[str]] = None,
) -> List[str]:
    """Assemble the full launch command line."""
    mode = str(window.get("mode", "maximized")).lower()
    cmd: List[str] = [engine.executable]
    cmd.append(f"--app={url}")
    cmd.append("--new-window")
    cmd.append("--no-first-run")
    cmd.append("--no-default-browser-check")
    cmd.append("--disable-session-crashed-bubble")
    cmd.append("--disable-features=Translate,msSmartScreenProtection")
    cmd.append("--autoplay-policy=no-user-gesture-required")
    cmd.append("--disable-background-timer-throttling")
    cmd.append("--disable-renderer-backgrounding")
    cmd.append("--password-store=basic")

    if mode == "fullscreen":
        cmd.append("--start-fullscreen")
    elif mode == "maximized":
        cmd.append("--start-maximized")
    else:
        width = int(window.get("width") or 1440)
        height = int(window.get("height") or 900)
        cmd.append(f"--window-size={width},{height}")
        if window.get("x") is not None and window.get("y") is not None:
            cmd.append(f"--window-position={int(window['x'])},{int(window['y'])}")

    if profile_dir:
        os.makedirs(profile_dir, exist_ok=True)
        cmd.append(f"--user-data-dir={profile_dir}")

    cmd.extend(engine.extra_flags)
    cmd.extend(extra_args or [])
    cmd.append(url)
    return cmd


def open_app_window(
    url: str,
    window: Dict[str, Any],
    profile_dir: Optional[str] = None,
    engine_preference: str = "auto",
    extra_args: Optional[List[str]] = None,
    verbose: bool = False,
) -> Tuple[Optional[subprocess.Popen], str]:
    """Launch the window. Returns (process, human readable description)."""
    engine = find_browser(engine_preference)
    if engine is None:
        import webbrowser

        webbrowser.open(url)
        return None, (
            "No Chromium based browser found - opened %s in the default browser. "
            "Install Microsoft Edge or Google Chrome for the chrome-less app window."
            % url
        )

    cmd = build_command(engine, url, window, profile_dir, extra_args)
    flags = 0
    if IS_WINDOWS:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )
    except OSError as exc:
        import webbrowser

        webbrowser.open(url)
        return None, "Could not start %s (%s) - opened the default browser instead." % (
            engine.name,
            exc,
        )

    if verbose:
        print("[window] launched %s: %s" % (engine.name, " ".join(cmd)))
    return process, "%s app window" % engine.name
