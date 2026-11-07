/**
 * Interaction tests for index.js: the Nuimo and the speaker are replaced by fakes
 * (via require.cache), so no Bluetooth or network is touched.
 *
 * index.js keeps module-level state and is loaded once, so the tests run in order
 * and each builds on the state the previous one left behind.
 *
 * Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..');
const { PATTERNS } = require(path.join(ROOT, 'patterns'));

process.argv.push('--ip=192.0.2.1');

// ── Fakes ────────────────────────────────────────────────────────────────

/** Everything drawn on the matrix: numbers as numbers, patterns by name. */
const draws = [];
let batteryLevel = 86;

const nuimo = {
    emitter: new EventEmitter(),
    initialiseNuimo() {},
    shutdown: async () => {},
    getBatteryLevel: () => batteryLevel,
    setMatrix(leds) {
        const pattern = PATTERNS.find((p) => p.leds === leds);
        draws.push(pattern ? pattern.name : 'unknown');
    },
    setNumber(value) { draws.push(value); },
};

const speakerState = { connected: false, vol: 0, canPause: false, toggles: 0, playing: false };
const sentDeltas = [];

const speaker = {
    speakerEmitter: new EventEmitter(),
    initialiseSpeaker() {},
    shutdown() {},
    isConnected: () => speakerState.connected,
    getVolume: () => ({ vol: speakerState.vol, max: 100 }),
    changeVolume(amount) { sentDeltas.push(amount); },
    canTogglePlayPause: () => speakerState.canPause,
    togglePlayPause() { speakerState.toggles++; speakerState.playing = !speakerState.playing; return speakerState.playing; },
};

function stub(name, exports) {
    const filename = path.join(ROOT, name);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('nuimo.js', nuimo);
stub('speaker.js', speaker);

require(path.join(ROOT, 'index.js'));

// ── Helpers ──────────────────────────────────────────────────────────────

const SETTLE_WAIT_MS = 900; // index.js SETTLE_MS (800) + margin
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The speaker reports a volume (initial state or an echo of a change). */
function speakerReports(vol) {
    speakerState.vol = vol;
    speaker.speakerEmitter.emit('volumeChange', { vol, max: 100 });
}

function rotate(direction, times = 1) {
    for (let i = 0; i < times; i++) nuimo.emitter.emit('rotate', direction);
}

function resetDraws() {
    draws.length = 0;
}

// ── Tests ────────────────────────────────────────────────────────────────

test('Nuimo ready shows the hello glyph', () => {
    nuimo.emitter.emit('ledReady');
    assert.deepEqual(draws, ['hello']);
});

test('rotating with no speaker connected shows ✕ once and sends nothing', () => {
    resetDraws();
    rotate(1, 5);
    assert.deepEqual(draws, ['crossX']);
    assert.equal(sentDeltas.length, 0);
});

test('numbers update instantly and a stale echo mid-turn is ignored', () => {
    speakerState.connected = true;
    speakerReports(31);
    resetDraws();
    rotate(1, 2);
    speakerReports(32); // lagging echo of the first step
    rotate(1);
    assert.deepEqual(draws, [32, 33, 34]);
    assert.deepEqual(sentDeltas, [1, 1, 1]);
});

test('after settling, no redraw when the speaker agrees', async () => {
    speakerReports(33);
    speakerState.vol = 34;
    await sleep(SETTLE_WAIT_MS);
    assert.deepEqual(draws, [32, 33, 34]);
});

test('after settling, snaps back to the real volume when a change was lost', async () => {
    resetDraws();
    rotate(1); // speaker stays at 34
    await sleep(SETTLE_WAIT_MS);
    assert.deepEqual(draws, [35, 34]);
});

test('another gesture after turning is not overwritten by the correction', async () => {
    resetDraws();
    rotate(1);
    await sleep(50);
    await shortPress();
    await sleep(SETTLE_WAIT_MS);
    assert.deepEqual(draws, [35, 'nuimo']);
});

test('after a speaker drop it shows ✕, then resumes from the fresh volume', async () => {
    speakerState.connected = false;
    speaker.speakerEmitter.emit('disconnected');
    resetDraws();
    await sleep(1000); // let the ✕ throttle expire
    rotate(1);
    speakerState.connected = true;
    speakerReports(20);
    rotate(-1);
    assert.deepEqual(draws, ['crossX', 19]);
});

test('a volume change from elsewhere is the base for the next turn', async () => {
    await sleep(SETTLE_WAIT_MS);
    speakerReports(50);
    resetDraws();
    rotate(1);
    assert.equal(draws[0], 51);
});

test('touch, swipe and fly gestures do nothing', async () => {
    await sleep(SETTLE_WAIT_MS);
    resetDraws();
    nuimo.emitter.emit('touch', 'longTouchTop');
    nuimo.emitter.emit('swipe', 'swipeLeft');
    nuimo.emitter.emit('fly', 'updown');
    assert.deepEqual(draws, []);
});

async function shortPress() {
    nuimo.emitter.emit('press');
    await sleep(50);
    nuimo.emitter.emit('release');
    await sleep(50);
}

async function longPress() {
    resetDraws();
    nuimo.emitter.emit('press');
    await sleep(650);
    nuimo.emitter.emit('release');
    await sleep(1600);
}

test('long press shows the battery icon, then the battery level', async () => {
    batteryLevel = 86;
    await longPress();
    assert.deepEqual(draws, ['almostFullBattery', 86]);
});

test('long press picks the battery icon for the level', async () => {
    for (const [level, icon] of [
        [5, 'oneThirdBattery'], [33, 'oneThirdBattery'],
        [34, 'twoThirdsBattery'], [66, 'twoThirdsBattery'],
        [67, 'almostFullBattery'], [99, 'almostFullBattery'],
    ]) {
        batteryLevel = level;
        await longPress();
        assert.deepEqual(draws, [icon, level], 'level ' + level);
    }
});

test('long press on a full battery shows "full" instead of the number', async () => {
    batteryLevel = 100;
    await longPress();
    assert.deepEqual(draws, ['fullBattery', 'full']);
});

test('long press on a nearly empty battery shows "charge" instead of the number', async () => {
    for (const level of [0, 4]) {
        batteryLevel = level;
        await longPress();
        assert.deepEqual(draws, ['battery', 'charge'], 'level ' + level);
    }
});

test('short press where play/pause is impossible shows the nuimo glyph and does nothing', async () => {
    resetDraws();
    speakerState.canPause = false;
    speakerState.toggles = 0;
    await shortPress();
    await shortPress();
    assert.deepEqual(draws, ['nuimo', 'nuimo']);
    assert.equal(speakerState.toggles, 0);
});

test('short press where play/pause is possible: first press only says so, second does it', async () => {
    resetDraws();
    speakerState.canPause = true;
    speakerState.toggles = 0;
    await shortPress();
    assert.deepEqual(draws, ['control']);
    assert.equal(speakerState.toggles, 0);
    await shortPress();
    assert.deepEqual(draws, ['control', 'playMatrix']);
    assert.equal(speakerState.toggles, 1);
    await shortPress(); // done: the next press arms again instead of toggling
    assert.deepEqual(draws, ['control', 'playMatrix', 'control']);
    assert.equal(speakerState.toggles, 1);
});

test('another gesture between the two presses cancels the arming', async () => {
    resetDraws();
    speakerState.toggles = 0;
    await sleep(3100); // let any earlier arming lapse
    await shortPress();
    rotate(1);
    await shortPress();
    assert.equal(draws.length, 3);
    assert.equal(draws[0], 'control');
    assert.equal(draws[2], 'control');
    assert.equal(speakerState.toggles, 0);
});

test('a swipe between the two presses does not cancel the arming', async () => {
    resetDraws();
    speakerState.toggles = 0;
    speakerState.playing = false;
    await sleep(3100);
    await shortPress();
    nuimo.emitter.emit('swipe', 'swipeLeft');
    await shortPress();
    assert.deepEqual(draws, ['control', 'playMatrix']);
    assert.equal(speakerState.toggles, 1);
    await shortPress(); // leave it armed-and-fired, so the next test starts clean
});

test('the second press is too late after the arming window', async () => {
    resetDraws();
    speakerState.toggles = 0;
    await sleep(3100);
    await shortPress();
    await sleep(3100);
    await shortPress();
    assert.deepEqual(draws, ['control', 'control']);
    assert.equal(speakerState.toggles, 0);
});

test('presses alternate between the play and pause icons', async () => {
    await sleep(3100);
    speakerState.canPause = true;
    speakerState.playing = false;
    resetDraws();
    for (let i = 0; i < 2; i++) {
        await shortPress();   // arm
        await shortPress();   // do it
    }
    assert.deepEqual(draws, ['control', 'playMatrix', 'control', 'pauseMatrix']);
});

test('when the speaker undoes a play/pause, the nuimo glyph is shown', async () => {
    resetDraws();
    speaker.speakerEmitter.emit('playbackIneffective');
    assert.deepEqual(draws, ['nuimo']);
});

test.after(() => {
    // index.js has no pending work of its own, but end promptly regardless.
    setImmediate(() => process.exit(0));
});
