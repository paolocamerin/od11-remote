/**
 * OD-11 remote: Nuimo controller + OD-11 speaker integration.
 *
 * Interaction model:
 *   - On connect:       powerOnMatrix icon
 *   - Rotate:           volume up/down; number shown instantly, then corrected to the
 *                       speaker's real volume once rotation settles. Shows ✕ instead
 *                       while no speaker is connected (so "no number" = not working).
 *   - Short press:      toggle play/pause; show play/pause icon
 *   - Long press ≥600ms: show battery icon (1.5s) → battery level number
 *   - 5-min idle:       first button press shows diamond, skips play/pause
 *   - Touch/swipe/fly:  show feedback icon (no functional effect)
 *   - --debug mode:     longTouchBottom toggles pattern browser
 *                         (rotate cycles patterns, longTouchBottom again exits)
 */

const nuimo = require('./nuimo');
const speaker = require('./speaker');
const config = require('./config');
const { PATTERNS, PATTERNS_BY_NAME } = require('./patterns');

// ── Crash-proofing / shutdown ─────────────────────────────────────────────
// Belt-and-suspenders on top of nuimo.js's/speaker.js's own try/catch —
// if anything still slips through, log it and keep running rather than
// let Node kill the process.
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err && err.stack ? err.stack : err);
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nReceived', signal, '— shutting down...');
    speaker.shutdown();
    nuimo.shutdown()
        .catch((e) => console.log('Shutdown error:', e.message))
        .finally(() => process.exit(0));
    // Safety net in case BLE disconnect hangs — don't block a restart forever.
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

nuimo.initialiseNuimo();
speaker.initialiseSpeaker();

// ── State ──────────────────────────────────────────────────────────────────

let surrogateVolume = 0;
let surrogateMax = 100;
/** True only while connected AND the speaker has reported its volume since connecting. */
let volumeInitialised = false;
let ledReady = false;

const VOLUME_STEP = 1;

/**
 * Rotation settle: while turning, the speaker's volume echoes lag behind and would
 * drag the number backwards, so they're ignored; once rotation has been quiet this
 * long, the display is corrected to the speaker's real volume.
 */
const SETTLE_MS = 800;
let lastRotateTime = 0;
let settleTimer = null;
/** Volume number currently on the matrix (null when something else is shown). */
let shownVolume = null;

/** Throttle for the ✕ shown when rotating while disconnected (rotate fires per tick). */
const DISCONNECTED_FEEDBACK_MS = 1000;
let lastDisconnectedFeedback = 0;

/** Timestamp of last user interaction (for 5-min idle detection) */
let lastInteractionTime = Date.now();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Long-press threshold */
const LONG_PRESS_MS = 600;
let buttonPressTime = null;

/** First press after connect/reconnect is always a wake, not play/pause */
let hasWoken = false;

/** Pattern browser (debug mode only) */
let patternBrowserActive = false;
let patternBrowserIndex = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function p(name) {
    const pat = PATTERNS_BY_NAME[name];
    return pat ? pat.leds : null;
}

/**
 * Show a temporary feedback pattern. Expires via Nuimo's own matrix timeout.
 * @param {number[]|null} leds - 81-element array; if null, ignored
 */
function showFeedback(leds) {
    if (!ledReady || !leds) return;
    shownVolume = null;
    nuimo.setMatrix(leds);
}

/** The value the matrix shows for a volume: two digits max. */
function displayNumber(vol) {
    return Math.min(99, Math.round(vol));
}

/**
 * Show a volume number on the matrix.
 * @param {number} vol
 */
function showVolume(vol) {
    if (!ledReady) return;
    shownVolume = displayNumber(vol);
    nuimo.setNumber(shownVolume);
}

/**
 * Refresh the Nuimo display based on current app state.
 */
function updateDisplay() {
    if (!ledReady) return;
    if (patternBrowserActive) {
        nuimo.setMatrix(PATTERNS[patternBrowserIndex].leds);
        return;
    }
    if (!volumeInitialised) return;
    showVolume(surrogateVolume);
}

function markInteraction() {
    lastInteractionTime = Date.now();
}

function isIdle() {
    return (Date.now() - lastInteractionTime) >= IDLE_TIMEOUT_MS;
}


// ── Speaker sync ───────────────────────────────────────────────────────────

speaker.speakerEmitter.on('volumeChange', ({ vol, max }) => {
    surrogateMax = max;
    if (!volumeInitialised) {
        volumeInitialised = true;
        surrogateVolume = vol;
        console.log('Volume initialised from speaker:', vol, '/', max);
        return;
    }
    // Mid-rotation echoes are stale — settleVolume() reconciles afterwards.
    if (Date.now() - lastRotateTime < SETTLE_MS) return;
    surrogateVolume = vol;
});

speaker.speakerEmitter.on('disconnected', () => {
    // The last known volume is no longer trustworthy — wait for a fresh report.
    volumeInitialised = false;
    clearTimeout(settleTimer);
    settleTimer = null;
});

/**
 * After rotation settles, adopt the speaker's real volume and correct the display
 * if it differs — but only if the volume number is still what's on screen.
 */
function settleVolume() {
    settleTimer = null;
    if (!volumeInitialised || !speaker.isConnected()) return;
    surrogateVolume = speaker.getVolume().vol;
    if (patternBrowserActive || shownVolume === null) return;
    if (lastInteractionTime !== lastRotateTime) return; // another gesture took over the display
    if (displayNumber(surrogateVolume) === shownVolume) return;
    if (config.debug) console.log('Volume corrected to speaker value:', surrogateVolume);
    showVolume(surrogateVolume);
}

// ── Nuimo LED ready ────────────────────────────────────────────────────────

nuimo.emitter.on('ledReady', () => {
    ledReady = true;
    hasWoken = false;
    console.log('Nuimo LED ready');
    showFeedback(p('powerOnMatrix'));
});

nuimo.emitter.on('disconnect', () => {
    ledReady = false;
});

// ── Rotate ─────────────────────────────────────────────────────────────────

nuimo.emitter.on('rotate', (direction) => {
    markInteraction();

    if (patternBrowserActive) {
        patternBrowserIndex = Math.max(0, Math.min(PATTERNS.length - 1, patternBrowserIndex + direction));
        console.log('Pattern browser:', PATTERNS[patternBrowserIndex].name, '(' + patternBrowserIndex + ')');
        updateDisplay();
        return;
    }

    if (!volumeInitialised || !speaker.isConnected()) {
        if (Date.now() - lastDisconnectedFeedback >= DISCONNECTED_FEEDBACK_MS) {
            lastDisconnectedFeedback = Date.now();
            console.log('Rotate ignored — no speaker connected');
            showFeedback(p('crossX'));
        }
        return;
    }

    lastRotateTime = lastInteractionTime;
    surrogateVolume = Math.max(0, Math.min(surrogateMax, surrogateVolume + direction * VOLUME_STEP));
    if (config.debug) console.log('Volume:', surrogateVolume, '/', surrogateMax);
    showVolume(surrogateVolume);
    speaker.changeVolume(direction * VOLUME_STEP);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settleVolume, SETTLE_MS);
});

// ── Button ─────────────────────────────────────────────────────────────────

nuimo.emitter.on('press', () => {
    buttonPressTime = Date.now();
});

nuimo.emitter.on('release', () => {
    if (buttonPressTime === null) return;
    const held = Date.now() - buttonPressTime;
    buttonPressTime = null;
    markInteraction();

    if (held >= LONG_PRESS_MS) {
        // Long press → show battery icon (1.5s) → battery number
        const battery = nuimo.getBatteryLevel();
        console.log('Battery:', battery, '%');
        showFeedback(p('battery'));
        setTimeout(() => {
            if (!ledReady) return;
            nuimo.setNumber(battery != null ? battery : 0);
        }, 1500);
    } else {
        // Short press — first press after connect or idle is always a wake
        if (!hasWoken || isIdle()) {
            hasWoken = true;
            console.log('Wake press — showing diamond');
            showFeedback(p('diamond'));
            return;
        }
        // Toggle play/pause — route based on source capabilities
        const newPlaying = speaker.togglePlayPause();
        if (newPlaying === null) {
            // Source doesn't support pause (e.g. Optical) — see appletv.js (not wired in yet)
            showFeedback(p('questionMarkMatrix'));
        } else {
            console.log('Playback:', newPlaying ? 'playing' : 'paused');
            showFeedback(p(newPlaying ? 'playMatrix' : 'pauseMatrix'));
        }
    }
});

// ── Touch / swipe feedback ─────────────────────────────────────────────────

// Swipe and touch gestures have a pattern of the same name in patterns.js.

nuimo.emitter.on('swipe', (gesture) => {
    markInteraction();
    showFeedback(p(gesture) || p('questionMarkMatrix'));
});

nuimo.emitter.on('touch', (gesture) => {
    markInteraction();
    if (config.debug) {
        // longTouchBottom toggles pattern browser
        if (gesture === 'longTouchBottom') {
            patternBrowserActive = !patternBrowserActive;
            console.log('Pattern browser:', patternBrowserActive ? 'ON' : 'OFF');
            if (patternBrowserActive) {
                patternBrowserIndex = 0;
                nuimo.setMatrix(PATTERNS[patternBrowserIndex].leds);
            } else {
                updateDisplay();
            }
            return;
        }
    }
    if (patternBrowserActive) return; // suppress other touch feedback in browser
    showFeedback(p(gesture) || p('questionMarkMatrix'));
});

// ── Fly feedback ───────────────────────────────────────────────────────────

nuimo.emitter.on('fly', (dir) => {
    markInteraction();
    if (patternBrowserActive) return;
    const iconMap = {
        left:   'flyLeft',
        right:  'flyRight',
        updown: 'flyProximity',
    };
    showFeedback(p(iconMap[dir] || 'questionMarkMatrix'));
});
