/**
 * OD-11 speaker WebSocket client.
 * Connects to the speaker, parses volume from state updates, and exposes
 * getVolume() and changeVolume(). Does not change volume unless changeVolume() is called.
 * Automatically reconnects on disconnect.
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

const RECONNECT_DELAY_MS = 5000;

function connect() {
    socket = new ws.WebSocket(`ws://${config.speakerIp}/ws`);
    const uid = 'uid-' + Math.floor(1e8 * Math.random());

    socket.on('open', function () {
        console.log('Connected to speaker!');

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

        // Keep connection alive
        pingInterval = setInterval(() => {
            socket.send(JSON.stringify({
                value: (new Date()).getTime() % 1e6,
                action: 'speaker_ping'
            }));
        }, 5000);
    });

    socket.on('message', function (data) {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (_) {
            console.log('Message received (parse error):', data.toString());
            return;
        }

        const items = Array.isArray(msg) ? msg : [msg];
        for (const item of items) {
            // Top-level updates
            if (item && item.update) {
                parseUpdate(item);
            }
            // Sources list (from group_joined)
            if (item && Array.isArray(item.sources)) {
                for (const src of item.sources) {
                    if (src && typeof src.id === 'number') {
                        sourcesMap[src.id] = src;
                    }
                }
            }
            // Initial state inside group_joined.state[] and global_joined.state[]
            if (item && Array.isArray(item.state)) {
                for (const stateItem of item.state) {
                    if (stateItem && stateItem.update) parseUpdate(stateItem);
                }
                // Print a summary once the group state is fully parsed
                if (item.response === 'group_joined') {
                    const src = currentSourceId !== null ? sourcesMap[currentSourceId] : null;
                    console.log('Speaker state — vol:', currentVolume + '/' + maxVolume,
                        '| playing:', isPlaying,
                        '| source:', src ? src.name + ' (id=' + currentSourceId + ')' : 'unknown');
                }
            }
        }

        if (config.debug) fs.appendFileSync('speaker.log', data.toString() + '\n');
    });

    socket.on('error', function (err) {
        console.log('Speaker WebSocket error:', err.message);
    });

    socket.on('close', function () {
        clearInterval(pingInterval);
        pingInterval = null;
        if (isShuttingDown) {
            console.log('Disconnected from speaker (shutdown).');
            return;
        }
        console.log('Disconnected from speaker. Reconnecting in', RECONNECT_DELAY_MS / 1000, 's...');
        setTimeout(connect, RECONNECT_DELAY_MS);
    });
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
        speakerEmitter.emit('playbackChange', { playing: isPlaying });
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
    console.log('Speaker IP:', config.speakerIp);
    connect();
}

/**
 * Send a volume change command to the speaker.
 * @param {number} amount - Delta to apply (+/-)
 */
function changeVolume(amount) {
    if (!socket || socket.readyState !== ws.OPEN) {
        console.log('[changeVolume] blocked: socket not open (readyState=' + (socket ? socket.readyState : 'null') + ')');
        return;
    }
    socket.send(JSON.stringify({
        amount: amount,
        action: 'group_change_volume'
    }));
}

/**
 * Get the last known volume from the speaker.
 * @returns {{ vol: number, max: number }}
 */
function getVolume() {
    return { vol: currentVolume, max: maxVolume };
}

/**
 * Get the last known playback state.
 * @returns {boolean}
 */
function getIsPlaying() {
    return isPlaying;
}

/**
 * Toggle play/pause on the speaker.
 * Returns the new playing state (true/false), or null if the current source
 * does not support pause (e.g. line in, optical, bluetooth).
 * @returns {boolean|null}
 */
function togglePlayPause() {
    if (!socket || socket.readyState !== ws.OPEN) {
        console.log('[togglePlayPause] blocked: socket not open');
        return null;
    }
    const src = currentSourceId !== null ? sourcesMap[currentSourceId] : null;
    if (src && src.supports_pause === false) {
        console.log('[togglePlayPause] source does not support pause:', src.name || currentSourceId);
        return null;
    }
    const newPlaying = !isPlaying;
    const action = newPlaying ? 'playback_start' : 'playback_stop';
    const payload = { action };
    console.log('[togglePlayPause] sending:', JSON.stringify(payload), '(was isPlaying=' + isPlaying + ')');
    socket.send(JSON.stringify(payload));
    isPlaying = newPlaying; // optimistic — overridden by next playback_state_changed from speaker
    return newPlaying;
}

/**
 * Switch to a specific input source by id.
 * @param {number} sourceId
 */
function setInputSource(sourceId) {
    if (!socket || socket.readyState !== ws.OPEN) return;
    socket.send(JSON.stringify({ action: 'group_set_input_source', source: sourceId }));
}

/**
 * Get all known sources.
 * @returns {object} map of id → source object
 */
function getSources() {
    return sourcesMap;
}

/**
 * Get the current source id, or null if unknown.
 * @returns {number|null}
 */
function getCurrentSourceId() {
    return currentSourceId;
}

/**
 * Returns true if the current source supports pause (i.e. is not optical/line-in/bluetooth).
 * @returns {boolean}
 */
function canCurrentSourcePause() {
    const src = currentSourceId !== null ? sourcesMap[currentSourceId] : null;
    return src ? src.supports_pause !== false : true;
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

module.exports = { initialiseSpeaker, changeVolume, getVolume, getIsPlaying, togglePlayPause, setInputSource, getSources, getCurrentSourceId, canCurrentSourcePause, speakerEmitter, shutdown };
