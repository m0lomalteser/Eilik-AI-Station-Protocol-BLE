# Eilik "AI Station" BLE Protocol

Reverse-engineered from the official *Energize Lab* app (Hermes bytecode → readable JS) and
verified live against a real "AI Station 08XI" (device type `ES`).

## GATT

| Item | UUID |
|---|---|
| Service | `00008888-0000-1000-8000-00805F9B34FB` |
| Characteristic | `00009999-0000-1000-8000-00805F9B34FB` |

The 8888 service exposes **exactly one** characteristic (9999) with properties
`{read, write, write-without-response, indicate}`. The app uses it for **all** traffic:
writes commands, reads it, and subscribes to indications on it.

On connect, the device indicates the ASCII greeting `68656C6C6F2065696C696B` (`hello eilik`).
It re-sends the greeting every time the characteristic is read.

> **Echo trap:** the device echoes *any* written bytes back via indication **before** the
> protocol layer validates them. A byte-exact echo therefore proves nothing about whether a
> frame was accepted. Only a frame with a valid checksum triggers a `555555` reply or an action.

## Frame layout (v2)

All fields are ASCII-hex. Multi-byte numbers are little-endian.

```
aaaaaa | LEN  | INST | 0000000000 | CHILD | CUR  | TOT  | DATA | CKS
 6B     2 chars | 2  | 10          | 2     | 4    | 4   | var  | 2
```

- `aaaaaa` — fixed request header.
- `LEN` — length byte = `13 + dataBytes`
  (13 = INST + ENC + CHILD + CUR + TOT + CKS, i.e. length counts the checksum byte).
- `INST` — instruction byte.
- `0000000000` — constant 5-byte field (always zeros in every app command).
- `CHILD` — sub-instruction byte.
- `CUR` / `TOT` — current / total packet number, LE uint16 (`0100` / `0100` for single-packet).
- `DATA` — payload (0..~112 bytes per packet).
- `CKS` — checksum byte.

Replies use the identical layout but start with `555555` instead of `aaaaaa`.

## Checksum — the critical rule

```
sum = Σ(byte value) for every byte of the frame AFTER the "aaaaaa" header
      (i.e. starting at the LEN byte, ending at the last DATA byte)
CKS = (~sum) & 0xFF
```

Worked example — volume query `03 07` (empty data):

```
body (after header): 0d 03 00 00 00 00 00 00 07 01 00 01 00
sum                  = 0x0d + 0x03 + 0x07 + 0x01 + 0x01 = 0x19
CKS                  = (~0x19) & 0xFF = 0xE6
frame                = aaaaaa0d0300000000000701000100e6
```

Common pitfalls that produce "echo but never execute":
- summing hex **digits** instead of **bytes**,
- including the `aaaaaa` (or `555555`) header in the sum,
- including the checksum byte itself in the sum.

## Command catalogue

Headings are `INST CHILD` → description. `DATA` shown as hex. LE values are little-endian.

### Queries

| Command | Meaning | Reply |
|---|---|---|
| `03 01` | WiFi state | `555555…` data: `[1]` state, `[3]` ssidLen, `[4..]` ssid ASCII |
| `03 07` | Volume | 1-byte value (e.g. `33` = 51) |
| `03 08` | Light / brightness | 1-byte value (e.g. `64` = 100) |
| `01 07` | Device status | 1-byte value (e.g. `64`) |
| `00 00` | Factory info | see below |

WiFi state values (`data[1]`): `01` connecting, `02` fail, `03` fail/wrong password, `04` connected, `09` skip.

Factory info reply data (minimum 31 bytes):
`[0..16)` cpuId (16 ASCII hex chars), `[16..20)` modeNumber (LE u32),
`[20][21]` version `major.minor`, `[22..26)` appState,
`[26..30)` serialId (LE u32), `[30]` nameLen, `[31..31+nameLen)` device name ASCII.

Observed real reply for `00 00`:
```
55555541000000000000000100010037653438333339643666663366316534409601000201…
                                                        └─ cpuId "7e48339d6ff3f1e4"
data …00000000…0F41492053746174696F6E2030385849…
                          └─ nameLen 0x0F, name "AI Station 08XI"
```

### Emotes / actions — `04 91 <sub>`

| sub | Name | | sub | Name |
|---|---|---|---|---|
| `01` | smallChat | | `0c` | wine |
| `02` | doctor | | `0d` | flower |
| `03` | weather | | `0e` | sandwich |
| `04` | rps | | `0f` | iceCream |
| `05` | divination | | `10` | spWater |
| `06` | fishing | | `11` | painting |
| `07` | thunder | | `12` | end-chat |
| `08` | fairyTail | | `14` | power_off |
| `09` | eilikLegend | | `15` | quiet |
| `0b` | coffee | | `16` | theme |
| | | | `17` | onlineChat |

Emote replies are acks, e.g. `5555550E04000000000091010001000159` (`DATA=01`).

Ending a chat session: send `17` then `12`.

### Setters

| Command | Meaning |
|---|---|
| `04 07 <value LE>` | set volume (e.g. `1e00` = 30, `3200` = 50) |
| `04 08 <value LE>` | set light level |
| `02 82 <value LE>` | set screen brightness |
| `02 03 <len><name>` | rename device |

### WiFi config

| Command | DATA |
|---|---|
| `04 01` | `01 <ssidLen> <ssidHex> 02 <pwdLen> <pwdHex>` |
| `04 02 <00\|01>` | wifi off / on |

### Multi-packet payloads

DATA larger than 112 bytes is split into multiple physical frames:

- packet `N`: `CUR` = N (LE), `TOT` = total count (LE);
- receiver concatenates DATA and finishes when `CUR == TOT`.

Used by `04 94` (alarm JSON) and `04 95` (face JSON) etc. The app never sends > ~112 data
bytes in a single frame.

## Boot / connect sequence (what the app actually does)

1. Scan, filter devices whose advertised name starts with `rkble` (or communicate with
   previously-added devices).
2. Connect with `{ mtu: 512 }`, discover services.
3. Subscribe to indications on the single 9999 characteristic, read it (greeting).
4. `03 01` WiFi query → if connected, app shows state + ssid.
5. `00 00` factory query → device identity (cpuId, mode, serial, name, version).
6. Interactions: emotes `04 91 …`, polls `03 01` every ~5s on the detail page,
   `01 08` heartbeat on Eiliko every 10s.

## Reproducing the packets

Channel: write-with-response on char 9999, hex → base64 (the app base64-encodes raw bytes;
CoreBluetooth on macOS writes raw data directly).

Reference frames (correct checksums, verified live):

```
03 01 wifi      aaaaaa0d0300000000000101000100ec
00 00 factory   aaaaaa0d0000000000000001000100f0
03 07 volQ      aaaaaa0d0300000000000701000100e6
03 08 briQ      aaaaaa0d0300000000000801000100e5
01 07 statusQ   aaaaaa0d0100000000000701000100e8
04 91 0d flower aaaaaa0e04000000000091010001000d4d
04 91 01 chat   aaaaaa0e04000000000091010001000159
04 91 13 tea    aaaaaa0e04000000000091010001001347
04 91 14 power  aaaaaa0e04000000000091010001001446
04 07 3200 vol50 aaaaaa0f04000000000007010001003200b1
```

## Reverse-engineering notes

- App bundle: Hermes bytecode of *Energize Lab*, extracted to readable JS.
- Key modules: `1045` BleController (connect/write/monitor/formatData_v2/decodeData_v2),
  `1333` factory-info parse, `1468` AiStation detail (emotes/setters), `485` protocol
  constants (BLEARGSLENS etc.), `1156` helpers incl. `generalCheckSum`.
- Dead ends that are *not* the answer: wrong characteristic, MTU, noble vs CoreBluetooth,
  indication vs notify, wifi-credential gating, Bluetooth-Classic SPP/audio gating,
  a custom `BluetoothModule` (imported but never invoked).