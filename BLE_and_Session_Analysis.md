# Energize Lab "Energize Lab" app — BLE / session / command analysis

Root: `/Users/marlinschuck/Desktop/AwesomeProject_Source` (extracted Hermes bytecode, de-minified modules `<id>_<Name>.js` / `module_<id>.js`).
All line numbers are from the files as extracted. User harness files (`appflow_test.js`, `eilik_fixed.js`, `handshake_test.js`, `long_wait_test.js`, `gatt_dump.js`, `eilik_spp_probe.py`, `eilikprobe`, `EilikProbe.swift`, `fuck.py`, `node_modules/`) are excluded from the app analysis.

---

## 0. Single source of truth: BleController (module 1045)

- Only BLE controller in the app. Singleton `getInstance()` (1045:740), current device held in `this.currentDevice`; `getConnDeviceInfo()` returns it (1045:688-692).
- GATT target is discovered at runtime: services scanned for `uuid.startsWith("00008888")` (1045:376, 1045:434); char UUID taken as `characteristicsForDevice(...).then(c => c[0].uuid)` (1045:447-450). The hard-coded defaults are the well-known Eilik service/char (1045:25-26):

```
this.serviceUUID = "00008888-0000-1000-8000-00805F9B34FB";
this.writeReadId = "00009999-0000-1000-8000-00805F9B34FB";
```

- Scan filters on the *advertisement device name* `name.startsWith("rkble")` (1045:300, 1045:350). No other name filter, no `omni`, no "eilik" string, no "hello eilik" literal anywhere in app JS.
- **write() is ALWAYS write-with-response.** 1045:472-528: both proto write impls (items[11] and items[12]) call `currentDevice.writeCharacteristicWithResponseForService(self.serviceUUID, self.writeReadId, base64)` (1045:510 and 1045:568). The `{response:false}` option passed by 1692:259 is ignored — JS never uses writeWithoutResponse. Hex payloads are validated by `/^[0-9a-fA-F]+$/` (1045:503) then base64-encoded.
- read(): `readCharacteristicForService` at 1045:606 (the only explicit read; the onboard greeting / "hello eilik" is robot-initiated, not in JS).
- `normalizeError` (1045:710-737): `DEVICE_NOT_CONNECTED` / `INVALID_HEX_DATA` / `CHARACTERISTIC_NOT_FOUND`, and `errorCode == 401` => disconnect + navigate Home.
- **No keep-alive, no background/AppState/reconnect logic, no queueing** anywhere in the controller. Polling that exists is page-scoped (see §1).

---

## 1. (a) Command-emission inventory (inst / child / data / timing)

All commands are built by `formatData_v2(inst, child, data)` (1045:858-897) → packets `aaaaaa` + LEN(2 hex, LE) + inst + `0000000000` (5-byte "encryption" field, always zeros) + child + CURPACK(`0100`) + TOTALPACK(`0100`) + data + CHECK (1045:891-892). All writes use `write(...)` described above.

### Protocol-format utilities (module_1156.js)
- `decimalToHexString(len, width, leFlag)`: 1156:56-90 — `BigInt(4*width)` modulus, `padStart`, and byte-reversal when leFlag=false.
- `generalCheckSum`: 1156:178-199 — sum of each 2-char hex byte interpreted `0x<byte>`, then `decimalToHexString((~sum) & 0xFF, 2)`.
- `char2Hex`, `hexArrayToAscii`, `sliceStrToArray`, `getStringLength` also live here (1156:111-178, 288+).

### Connection / add-device flow (module 1332 ConnectBle)
1. `connectBle (closure_16)` 1332:172-233: `instance.disconnect()` (176), `stopScan()` (178), `connect(device)` (183).
2. On connect success: `getDeviceWifiInfo()` → writes **03/01** (1333:117); then `uploadDeviceInfo()` → `getDeviceFactoryInfo()` → writes **00/00** (1333:31). (1332:187 → 188.)
3. Sets `connectState = CONNTED`, dispatches redux `setConnectedBleDeviceWifiInfo`, `setSelectDeviceInfo`, emits `DeviceEventEmitter.emit("upsertDevice", device)` (1332:191-212). Connect failure retries up to 3 times (1332:217-227).
4. `uploadDeviceInfo` 1332:92-160: factory object mapped to user-device row: `cpuId`, `serialId`, `deviceName`, `versionNumber`, `modeNumber`, `appState`, then `addUserDevice(obj)` (1220) HTTP call.

### Per-page command sets (query→all-fire-on-open; set→on-user-action)

| Command | Direction / data | Where |
|---|---|---|
| `00/00` | get factory info (resp = full device info blob) | 1333:15-103 (timeout 5000 ms); 1661:311 (DeviceParamSettingPage re-query) |
| `03/01` | get wifi status | 1333:104-178 (timeout 10000 ms); add-device 1332:187; every detail page: 1468:561, 1679:518, 1470:732, 1471:825, and polled every **5000 ms** until wifi `connected`: 1468:571-575, 1679:528-533, 1470:742-747, 1471:833-838 |
| `03/07` | ES volume query | 1468:221, 1679:189 |
| `03/08` | ES light-brightness query | 1468:234, 1679:202 |
| `01/07` | ES device-state query | 1468:247, 1679:215 |
| `01/81` | get device base info (QL/ML/SB/SX) | 1211:224, 1673:217, 1473:151, 1470 & 1471 (3x each) |
| `01/82` | get (SX) param | 1471 (3x) |
| `01/88` | get device params (SX) | 1661:297 |
| `01/87` | get (QL) param | 1211:254, 1673:247 |
| `02/92` | get (QL) param | 1211:268, 1673:261 |
| `02/89` | get (SX) param | 1661:887 |
| `03/83` | get wake-up settings | 1645: query |
| `03/84` | get QA settings | 1650 |
| `03/94` | get alarm settings | 1651:57 |
| `03/81` | get face list | 1663 |
| `03/85` | get program (JSON) list | 1554:142, 1644:104, 1910 |
| `04/02` | wifi toggle set: data `01`=connect / `00`=off | 1679:857; also 1468 & 1470 & 1471 (monitored as `04/02`) |
| `04/01` | wifi config (ssid/pwd): `01`+len+ssidHex+`02`+len+pwdHex | 1465:107 (timeout 30000 ms, 1465:183-189; UI progress interval 500 ms, 1465:87-89); resp data `01`⇒connected, `02`⇒password error (1465:125, 1465:165) |
| `02/82` | ES screen-brightness set, data `decimalToHexString(v,4,false)` | 1468:426-441, 1679:392-409 |
| `04/07` | ES volume set, 4-hex LE | 1468:429-441, 1679:397-409 |
| `04/08` | ES light-brightness set, 4-hex LE | 1468:434-441, 1679:402-409 |
| `04/91` | ES run-target/emote: data = 1-byte inst (`01,03,02,08,09,0d,11,0b,13,10,0c,0e,0f,04,05,07,06,14,15,16,17,12` etc.) | 1468:451-478 (04/91 write at 476), 1679:426-453; endChat sends `17` then `12` (1468:546-552, 1679:503-510); 10-s cleanup timer (1468:464-467) |
| `02/03` | set device name: `len(2)` + char2Hex(name) | 1468:1455, 1211:985/1037 (writes 996/1048), 1473:694/746, 1470, 1471 |
| `04/83` | set wake-up settings | 1645 |
| `04/84` | set QA (JSON, `len(8,LE)`+char2Hex) | 1650, 1672 |
| `04/87` | set action (JSON, `len(8,LE)`+char2Hex) | 1687:143, 1687:221 |
| `04/88` | action-related set | 1644 |
| `04/94` | set alarm (JSON, `len(8,LE)`+char2Hex) | 1651:144, 1652 (6 call sites) |
| `04/81` | add face (JSON, `len(8,LE)`+char2Hex), `04/95` edit face, `04/96` | 1665:167 (str4 = **81** for add, **95** otherwise), 1664 |
| `04/85` | delete program | 1554, 1910 |
| `02/95` | set current device program | 1554, 1910 |
| `02/90` | set (SX) device param, data `combined` | 1661:1091-1199 |
| `02/91` | set sleep time: data `"010"+timeHex` | 1661:1287, 1688:93 |
| `02/93` | set language: `"01"+len(2)+char2Hex(lang)` | 1691:108 |
| `02/94` | set language (QL add-device path): `len(2)+char2Hex(lang)` | 1465:213 |
| `05/01` | SB/SX motion command (data varies; powerOn `01`, powerOff `02`, forward `03`, backward `04`, moveLeft `05`, moveRight `06`, turnLeft `07`, turnRight `08`, stop `09`, exit `0a`) | 1470, 1471, 1692:281-282, 1786, 1789 |
| `05/02` | SB/SX remote-control frame: 6 bytes `lx ly rx ry keyLow keyHigh` (joystick bytes = center 127 ± ratio*128; key mask via 1701: cmds from 1702:18) | 1692:258-260 (writeWithoutResponse requested but 1045 uses writeWithResponse) |
| `05/03` | SB offline command | 1786 |
| `05/04` | SB/SX chat | 1789, 1790 |
| `05/05` | SB/SX gait config | 1470 (3x), 1471 (3x) |
| `05/06` | SB/SX action config | 1470 (6x), 1471 (3x) |
| `05/07` | SX action | 1471 (3x) |

### Heartbeats / polls observed
- **QL (Eiliko) detail heartbeat**: 1211:189-216 and 1673:180-210 — `setInterval(..., 10000)` sends **01/08** (one-shot, `{response:true,type:"hex"}`) while the page is open; re-arm flag set when the matching 01/08 reply is collected (1211 monitor 01/08 at 281; 1673:276). Stopped when unconnected (1211:210-213). This is a serialized 10-s status poll, not a keep-alive.
- **ES (AI Station) wifi poll**: 1468:571-575, 1679:528-533 — send 03/01 then `setInterval(..., 5000)` re-send until wifiState==CONNTED.
- **SB/SX wifi poll**: 1470:742-747, 1471:833-838 — same 5-s 03/01 poll.
- **SX body-info poll**: 1471:610-615 — `setInterval(..., 60000)` calling closure_1_47() (a status query re-send), plus one-shot 500 ms timer at 1471:607-609.

### Query timeouts (page “Get device infomation timeout.”)
- 5000 ms for `00/00` (1333:88-92); 10000 ms for `03/01` (1333:164-168); 30000 ms for wifi connect `04/01` (1465:183-189); 10000 ms generic page getParams (1471:600-605, 1468 proximity, etc.); 10000 ms cleanup after a runTarget (1468:464-467).

---

## 2. (b) Any hidden handshake / session / wake / unlock command? — **No.**

- Grep across the whole app (excluding harness files) for `getBootInfo`, `getScanDeviceInfo`, `getDeviceStatus`, `getEmotion`, `emotion`, `handshake`, `session`, `auth`, `token`, `unlock`, `ready`, `wake`, `sign`, `checkCode`, `disablePower`, `powerOn` found **no BLE-layer handshake/auth/token/session command**.
- The only BLE writes at connect time are `03/01` (wifi status) and `00/00` (factory info) inside the *add-device* flow (1332:187-188). There is no post-connect wake/power-on/emotion command, nothing on AppState/background/resume (no `AppState` listener tied to BLE anywhere in app JS).
- `token` hits are pure HTTP auth: 1323`_refreshTokenApi` (refresh token), 1221`_getTickForNoCache` HTTP interceptor (on refresh failure: `instance.disconnect()` + navigate Login, 1221:183-185). `wake` hits are the **DeviceWakeupPage settings UI** (1645: `03/83` query / `04/83` set) — that's the "auto wake response" robot feature, not a session-layer wake. `emotion`/icon-ish hits are font-glyph maps (see §3).
- The "encryption" field in every packet is literally `0000000000` (constant; 1045:891) — no keys, no padding derived from anything.
- Overall: **the app NEVER sends anything besides the v2 `aaaaaa` protocol frames over char 9999.** There is no pre-command greeting, no "hello eilik", no ASCII session bootstrap. All de-minified command call-sites are enumerated in §1(a).

## 3. (c) The "audio modules" (1096, 1097, 1088, 1648, 1099, 1090, 1103, 1649) — **they are icon-font glyph maps, not audio**

Each is a 1-7 line JS object of `"icon-name": codepoint` pairs with no imports:
- module_1096.js → FontAwesome 5 free-solid glyph map
- module_1097.js → FontAwesome 5 free-brands map
- module_1088.js → Ionicons map
- module_1648.js → FontAwesome 6 free-solid map
- module_1649.js → FontAwesome 6 free-brands map
- module_1090.js → Material (Google) glyph map
- module_1099.js → Material Design Icons (MDI) map
- module_1103.js → Feather map

They matched "audio/emotion/wake" keyword greps only because icon names include `audio-description`, `record-vinyl`, `volume-*`, etc. **No A2DP / AVRCP / headset / SPP / Bluetooth-Classic session, and no audio streaming over BLE exists in the app.** The only audio in the app is the native touch-sound:
- 279`_SoundManager`: `NativeModules.get("SoundManager")` (279:11)
- 277: wrapper `playTouchSound()` (277:11-18)
- 278 re-exports 279
- used at 276`_normalizeDelay`.js:454 and 422`_extractSingleTouch`.js:372
(The standalone `class Classic` thing found in 1164`_nbi`.js is a Java BigDecimal BigInteger implementation — RSA code, unrelated to Bluetooth.) App `package.json` declares no BT-audio libs; the only native BLE is `react-native-ble-plx` (modules 1046-1055).

## 4. (d) Exact reply parse rules

### Reply framing (1045)
`decodeData_v2` (1045:800-856) splits a reply into `{length, instructHex, encryptionHex, childInstructHex, dataHex, curPackNum, totalPackNum, checkHex}`. Byte layout: `aaaaaa`(3) LEN(1) INST(1) ENCRYPTION(5) CHILD(1) CURPACK(`0100` LE) TOTALPACK(`0100` LE) DATA CHECK(1) — i.e. index math `3+1+1+5+1+2 = 13` header bytes.

`collectInfo(arr, inst, child, prevData)` (1045:912-946):
```
if (arr.startsWith("555555")) {                 // 1045:923
    decode → if instructHex===inst && childInstructHex===child
        finish = (curPackNum === totalPackNum)  // 1045:929
        respData = prevData + dataHex           // 1045:930  (multi-pack append)
    ... else respData unchanged, finish=false
}
```
So **replies MUST begin `555555`**; multi-packet responses append data until `curPackNum == totalPackNum`.

### getDeviceWifiInfo — 03/01 reply parse (1333:104-178)
Write at 1333:117; monitor `collectInfo(arr,"03","01",...)` (125), on `finish` (128):
```
sliceStrToArrayResult = sliceStrToArray(respData, 2);   // [b0,b1,b2,b3,...]
wifiStateHex = sliceStrToArrayResult[1];                // 1333:135  ← status byte
if (sliceStrToArrayResult[1] !== "04") {                // 1333:136
    if (byte1 !== "09") {
        if (byte1 === "01") state = CONNTING (connecting)
        if (byte1 === "02") state = DISCONN, error = "connect fail, unknown error"
        if (byte1 === "03") state = DISCONN, error = "connect fail, password error"
    }
    ssidLen = parseInt("0x"+arr[3]);                    // 1333:152  ← byte index 3
    ssid = hexArrayToAscii(slice(4, 4 + ssidLen));      // 1333:155  ← ASCII from byte 4
    resolve({ wifiState, ssid, error })                 // 1333:157
} else resolve({ wifiState: CONNTED, ssid: "" });       // 1333:160 (state byte "04" = connected)
```
Timeout 10000 ms → `resolve(null)` (1333:164-168). **Field map for the 03/01 reply: `[0] junk/skip, [1] wifi-status hex (04=connected, 01=connecting, 02=fail-unknown, 03=fail-pwd, 09=ignored), [2] pad, [3] ssid-len, [4..4+len] ssid ASCII`.**

The detail pages use the same parse inline: 1468:577-611 (`sliceStrToArrayResult[1]` status, `Int` parse of `arr[3]` as ssid-length, ssid from slice 4..4+len), 1679:534-568, 1470:748-781, 1471:839-864. Each also maps the byte into `CONNSTATUS {disconnect, connecting, connected}` (module_485.js).

### getDeviceFactoryInfo — 00/00 reply parse (1333:15-103)
Write at 1333:31; monitor `collectInfo(arr,"00","00",...)` (39), on `finish` (41):
```
str = sliceStrToArray(closure_1, 2);        // hex nibbles  [s[0..n]]
cpuId     = hexArrayToAscii( str.slice(0,16) )                       // bytes  0–15    ASCII cpuId
substr1   = str.slice(16,20).reverse();
modeNumber= parseInt("0x"+joined)   .toString()                      // bytes 16–20    LE uint32
substr2   = str.slice(20,22)
version   = parseInt(hex[20]) + "." + parseInt(hex[21])              // bytes 20–22    X.Y version
appState  = str.slice(22,26)                                         // bytes 22–26    raw hex
serialId  = parseInt("0x"+str.slice(26,30).reverse().join(""))       // bytes 26–30    LE uint32
nameLen   = parseInt("0x"+str[30])                                   // byte 30
deviceName= nameLen>0 ? hexArrayToAscii(str.slice(31, 31+nameLen)) : ""  // bytes 31+  ASCII
if (modeNumber !== "4101000" && modeNumber !== "101999") resolve({cpuId,deviceName,serialId,versionNumber,modeNumber,appState})
```
(1333:48-86; the two string comparisons at 1333:77-78 are debug/skip heuristics for known dev-mode values.) Timeout 5000 ms → `resolve(null)` (1333:88-92). **If the reply never starts with `555555` or never arrives, both helpers resolve `null` and the app proceeds as best it can (wifi status `""`/DISCONN, factory `{}`).** The same factory fields are re-requested verbatim in DeviceParamSettingPage (1661:311 write + 1661:330 collect `00/00`).

### 04/01 wifi-connect reply (1465:117-181)
`collectInfo(arr,"04","01",...)`; `respData`: `"01"` ⇒ wifi+internet OK (1465:125, sets CONNTED + saves ssid/pwd history to redux + advances to CONNECTFINISH), `"02"` ⇒ password error `pswErr` (1465:165), anything else ⇒ `news.check_network` network error (1465:171-178). Timeout 30000 ms ⇒ CONNECTFAIL (1465:183-189).

## 5. (e) Literal protocol constants found

| Constant | Location |
|---|---|
| service `00008888-0000-1000-8000-00805F9B34FB`, char `00009999-...` | 1045:25-26 |
| scan-device-name check `name.startsWith("rkble")` | 1045:300, 1045:350 |
| find service with `uuid.startsWith("00008888")` | 1045:376, 1045:434 |
| outbound packet header `aaaaaa` | 1045:892 (formatData_v2), 1045:908 (legacy formatData) |
| inbound packet magic `startsWith("555555")` | 1045:923 |
| fixed 5-byte encryption field `0000000000` (literal in template string) | 1045:891 |
| "hello eilik", "omni" | **nowhere** in app JS (only in user harness files) |

## 6. (f) Module web around BleController (35 importers)

Direct importers of `BleController` (module 1045), and their actual BLE role:

- **1044 DeviceList** — device list screen; scan via 1049, parses `manufacturerData` → deviceType/deviceId; `upsertDevice` listener at 1044:232-234; imports all detail pages; dead `NativeModules.BluetoothModule` import (1044:44). No BLE writes.
- **1211 EilikoDetail** — QL detail: getParams (01/81,01/08,01/87,02/92), 10-s 01/08 heartbeat, rename 02/03, `upsertDevice` 1211:991/1043.
- **1673 EilikoDetailPage** — newer QL detail (duplicate of 1211): same heartbeat/commands.
- **1221 getTickForNoCache** — HTTP interceptor; on token-refresh failure calls `instance.disconnect()` (1221:183-184) and sends user to Login. No BLE writes.
- **1329 SelectProdTypes** — add-device step: device-type picker; only reads `getConnDeviceInfo`-style controller presence. No writes.
- **1332 ConnectBle** — add-device connect (see §1); the only place that runs getDeviceWifiInfo+getDeviceFactoryInfo and emits `upsertDevice`.
- **1333 getDeviceFactoryInfo** — the two query helpers `00/00` and `03/01` (see §4).
- **1334 SelectWifi** — add-device wifi picker (reads saved ssid/pwd list into redux). No writes.
- **1465 ConnectingWifi** — wifi provisioning `04/01` + 02/94 QL lang (see §1).
- **1468 AiStationDetail** — ES detail: 03/07,03/08,01/07 queries; slidingComplete 02/82/04/07/04/08; runTarget 04/91; wifi 03/01 poll 5 s (1468:571-575).
- **1679 AiStationDetail** — newer ES detail: same command set + 04/02 wifi toggle (1679:857), 04/91 (1679:451), poll (1679:528-533).
- **1470 HexapodRobotDetailPage** — SB detail: 01/81, 05/01, 05/05, 05/06, 02/03, 04/02 wifi toggle, 03/01 wifi poll 5 s (1470:742-747).
- **1471 ServoBrainMiniDetailPage** — SX detail: 01/81, 01/82, 05/07, 05/05, 05/06, 05/01, 02/03, 04/02, 03/01 poll 5 s (1471:833-838) + 60-s body poll (1471:610-615).
- **1473 MiniEilikoDetail** — ML detail: 01/81 query, 02/03 rename, 02/82/02/83 collected; `upsertDevice` 1473:700/752.
- **1554 EndOfList** — program list `03/85`, run/set `02/95`, delete `04/85`.
- **1559 AccountSettingPage** — only `exitApp`/logout BLE cleanup (1559:99 pulls controller; no writes).
- **1644 DeviceActionPage** — custom actions: `03/85` list, `04/86`, `04/88`.
- **1645 DeviceWakeupPage** — wake-up automation settings: `03/83` get / `04/83` set.
- **1650 DeviceAnswerPage** — QA config: `03/84` get / `04/84` set (JSON).
- **1651 DeviceAlarmPage** — alarm config: `03/94` get / `04/94` set (JSON, 1651:144).
- **1652 AlarmSettingPage** — alarm JSON writes `04/94`.
- **1661 DeviceParamSettingPage** — SX param settings: `00/00` factory re-query (1661:311), `01/88`, `02/89`, `02/90` params, `02/91` sleep (`010`+time, 1661:1287), `02/93` language.
- **1663 DeviceFacePage** — face list `03/81`.
- **1664 DeviceEditFacePage** — face edit `04/95` / `04/96`.
- **module_1665** — face upload modal: `04/81` (add) / `04/95` (edit) with `jsonLength(8,LE)+char2Hex(JSON)` (1665:162-167).
- **1672 DeviceEditQaPage** — QA edit writes `04/84`.
- **1687 EditActionPage** — action edit writes `04/87` (JSON, 1687:143/221).
- **1688 DeviceSleepPage** — sleep time `02/91` with `"010"+time` (1688:93).
- **1691 DeviceLangPage** — language `02/93` (`01`+len+hex, 1691:108).
- **1692 DeviceRemoteControlPage** — SB/SX controller: `05/02` frame (1692:258-260), `05/01` mode switch (1692:281-282); frame builder in **1701/getJoystickDirectionCommand** (joystick ratio→byte: `127 ± ratio*128`, 1701:58-60; key mask 1701:61-67), constants in **1702/pendingProtocol**: `REMOTE_COMMANDS {powerOn:"01",...stop:"09",exit:"0a"}`, `REMOTE_CONTROL_CENTER=127`, `REMOTE_CONTROL_EXIT_KEY=32768` (1702:14-18).
- **1786 DeviceSbOfflineCmdPage** — SB offline commands `05/01`, `05/03`.
- **1789 DeviceSbChatPage** — SB chat `05/01`, `05/04`.
- **1790 DeviceSxChatPage** — SX chat `05/04`.
- **1909 SearchDevicePage** — scan UI; dead `NativeModules.BluetoothModule` import (1909:87).
- **1910 ProgramDetailPage** — program detail `02/95`, `03/85`, `04/85`.

The `upsertDevice` event is a DeviceEventEmitter flow: emitted by 1332:212 (add-device), 1211:991/1043 and 1473:700/752 (rename); listened to only by DeviceList at 1044:232-234 (updates the list). Redux (`module_1037`, slice name `"device"`, 1037:58) stores only `connectedBleDevice`/`alarmInfo` — **no reducer ever triggers BLE commands**; the `setConnectedBleDeviceWifiInfo` action is just state bookkeeping used at 1332:208, 1465:148, 1468:601, 1679:558, 1470:772, 1471:863.

## 7. (g) Bottom line — what the session layer looks like vs the byte-replay harness

1. **There is no hidden session bootstrap.** The complete set of writes ever sent by the app over char 9999 is the v2 `aaaaaa…` protocol frames enumerated above plus nothing text. The connect-time sequence is only `03/01` (wifi) and `00/00` (factory). So if the harness replays the app's frames byte-exact (same `aaaaaa`, same LE length, same `0000000000` encryption field, same `0100 0100` pack numbers, same ~sum&0xFF checksum), it has already matched the app's session layer.
2. **The possibly-missed piece is not "a wake/hello/token", it is *when and where* packets are sent.** The robot receiving `03/01` plays a "connected" role only if the harness also: (1) sends the frame *as a single write with response*, (2) keeps listening on the indicate/notify (collectInfo consumes `555555` replies), and (3) honors the app's request/response cadence — the app, at minimum, expects `00/00` and `03/01` replies within 5/10 s and treats a `555555`-prefixed multi-`0100`-packet response as valid.
3. The app does **not** do anything special at the physical/GATT layer beyond: discovering the `00008888` service + its first characteristic, writing with response, reading once, and mounting `monitor()` → 1049 `ReadEvent` (indicate) listeners while a page is open. There is no MTU/ATT windowing, no characteristic toggle, no pairing/security exchange.
4. Remaining candidates for the observed "app works / replay doesn't" difference are therefore **non-JS**: device firmware requiring the write to arrive via a specific transport ordering, a timing/window between scan→connect→write that the harness doesn't replicate, or the robot gating 555555 replies on the previous message having been a *query with an outstanding monitor* the way `04/05`-poll pages do. From the JS alone, the app's BLE session is fully described by §1.