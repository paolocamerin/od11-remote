/**
 * Application configuration.
 * Speaker IP(s): use --ip=192.168.0.101 when running, or create config.local.js (gitignored).
 * For a speaker group, pass every member: --ip=192.168.0.101,192.168.0.100 — any member can
 * control the group, so the app falls back to the next IP when one is unreachable.
 * Battery logging: use --battery-log to enable writing battery readings to battery.log.
 */
const args = process.argv.slice(2);

function getArg(name) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === name && args[i + 1]) return args[i + 1];
        if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
    }
    return null;
}

function hasFlag(name) {
    return args.includes(name);
}

function parseIpList(value) {
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list.map((ip) => String(ip).trim()).filter(Boolean);
}

function getSpeakerIps() {
    const ip = getArg('--ip');
    if (ip) return parseIpList(ip);
    try {
        const local = require('./config.local');
        if (local && local.speakerIps) return parseIpList(local.speakerIps);
        if (local && local.speakerIp) return parseIpList(local.speakerIp);
    } catch (_) {}
    return [];
}

const speakerIps = getSpeakerIps();
if (speakerIps.length === 0) {
    console.error('Usage: node index.js --ip=192.168.0.101[,192.168.0.100] [--battery-log]');
    console.error('   or: create config.local.js with module.exports = { speakerIps: ["192.168.0.101", "192.168.0.100"] }');
    process.exit(1);
}
const speakerIp = speakerIps[0];

const batteryLog = hasFlag('--battery-log');
const debug = hasFlag('--debug');
const atvName = getArg('--atv-name');

const KNOWN_ARGS = ['--ip', '--battery-log', '--debug', '--atv-name'];
for (const arg of args) {
    const argName = arg.startsWith('--') ? arg.split('=')[0] : null;
    if (argName && !KNOWN_ARGS.includes(argName)) {
        console.warn('Warning: unrecognised argument "' + arg + '". Known arguments: ' + KNOWN_ARGS.join(', ') + '. Continuing without it.');
    }
}

module.exports = { speakerIp, speakerIps, batteryLog, debug, atvName };
