# OD-11 Remote

Control a **Teenage Engineering OD-11** speaker (or a grouped pair) with a **Senic Nuimo** controller. Turn the Nuimo to change the volume, press it to play/pause, and read the volume on its LED display.

Designed to run unattended on a Raspberry Pi, but works on any machine with Bluetooth LE and Node.js.

## How it works

```
Nuimo  ──Bluetooth LE──►  od11-remote (Pi)  ──WebSocket──►  OD-11 speaker(s)
```

- **Nuimo side:** the app finds the Nuimo over Bluetooth, subscribes to its rotate/press/touch events, and draws numbers and icons on its 9×9 LED matrix. If the Nuimo drops out (battery, range, Bluetooth hiccup), the app keeps rescanning and reconnects by itself.
- **Speaker side:** the app connects to the speaker's local WebSocket (`ws://<speaker-ip>/ws`, the same one the Orthoplay app uses), receives volume/playback updates, and sends volume changes.
- **Speaker groups:** in a stereo pair, either speaker controls the whole group. List both IPs and the app uses whichever one answers. It also learns the other group members' IPs from the speaker itself. If a speaker stops responding, the app notices within ~20 s and moves on to the next one.

### What the number on the Nuimo means

- While you turn, the number updates instantly. Shortly after you stop, it corrects itself to the speaker's **real** volume. If it jumps back, the speaker didn't take the change.
- **No number (✕ instead) means no speaker is connected.** The volume is only shown once a speaker has reported it.

## Controls

| Action | Result |
|---|---|
| **Rotate** | Volume up/down (shows ✕ if no speaker is connected) |
| **Short press** | Play/pause. After 5 min idle, the first press only wakes the display (◆) |
| **Long press** (≥ 0.6 s) | Show Nuimo battery icon, then battery % |
| **Touch / swipe / fly** | Shows a feedback icon (no action yet) |

Play/pause only works for sources that support it (AirPlay, Spotify, Playlist). On Line in / Optical, a press shows **?**.

## Requirements

**Hardware**
- An OD-11 speaker, or two in a group, on your local network. Give them **static IPs** (or DHCP reservations) so the addresses don't change.
- A Senic Nuimo, charged and not connected to another device (e.g. the Senic hub or a phone).
- A computer with Bluetooth LE, within range of the Nuimo and on the same network as the speakers. A Raspberry Pi 3/4/5 or Zero 2 W with built-in Bluetooth works well.

**Software**
- Node.js 18 or later (tested on 20)
- On Linux / Raspberry Pi OS, BlueZ plus build tools, since the Bluetooth library compiles a native module:
  ```bash
  sudo apt install bluetooth bluez libbluetooth-dev libudev-dev build-essential
  ```
- On macOS, grant Bluetooth permission to your terminal when prompted.

## Install

### 1. Get the code

```bash
git clone https://github.com/paolocamerin/od11-remote.git
cd od11-remote
npm install
```

### 2. Allow Node to use Bluetooth (Linux only)

So you don't need `sudo` every time:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

Re-run this after upgrading Node.

### 3. Try it

Find your speaker IPs (Orthoplay app → speaker settings, or your router's device list), then:

```bash
node index.js --ip=192.168.0.100,192.168.0.101
```

For a single speaker, pass one IP. You should see:

```
Speaker IPs: 192.168.0.100, 192.168.0.101
Connected to speaker at 192.168.0.100
Volume initialised from speaker: 31 / 100
Scanning for Nuimo...
Nuimo found: f2a6470ee3fa
...
Nuimo LED ready
Nuimo fully connected.
```

Turn the Nuimo. The volume should change and the number should follow.

Instead of `--ip`, you can copy `config.example.js` to `config.local.js` and list the IPs there (`config.local.js` is gitignored).

### 4. Run it in the background with PM2

[PM2](https://pm2.keymetrics.io/) keeps the app running and starts it again after a reboot:

```bash
npm install -g pm2
pm2 start index.js --name od11-remote -- --ip=192.168.0.100,192.168.0.101
pm2 save
pm2 startup     # prints a sudo command, run it once
```

## Everyday use

| Task | Command |
|---|---|
| Check it's running | `pm2 status` |
| Watch the logs | `pm2 logs od11-remote` (Ctrl+C to exit) |
| Restart | `pm2 restart od11-remote` |
| Update to the latest code | `git pull && pm2 restart od11-remote` |
| Change the speaker IPs | `pm2 delete od11-remote`, then the `pm2 start …` and `pm2 save` lines above |

## Options

| Flag | Purpose |
|---|---|
| `--ip=A[,B]` | Speaker IP(s). Required unless set in `config.local.js` |
| `--debug` | More logging, raw speaker messages to `speaker.log`, and an LED pattern browser (long-touch bottom) |
| `--battery-log` | Append Nuimo battery readings to `battery.log` |

## Troubleshooting

Start with `pm2 logs od11-remote`, since the app logs each step.

| You see | Likely cause / fix |
|---|---|
| ✕ on the Nuimo when turning | No speaker connected. Check the logs for `No speaker reachable` and make sure the speakers are on and on Wi-Fi |
| `No speaker reachable (tried …)` | None of the IPs answer. Check the IPs and the speakers' network connection |
| Number jumps back after turning | The speaker is connected but ignored the change. Try again, and check the Orthoplay app |
| Stuck after `Nuimo found:` / `Connect timeout` | The Nuimo is still connected elsewhere. Power-cycle it (it retries on its own) |
| Nuimo never found | Nuimo off or out of range, or Bluetooth disabled (`sudo systemctl status bluetooth`) |
| Bluetooth permission errors | Run the `setcap` step above |

## Project structure

```
od11-remote/
├── index.js        # Interaction logic: Nuimo gestures → speaker actions, LED display
├── nuimo.js        # Nuimo Bluetooth client (scan, connect, reconnect, LED matrix)
├── speaker.js      # OD-11 WebSocket client (multi-IP failover, volume, playback)
├── config.js       # Command-line / config.local.js parsing
├── patterns.js     # Named 9×9 LED icons
└── glyphs.json     # Digit glyphs for the volume number
```
