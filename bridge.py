#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pyserial",
#     "websockets",
#     "influxdb-client",
# ]
# ///
"""
bridge.py — WebSocket ↔ Serial bridge for TA612C thermocouple logger.

Allows non-Chromium browsers (Firefox, Safari) to communicate with the
TA612C by relaying raw binary data between a WebSocket and a serial port.

Usage:
    uv run bridge.py                        # auto-detect serial port
    uv run bridge.py /dev/cu.usbserial-10   # specify port
    uv run bridge.py COM3                   # Windows

The web app connects to ws://localhost:8767 (default).
"""

import asyncio
import datetime
import getpass
import os
import shutil
import signal
import struct
import sys

import serial
import serial.tools.list_ports
import websockets


BAUD_RATE = 9600
WS_HOST = "localhost"
WS_PORT = 8767
TUI_ROWS = 10  # fixed terminal rows used by TUI (passive: no command input)

# ─────────────────────────────────────────────────────────────────────────────
# USER CONFIGURATION
# Hard-code values here to skip the interactive prompts at startup.
# Leave a field as None to be prompted interactively.
# ─────────────────────────────────────────────────────────────────────────────
SERIAL_PORT          = None   # e.g. "/dev/ttyUSB2" or "/dev/serial/by-id/usb-..."
INFLUXDB_URL         = None   # e.g. "http://localhost:8086"
INFLUXDB_ORG         = None   # e.g. "my-org"
INFLUXDB_BUCKET      = None   # e.g. "sensors"
INFLUXDB_TOKEN       = None   # e.g. "my-token=="
INFLUXDB_MEASUREMENT = None   # e.g. "ta612c_lab1"
# ─────────────────────────────────────────────────────────────────────────────

# InfluxDB state (set by setup_influxdb)
_influx = None  # dict with write_api, bucket, org, measurement, client

# ─────────────────────────────────────────────────────────────────────────────
# TUI STATE
# ─────────────────────────────────────────────────────────────────────────────
_tui_active         = False
_tui_temps          = [None, None, None, None]  # latest °C per channel (or None)
_tui_client         = None          # connected client IP string or None
_tui_influx_desc    = "disabled"    # "disabled" or "enabled (name)"
_tui_transport_desc = ""
_tui_last_update    = ""
_tui_term_state     = None          # saved termios state for restore
_tui_loop           = None          # event loop reference set in tui_start()
_tui_w              = 80            # current terminal width


# ─────────────────────────────────────────────────────────────────────────────
# TUI HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _tui_can_use():
    """Return True if terminal TUI is supported on this system."""
    if os.name != "posix":
        return False
    if not sys.stdout.isatty():
        return False
    try:
        import tty as _t, termios as _m  # noqa: F401
        return True
    except ImportError:
        return False


def _tui_box_line(content, row):
    """Write a │-bordered content line at the given 1-indexed row."""
    inner = _tui_w - 2
    padded = content[:inner].ljust(inner)
    sys.stdout.write(f"\033[{row};1H\u2502{padded}\u2502")


def _tui_cell_width():
    return max(12, (_tui_w - 2) // 4)


def _tui_labels_line():
    cell = _tui_cell_width()
    return "".join(f"T{i}".center(cell) for i in range(1, 5))


def _tui_values_line():
    cell = _tui_cell_width()
    parts = []
    for t in _tui_temps:
        s = f"{t:.1f} \u00b0C" if t is not None else "---"
        parts.append(s.center(cell))
    return "".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
# TUI LIFECYCLE
# ─────────────────────────────────────────────────────────────────────────────

def tui_start(transport_desc, influx_desc):
    """Initialize TUI: save terminal, setcbreak, hide cursor, draw frame."""
    global _tui_active, _tui_transport_desc, _tui_influx_desc
    global _tui_term_state, _tui_w, _tui_loop

    if not _tui_can_use():
        return
    cols, rows = shutil.get_terminal_size()
    if cols < 50 or rows < TUI_ROWS:
        return

    import tty, termios  # noqa: E401

    _tui_transport_desc = transport_desc
    _tui_influx_desc = influx_desc
    _tui_w = min(cols, 120)
    _tui_active = True

    fd = sys.stdin.fileno()
    _tui_term_state = termios.tcgetattr(fd)
    tty.setcbreak(fd)

    sys.stdout.write("\033[?25l\033[2J")
    sys.stdout.flush()
    tui_draw()

    _tui_loop = asyncio.get_event_loop()
    try:
        _tui_loop.add_signal_handler(signal.SIGWINCH,
                                     lambda: (tui_draw(), sys.stdout.flush()))
    except (OSError, NotImplementedError):
        pass


def tui_stop():
    """Restore terminal to original state and show cursor."""
    global _tui_active, _tui_term_state

    if not _tui_active:
        return
    _tui_active = False

    if _tui_loop is not None and not _tui_loop.is_closed():
        try:
            _tui_loop.remove_signal_handler(signal.SIGWINCH)
        except Exception:
            pass

    if _tui_term_state is not None:
        try:
            import termios
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _tui_term_state)
        except Exception:
            pass

    sys.stdout.write(f"\033[?25h\033[{TUI_ROWS + 1};1H\033[J")
    sys.stdout.flush()


# ─────────────────────────────────────────────────────────────────────────────
# TUI DRAWING
# ─────────────────────────────────────────────────────────────────────────────

def tui_draw():
    """Full TUI redraw — used on startup and terminal resize."""
    global _tui_w

    if not _tui_active:
        return

    cols, _ = shutil.get_terminal_size()
    _tui_w = min(cols, 120)
    w = _tui_w
    inner = w - 2

    # Row 1: top border with title
    title = f" TA612C Bridge  ws://{WS_HOST}:{WS_PORT}  [{_tui_transport_desc}] "
    fill = max(0, w - 2 - len(title) - 1)
    top = ("\u250c\u2500" + title + "\u2500" * fill + "\u2510")[:w]
    sys.stdout.write(f"\033[1;1H{top}")

    # Row 2: blank
    _tui_box_line("", 2)

    # Row 3: channel labels
    _tui_box_line(_tui_labels_line(), 3)

    # Row 4: blank
    _tui_box_line("", 4)

    # Row 5: temperature values
    _tui_box_line(_tui_values_line(), 5)

    # Row 6: blank
    _tui_box_line("", 6)

    # Row 7: InfluxDB + client status
    influx_str = f"InfluxDB: {_tui_influx_desc}"
    client_str = ("Client: connected (" + _tui_client + ")"
                  if _tui_client else "Client: disconnected")
    gap = max(2, inner - 4 - len(influx_str) - len(client_str))
    _tui_box_line(f"  {influx_str}{' ' * gap}{client_str}", 7)

    # Row 8: blank
    _tui_box_line("", 8)

    # Row 9: last update time
    _tui_box_line(f"  Updated: {_tui_last_update or '--:--:--'}", 9)

    # Row 10: bottom border
    bot = ("\u2514" + "\u2500" * (w - 2) + "\u2518")[:w]
    sys.stdout.write(f"\033[10;1H{bot}")

    sys.stdout.flush()


def tui_update_reading(temps):
    """Rewrite rows 5 and 9 with the latest temperature readings."""
    global _tui_temps, _tui_last_update

    _tui_temps = list(temps)
    if not _tui_active:
        return

    _tui_last_update = datetime.datetime.now().strftime("%H:%M:%S")
    inner = _tui_w - 2

    sys.stdout.write(f"\033[5;1H\u2502{_tui_values_line()[:inner].ljust(inner)}\u2502")

    content9 = f"  Updated: {_tui_last_update}"
    sys.stdout.write(f"\033[9;1H\u2502{content9[:inner].ljust(inner)}\u2502")

    sys.stdout.flush()


def tui_update_client(peer, connected):
    """Update the client connection status display."""
    global _tui_client

    if connected:
        _tui_client = peer[0] if isinstance(peer, tuple) else str(peer)
    else:
        _tui_client = None

    if not _tui_active:
        if connected:
            print(f"  Client connected: {peer}")
        else:
            print(f"  Client disconnected: {peer}")
        return

    inner = _tui_w - 2
    influx_str = f"InfluxDB: {_tui_influx_desc}"
    client_str = ("Client: connected (" + _tui_client + ")"
                  if _tui_client else "Client: disconnected")
    gap = max(2, inner - 4 - len(influx_str) - len(client_str))
    status = f"  {influx_str}{' ' * gap}{client_str}"
    sys.stdout.write(f"\033[7;1H\u2502{status[:inner].ljust(inner)}\u2502")
    sys.stdout.flush()


# ─────────────────────────────────────────────────────────────────────────────
# DEVICE DETECTION
# ─────────────────────────────────────────────────────────────────────────────

def _is_usb_port(p):
    """Return True if this port looks like a USB serial device.

    Checks VID/PID first (most reliable), then falls back to device name
    patterns for systems where pyserial doesn't populate VID/PID from sysfs
    (common with some Linux kernel/driver combinations, e.g. CH340/CH341).
    USB serial devices on Linux appear as /dev/ttyUSB* or /dev/ttyACM*;
    on macOS as /dev/cu.usbserial-* or /dev/cu.usbmodem*.
    """
    if p.vid is not None:
        return True
    name = p.device.lower()
    return any(s in name for s in ("ttyusb", "ttyacm", "cu.usb", "cu.wch"))


def find_serial_port():
    """List available serial ports, preferring USB devices.

    The TA612C has a built-in USB-to-serial converter (CH340/CH341) and
    appears as a USB serial device. We show only USB ports by default and
    fall back to all ports if none are found.
    """
    all_ports = list(serial.tools.list_ports.comports())
    if not all_ports:
        return None

    usb_ports = [p for p in all_ports if _is_usb_port(p)]
    ports = usb_ports if usb_ports else all_ports
    if not usb_ports:
        print("No USB serial devices found — showing all ports:")

    if len(ports) == 1:
        tag = " [USB]" if _is_usb_port(ports[0]) else ""
        print(f"Found serial port: {ports[0].device}{tag}  —  {ports[0].description}")
        return ports[0].device

    print("USB serial devices found:\n")
    for i, p in enumerate(ports, 1):
        vid_pid = f"  VID:PID={p.vid:04X}:{p.pid:04X}" if p.vid is not None else ""
        print(f"  [{i}]  {p.device}  —  {p.description}{vid_pid}")
    print()
    while True:
        try:
            choice = input(f"Type a number [1-{len(ports)}] and press Enter: ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(ports):
                return ports[idx].device
        except (ValueError, EOFError):
            pass
        print(f"  Please enter a number between 1 and {len(ports)}")


def open_serial(port_name):
    """Open serial port with TA612C settings."""
    try:
        return serial.Serial(
            port=port_name,
            baudrate=BAUD_RATE,
            bytesize=serial.EIGHTBITS,
            stopbits=serial.STOPBITS_ONE,
            parity=serial.PARITY_NONE,
            timeout=0.1,
            exclusive=True,
        )
    except serial.SerialException as e:
        print(f"Cannot open {port_name}: {e}")
        print("Is another bridge already using this port?")
        sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# INFLUXDB
# ─────────────────────────────────────────────────────────────────────────────

def setup_influxdb():
    """Interactively configure InfluxDB logging. Returns config dict or None."""
    global _influx

    # Use pre-configured values if all USER CONFIGURATION fields are set
    if all([INFLUXDB_URL, INFLUXDB_ORG, INFLUXDB_BUCKET, INFLUXDB_TOKEN, INFLUXDB_MEASUREMENT]):
        url = INFLUXDB_URL
        org = INFLUXDB_ORG
        bucket = INFLUXDB_BUCKET
        token = INFLUXDB_TOKEN
        measurement = INFLUXDB_MEASUREMENT
        print(f"\nUsing pre-configured InfluxDB: {org}/{bucket}/{measurement}")
    else:
        try:
            answer = input("\nEnable InfluxDB logging? [y/N]: ").strip().lower()
        except EOFError:
            return None
        if answer != "y":
            return None

        print("\n── InfluxDB Setup ──────────────────────────────────")
        url = input("URL [http://localhost:8086]: ").strip() or "http://localhost:8086"
        org = input("Organization: ").strip()
        bucket = input("Bucket: ").strip()
        print("API Token")
        print("  (Find yours at: InfluxDB UI → Load Data → API Tokens)")
        token = getpass.getpass("  Token: ")
        measurement = input("Measurement name: ").strip()
        print("  Use snake_case, e.g. ta612c_lab1")

        if not all([org, bucket, token, measurement]):
            print("Missing required fields — InfluxDB logging disabled.")
            return None

    from influxdb_client import InfluxDBClient

    print("\nTesting connection... ", end="", flush=True)
    client = InfluxDBClient(url=url, token=token, org=org)
    try:
        health = client.health()
        if health.status != "pass":
            print(f"✗ ({health.message})")
            client.close()
            return None
    except Exception as e:
        print(f"✗ ({e})")
        client.close()
        return None
    print("✓")

    from influxdb_client.client.write_api import SYNCHRONOUS
    write_api = client.write_api(write_options=SYNCHRONOUS)
    _influx = {
        "client": client,
        "write_api": write_api,
        "bucket": bucket,
        "org": org,
        "measurement": measurement,
    }
    print(f"InfluxDB logging enabled → {org}/{bucket}/{measurement}\n")
    return _influx


def close_influxdb():
    """Flush pending writes and close the InfluxDB client."""
    global _influx
    if _influx:
        print("Flushing InfluxDB...", end=" ", flush=True)
        try:
            _influx["write_api"].close()
            _influx["client"].close()
        except Exception:
            pass
        print("done.")
        _influx = None


# ─────────────────────────────────────────────────────────────────────────────
# PROTOCOL
# ─────────────────────────────────────────────────────────────────────────────

def parse_ta612c_frames(buf):
    """Parse TA612C binary frames from buffer.

    Scans for device→PC header (0x55 0xAA), validates length and checksum,
    extracts 4-channel temperatures from cmd 0x01 (real-time data) frames.

    Returns (readings, remaining_buffer) where readings is a list of
    (t1, t2, t3, t4) tuples in °C.
    """
    readings = []
    while True:
        # Find device→PC header
        idx = -1
        for i in range(len(buf) - 1):
            if buf[i] == 0x55 and buf[i + 1] == 0xAA:
                idx = i
                break
        if idx < 0:
            # Keep last byte in case it's the start of a header
            if len(buf) > 1:
                buf = buf[-1:]
            break

        # Discard bytes before header
        buf = buf[idx:]

        # Need at least header(2) + cmd(1) + length(1) to read length
        if len(buf) < 4:
            break

        length = buf[3]  # total bytes after the 2-byte header (cmd + length + payload + checksum)
        frame_size = 2 + length
        if len(buf) < frame_size:
            break

        frame = buf[:frame_size]
        buf = buf[frame_size:]

        # Validate checksum: low byte of sum of all preceding bytes
        checksum = sum(frame[:-1]) & 0xFF
        if checksum != frame[-1]:
            continue

        cmd = frame[2]
        if cmd == 0x01:
            # Real-time data: payload is 4 × 16-bit LE signed temperatures
            payload = frame[4:-1]  # skip header(2)+cmd(1)+length(1), exclude checksum
            if len(payload) >= 8:
                temps = []
                for ch in range(4):
                    raw = struct.unpack_from("<h", payload, ch * 2)[0]
                    temp = raw / 10.0
                    # Out-of-range values indicate open/disconnected thermocouple
                    temps.append(temp if -300 <= temp <= 2000 else None)
                readings.append(tuple(temps))

    return readings, buf


def write_influx_temps(temps):
    """Write a 4-channel temperature reading to InfluxDB."""
    if not _influx:
        return
    from influxdb_client import Point, WritePrecision

    point = Point(_influx["measurement"])
    has_fields = False
    for i, t in enumerate(temps, 1):
        if t is not None:
            point = point.field(f"t{i}", t)
            has_fields = True
    if not has_fields:
        return  # all channels open/disconnected — nothing to write
    point = point.time(datetime.datetime.now(datetime.timezone.utc), WritePrecision.MILLISECONDS)
    try:
        _influx["write_api"].write(
            bucket=_influx["bucket"],
            org=_influx["org"],
            record=point,
        )
    except Exception as e:
        if not _tui_active:
            print(f"  InfluxDB write error: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# TRANSPORT HANDLERS
# ─────────────────────────────────────────────────────────────────────────────

async def serial_to_ws(ser, ws):
    """Read raw bytes from serial and forward as binary WebSocket frames."""
    loop = asyncio.get_event_loop()
    parse_buf = b""
    while True:
        try:
            data = await loop.run_in_executor(None, ser.read, 256)
        except serial.SerialException as e:
            if not _tui_active:
                print(f"\n  Serial read error: {e}")
            return
        if data:
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                return
            # Always parse frames for TUI display and InfluxDB
            parse_buf += data
            readings, parse_buf = parse_ta612c_frames(parse_buf)
            for temps in readings:
                tui_update_reading(temps)
                write_influx_temps(temps)
        else:
            await asyncio.sleep(0.05)


async def ws_to_serial(ser, ws):
    """Read binary WebSocket frames and write raw bytes to serial."""
    try:
        async for message in ws:
            if isinstance(message, bytes) and message:
                try:
                    ser.write(message)
                except serial.SerialException as e:
                    if not _tui_active:
                        print(f"\n  Serial write error: {e}")
                    return
            elif isinstance(message, str):
                # Fallback for text frames
                try:
                    ser.write(message.encode("ascii"))
                except serial.SerialException as e:
                    if not _tui_active:
                        print(f"\n  Serial write error: {e}")
                    return
    except websockets.ConnectionClosed:
        pass


async def handler(ws, ser):
    """Handle a single WebSocket connection."""
    peer = getattr(ws, "remote_address", None)
    tui_update_client(peer, True)
    try:
        await asyncio.gather(
            serial_to_ws(ser, ws),
            ws_to_serial(ser, ws),
        )
    finally:
        tui_update_client(peer, False)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    if len(sys.argv) > 1:
        port_name = sys.argv[1]
    elif SERIAL_PORT:
        port_name = SERIAL_PORT
        print(f"Using pre-configured serial port: {port_name}")
    else:
        port_name = find_serial_port()
    if not port_name:
        print("No serial ports found. Connect the TA612C and try again,")
        print("or specify the port: uv run bridge.py /dev/cu.usbserial-10")
        sys.exit(1)

    print(f"Opening serial port: {port_name} at {BAUD_RATE} baud")
    ser = open_serial(port_name)
    print(f"Serial port opened: {ser.name}")

    influx_cfg = setup_influxdb()
    influx_desc = (f"enabled ({influx_cfg['measurement']})"
                   if influx_cfg else "disabled")

    print(f"Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}")
    print("Web app can now connect via the Bridge button.\n")
    tui_start(f"serial: {ser.name}", influx_desc)

    async with websockets.serve(lambda ws: handler(ws, ser), WS_HOST, WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        tui_stop()
        close_influxdb()
        print("\nBridge stopped.")
