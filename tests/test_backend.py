"""Backend tests - standard library only.

    python3 -m unittest discover -s tests -v
    python3 tests/test_backend.py

Covers the state machine, the resting routine, persistence across restarts,
the HTTP API and the desktop window launch command.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from backend.brain import PlaceholderBrain                       # noqa: E402
from backend.config import Config                                # noqa: E402
from backend.state import (                                      # noqa: E402
    ALL_EVENTS, STATES, CompanionState, EventBus, VOICE_EVENTS,
)
from backend.storage import JsonStore                            # noqa: E402
from backend.window import build_command, find_browser           # noqa: E402


def make_state(tmp):
    store = JsonStore(os.path.join(tmp, "state.json"), defaults={"energy": 88.0})
    return CompanionState(store=store, brain=PlaceholderBrain(), bus=EventBus())


def run_for(state, seconds, step=0.1):
    """Advance the simulation clock without sleeping.

    Rewinds the timestamps the model compares against ``time.time()`` and
    returns the sequence of distinct states that were visited.
    """
    seen = []
    steps = max(1, int(round(seconds / step)))
    for _ in range(steps):
        # Every absolute timestamp the model compares against time.time().
        state.state_entered_at -= step
        if getattr(state, "_travel_started_at", 0.0):
            state._travel_started_at -= step
        turn = state._turn
        if turn is not None:
            turn.phase_started_at -= step
        state.tick(step)
        if not seen or seen[-1] != state.state:
            seen.append(state.state)
    return seen


class StateMachineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nex3d-test-")
        self.state = make_state(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_starts_idle_with_documented_fields(self):
        snap = self.state.snapshot()
        for key in (
            "currentState", "energy", "mood", "currentLocation", "targetLocation",
            "lastInteraction", "isListening", "isSpeaking", "isThinking",
        ):
            self.assertIn(key, snap)
        self.assertEqual(snap["currentState"], "IDLE")
        self.assertEqual(snap["currentLocation"], "CENTER")
        self.assertFalse(snap["isListening"])
        self.assertFalse(snap["isSpeaking"])
        self.assertFalse(snap["isThinking"])

    def test_full_voice_turn(self):
        events = [
            ("user_started_speaking", "LISTENING"),
            ("user_finished_speaking", "THINKING"),
            ("ai_started_thinking", "THINKING"),
            ("ai_started_speaking", "SPEAKING"),
            ("ai_finished_speaking", "IDLE"),
        ]
        for event, expected in events:
            snapshot = self.state.handle_voice_event({"event": event})
            self.assertEqual(snapshot["currentState"], expected, event)

        snap = self.state.snapshot()
        self.assertEqual(snap["counters"]["turnsCompleted"], 1)
        self.assertGreater(snap["counters"]["interactions"], 0)
        self.assertIsNotNone(snap["lastInteraction"])

    def test_voice_flags(self):
        self.state.handle_voice_event({"event": "user_started_speaking"})
        snap = self.state.snapshot()
        self.assertTrue(snap["isListening"])
        self.state.handle_voice_event({"event": "user_finished_speaking"})
        snap = self.state.snapshot()
        self.assertFalse(snap["isListening"])
        self.assertTrue(snap["isThinking"])
        self.state.handle_voice_event({"event": "ai_started_speaking"})
        snap = self.state.snapshot()
        self.assertTrue(snap["isSpeaking"])

    def test_brain_drives_thinking_working_speaking(self):
        self.state.handle_voice_event({"event": "user_started_speaking"})
        self.state.handle_voice_event({"event": "user_finished_speaking"})
        self.assertEqual(self.state.snapshot()["currentState"], "THINKING")
        seen = run_for(self.state, 30)
        # The placeholder brain walks thinking -> working -> speaking -> done.
        self.assertIn("WORKING", seen)
        self.assertIn("SPEAKING", seen)
        self.assertEqual(seen[-1], "IDLE")
        self.assertEqual(self.state.snapshot()["counters"]["turnsCompleted"], 1)

    def test_unknown_event_rejected(self):
        with self.assertRaises(ValueError):
            self.state.handle_voice_event({"event": "make_coffee"})
        with self.assertRaises(ValueError):
            self.state.handle_voice_event({})
        with self.assertRaises(ValueError):
            self.state.handle_voice_event(["not", "an", "object"])

    def test_documented_events_are_all_accepted(self):
        for event in VOICE_EVENTS:
            self.assertIn(event, ALL_EVENTS)

    def test_resting_routine(self):
        self.state.energy = 100.0  # keep the low-energy shortcuts out of the way
        seen = run_for(self.state, 95)          # IDLE -> BORED
        self.assertIn("BORED", seen)
        seen += run_for(self.state, 155)        # BORED -> RESTING -> SLEEPING
        self.assertIn("RESTING", seen)
        seen += run_for(self.state, 125)
        self.assertIn("SLEEPING", seen)
        self.assertEqual(self.state.snapshot()["currentState"], "SLEEPING")
        self.assertEqual(self.state.snapshot()["targetLocation"], "BED")
        # It must pass through every stage in order - no skipping to sleep.
        stages = [n for n in seen if n in ("IDLE", "BORED", "RESTING", "SLEEPING")]
        collapsed = [n for i, n in enumerate(stages) if i == 0 or n != stages[i - 1]]
        self.assertEqual(collapsed, ["IDLE", "BORED", "RESTING", "SLEEPING"])

    def test_sleeping_recovers_energy_and_awake_drains_it(self):
        start = self.state.snapshot()["energy"]
        run_for(self.state, 60)
        drained = self.state.snapshot()["energy"]
        self.assertLess(drained, start)

        self.state.handle_voice_event({"event": "system_reset"})
        self.state._set_state("SLEEPING", "test")
        low = self.state.energy = 40.0
        run_for(self.state, 20)
        self.assertGreater(self.state.snapshot()["energy"], low)
        self.assertLessEqual(self.state.snapshot()["energy"], 100.0)

    def test_wake_path(self):
        self.state._set_state("SLEEPING", "test")
        snap = self.state.handle_voice_event({"event": "user_started_speaking"})
        self.assertEqual(snap["currentState"], "WAKING")
        run_for(self.state, 5)
        self.assertEqual(self.state.snapshot()["currentState"], "LISTENING")
        self.assertEqual(self.state.snapshot()["counters"]["wakeCount"], 1)

    def test_interaction_wakes_without_listening(self):
        self.state._set_state("SLEEPING", "test")
        self.state.handle_voice_event({"event": "user_interaction"})
        run_for(self.state, 5)
        self.assertEqual(self.state.snapshot()["currentState"], "IDLE")

    def test_locations_follow_state(self):
        for state, location in [("WORKING", "DESK"), ("SLEEPING", "BED"), ("LISTENING", "CENTER")]:
            self.state._set_state(state, "test")
            self.assertEqual(self.state.snapshot()["targetLocation"], location, state)
        for state in STATES:
            self.assertIn(state, STATES)

    def test_arrival_report_moves_current_location(self):
        self.state.apply_patch({"targetLocation": "DESK"})
        self.assertEqual(self.state.snapshot()["currentLocation"], "CENTER")
        self.state.apply_patch({"arrivedAt": "DESK"})
        self.assertEqual(self.state.snapshot()["currentLocation"], "DESK")
        with self.assertRaises(ValueError):
            self.state.apply_patch("nope")

    def test_arrival_watchdog_completes_a_stalled_trip(self):
        """A renderer that never reports arrival must not desync the model.

        Regression: the clock used to be re-armed the moment it expired, so the
        watchdog reset itself every ARRIVAL_TIMEOUT seconds and never fired.
        """
        self.state.apply_patch({"targetLocation": "WINDOW"})
        run_for(self.state, 20)
        self.assertEqual(self.state.snapshot()["currentLocation"], "CENTER")
        run_for(self.state, 15)
        snap = self.state.snapshot()
        self.assertEqual(snap["currentLocation"], "WINDOW")
        self.assertEqual(snap["targetLocation"], "WINDOW")

    def test_time_of_day_patch(self):
        snap = self.state.apply_patch({"timeOfDay": "night"})
        self.assertEqual(snap["timeOfDay"], "NIGHT")
        snap = self.state.apply_patch({"timeOfDay": "NOON"})
        self.assertEqual(snap["timeOfDay"], "NIGHT")  # ignored, stays valid

    def test_telemetry_patch(self):
        snap = self.state.apply_patch({"fps": 60, "drawCalls": 44, "frameMs": 16.7})
        self.assertEqual(snap["currentState"], "IDLE")
        self.assertEqual(self.state.telemetry["fps"], 60)
        self.assertEqual(self.state.telemetry["drawCalls"], 44)

    def test_wander_changes_target_while_idle(self):
        self.state._next_wander_at = 0.0
        self.state.tick(0.1)
        self.assertIn(self.state.snapshot()["targetLocation"],
                      ("CENTER", "WINDOW", "SOFA", "DESK"))
        self.assertGreater(self.state._next_wander_at, 0.0)

    def test_listening_times_out(self):
        self.state.handle_voice_event({"event": "user_started_speaking"})
        run_for(self.state, 50)
        self.assertEqual(self.state.snapshot()["currentState"], "IDLE")


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nex3d-persist-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_state_survives_a_restart(self):
        first = make_state(self.tmp)
        first.handle_voice_event({"event": "user_started_speaking"})
        first.apply_patch({"arrivedAt": "DESK", "timeOfDay": "SUNSET"})
        first.energy = 42.0
        first.save()

        second = make_state(self.tmp)
        snap = second.snapshot()
        self.assertEqual(snap["currentLocation"], "DESK")
        self.assertEqual(snap["timeOfDay"], "SUNSET")
        self.assertAlmostEqual(snap["energy"], 42.0, delta=1.0)
        self.assertEqual(snap["counters"]["bootCount"], 2)

    def test_asleep_companion_wakes_on_boot(self):
        first = make_state(self.tmp)
        first._set_state("SLEEPING", "test")
        first.energy = 30.0
        first.save()

        second = make_state(self.tmp)
        self.assertEqual(second.snapshot()["currentState"], "WAKING")

    def test_corrupt_state_file_does_not_crash(self):
        path = os.path.join(self.tmp, "state.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{ this is not json")
        state = make_state(self.tmp)
        self.assertEqual(state.snapshot()["currentState"], "IDLE")
        self.assertTrue(os.path.exists(path + ".corrupt"))


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nex3d-config-")
        self.config = Config(os.path.join(self.tmp, "config.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_defaults_and_deep_patch(self):
        self.assertEqual(self.config.get("browser.engine"), "brave")
        self.config.patch({"window": {"width": 1600}})
        self.assertEqual(self.config.get("window.width"), 1600)
        self.assertEqual(self.config.get("window.mode"), "maximized")  # untouched

    def test_window_prefs_round_trip(self):
        self.config.set("window.mode", "fullscreen")
        reloaded = Config(os.path.join(self.tmp, "config.json"))
        self.assertEqual(reloaded.get("window.mode"), "fullscreen")


class WindowTests(unittest.TestCase):
    def test_brave_is_preferred(self):
        from backend.window import _windows_candidates

        names = [name for name, _ in _windows_candidates()]
        self.assertEqual(names[0], "Brave")

    def test_command_uses_app_mode_and_saved_size(self):
        engine = find_browser("brave") or type("E", (), {"name": "Brave", "executable": "/usr/bin/brave", "extra_flags": []})()
        cmd = build_command(
            engine,
            "http://127.0.0.1:8737/",
            {"mode": "windowed", "width": 1280, "height": 800},
            profile_dir=None,
        )
        self.assertIn("--app=http://127.0.0.1:8737/", cmd)
        self.assertIn("--window-size=1280,800", cmd)
        self.assertNotIn("--start-maximized", cmd)

        maximized = build_command(engine, "http://x/", {"mode": "maximized"})
        self.assertIn("--start-maximized", maximized)

    def test_falls_back_when_brave_is_missing(self):
        # No browser installed in this sandbox: the lookup must return None
        # rather than raising, so the launcher can use the default browser.
        result = find_browser("brave")
        self.assertTrue(result is None or hasattr(result, "executable"))


class HttpApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="nex3d-http-")
        from backend.server import NEx3DServer, RequestHandler, SimulationLoop, create_context

        cls.ctx = create_context(cls.tmp, verbose=False, exit_on_window_close=False)
        cls.httpd = NEx3DServer(("127.0.0.1", 0), RequestHandler, cls.ctx)
        cls.port = cls.httpd.server_address[1]
        cls.base = "http://127.0.0.1:%d" % cls.port
        cls.loop = SimulationLoop(cls.ctx.state)
        cls.loop.start()
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.loop.stop()
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as response:
            return response.status, response.read()

    def post(self, path, payload):
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.base + path,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_health_and_meta(self):
        status, body = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

        status, body = self.get("/api/meta")
        meta = json.loads(body)
        self.assertEqual(meta["name"], "NEx3D Room")
        self.assertIn("POST /api/voice-event", meta["endpoints"])

    def test_frontend_is_served(self):
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"NEx3D Room", body)

        status, body = self.get("/js/main.js")
        self.assertEqual(status, 200)
        self.assertIn(b"buildScene", body)

        status, body = self.get("/css/app.css")
        self.assertEqual(status, 200)
        self.assertIn(b".dock", body)

    def test_missing_file_is_404_json(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/js/does-not-exist.js")
        self.assertEqual(caught.exception.code, 404)

    def test_state_endpoints(self):
        status, body = self.get("/api/state")
        self.assertEqual(status, 200)
        state = json.loads(body)
        self.assertIn("currentState", state)

        status, updated = self.post("/api/state", {"targetLocation": "WINDOW"})
        self.assertEqual(status, 200)
        self.assertEqual(updated["targetLocation"], "WINDOW")

        status, updated = self.post("/api/state", {"arrivedAt": "WINDOW"})
        self.assertEqual(updated["currentLocation"], "WINDOW")

    def test_voice_event_endpoint(self):
        status, body = self.post("/api/voice-event", {"event": "user_started_speaking"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["state"]["currentState"], "LISTENING")

        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post("/api/voice-event", {"event": "nope"})
        self.assertEqual(caught.exception.code, 400)
        detail = json.loads(caught.exception.read().decode("utf-8"))
        self.assertIn("expected", detail)

    def test_config_endpoints(self):
        status, body = self.get("/api/config")
        self.assertEqual(status, 200)
        config = json.loads(body)
        self.assertIn("window", config)

        status, updated = self.post("/api/config", {"window": {"width": 1366}})
        self.assertEqual(updated["window"]["width"], 1366)

    def test_window_state_endpoint(self):
        status, body = self.post("/api/window-state", {"width": 1500, "height": 900, "mode": "windowed"})
        self.assertTrue(body["ok"])
        self.assertEqual(body["window"]["width"], 1500)
        # Tiny values are rejected so a bad report cannot shrink the window away.
        status, body = self.post("/api/window-state", {"width": 10})
        self.assertEqual(body["window"]["width"], 1500)

    def test_event_stream(self):
        request = urllib.request.Request(self.base + "/api/events")
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.headers.get("Content-Type").split(";")[0], "text/event-stream")
            first = response.readline().decode("utf-8").strip()
            self.assertEqual(first, "event: hello")
            data_line = response.readline().decode("utf-8")
            payload = json.loads(data_line.split("data:", 1)[1])
            self.assertTrue(payload["ok"])
            self.assertIn("currentState", payload["state"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
