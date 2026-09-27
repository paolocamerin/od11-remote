/**
 * Nuimo controller BLE client.
 * Discovers and connects to a Nuimo, subscribes to rotation/button/touch/fly events,
 * and provides setMatrix() / setNumber() for the 9×9 LED matrix.
 *
 * LED matrix format (per Senic): 11 bytes (81 LEDs, row-major) + brightness + timeout.
 * 11th byte: bit 0 = 81st LED, bit 4 = onion skinning (smooth transitions).
 */

const noble = require('@abandonware/noble');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const GLYPHS = require('./glyphs.json');

const emitter = new EventEmitter();
let ledCharacteristic = null;
let batteryLevel = null;
let batteryInterval = null;

const RECONNECT_DELAY_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;
const DISCOVER_TIMEOUT_MS = 10000;
const SCAN_WATCHDOG_MS = 60000;

/** Log battery level with timestamp to battery.log every N ms */
const BATTERY_LOG_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function formatTimestamp() {
    return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function logBattery(level) {
    const line = formatTimestamp() + '  battery: ' + level + '%\n';
    console.log('Battery:', level, '%');
    if (config.batteryLog) {
        fs.appendFileSync(path.join(__dirname, 'battery.log'), line);
    }
}

// --- LED matrix encoding ---

/**
 * Convert an 81-element array (0/1) to 11-byte buffer.
 * Layout: row-major, 8 bits per byte, LSB-first per byte (nuimojs bit order).
 */
function matrixArrayToBuffer(arr) {
    const buf = Buffer.alloc(11);
    for (let i = 0; i < 11; i++) {
        const bits = arr.slice(i * 8, i * 8 + 8).reverse().join('');
        buf[i] = parseInt(bits || '0', 2);
    }
    return buf;
}

/**
 * Write a matrix pattern to the Nuimo LED characteristic.
 * @param {object} ch - BLE characteristic
 * @param {number[]} matrixArray - 81 elements, 0 or 1
 * @param {number} brightness - 0–255
 * @param {number} timeoutMs - Display duration in ms (max 25500)
 */
async function writeMatrix(ch, matrixArray, brightness = 0xff, timeoutMs = 25500) {
    const buf = Buffer.alloc(13);
    matrixArrayToBuffer(matrixArray).copy(buf);

    // 11th byte: bit 0 = 81st LED, bit 4 = onion skinning. Bit 5 = BUILTIN_MATRIX (keep clear).
    buf[10] = (buf[10] & 0x0f) | 0x10;

    buf[11] = brightness;
    buf[12] = Math.min(255, Math.floor(timeoutMs / 100));

    try {
        await ch.writeAsync(buf, true);
    } catch (e) {
        // A failed LED frame is cosmetic, not fatal — don't let a write that
        // races a disconnect become an unhandled rejection.
        if (config.debug) console.log('LED write failed (ignored):', e.message);
    }
}

/**
 * Render a number (0–99) to an 81-element matrix using the glyphs from glyphs.json.
 * Layout: 2 digits side-by-side, centered vertically. Each digit from glyphs (width×height).
 */
function numberToMatrix(value) {
    const arr = new Array(81).fill(0);
    const { width, height, gap } = GLYPHS;
    const digitWidth = width + gap;
    const totalWidth = digitWidth * 2 - gap;
    const offsetX = Math.floor((9 - totalWidth) / 2);
    const offsetY = Math.floor((9 - height) / 2);

    const num = Math.max(0, Math.min(99, Math.round(value)));
    const d1 = Math.floor(num / 10);
    const d2 = num % 10;

    for (let row = 0; row < height; row++) {
        const rowStr1 = GLYPHS.glyphs[String(d1)][row] || '';
        const rowStr2 = GLYPHS.glyphs[String(d2)][row] || '';
        for (let c = 0; c < width; c++) {
            if (rowStr1[c] === '1') arr[(offsetY + row) * 9 + (offsetX + c)] = 1;
            if (rowStr2[c] === '1') arr[(offsetY + row) * 9 + (offsetX + digitWidth + c)] = 1;
        }
    }
    return arr;
}

// --- BLE discovery and connection ---
//
// Connection state machine: idle -> scanning -> connecting -> discovering -> connected
// `connState` is the single source of truth for where we are. Every path that can
// end the current attempt (timeout, error, real disconnect, BT power-off) funnels
// through cleanupConnection() + scheduleRescan(), so nothing is ever a dead end.

const LED_MATRIX_SERVICE_UUID = 'f29b1523cb1940f3be5c7241ecb82fd1';
const LED_MATRIX_CHAR_UUID = 'f29b1524cb1940f3be5c7241ecb82fd1';

const BUTTON_UUID   = 'f29b1529cb1940f3be5c7241ecb82fd2';
const FLY_UUID      = 'f29b1526cb1940f3be5c7241ecb82fd2';
const TOUCH_UUID    = 'f29b1527cb1940f3be5c7241ecb82fd2';  // swipe + touch ring
const ROTATION_UUID = 'f29b1528cb1940f3be5c7241ecb82fd2';
const NUIMO_INPUT_UUIDS = [BUTTON_UUID, FLY_UUID, TOUCH_UUID, ROTATION_UUID];

const SWIPE_GESTURES = ['swipeLeft', 'swipeRight', 'swipeUp', 'swipeDown'];
const TOUCH_GESTURES = ['touchLeft', 'touchRight', 'touchTop', 'touchBottom'];
const LONG_TOUCH_GESTURES = ['longTouchLeft', 'longTouchRight', 'longTouchTop', 'longTouchBottom'];

let connState = 'idle';
let currentDevice = null;
let rescanTimer = null;
let scanWatchdogTimer = null;
let subscribedCharacteristics = []; // [{ ch, listener }] — for teardown on disconnect

function normaliseUuid(uuid) {
    return String(uuid).replace(/-/g, '').toLowerCase();
}

/** Cancel any pending scan-watchdog timer. */
function clearScanWatchdog() {
    if (scanWatchdogTimer) {
        clearTimeout(scanWatchdogTimer);
        scanWatchdogTimer = null;
    }
}

/** Arm a watchdog that restarts scanning if nothing is found for a while. */
function armScanWatchdog() {
    clearScanWatchdog();
    scanWatchdogTimer = setTimeout(() => {
        scanWatchdogTimer = null;
        if (connState !== 'scanning') return;
        console.log('Scan watchdog: no device found in', SCAN_WATCHDOG_MS / 1000, 's — restarting scan');
        noble.stopScanningAsync().catch(() => {}).then(() => {
            connState = 'idle';
            startScan();
        });
    }, SCAN_WATCHDOG_MS);
}

/**
 * Schedule a rescan after a delay. Idempotent — calling this repeatedly while
 * a rescan is already pending has no extra effect (no stacked timers).
 */
function scheduleRescan(delayMs = RECONNECT_DELAY_MS) {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
        rescanTimer = null;
        startScan();
    }, delayMs);
}

/**
 * Tear down everything associated with the current/attempted connection:
 * battery poller, input listeners, the device's own disconnect listener.
 * Emits 'disconnect' exactly once per established connection attempt
 * (i.e. only if we actually had a device to tear down).
 */
function cleanupConnection() {
    if (batteryInterval) {
        clearInterval(batteryInterval);
        batteryInterval = null;
    }
    for (const { ch, listener } of subscribedCharacteristics) {
        try { ch.removeListener('data', listener); } catch (_) {}
    }
    subscribedCharacteristics = [];

    const hadConnection = currentDevice !== null;
    if (currentDevice) {
        try { currentDevice.removeListener('disconnect', onDeviceDisconnect); } catch (_) {}
    }
    ledCharacteristic = null;
    currentDevice = null;

    if (hadConnection) emitter.emit('disconnect');
}

/**
 * Reject if `promise` doesn't settle within `ms`. Clears its timer either way.
 */
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timeout (' + ms / 1000 + 's)')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Give up on the current connection attempt: tear down, disconnect defensively
 * (a BLE connect can complete after we stopped waiting — a connected peripheral
 * stops advertising, so a lingering one would be invisible to the next scan),
 * and schedule a rescan.
 */
function abortAttempt(device) {
    cleanupConnection();
    device.disconnectAsync().catch(() => {});
    connState = 'idle';
    scheduleRescan();
}

async function readBattery(ch) {
    try {
        const b = await ch.readAsync();
        batteryLevel = b[0];
        logBattery(batteryLevel);
    } catch (e) {
        console.log('Battery read error:', e.message);
    }
}

/**
 * Translate a notification from one of the input characteristics into an emitter event.
 */
function handleInput(uuid, data) {
    if (config.debug) {
        const hex = [...data].map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log('DATA', uuid.slice(-8), '[' + hex + ']');
    }
    if (uuid === FLY_UUID) {
        // Fly/wave gesture: byte 0 = direction (0=left, 1=right, 4=updown), byte 1 = speed
        const dir = data[0] === 0 ? 'left' : data[0] === 1 ? 'right' : 'updown';
        emitter.emit('fly', dir, data[1] || 0);
    } else if (uuid === TOUCH_UUID) {
        // Touch/swipe ring: 0-3 = swipe L/R/U/D, 4-7 = touch L/R/T/B, 8-11 = long touch L/R/T/B
        const v = data[0];
        if (v < 4)       emitter.emit('swipe', SWIPE_GESTURES[v]);
        else if (v < 8)  emitter.emit('touch', TOUCH_GESTURES[v - 4]);
        else if (v < 12) emitter.emit('touch', LONG_TOUCH_GESTURES[v - 8]);
        if (config.debug) console.log('Touch/swipe:', v);
    } else if (uuid === BUTTON_UUID) {
        emitter.emit(data[0] === 1 ? 'press' : 'release');
    } else if (uuid === ROTATION_UUID) {
        // Rotation: Int16LE signed — only the direction is used
        const delta = data.readInt16LE(0);
        if (delta !== 0) emitter.emit('rotate', delta > 0 ? 1 : -1);
    }
}

function onDeviceDisconnect() {
    console.log('Nuimo disconnected. Reconnecting in', RECONNECT_DELAY_MS / 1000, 's...');
    cleanupConnection();
    connState = 'idle';
    scheduleRescan();
}

async function startScan() {
    if (noble.state !== 'poweredOn') {
        console.log('Scan skipped — BT state is', noble.state);
        connState = 'idle';
        return;
    }
    // Single-flight guard: don't stack scans on top of an attempt in progress.
    if (connState === 'scanning' || connState === 'connecting' || connState === 'discovering') {
        return;
    }
    connState = 'scanning';
    try {
        await noble.startScanningAsync();
        console.log('Scanning for Nuimo...');
        armScanWatchdog();
    } catch (e) {
        console.log('Scan error:', e.message);
        connState = 'idle';
        scheduleRescan();
    }
}

async function connect(device) {
    connState = 'connecting';
    currentDevice = device;
    console.log('Connecting to Nuimo...');
    try {
        await withTimeout(device.connectAsync(), CONNECT_TIMEOUT_MS, 'Connect');
        console.log('Connected. Discovering services...');
    } catch (e) {
        console.error('Connect failed:', e.message);
        currentDevice = null; // no listeners attached yet — nothing to clean up or announce
        abortAttempt(device);
        return;
    }

    // Attach the disconnect handler immediately — before discovery — so a
    // drop mid-discovery is never missed.
    device.once('disconnect', onDeviceDisconnect);

    connState = 'discovering';
    let services;
    try {
        services = await withTimeout(device.discoverServicesAsync(), DISCOVER_TIMEOUT_MS, 'Service discovery');
        console.log('Services found:', services.length);
    } catch (e) {
        console.error('Service discovery failed:', e.message);
        abortAttempt(device);
        return;
    }

    try {
        for (const service of services) {
            const serviceUuid = normaliseUuid(service.uuid);
            let characteristics;
            try {
                characteristics = await service.discoverCharacteristicsAsync();
            } catch (e) {
                console.log('Characteristic discovery error:', e.message);
                continue;
            }
            if (config.debug) console.log('Service:', serviceUuid, '— characteristics:', characteristics.map(c => normaliseUuid(c.uuid) + '[' + c.properties.join(',') + ']').join(', '));

            for (const ch of characteristics) {
                const uuid = normaliseUuid(ch.uuid);

                // Hardware version (device info service)
                if (uuid === '2a27') {
                    try {
                        const hw = await ch.readAsync();
                        console.log('Hardware version:', hw.toString('utf8').trim());
                    } catch (e) {
                        console.log('Hardware version read error:', e.message);
                    }
                    continue;
                }

                // Firmware version (device info service)
                if (uuid === '2a26') {
                    try {
                        const fw = await ch.readAsync();
                        console.log('Firmware version:', fw.toString('utf8').trim());
                    } catch (e) {
                        console.log('Firmware read error:', e.message);
                    }
                    continue;
                }

                // Battery level
                if (uuid === '2a19') {
                    await readBattery(ch);
                    batteryInterval = setInterval(() => readBattery(ch), BATTERY_LOG_INTERVAL_MS);
                    continue;
                }

                // LED matrix characteristic (write)
                if (uuid === LED_MATRIX_CHAR_UUID ||
                    (serviceUuid === LED_MATRIX_SERVICE_UUID && ch.properties.includes('write'))) {
                    ledCharacteristic = ch;
                    emitter.emit('ledReady');
                    continue;
                }

                // Input characteristics (button, rotation, etc.) – subscribe to notifications
                if (NUIMO_INPUT_UUIDS.includes(uuid) && ch.properties.includes('notify')) {
                    try {
                        await ch.subscribeAsync();
                    } catch (e) {
                        console.log('Subscribe error:', e.message);
                        continue;
                    }
                    const listener = (data) => handleInput(uuid, data);
                    ch.on('data', listener);
                    subscribedCharacteristics.push({ ch, listener });
                }
            }
        }
    } catch (e) {
        console.error('Setup failed after service discovery:', e.message);
        abortAttempt(device);
        return;
    }

    connState = 'connected';
    console.log('Nuimo fully connected.');
}

function initialiseNuimo() {
    noble.on('stateChange', function (state) {
        console.log('Bluetooth:', state);
        if (state === 'poweredOn') {
            if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
            // Delay scan slightly — gives peripheral time to detect the
            // disconnection (e.g. after laptop sleep/wake) and start advertising
            setTimeout(startScan, 3000);
        } else {
            // Cancel any pending scan/rescan — BT went away before it could run
            clearScanWatchdog();
            if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
            const wasActive = connState !== 'idle' || currentDevice !== null;
            cleanupConnection();
            connState = 'idle';
            if (wasActive) console.log('Bluetooth unavailable — connection cleared');
        }
    });

    noble.on('discover', function (discovered) {
        if (connState !== 'scanning') return; // single-flight guard — ignore stray results
        if (discovered.advertisement.localName === 'Nuimo') {
            console.log('Nuimo found:', discovered.id);
            clearScanWatchdog();
            noble.stopScanningAsync().catch(e => console.log('Stop scan error:', e.message));
            connect(discovered).catch(e => {
                // Should not happen (connect() handles its own errors internally),
                // but never let a stray rejection become an unhandled one.
                console.error('Unexpected error in connect():', e.message);
                cleanupConnection();
                connState = 'idle';
                scheduleRescan();
            });
        }
    });
}

/**
 * Best-effort cleanup for graceful process shutdown: cancels pending
 * timers and disconnects the Nuimo peripheral (if connected). Disconnecting
 * lets it start re-advertising immediately instead of the next launch
 * having to wait out a stale BLE supervision timeout.
 */
async function shutdown() {
    if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
    clearScanWatchdog();
    const device = currentDevice;
    cleanupConnection(); // removes device's own disconnect listener before we disconnect it
    connState = 'idle';
    if (device) {
        try { await device.disconnectAsync(); } catch (_) {}
    }
}

// --- Public API ---

const MATRIX_TIMEOUT_MS = 1000;

/**
 * Draw a number (00–99) on the Nuimo matrix using glyphs from glyphs.json.
 * @param {number} value - clamped to 0–99
 */
async function setNumber(value) {
    if (!ledCharacteristic) return;
    const arr = numberToMatrix(value);
    await writeMatrix(ledCharacteristic, arr, 0xff, MATRIX_TIMEOUT_MS);
}

/**
 * Get last known battery level (0–100), or null if not yet read.
 */
function getBatteryLevel() {
    return batteryLevel;
}

/**
 * Write an arbitrary 81-element matrix array to the Nuimo.
 * @param {number[]} matrixArray - 81 elements, 0 or 1
 * @param {number} [brightness=0xff]
 * @param {number} [timeoutMs=MATRIX_TIMEOUT_MS]
 */
async function setMatrix(matrixArray, brightness = 0xff, timeoutMs = MATRIX_TIMEOUT_MS) {
    if (!ledCharacteristic) return;
    await writeMatrix(ledCharacteristic, matrixArray, brightness, timeoutMs);
}

module.exports = { initialiseNuimo, emitter, setNumber, setMatrix, getBatteryLevel, shutdown };
