/**
 * Tests for speaker.js: `ws` and `config` are replaced by fakes (via require.cache),
 * so no network is touched. The fake speaker is driven by hand: tests push the same
 * messages the real OD-11 sends and inspect what the client sends back.
 *
 * Covers the play/pause logic, in particular an AirPlay source (an Apple TV) that
 * undoes our playback_stop right away.
 *
 * speaker.js keeps module-level state and is loaded once, so tests run in order.
 *
 * Run: npm test
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..');

// ── Fakes ────────────────────────────────────────────────────────────────

const OPEN = 1;
let socket = null;   // the most recent fake WebSocket
const sent = [];     // every message the client sent, parsed

class FakeWebSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = OPEN;
        socket = this;
        setImmediate(() => this.emit('open'));
    }
    send(text) { sent.push(JSON.parse(text)); }
    terminate() {}
    close() {}
}

/** Make require(request) from speaker.js return `exports` instead of the real module. */
function stub(filename, exports) {
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub(require.resolve('ws', { paths: [ROOT] }), { WebSocket: FakeWebSocket, OPEN });
stub(path.join(ROOT, 'config.js'), { speakerIps: ['192.0.2.1'], debug: false });

// Silence the module's logging; keep the test output readable.
const realLog = console.log;
console.log = () => {};
test.after(() => { console.log = realLog; });

const speaker = require(path.join(ROOT, 'speaker.js'));

// ── Helpers ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Deliver a message from the speaker to the client. */
function fromSpeaker(message) {
    socket.emit('message', Buffer.from(JSON.stringify(message)));
}

const SOURCES = [
    { id: 0, name: 'AirPlay', supports_pause: true },
    { id: 1, name: 'Spotify', supports_pause: true },
    { id: 4, name: 'Optical', supports_pause: false },
];

function selectSource(id) {
    fromSpeaker({ update: 'group_input_source_changed', source: id });
}

function reportPlaying(playing) {
    fromSpeaker({ update: 'playback_state_changed', playing });
}

function playbackCommands() {
    return sent.map((m) => m.action).filter((a) => a === 'playback_start' || a === 'playback_stop');
}

const ineffectiveEvents = [];
speaker.speakerEmitter.on('playbackIneffective', () => ineffectiveEvents.push(Date.now()));

// ── Tests ────────────────────────────────────────────────────────────────

test('connects and learns the sources', async () => {
    speaker.initialiseSpeaker();
    await sleep(20);
    assert.ok(speaker.isConnected());
    fromSpeaker({ response: 'group_joined', sources: SOURCES, state: [] });
    assert.equal(speaker.getSource(), null, 'no source selected yet');
    assert.equal(speaker.canTogglePlayPause(), false, 'unknown source: nothing to toggle');
});

test('Optical can not be paused', () => {
    selectSource(4);
    assert.equal(speaker.canTogglePlayPause(), false);
    assert.equal(speaker.togglePlayPause(), null);
    assert.deepEqual(playbackCommands(), []);
    assert.deepEqual(speaker.getSource(), { id: 4, name: 'Optical', supportsPause: false, controllable: false });
});

test('a source that honours play/pause toggles normally', async () => {
    selectSource(1);
    reportPlaying(true);
    assert.equal(speaker.canTogglePlayPause(), true);

    assert.equal(speaker.togglePlayPause(), false);   // pause
    reportPlaying(false);                              // speaker agrees
    await sleep(20);
    assert.equal(speaker.togglePlayPause(), true);    // resume
    reportPlaying(true);

    assert.deepEqual(playbackCommands(), ['playback_stop', 'playback_start']);
    assert.equal(ineffectiveEvents.length, 0);
    assert.equal(speaker.canTogglePlayPause(), true);
});

test('AirPlay that undoes playback_stop is detected, audio is restored, play/pause is switched off', () => {
    sent.length = 0;
    selectSource(0);
    reportPlaying(true);
    assert.equal(speaker.canTogglePlayPause(), true, 'the first attempt is always allowed');

    assert.equal(speaker.togglePlayPause(), false);   // we send playback_stop
    reportPlaying(true);                               // ...and the speaker says "playing" again

    assert.deepEqual(playbackCommands(), ['playback_stop', 'playback_start'], 'stop, then one restoring start');
    assert.equal(ineffectiveEvents.length, 1);
    assert.equal(speaker.canTogglePlayPause(), false, 'no more attempts on this source');
    assert.equal(speaker.togglePlayPause(), null);
    assert.deepEqual(playbackCommands(), ['playback_stop', 'playback_start'], 'nothing further was sent');
    assert.equal(speaker.getSource().controllable, false);
});

test('the speaker confirming the restore does not retrigger anything', () => {
    reportPlaying(true);
    reportPlaying(true);
    assert.equal(ineffectiveEvents.length, 1);
    assert.deepEqual(playbackCommands(), ['playback_stop', 'playback_start']);
});

test('changing the source clears the flag', () => {
    selectSource(4);
    selectSource(0);
    assert.equal(speaker.canTogglePlayPause(), true, 'a fresh AirPlay session gets a fresh attempt');
});

test('a duplicate message for the same source does not clear the flag', () => {
    reportPlaying(true);
    speaker.togglePlayPause();
    reportPlaying(true);                               // echo again -> flagged
    assert.equal(speaker.canTogglePlayPause(), false);
    selectSource(0);                                   // the speaker repeats the current source
    assert.equal(speaker.canTogglePlayPause(), false);
});

test('a contradicting report after the echo window is not treated as an echo', async () => {
    selectSource(1);
    reportPlaying(true);
    const before = ineffectiveEvents.length;
    assert.equal(speaker.togglePlayPause(), false);
    await sleep(2100);                                 // longer than the echo window
    reportPlaying(true);                               // e.g. someone pressed play elsewhere
    assert.equal(ineffectiveEvents.length, before);
    assert.equal(speaker.canTogglePlayPause(), true);
});

test('reconnecting forgets an ineffective flag', async () => {
    selectSource(0);
    reportPlaying(true);
    speaker.togglePlayPause();
    reportPlaying(true);
    assert.equal(speaker.canTogglePlayPause(), false);

    socket.emit('open');                               // a new connection to the speaker
    assert.equal(speaker.canTogglePlayPause(), true);
});

test.after(() => {
    speaker.shutdown();
    setImmediate(() => process.exit(0));
});
