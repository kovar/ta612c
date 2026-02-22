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
import getpass
import struct
import sys

import serial
import serial.tools.list_ports
import websockets


BAUD_RATE = 9600
WS_HOST = "localhost"
WS_PORT = 8767

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

    write_api = client.write_api()
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

        length = buf[3]  # total bytes after header, including length byte itself
        # Total frame size: header(2) + cmd(1) + length bytes
        # length includes: length_byte + payload + checksum
        frame_size = 2 + 1 + length
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
    from influxdb_client import Point

    point = Point(_influx["measurement"])
    for i, t in enumerate(temps, 1):
        if t is not None:
            point = point.field(f"t{i}", t)
    try:
        _influx["write_api"].write(
            bucket=_influx["bucket"],
            org=_influx["org"],
            record=point,
        )
    except Exception as e:
        print(f"  InfluxDB write error: {e}")


async def serial_to_ws(ser, ws):
    """Read raw bytes from serial and forward as binary WebSocket frames."""
    loop = asyncio.get_event_loop()
    parse_buf = b""
    while True:
        try:
            data = await loop.run_in_executor(None, ser.read, 256)
        except serial.SerialException as e:
            print(f"\n  Serial read error: {e}")
            return
        if data:
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                return
            # Parse frames for InfluxDB (only if enabled)
            if _influx:
                parse_buf += data
                readings, parse_buf = parse_ta612c_frames(parse_buf)
                for temps in readings:
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
                    print(f"\n  Serial write error: {e}")
                    return
                print(f"  → Sent to device: [{' '.join(f'{b:02x}' for b in message)}]")
            elif isinstance(message, str):
                # Fallback for text frames
                try:
                    ser.write(message.encode("ascii"))
                except serial.SerialException as e:
                    print(f"\n  Serial write error: {e}")
                    return
                print(f"  → Sent to device (text): {message.strip()}")
    except websockets.ConnectionClosed:
        pass


async def handler(ws, ser):
    """Handle a single WebSocket connection."""
    peer = getattr(ws, "remote_address", None)
    print(f"  Client connected: {peer}")
    try:
        await asyncio.gather(
            serial_to_ws(ser, ws),
            ws_to_serial(ser, ws),
        )
    finally:
        print(f"  Client disconnected: {peer}")


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

    setup_influxdb()

    print(f"Starting WebSocket server on ws://{WS_HOST}:{WS_PORT}")
    print("Web app can now connect via the Bridge button.\n")

    async with websockets.serve(lambda ws: handler(ws, ser), WS_HOST, WS_PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        close_influxdb()
        print("\nBridge stopped.")
