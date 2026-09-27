/**
 * Apple TV control via node-pyatv (wraps the `atvremote` CLI from pyatv).
 *
 * Not wired into index.js yet — planned for play/pause on sources the speaker
 * can't pause itself (e.g. Optical from the Apple TV).
 *
 * Setup (once per Pi):
 *   pip install pyatv
 *   atvremote wizard   # discovers Apple TV, pairs, saves credentials to ~/.pyatv/
 *
 * Pass --atv-name="Living Room" (or whatever the Apple TV is named) to enable.
 */

const { execSync } = require('child_process');
const { default: NodePyATVInstance } = require('@sebbo2002/node-pyatv');
const config = require('./config');

/**
 * Locate the atvscript binary. node-pyatv spawns it directly, so it must be
 * on PATH or we pass the full path via atvscriptPath. We try `which atvscript`
 * first (works on Linux/Pi after a standard pip install), then fall back to
 * the macOS user-local Python bin dir.
 */
function findAtvscript() {
    try {
        return execSync('which atvscript', { encoding: 'utf8' }).trim();
    } catch (_) {}
    // macOS fallback: pip --user installs here but it's not on PATH by default
    for (const v of ['3.9', '3.10', '3.11', '3.12', '3.13']) {
        const fallback = require('os').homedir() + `/Library/Python/${v}/bin/atvscript`;
        try { require('fs').accessSync(fallback); return fallback; } catch (_) {}
    }
    return null;
}

const atvscriptPath = findAtvscript();

// Suppress Python deprecation/SSL warnings that go to stderr and confuse node-pyatv.
// On macOS, urllib3 v2 warns about LibreSSL; this env var silences it for all child procs.
process.env.PYTHONWARNINGS = 'ignore';

const pyatv = new NodePyATVInstance(atvscriptPath ? { atvscriptPath } : {});

let device = null;
let ready = false;

/**
 * Discover and connect to the configured Apple TV by name.
 * Safe to call even if --atv-name is not set (no-ops quietly).
 */
async function initialiseAppleTV() {
    if (!config.atvName) {
        console.log('[atv] --atv-name not set, Apple TV control disabled');
        return;
    }
    if (!atvscriptPath) {
        console.log('[atv] atvscript not found. Run: pip3 install pyatv');
        return;
    }
    console.log('[atv] Using atvscript at:', atvscriptPath);

    console.log('[atv] Discovering Apple TV named "' + config.atvName + '"...');
    try {
        const devices = await pyatv.find();
        const found = devices.find(d => d.name === config.atvName);
        if (!found) {
            console.log('[atv] No Apple TV found with name "' + config.atvName + '". Check --atv-name and run: atvremote wizard');
            return;
        }
        device = found;
        ready = true;
        console.log('[atv] Connected to "' + device.name + '" (' + device.host + ')');
    } catch (e) {
        console.log('[atv] Discovery error:', e.message);
    }
}

/**
 * Returns true if Apple TV is discovered and ready for commands.
 */
function isReady() {
    return ready;
}

/**
 * Send play_pause command to Apple TV.
 */
async function togglePlayPause() {
    if (!ready || !device) {
        console.log('[atv] togglePlayPause: not ready');
        return;
    }
    try {
        await device.playPause();
        console.log('[atv] play_pause sent');
    } catch (e) {
        console.log('[atv] togglePlayPause error:', e.message);
    }
}

/**
 * Send next track command to Apple TV.
 */
async function skipNext() {
    if (!ready || !device) {
        console.log('[atv] skipNext: not ready');
        return;
    }
    try {
        await device.next();
        console.log('[atv] next sent');
    } catch (e) {
        console.log('[atv] skipNext error:', e.message);
    }
}

/**
 * Send previous track command to Apple TV.
 */
async function skipPrevious() {
    if (!ready || !device) {
        console.log('[atv] skipPrevious: not ready');
        return;
    }
    try {
        await device.previous();
        console.log('[atv] previous sent');
    } catch (e) {
        console.log('[atv] skipPrevious error:', e.message);
    }
}

module.exports = { initialiseAppleTV, isReady, togglePlayPause, skipNext, skipPrevious };
