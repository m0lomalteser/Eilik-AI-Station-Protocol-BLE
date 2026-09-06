#!/usr/bin/env node
// Eilik Robot BLE Controller - Standalone Node.js Script
// Reverse-engineered from decompiled iOS React Native app (Hermes bytecode)
//
// Protocol: BLE GATT over Service 0x8888, Characteristic 0x9999
// Packet format: V2 (formatData_v2 with pack number support)
//
// Install: npm install @abandonware/noble
// Usage:   node eilik_fixed.js

const noble = require("@abandonware/noble");

// ── BLE UUIDs (from BleController.js lines 25-26) ────────────────────────
const SERVICE_UUID      = "00008888-0000-1000-8000-00805f9b34fb";
const CHAR_UUID         = "00009999-0000-1000-8000-00805f9b34fb";

// Eilik product codes, read (reversed) from the FIRST TWO bytes of manufacturer
// data (module_485.js:15). Robot transmits reversed ("SE"), app decodes as "ES".
// "ES" = Eilik AI Station (~08XI), "QL" = Eiliko, etc.
const PRODUCT_CODES = ["QL", "ES", "SB", "ML", "SX"];

// ── Protocol constants (from module_485.js line 13) ──────────────────────
const BLEARGSLENS = {
  HEADERLEN:      3,   // "aaaaaa" = 3 bytes
  LENTHLEN:       1,   // length field = 1 byte
  INSTRUCTIONLEN: 1,   // instruction = 1 byte
  ENCRYPTIONLEN:  5,   // encryption placeholder = 5 bytes (always 0000000000)
  CHECKLEN:       1,   // checksum = 1 byte
  MAXPACKDATALEN: 112, // max data bytes per packet
  PACKNUMINFOLEN: 2,   // each pack number = 2 bytes (cur + total = 4 bytes)
};

// ── decimalToHexString (from InsertString.js line 56-90) ─────────────────
// Converts a number to a hex string of `numChars` hex digits.
// When flag=false, reverses byte-pair order (little-endian encoding).
function decimalToHexString(value, numChars, flag) {
  if (flag === undefined) flag = true;
  const modulus = BigInt(2) ** BigInt(4 * numChars);
  let result = BigInt(value) % modulus;
  if (result < 0n) result += modulus;
  let str = result.toString(16);
  str = str.padStart(numChars, "0");
  if (!flag) {
    const pairs = [];
    for (let i = 0; i < str.length; i += 2) {
      pairs.push(str.slice(i, i + 2));
    }
    pairs.reverse();
    return pairs.join("").toLowerCase();
  }
  return str;
}

// ── generalCheckSum (from InsertString.js line 178-199) ──────────────────
// Sums all byte values in the hex string, returns (~sum & 0xFF) as 2 hex chars.
function generalCheckSum(hexStr) {
  let sum = 0;
  for (let i = 0; i < hexStr.length; i += 2) {
    sum += parseInt(hexStr.slice(i, i + 2), 16);
  }
  return decimalToHexString((~sum) & 0xff, 2, false);
}

// ── sliceStrToArray (from InsertString.js constructor pattern) ────────────
// Splits a string into an array of fixed-size chunks.
function sliceStrToArray(str, chunkSize) {
  chunkSize = chunkSize || 2;
  const arr = [];
  for (let i = 0; i < str.length; i += chunkSize) {
    arr.push(str.slice(i, i + chunkSize));
  }
  return arr;
}

// ── formatData_v2 (from BleController.js line 860-897) ───────────────────
// Builds a V2 protocol packet (or array of packets for large payloads).
//
// Reconstructed layout of the text portion (between header and checksum):
//   length(1B LE) + instruction(1B) + encryption(5B=00..00) + childInstr(1B)
//   + curPackNum(2B LE) + totalPackNum(2B LE) + data + checksum(1B)
//
// The length byte value = LENTHLEN + INSTRUCTIONLEN + ENCRYPTIONLEN + INSTRUCTIONLEN
//   + PACKNUMINFOLEN*2 + dataBytes + CHECKLEN  (includes itself)
function formatData_v2(instruction, childInstruction, dataHex) {
  dataHex = dataHex || "";
  const dataBytes = dataHex ? sliceStrToArray(dataHex, 2) : [];
  const packets = [];

  let numPackets = 1;
  if (dataHex.length > 0) {
    numPackets = Math.ceil(dataBytes.length / BLEARGSLENS.MAXPACKDATALEN);
  }

  for (let i = 0; i < numPackets; i++) {
    const start = i * BLEARGSLENS.MAXPACKDATALEN;
    const end   = Math.min(start + BLEARGSLENS.MAXPACKDATALEN, dataBytes.length);
    const chunk = dataBytes.slice(start, end);
    const chunkHex = chunk.join("");

    // Total payload length (including the length byte itself)
    const totalLen =
      BLEARGSLENS.LENTHLEN       + // 1  (the length byte itself)
      BLEARGSLENS.INSTRUCTIONLEN + // 1
      BLEARGSLENS.ENCRYPTIONLEN  + // 5
      BLEARGSLENS.INSTRUCTIONLEN + // 1  (child instruction)
      BLEARGSLENS.PACKNUMINFOLEN * 2 + // 4 (curPack 2B + totalPack 2B)
      chunk.length               + // data bytes
      BLEARGSLENS.CHECKLEN;        // 1

    const lengthHex     = decimalToHexString(totalLen, 2, false);
    const curPackHex    = decimalToHexString(i + 1, 4, false);
    const totalPackHex  = decimalToHexString(numPackets, 4, false);

    // Text = everything from length through data (checksum computed on this)
    const text =
      lengthHex +
      instruction +
      "0000000000" +           // encryption placeholder (5 bytes)
      childInstruction +
      curPackHex +             // current packet number (2 bytes LE)
      totalPackHex +           // total packet count (2 bytes LE)
      chunkHex;                // payload data

    const checksum = generalCheckSum(text);

    // Full packet = header + text + checksum
    packets.push("aaaaaa" + text + checksum);
  }

  return packets;
}

// ── Helper: hex string to Buffer ──────────────────────────────────────────
function hexToBuffer(hexStr) {
  const buf = Buffer.alloc(hexStr.length / 2);
  for (let i = 0; i < hexStr.length; i += 2) {
    buf[i / 2] = parseInt(hexStr.slice(i, i + 2), 16);
  }
  return buf;
}

// ── Helper: promisified noble operations ───────────────────────────────────
function nobleConnect(peripheral) {
  return new Promise((resolve, reject) => {
    peripheral.connect((err) => (err ? reject(err) : resolve()));
  });
}

function nobleDisconnect(peripheral) {
  return new Promise((resolve) => {
    peripheral.disconnect(() => resolve());
  });
}

function nobleDiscoverServices(peripheral, uuids) {
  return new Promise((resolve, reject) => {
    peripheral.discoverServices(uuids, (err, services) =>
      err ? reject(err) : resolve(services)
    );
  });
}

function nobleDiscoverCharacteristics(service, uuids) {
  return new Promise((resolve, reject) => {
    service.discoverCharacteristics(uuids, (err, chars) =>
      err ? reject(err) : resolve(chars)
    );
  });
}

function nobleSubscribe(characteristic) {
  return new Promise((resolve, reject) => {
    characteristic.subscribe((err) => (err ? reject(err) : resolve()));
  });
}

function nobleWrite(characteristic, data, withoutResponse) {
  return new Promise((resolve, reject) => {
    characteristic.write(data, withoutResponse, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
let peripheral = null;
let writeChar  = null;

function fmt(hex) {
  return hex.match(/.{1,2}/g).join(" ");
}

async function main() {
  // Wait for BLE powered on
  await new Promise((resolve) => {
    if (noble.state === "poweredOn") return resolve();
    noble.once("stateChange", (state) => {
      if (state === "poweredOn") resolve();
      else {
        console.error("BLE not available:", state);
        process.exit(1);
      }
    });
  });

  // Scan for Eilik devices.
  // IMPORTANT: The app (SearchDevicePage.js:168-182) does NOT identify the
  // robot by device name. It reads the FIRST byte of the ADVERTISED
  // MANUFACTURER DATA and matches it against PRODUCTCODES = ["QL","ES","SB","ML","SX"]
  //   - "ES" = Eilik AI Station (the one we want)
  // The old name check name.startsWith("rkble") (BleController.js:300) is legacy.
  console.log("Scanning for Eilik robot...");
  const found = await new Promise((resolve) => {
    const candidates = [];
    noble.on("discover", (p) => {
      const mfr = p.advertisement && p.advertisement.manufacturerData;
      let code = "";
      if (mfr && mfr.length >= 2) {
        // The app (SearchDevicePage.js:169-172) reverses the FIRST TWO bytes
        // of manufacturer data and reads them as the 2-char ASCII product code.
        // Robot transmits "SE" -> app shows "ES" (Eilik AI Station).
        // So we reverse bytes [0],[1] before forming the code string.
        code = String.fromCharCode(mfr[1], mfr[0]);
      }
      const local = (p.advertisement && p.advertisement.localName) || "(no-name)";
      console.log(`  [saw] "${local}" [${p.uuid}] mfrCode="${code}" (mfrBytes: ${mfr ? mfr.toString("hex") : "none"})`);

      // Accept Eilik family (any known product code)
      if (PRODUCT_CODES.includes(code)) {
        console.log(`  >>> MATCHED product code "${code}" (localName="${local}")`);
        noble.stopScanning();
        resolve(p);
        return;
      }
      candidates.push(p);
    });
    noble.startScanning([], true);
    // Timeout after 30 seconds
    setTimeout(() => {
      noble.stopScanning();
      console.warn("No Eilik robot (matching product code) found in 30s.");
      if (candidates.length > 0) {
        console.warn("Candidate devices seen (none matched a known Eilik product code):");
        for (const c of candidates) {
          console.warn(`  "${c.advertisement.localName || '(no-name)'}" [${c.uuid}]`);
        }
        console.warn("If the Eilik is NOT advertising its product code in byte 0 of manufacturer data,");
        console.warn("the robot is OFF or malfunctioning. Power-cycle it and retry.");
      }
      resolve(null);
    }, 30000);
  });

  if (!found) {
    console.error("No Eilik robot found.");
    process.exit(1);
  }

  peripheral = found;
  const name = found.advertisement.localName || "(unknown)";
  console.log(`Found: "${name}" [${found.uuid}]`);

  // Connect
  console.log("Connecting...");
  await nobleConnect(found);
  console.log("Connected!");

  // Discover ALL services, then locate the Eilik service 0x8888.
  const allServices = await nobleDiscoverServices(found, []);
  const service = allServices.find((s) => s.uuid.toLowerCase() === SERVICE_UUID)
    || allServices.find((s) => s.uuid.toLowerCase().startsWith("8888"));

  if (!service) {
    console.error("Eilik service 0x8888 was NOT exposed by this peripheral.");
    console.error("This is another strong sign you connected to the WRONG device.");
    for (const s of allServices) {
      console.log(`  Service: ${s.uuid}`);
      const chars = await nobleDiscoverCharacteristics(s, []);
      for (const c of chars) {
        console.log(`    Char: ${c.uuid} [${c.properties.join(", ")}]`);
      }
    }
    await nobleDisconnect(found);
    process.exit(1);
  }
  console.log(`Service: ${service.uuid}`);

  const chars = await nobleDiscoverCharacteristics(service, [CHAR_UUID]);
  if (chars.length === 0) {
    console.error(`Eilik characteristic ${CHAR_UUID} not found under service ${service.uuid}.`);
    const allChars = await nobleDiscoverCharacteristics(service, []);
    for (const c of allChars) {
      console.log(`    Char: ${c.uuid} [${c.properties.join(", ")}]`);
    }
    await nobleDisconnect(found);
    process.exit(1);
  }
  writeChar = chars[0];
  console.log(`Characteristic: ${writeChar.uuid}`);

  // Subscribe to notifications (to receive robot responses)
  await nobleSubscribe(writeChar);
  writeChar.on("data", (data) => {
    const hex = data.toString("hex");
    console.log(`  < ${fmt(hex)}`);
  });
  console.log("Notifications enabled.\n");

  // ── Send initialization commands (from getParams() in AiStationDetail.js lines 215-398) ──
  // These are the exact same commands the app fires on connect:
  //   1. formatData_v2("03", "07", "")  — get volume level
  //   2. formatData_v2("03", "08", "")  — get light strip brightness
  //   3. formatData_v2("01", "07", "")  — get device status
  const initCommands = [
    { inst: "03", child: "07", data: "", label: "Get Volume" },
    { inst: "03", child: "08", data: "", label: "Get Light Brightness" },
    { inst: "01", child: "07", data: "", label: "Get Device Status" },
  ];

  for (const cmd of initCommands) {
    const packets = formatData_v2(cmd.inst, cmd.child, cmd.data);
    const hexPacket = packets[0];
    const buf = hexToBuffer(hexPacket);

    console.log(`> ${cmd.label}`);
    console.log(`  > ${fmt(hexPacket)}`);

    try {
      await nobleWrite(writeChar, buf, false); // false = write with response
      console.log("  OK");
    } catch (err) {
      console.error("  Write failed:", err.message);
    }

    await sleep(300);
  }

  // ── Optional: Set volume to 50% (example of data payload) ──────────────
  // formatData_v2("04", "07", decimalToHexString(50, 4, false))
  // decimalToHexString(50, 4, false) = "3200" (50 in 2-byte LE)
  // const volPackets = formatData_v2("04", "07", "3200");
  // await nobleWrite(writeChar, hexToBuffer(volPackets[0]), false);

  console.log("\nInitialization complete. Listening for responses... (Ctrl+C to exit)\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Entry point ───────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// ── Cleanup on exit ───────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\nDisconnecting...");
  if (peripheral) {
    try { await nobleDisconnect(peripheral); } catch (_) {}
  }
  process.exit(0);
});
