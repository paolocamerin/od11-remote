/**
 * OD-11 speaker WebSocket client.
 * Connects to the speaker, parses volume from state updates, and exposes
 * getVolume() and changeVolume(). Does not change volume unless changeVolume() is called.
 * Automatically reconnects on disconnect. With several IPs (a speaker group), any
 * member can control the whole group, so it falls back to the next IP when one is
 * unreachable, and learns other members' IPs from the speaker's own group state.
 */

const ws = require('ws');
const fs = require('fs');
const config = require('./config');
const EventEmitter = require('events');

const speakerEmitter = new EventEmitter();

let socket;
let currentVolume = 0;
let maxVolume = 100;
let pingInterval = null;
let isPlaying = false;
let currentSourceId = null;
let sourcesMap = {};
let isShuttingDown = false;

/** IPs to try, in order: configured ones first, then any learned from the group. */
const candidateIps = [...config.speakerIps];
let ipIndex = 0;
/** Failed connection attempts since the last successful one. */
let failedAttempts = 0;

const RECONNECT_DELAY_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 5000;
/**
 * The speaker answers every ping with speaker_pong. Counting unanswered pings (rather
 * than timing silence) keeps a busy event loop — e.g. during BLE connects — from
 * looking like a dead link, since queued replies reset the count before the next ping.
 */
const MAX_UNANSWERED_PINGS = 3;
let unansweredPings = 0;

function connect() {
    const ip = candidateIps[ipIndex];
    let opened = false;
    socket = new ws.WebSocket(`ws://${ip}/ws`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    const uid = 'uid-' + Math.floor(1e8 * Math.random());

    socket.on('open', function () {
        opened = true;
        failedAttempts = 0;
        unansweredPings = 0;
        console.log('Connected to speaker at', ip);

        // Join global and group to receive state updates
        socket.send(JSON.stringify({
            protocol_major_version: 0,
            protocol_minor_version: 4,
            action: 'global_join'
        }));
        socket.send(JSON.stringify({
            color_index: 0,
            name: 'od11-remote',
            realtime_data: true,
            uid: uid,
            action: 'group_join'
        }));

        // Keep connection alive, and drop it if the speaker has gone silent
        // (e.g. lost power without closing the socket) so we fail over.
        pingInterval = setInterval(() => {
            if (unansweredPings >= MAX_UNANSWERED_PINGS) {
                console.log('Speaker at', ip, 'stopped answering (' + unansweredPings + ' pings) — dropping connection');
                socket.terminate();
                return;
            }
            unansweredPings++;
            socket.send(JSON.stringify({
                value: (new Date()).getTime() % 1e6,
                action: 'speaker_ping'
            }));
        }, 5000);
    });

    socket.on('message', function (data) {
        unansweredPings = 0;
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (_) {
            console.log('Message received (parse error):', data.toString());
            return;
        }

        const items = Array.isArray(msg) ? msg : [msg];
        for (const item of items) {
            if (!item) continue;
            // The item itself first (it may carry the sources list), then the
            // initial state bundled in group_joined.state[] / global_joined.state[].
            for (const entry of [item, ...(Array.isArray(item.state) ? item.state : [])]) {
                if (entry) handleEntry(entry);
            }
            // Print a summary once the group state is fully parsed
            if (item.response === 'group_joined') {
                const src = currentSourceId !== null ? sourcesMap[currentSourceId] : null;
                console.log('Speaker state — vol:', currentVolume + '/' + maxVolume,
                    '| playing:', isPlaying,
                    '| source:', src ? src.name + ' (id=' + currentSourceId + ')' : 'unknown');
            }
        }

        if (config.debug) fs.appendFileSync('speaker.log', data.toString() + '\n');
    });

    socket.on('error', function (err) {
        console.log('Speaker WebSocket error (' + ip + '):', err.message);
    });

    socket.on('close', function () {
        clearInterval(pingInterval);
        pingInterval = null;
        if (isShuttingDown) {
            console.log('Disconnected from speaker (shutdown).');
            return;
        }
        if (opened) {
            speakerEmitter.emit('disconnected');
            // A working connection dropped — retry the same speaker first.
            console.log('Disconnected from speaker at', ip + '. Reconnecting in', RECONNECT_DELAY_MS / 1000, 's...');
            setTimeout(connect, RECONNECT_DELAY_MS);
            return;
        }
        // Couldn't reach this speaker — move straight on to the next one, and only
        // pause once every known IP has failed in a row.
        failedAttempts++;
        ipIndex = (ipIndex + 1) % candidateIps.length;
        if (failedAttempts % candidateIps.length === 0) {
            console.log('No speaker reachable (tried ' + candidateIps.join(', ') + '). Retrying in', RECONNECT_DELAY_MS / 1000, 's...');
            setTimeout(connect, RECONNECT_DELAY_MS);
        } else {
            setImmediate(connect);
        }
    });
}

/**
 * Apply one message entry: a state update, the sources list, or a group member's info.
 */
function handleEntry(entry) {
    if (entry.update) parseUpdate(entry);
    if (Array.isArray(entry.sources)) {
        for (const src of entry.sources) {
            if (src && typeof src.id === 'number') sourcesMap[src.id] = src;
        }
    }
    if (entry.speaker) learnSpeakerIp(entry.speaker);
}

/**
 * Remember a group member's IP (from the speaker's own group state) as a fallback.
 */
function learnSpeakerIp(speakerInfo) {
    const ip = speakerInfo && speakerInfo.ip;
    if (typeof ip !== 'string' || !ip || candidateIps.includes(ip)) return;
    candidateIps.push(ip);
    console.log('Learned group speaker', speakerInfo.box_serial || '', 'at', ip, '— added as fallback');
}

function parseUpdate(item) {
    if (item.update === 'group_max_volume' && typeof item.value === 'number') {
        maxVolume = item.value;
    }
    if (item.update === 'group_volume_changed' && typeof item.vol === 'number') {
        currentVolume = item.vol;
        speakerEmitter.emit('volumeChange', { vol: currentVolume, max: maxVolume });
    }
    if (item.update === 'playback_state_changed' && typeof item.playing === 'boolean') {
        console.log('[speaker] playback_state_changed:', item.playing);
        isPlaying = item.playing;
    }
    if (item.update === 'group_input_source_changed' && typeof item.source === 'number') {
        currentSourceId = item.source;
        const src = sourcesMap[currentSourceId];
        const name = src ? src.name : 'unknown';
        const canPause = src ? src.supports_pause : false;
        console.log('[speaker] source:', name, '(id=' + currentSourceId + ', supports_pause=' + canPause + ')');
    }
}

/**
 * Initialise the speaker WebSocket connection.
 */
function initialiseSpeaker() {
    console.log('Speaker IP' + (candidateIps.length > 1 ? 's' : '') + ':', candidateIps.join(', '));
    connect();
}

/**
 * Send a volume change command to the speaker.
 * @param {number} amount - Delta to apply (+/-)
 */
function changeVolume(amount) {
    if (!isConnected()) {
        console.log('[changeVolume] blocked: socket not open (readyState=' + (socket ? socket.readyState : 'null') + ')');
        return;
    }
    socket.send(JSON.stringify({
        amount: amount,
        action: 'group_change_volume'
    }));
}

/**
 * Whether the speaker WebSocket is currently open.
 * @returns {boolean}
 */
function isConnected() {
    return !!socket && socket.readyState === ws.OPEN;
}

/**
 * Get the last known volume from the speaker.
 * @returns {{ vol: number, max: number }}
 */
function getVolume() {
    return { vol: currentVolume, max: maxVolume };
}

/**
 * Whether the current source supports pause (line in / optical don't).
 * Unknown source → assume it does.
 * @returns {boolean}
 */
function canCurrentSourcePause() {
    const src = currentSourceId !== null ? sourcesMap[currentSourceId] : null;
    return src ? src.supports_pause !== false : true;
}

/**
 * Toggle play/pause on the speaker.
 * Returns the new playing state (true/false), or null if not connected or the
 * current source does not support pause (e.g. line in, optical).
 * @returns {boolean|null}
 */
function togglePlayPause() {
    if (!isConnected()) {
        console.log('[togglePlayPause] blocked: socket not open');
        return null;
    }
    if (!canCurrentSourcePause()) {
        const src = sourcesMap[currentSourceId];
        console.log('[togglePlayPause] source does not support pause:', src.name || currentSourceId);
        return null;
    }
    const newPlaying = !isPlaying;
    const payload = { action: newPlaying ? 'playback_start' : 'playback_stop' };
    console.log('[togglePlayPause] sending:', JSON.stringify(payload), '(was isPlaying=' + isPlaying + ')');
    socket.send(JSON.stringify(payload));
    isPlaying = newPlaying; // optimistic — overridden by next playback_state_changed from speaker
    return newPlaying;
}

/**
 * Best-effort cleanup for graceful process shutdown: stops the keepalive
 * ping and closes the socket without scheduling a reconnect.
 */
function shutdown() {
    isShuttingDown = true;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (socket) {
        try { socket.close(); } catch (_) {}
    }
}

module.exports = { initialiseSpeaker, changeVolume, isConnected, getVolume, togglePlayPause, speakerEmitter, shutdown };
