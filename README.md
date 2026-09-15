# NEx3D Room

A local desktop application: a real-time 3D room rendered in a dedicated
chrome-less window, with a small floating AI companion living inside it. It
drifts around, watches the window light change, works at the desk, gets tired,
flies to the bed and sleeps, and wakes up when you talk to it.

There is no chat window, no message bubbles, no dashboard. The companion is
**voice-first** — it exposes a voice-event API so a speech stack can drive it
later, and until then it runs on its own routine.

* **Python backend, standard library only.** No pip, no virtualenv, no packages.
* **No npm, no CDN, no build step.** The frontend is plain HTML/CSS/JS modules
  served by that same backend.
* **Fully offline.** Nothing leaves the machine; state lives in `data/` as JSON.
* **Copy the folder to a Windows PC and run it.** That is the whole install.

---

## Run it

```bat
:: Windows - double click this, or run it from a terminal
NEx3D Room.bat
```

```bash
python run.py            # any OS
python run.pyw           # Windows, without a console window
```

The launcher starts the backend on <http://127.0.0.1:8737>, then opens the room
in a **dedicated application window** — no address bar, no tabs, its own taskbar
entry — using **Brave**, the preferred engine for this project. If Brave is not
installed it falls back to Microsoft Edge, then Google Chrome, then any
Chromium binary on `PATH`, and finally the system default browser.

Useful flags:

| Flag | What it does |
| --- | --- |
| `--no-window` | Backend only (development, or embed it yourself) |
| `--port 9000` / `--host 0.0.0.0` | Change the local endpoint |
| `--fullscreen` / `--windowed` / `--kiosk` | Window mode for this launch |
| `--engine edge` | Force a different engine (`brave`, `edge`, `chrome`, `auto`) |
| `--keep-alive` | Keep serving after the window closes |
| `--verbose` | Log HTTP traffic |
| `--reset-state` | Forget everything and start fresh |

Requirements: Python 3.8+ and any Chromium-family browser. Nothing else.

### Controls

| Key | Action |
| --- | --- |
| Drag / wheel | Orbit and zoom the room camera (releases back to drift after 5.5 s) |
| `F1` | Developer overlay: FPS, frame ms, AI state, location, backend link, model |
| `F` | Fullscreen |
| `R` | Reset the camera |
| `1` / `2` / `3` | Time of day: DAY / SUNSET / NIGHT |

The developer overlay is **hidden by default**.

---

## How it is put together

```
backend/    Python 3, stdlib only
  server.py    HTTP + SSE server, static file server, window lifecycle
  state.py     the companion: state machine, timers, routine, persistence
  brain.py     turn abstraction; PlaceholderBrain today, Ollama slot reserved
  storage.py   atomic JSON store (data/state.json, data/config.json)
  config.py    deep-mergeable configuration
  window.py    finds Brave/Edge/Chrome and launches the chrome-less window

frontend/   plain ES modules, served by the backend
  js/core/     math, geometry, GLSL, WebGL2 wrapper, procedural textures,
               forward PBR renderer, room camera
  js/world/    room layout, materials, shell, furniture, sky, lighting, scene
  js/ai/       the entity, flight controller, behaviour
  js/ui/       subtle status HUD + debug overlay
  js/net.js    fetch + Server-Sent Events client with reconnect/backoff

tests/      geometry checks, backend unit tests, headless frontend harness
```

### The renderer

Raw WebGL2, forward-rendered PBR: GGX + Smith + Schlick, Karis env BRDF, up to
8 punctual lights with PCF shadow filtering, a procedural HDR environment cube
regenerated only when the time of day changes, MSAA 4× into an RGBA16F target,
quarter-resolution bloom, ACES tone mapping, vignette and film grain.

The room is ~5.4 × 4.2 × 2.7 m with a desk, a bed, a sofa, a rug, a window and
real proportions, dressed warm and lived-in: open shelves with corked glass
jars and trailing herbs, a woven rattan pendant, window-sill pots, a marble
coffee table and a soft warm under-shelf glow. The default camera sits high in
the top-right corner so the whole room reads at a glance. ~20,000 triangles and
a few dozen draw calls — geometry, materials and lighting do the work, not
particle spam.

### The companion

A glossy white egg head with a dark glass visor, two warm amber oval eyes and a
smile drawn on a tiny glowing screen-canvas, little ear pods and a rounded body
pod, wrapped in a soft additive aura. It blinks, looks around, talks, dozes and
wakes; the face is parameter-driven so every state reads clearly. No arms, no
legs — it hovers. It flies on cubic Bezier paths with acceleration,
deceleration and damped rotation — it never teleports.

It also has a life of its own: a per-state posture (leans in while working,
head droops when resting, curls when asleep) plus one-shot emotes — spin,
stretch-with-yawn, wiggle, nod, happy bounce and look-around — triggered on
state changes and by an idle timer so it never feels frozen. Wake triggers a
stretch, listening a nod, speaking a bounce. The F1 overlay has an emote row,
and `window.__nex.emote('spin')` drives it from the console.

States: `IDLE`, `BORED`, `THINKING`, `WORKING`, `RESTING`, `SLEEPING`,
`WAKING`, `LISTENING`, `SPEAKING`.

```
IDLE --90 s--> BORED --150 s--> RESTING --120 s--> SLEEPING
SLEEPING --user speaks--> WAKING --3.5 s--> LISTENING --> THINKING
THINKING --> WORKING --> SPEAKING --> IDLE
```

Energy drains while awake and recovers while resting; low energy shortens the
patience timers. Everything is driven by state and timers — the environment
never animates randomly.

---

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | The whole state document |
| `POST` | `/api/state` | Partial update (arrival reports, telemetry, time of day) |
| `POST` | `/api/voice-event` | One voice event (see below) |
| `GET` | `/api/events` | Server-Sent Events: live state changes |
| `GET` / `POST` | `/api/config` | Read / deep-patch configuration |
| `GET` | `/api/health`, `/api/meta` | Liveness and version info |
| `POST` | `/api/window-state` | Remember window size and mode |
| `POST` | `/api/window-closed`, `/api/shutdown` | Window lifecycle |

`GET /api/state` always contains:

```json
{
  "currentState": "IDLE",
  "energy": 88.0,
  "mood": 0.7,
  "currentLocation": "CENTER",
  "targetLocation": "CENTER",
  "lastInteraction": 1725000000.0,
  "isListening": false,
  "isSpeaking": false,
  "isThinking": false
}
```

plus supporting detail (`moodLabel`, `activity`, `timeOfDay`, `turn`, `model`,
`counters`, `uptime`). Locations are `CENTER`, `DESK`, `BED`, `WINDOW`, `SOFA`.

### Voice events

```bash
curl -X POST http://127.0.0.1:8737/api/voice-event \
     -H "Content-Type: application/json" \
     -d '{"event":"user_started_speaking"}'
```

`user_started_speaking` · `user_finished_speaking` · `ai_started_thinking` ·
`ai_started_speaking` · `ai_finished_speaking`

Unknown events answer `400` with the list of accepted names. A few extras exist
for development and future hardware (`user_interaction`, `task_assigned`,
`teleport_hint`, `system_reset`); a client that only ever sends the five events
above gets a fully working companion.

### Ollama, later

`backend/brain.py` defines the `Brain` interface (`begin_turn` / `poll` /
`cancel`) and an `OllamaBrain` **stub that raises on purpose**. Implement those
three methods against `http://127.0.0.1:11434/api/chat` and set
`{"brain": {"provider": "ollama", "model": "llama3.2"}}` in `data/config.json`.
The HTTP API, the voice events and the 3D behaviour do not change. Until a
brain is implemented, `PlaceholderBrain` runs the turn timeline so the loop
`THINKING → WORKING → SPEAKING → IDLE` is observable.

---

## Configuration

`data/config.json` is created on first run and is plain JSON. Window
preferences are remembered automatically; everything else you edit by hand.

```json
{
  "window":   { "mode": "maximized", "width": 1440, "height": 900, "remember": true },
  "browser":  { "engine": "brave", "dedicatedProfile": true },
  "graphics": { "quality": "high", "shadows": true, "bloom": true, "msaa": true },
  "behaviour":{ "boredAfterIdle": 90, "restingAfterBored": 150, "sleepingAfterResting": 120 },
  "brain":    { "provider": "placeholder", "model": "" },
  "dev":      { "overlay": false }
}
```

The renderer also drops its own graphics settings back here (quality adapts if
the frame time is poor) and reports telemetry to `POST /api/state` every 5 s.

---

## Tests

```bash
python3 -m unittest discover -s tests -v   # backend: 33 tests
node tests/geometry.test.mjs               # mesh winding / normals / bounds
node tests/frontend.test.mjs               # 60 checks, whole app headless
```

`tests/frontend.test.mjs` boots the real modules against a recording WebGL2
mock (`tests/gl-mock.mjs`) and a minimal DOM shim, then compiles every shader,
builds the whole scene, flies the companion to all five locations, runs a full
voice turn, puts it to sleep on the bed and wakes it, and switches the time of
day. It asserts on draw calls, triangles, uniform values, camera bounds, flight
speed (no teleporting) and the sleep/wake choreography.

> What that harness does **not** do: drive a real GPU. Shader compilation here
> is a static lint, and no pixels are produced. Open the app on a machine with
> a browser for the real thing — the developer overlay (`F1`) is the quickest
> way to confirm the backend link and the frame rate.

---

## Project rules this build follows

* No chat UI, no text box, no message bubbles, no "Ask AI" button — the only UI
  is a subtle status area for mic, listening, speaking and AI state.
* Python standard library only; no npm; no CDN; no cloud; no external runtime
  dependencies. Everything needed lives in this folder.
* No reference robot or branding is reproduced; the room design comes from the
  brief.
