/**
 * Optional: copy to config.local.js to set your speaker IP without --ip flag.
 * config.local.js is gitignored.
 *
 * Or run with: node index.js --ip=192.168.0.101
 * For a speaker group, list every member (any member can control the group):
 *   node index.js --ip=192.168.0.101,192.168.0.100
 */
module.exports = {
    speakerIps: ['YOUR_SPEAKER_IP']  // e.g. ['192.168.0.101', '192.168.0.100'] or hostnames
};
