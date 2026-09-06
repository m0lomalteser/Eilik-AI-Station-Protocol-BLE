#!/usr/bin/env python3
"""Eilik AI Station SPP (Bluetooth Classic serial) probe.

Pairs via RFCOMM/serial the way the official app does over BT Classic, and
replays the same v2 packets used on USB/BLE. Any real reply (not a byte-exact
echo) and any physical reaction proves the serial channel is the command path.

Usage:
  python3 eilik_spp_probe.py XX:XX:XX:XX:XX:XX [--channel N] [--scan-channels]
"""
import socket
import sys
import time
import argparse


def format_data_v2(instr, child, data):
    """Replicate the app's formatData_v2: magic aaaaaa + len + instr +
    '0000000000' + child + '0100' + '0100' + data, checksum = (255 - sum) & 0xFF
    over the hex digits. Verified byte-exact against the robot's echoes."""
    data = (data or "").upper()
    length = 13 + len(data) // 2
    length_hex = format(length, "02x").upper()
    tmp = "aaaaaa" + length_hex + instr + "0000000000" + child + "0100" + "0100" + data
    total = sum(int(c, 16) for c in tmp) & 0xFF
    ck = format(255 - total, "02x").upper()
    return tmp + ck


def tx(rc, label, packet, note=""):
    data = bytes.fromhex(packet)
    print(f"\n>>> {label}   {packet}  {note}")
    rc.sendall(data)
    buf = b""
    deadline = time.time() + 1.2
    while time.time() < deadline:
        try:
            rc.settimeout(deadline - time.time())
            chunk = rc.recv(512)
        except socket.timeout:
            break
        if not chunk:
            break
        buf += chunk
    h = buf.hex().upper()
    verdict = "ECHO" if h == packet else ("555555-REPLY!!!" if h.startswith("555555") else ("NON-ECHO" if h else "no reply"))
    print(f"<<< {label}   {h or '(none)'}   <{verdict}>")
    printable = "".join(chr(c) for c in buf if 32 <= c <= 126)
    if printable:
        print(f"    ascii: {printable!r}")
    return buf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mac")
    ap.add_argument("--channel", type=int, default=1)
    ap.add_argument("--scan-channels", action="store_true")
    args = ap.parse_args()

    attempts = list(range(args.channel, args.channel + 1))
    if args.scan_channels:
        attempts = list(range(1, 21))

    rc = None
    for ch in attempts:
        print(f"[try] RFCOMM channel {ch} ...")
        try:
            s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
            s.settimeout(5)
            s.connect((args.mac, ch))
            rc = s
            print(f"[connected] RFCOMM ch {ch} to {args.mac}")
            break
        except Exception as e:
            print(f"  failed: {e}")
            time.sleep(0.5)
    if rc is None:
        print("FATAL: could not open any RFCOMM channel. Is the robot paired, and is the iPhone app fully closed?")
        sys.exit(1)

    tests = [
        ("ping     03 01 wifi", "03", "01", ""),
        ("factory  00 00", "00", "00", ""),
        ("volQ     03 07", "03", "07", ""),
        ("briQ     03 08", "03", "08", ""),
        ("statusQ  01 07", "01", "07", ""),
        ("flower   04 91 0d", "04", "91", "0d"),
        ("chat     04 91 01", "04", "91", "01"),
        ("tea      04 91 13", "04", "91", "13"),
        ("set30%   04 07 1e00", "04", "07", "1e00"),
        ("wifiCfg  04 01 empty", "04", "01", "01000200"),
    ]
    try:
        for label, ins, child, data in tests:
            pkt = format_data_v2(ins, child, data)
            tx(rc, label, pkt)
            time.sleep(1.2)
    finally:
        rc.close()
    print("\n[done]")


if __name__ == "__main__":
    main()