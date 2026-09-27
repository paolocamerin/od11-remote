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

const nuimo = {
    emitter: new EventEmitter(),
    initialiseNuimo() {},
    shutdown: async () => {},
    getBatteryLevel: () => 86,
    setMatrix(leds) {
        const pattern = PATTERNS.find((p) => p.leds === leds);
        draws.push(pattern ? pattern.name : 'unknown');
    },
    setNumber(value) { draws.push(value); },
};

const speakerState = { connected: false, vol: 0 };
const sentDeltas = [];

const speaker = {
    speakerEmitter: new EventEmitter(),
    initialiseSpeaker() {},
    shutdown() {},
    isConnected: () => speakerState.connected,
    getVolume: () => ({ vol: speakerState.vol, max: 100 }),
    changeVolume(amount) { sentDeltas.push(amount); },
    togglePlayPause: () => true,
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

test('Nuimo ready shows the power-on icon', () => {
    nuimo.emitter.emit('ledReady');
    assert.deepEqual(draws, ['powerOnMatrix']);
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
    nuimo.emitter.emit('swipe', 'swipeLeft');
    await sleep(SETTLE_WAIT_MS);
    assert.deepEqual(draws, [35, 'swipeLeft']);
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

test('touch and fly gestures show their icons', async () => {
    await sleep(SETTLE_WAIT_MS);
    resetDraws();
    nuimo.emitter.emit('touch', 'longTouchTop');
    nuimo.emitter.emit('fly', 'updown');
    assert.deepEqual(draws, ['longTouchTop', 'flyProximity']);
});

test('long press shows the battery icon, then the battery level', async () => {
    resetDraws();
    nuimo.emitter.emit('press');
    await sleep(650);
    nuimo.emitter.emit('release');
    await sleep(1600);
    assert.deepEqual(draws, ['battery', 86]);
});

test.after(() => {
    // index.js has no pending work of its own, but end promptly regardless.
    setImmediate(() => process.exit(0));
});
