# Eilik-BLE Controller

A lightweight macOS CLI that controls the **Eilik "AI Station"** robot over Bluetooth LE.
Built by fully reverse-engineering the official *Energize Lab* app (Hermes bytecode → readable JS)
and replicating its protocol byte-for-byte.

Verified working: emote actions (flower, chat, coffee, …), volume/light, wifi & factory queries, power off — all with live `555555` replies and real robot reactions.

## Why this works (the missing checksum)

The robot echoes *any* written frame over its BLE link **before** validating it. Older local
attempts computed the checksum wrong (summing hex *digits*, or including the `aaaaaa` header),
so every frame was echoed back but silently dropped by the protocol layer.

The official app computes:

```
sum = Σ bytes of the frame AFTER the "aaaaaa" header (starting at the LEN byte)
CKS = (~sum) & 0xFF
```

With the correct checksum the robot executes commands and replies with `555555…` frames.
Full spec in [documentation.md](documentation.md).

## Requirements

- macOS 12+ (uses CoreBluetooth)
- Xcode Command Line Tools (`swiftc`)

## Build

```
swiftc -O EilikProbe.swift -o eilikprobe
```

## Usage

```
./eilikprobe                     # app-like boot sequence (wifi → factory → queries → flower)
./eilikprobe demo                # full emote tour + screen/light/volume, ends with power off
./eilikprobe cmd INST CHILD [DATAHEX]   # send one arbitrary command, decode the reply
./eilikprobe sweep               # command sweep
./eilikprobe wifi <ssid> <pwd>   # wifi-config (builds the frame at runtime) + queries
./eilikprobe gattdump            # dump GATT + replay sequence on the app's char target
```

### Examples

```
./eilikprobe cmd 04 91 0d        # flower
./eilikprobe cmd 04 91 01        # small chat
./eilikprobe cmd 04 91 14        # power off
./eilikprobe cmd 04 07 3200      # set volume to 50
./eilikprobe cmd 03 07           # query volume
./eilikprobe cmd 03 01           # query wifi state (prints ssid / state)
./eilikprobe cmd 00 00           # query factory info (cpu / mode / serial / name)
```

## Repository layout

- `EilikProbe.swift` — the tool (single file, no dependencies)
- `documentation.md` — full wire protocol + command catalogue
- `BLE_and_Session_Analysis.md` — deep code-analysis report of the extracted app
- `legacy_probes/` — older experiment scripts, kept for reference only.
  They use the outdated checksum rule and will NOT trigger the robot.

## Disclaimer

Independent research for interoperability with hardware you own. Not affiliated with or
endorsed by Energize Lab / Eilik / Miko.