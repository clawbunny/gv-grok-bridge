# Grok voice activation — 2026-08-14

Callers were answered, then could not talk to Grok about half the time.
When activation did work, Grok often took 20–30 seconds to become
interactable. Fixed and verified live on `gvgrok@dsd.890.be`
(instance `gvgrok-gv-grok-01`).

- **First reported:** 2026-08-14
- **Verified working:** 2026-08-15 03:05 UTC — pickup ~2s, bridged ~5s
- **Primary code:** `src/providers/ai/grok/provider.ts`,
  `src/runtime/orchestrator.ts`, `src/runtime/browser/manager.ts`,
  `scripts/watchdog.cjs`
- **Tests:** `src/providers/ai/grok/__tests__/provider.test.ts`,
  `src/runtime/__tests__/orchestrator.test.ts`

## Symptom

Authorized callers rang the Google Voice bridge. The phone was picked
up (`acceptCall` succeeded), but more than half of those calls had
nobody to talk to: silence, or Grok only becoming usable after a long
pause.

`calls.jsonl` showed the call as `accepted` and `bridged` almost every
time. `verifyVoiceSession` never failed. Long calls often recorded
`silentAiAudio` (and sometimes `silentCallerAudio`). Short hang-ups
were not flagged because silence sampling used to require two 30s
windows.

## What the logs actually showed

A typical failed call (before the click fix):

1. Playwright resolved `button[aria-label="Enter voice mode (Ctrl+⇧O)"]`.
2. The click **landed** (`click action done`).
3. grok.com treats voice mode as a client-side navigation. Playwright's
   default `click()` waited for that navigation and timed out at 5s.
4. The fallback pressed `Control+Shift+O`, which **toggles** voice, so
   it turned off the session the click had just started.
5. Leftover `getUserMedia` tracks / RTCPeerConnections made
   `verifyVoiceSession` report success (`liveAudioTrack` or
   `connectedPeer`).
6. The orchestrator entered `BRIDGED` with a dead or half-started
   session.

A later “slow but answered” call (after the toggle fix, before the
cookie/routing fix) dumped the Grok page one second after the click:

- Composer text **Connecting…**
- Button `aria-label="Connecting..."`
- OneTrust preference center still in the DOM (`Allow All`,
  `Close preference center`, `Confirm My Choices`)
- `__rtcHooks.peers = []`, `liveTracks = 1`
- URL still `https://grok.com/` (empty composer, not a `/chat/<id>` thread)

Audio routing was started only **after** an 8s verification wait for a
connected peer that grok.com never exposes to the hook. The caller sat
on hold for that wait plus Grok's own Connecting handshake.

## Root causes (layered)

Several independent bugs stacked. Fixing only the first one moved the
failure from “dead line” to “20–30s until Grok speaks”.

### 1. Click timeout treated as failure → keyboard toggle-off

`locator.click()` without `noWaitAfter` waits for a follow-up
navigation. grok.com's voice mode is a client-side route change.
Playwright reported timeout after the click had already succeeded, and
the keyboard shortcut then toggled voice **off**.

### 2. Broad selector can hit dictation, not voice mode

The composer has two controls next to each other:

- Small mic — dictation / speech-to-text (`aria-label` often contains
  `microphone`)
- Black waveform — **Enter voice mode (Ctrl+⇧O)**

`page.locator('a, b, c').first()` is **DOM order**, not selector
order. A combined `microphone` / `voice` locator can click dictation.
That starts `getUserMedia` (so RTC hooks look live) without opening a
Grok voice session.

### 3. New Chat on an already-empty composer remounts grok.com

Clicking sidebar **New Chat** while already on `https://grok.com/`
remounts the composer. Voice then starts on a cold page. Measured
cost: ~30s until Grok was interactable.

### 4. Verification accepted leftover RTC and then waited 8s for a peer that never appears

`window.__rtcHooks` accumulates peers/streams and is not cleared
between calls unless we reset it. A leftover `connected` peer was
treated as proof of a new session.

After hooks were reset, grok.com still never pushed an
`RTCPeerConnection` into the hook (`peers: []`). Waiting 8s for
`connectedPeer` only delayed PulseAudio routing.

### 5. Aggressive recovery made good sessions worse

- First silence sample at 4s, while Grok was still Connecting, recycled
  the AI page mid-call (the 31s “bridge” time was a second start).
- Idle “AI page has no open websockets” recycled grok.com every ~30s.
  grok.com often has zero CDP-visible websockets (HTTP/2, or sockets
  opened before `Network.enable`). Three recycles exhausted the budget
  and systemd restarted the bridge.
- Planned recycle after every call cold-started grok.com and surfaced
  Chromium's **Restore pages?** bubble.

### 6. OneTrust cookie UI blocked Connecting

After getUserMedia, OneTrust's banner / preference center is often in
the page (`Allow All`, `Close preference center`). Leaving it up
coincided with a long Connecting state.

## Fix

### Grok provider (`src/providers/ai/grok/provider.ts`)

- Click **only** `button[aria-label*="Enter voice mode" i]`, with
  `{ force: true, noWaitAfter: true }`. If Playwright still reports
  “click action done / waiting for scheduled navigations”, treat that
  as success and do **not** press the keyboard shortcut.
- Skip New Chat unless the URL is an existing thread
  (`/chat/<id>`).
- Reset `__rtcHooks.peers` / `streams` immediately before the click so
  leftover RTC cannot fake a new session.
- Dismiss OneTrust (`#onetrust-accept-btn-handler`, `Allow All`,
  preference-center close, including same-origin frames) **before and
  after** the voice click.
- `verifyVoiceSession` succeeds on a **new live mic track** or the
  Connecting / active voice UI. It no longer blocks ~8s for a hooked
  `RTCPeerConnection` grok.com does not expose.
- On activation, dump screenshot + button inventory + RTC snapshot to
  `$GV_DEBUG_DIR` (default `/tmp/gv-bridge-debug/grok-after-activate-*`).

### Orchestrator (`src/runtime/orchestrator.ts`)

- Start PulseAudio stream/sink routing **before** verification so the
  greeting is not delayed by the verify wait.
- Do not recycle grok.com on “zero CDP websockets”.
- Do not recycle a healthy Grok page after every call (keep it warm).
- First silence sample waits 15s; mid-call Grok recycle is last-resort
  only, after the greeting window.

### Browser (`src/runtime/browser/manager.ts`)

Launch Chromium with `--hide-crash-restore-bubble` and
`--disable-session-crashed-bubble` so unclean recycles do not leave a
Restore-pages overlay on grok.com.

### Watchdog (`scripts/watchdog.cjs`)

On `silent_ai_audio` / `ai_voice_unavailable`, restart the instance
service when idle (20-minute cooldown, never mid-call). Alert-only
watchdogs left a wedged Grok page in place until the next human call.

## Verified call times (live instance)

| When (UTC) | `bridgeLatencyMs` | What the caller heard |
|------------|-------------------|------------------------|
| 2026-08-15 00:00 | 15742 | Click timeout → keyboard toggle; dead / flaky |
| 2026-08-15 02:49 | 31225 | Voice started in 4s, then a false silence recycle reloaded grok.com |
| 2026-08-15 02:54 | 10226 | New Chat remount; Connecting ~20s |
| 2026-08-15 03:01 | 9889 | New Chat skipped; still waited 8s for a peer + cookies |
| 2026-08-15 03:05 | **5232** | Worked. Pickup ~2s, Grok interactable in ~5s |

## How to confirm a good call

Journal should look like:

```
Already on a fresh Grok composer — skipping New chat {"url":"https://grok.com/"}
Grok voice mode activated (click)
Dismissed cookie / OneTrust dialog    # if the banner was up
Voice session verified via RTC hooks {"liveAudioTrack":true,...}
State: ACTIVATE_AI -> BRIDGED
```

You should **not** see, on a healthy pickup:

- `Force click failed, trying keyboard shortcut` after `click action done`
- `Started a fresh Grok conversation` when already on `https://grok.com/`
- `Recycling ai page {"reason":"AI page has no open websockets..."}`
- `Recycling AI page to recover a silent Grok session` in the first ~15s

`bridgeLatencyMs` on `calls.jsonl` should be on the order of 5 seconds,
not 15–30.

## Debug dumps

Set `GV_DEBUG_DIR` (default `/tmp/gv-bridge-debug`). Each activation
writes `grok-after-activate-<ts>.{png,json}` with URL, button
aria-labels, and hook state. Incoming Google Voice UI dumps remain
`incoming-<ts>.{png,json}`.

## Commits

- `e8a4112` — stop toggling voice off after a successful mic click
- `1d9e353` — do not recycle grok.com mid-greeting or on missing websockets
- `eb945b6` — skip New Chat on a ready composer; click only voice mode
- `7094489` — dismiss OneTrust; start audio routing during Connecting
