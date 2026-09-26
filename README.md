# OD-11 Remote

Control an **OD-11 speaker** via a **Senic Nuimo** controller over Bluetooth. Volume, battery display, and LED feedback.

## Prerequisites

- **Node.js** (v14 or later)
- **Nuimo** controller (powered on, in range)
- **OD-11 speaker** on the same network
- **Bluetooth** (built-in or USB adapter)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/OD11-remote.git
cd OD11-remote
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure the speaker IP

You must provide your speaker’s IP address. Two options:

**Option A: Command-line (recommended)**

Pass the IP when you run the app:

```bash
node index.js --ip=192.168.0.101
```

Or with a space:

```bash
node index.js --ip 192.168.0.101
```

If you have several speakers in a group, list them all, comma-separated. Any member can control the whole group, so if one is unreachable the app moves on to the next. It also picks up other group members' IPs from the speaker itself:

```bash
node index.js --ip=192.168.0.101,192.168.0.100
```

**Option B: Local config file**

Copy `config.example.js` to `config.local.js` and set your speaker IP:

```bash
cp config.example.js config.local.js
# Edit config.local.js and set speakerIp to your speaker's IP
```

`config.local.js` is gitignored, so it won’t be committed.

## Running the program

1. Turn on the Nuimo and place it near your computer or Raspberry Pi.
2. Ensure the OD-11 speaker is on and connected to your network.
3. Run:

```bash
node index.js --ip=YOUR_SPEAKER_IP
```

Example:

```bash
node index.js --ip=192.168.0.101
```

### Expected output

```
Bluetooth: poweredOn
Scanning for Nuimo...
Nuimo found: f2a6470ee3fa
Connecting to Nuimo...
Connected. Discovering services...
Services found: 8
Battery: 85 %
Nuimo LED ready
Connected to speaker!
Volume initialised from speaker: 42 / 100
```

## Running with PM2

Use [PM2](https://pm2.keymetrics.io/) to run the app in the background and restart it on device reboot.

### 1. Install PM2

```bash
npm install -g pm2
```

### 2. Start the app

Replace `192.168.0.101` with your speaker IP:

```bash
pm2 start index.js --name od11-remote -- --ip=192.168.0.101
```

The `--` passes the following arguments to your app.

### 3. Save and enable startup on reboot

```bash
pm2 save
pm2 startup
```

`pm2 startup` prints a command you must run (with `sudo`) to enable PM2 at boot. Copy and run it.

### Useful PM2 commands

| Command | Description |
|---------|-------------|
| `pm2 status` | List processes and status |
| `pm2 logs od11-remote` | View logs |
| `pm2 restart od11-remote` | Restart the app |
| `pm2 stop od11-remote` | Stop the app |
| `pm2 delete od11-remote` | Remove from PM2 |

### Raspberry Pi with sudo

If the app needs `sudo` for Bluetooth, start it as:

```bash
sudo pm2 start index.js --name od11-remote -- --ip=192.168.0.101
sudo pm2 save
sudo pm2 startup
```

## Nuimo controls

| Action | Volume mode | Symbol exploration mode |
|--------|-------------|--------------------------|
| **Rotate** | Change volume | Cycle built-in symbols (0–99) |
| **Short press** | Show battery level | Exit symbol mode |
| **Long press (1s)** | Switch to symbol mode | Switch to volume mode |

## Raspberry Pi setup

### Bluetooth permissions

BLE often needs elevated permissions. Try:

```bash
sudo node index.js --ip=192.168.0.101
```

Or grant capabilities to Node:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

Then you can run without `sudo`:

```bash
node index.js --ip=192.168.0.101
```

### Bluetooth service

Ensure Bluetooth is running:

```bash
sudo systemctl status bluetooth
```

### If connection hangs

The app logs each step. If it stops after `Nuimo found:`:

- **Connect timeout** – Nuimo may still be paired elsewhere; power-cycle it.
- **Service discovery timeout** – Try `sudo` or check Bluetooth stability.
- **Permissions** – Run with `sudo` or use `setcap` as above.

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| `Usage: node index.js --ip=...` | Provide the speaker IP with `--ip=192.168.0.101` |
| `Nuimo found` then freeze | See [Raspberry Pi setup](#raspberry-pi-setup); try `sudo` or power-cycle Nuimo |
| `Connect timeout (10s)` | Power-cycle Nuimo; ensure it’s not connected to another device |
| `Disconnected from speaker` | Check speaker IP and network; speaker must be on |
| No Nuimo discovered | Turn Nuimo on; ensure Bluetooth is enabled |

## Project structure

```
OD11-remote/
├── index.js          # Main app – Nuimo + speaker integration
├── nuimo.js          # Nuimo BLE client (discovery, connect, LED, events)
├── speaker.js       # OD-11 WebSocket client
├── config.js        # Config loader (--ip or config.local.js)
├── glyphs.json      # Digit glyphs for volume display
└── package.json
```
