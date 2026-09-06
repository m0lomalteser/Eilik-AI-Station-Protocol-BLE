const noble = require("@abandonware/noble");

const SERVICE_UUID = "8888";
const CHAR_UUID = "9999";
const DEVICE_ID_PREFIX = "04ca774858a1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decimalToHexString(num, len, bigEndian) {
  let hex = num.toString(16).toUpperCase().padStart(len, "0");
  if (!bigEndian) {
    hex = hex.match(/.{2}/g).reverse().join("");
  }
  return hex;
}

function formatData_v2(inst, child, data) {
  const lenHex = decimalToHexString(13 + data.length / 2, 2, false);
  const curPack = decimalToHexString(1, 4, false);
  const totalPack = decimalToHexString(1, 4, false);
  let result = "aaaaaa" + lenHex + inst + "0000000000" + child + curPack + totalPack;
  if (data && data.length > 0) {
    result += data;
  }
  const sum = result.split("").reduce((acc, c) => acc + parseInt(c, 16), 0);
  const ck = ((~sum) & 0xff).toString(16).toUpperCase().padStart(2, "0");
  return [result + ck];
}

let subscriptionsActive = false;
let write = null;
let allRx = [];

async function connect() {
  await noble.startScanning([], true);
  const peripheral = await new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("scan timeout")), 20000);
    noble.on("discover", (p) => {
      if (p.id && p.id.toLowerCase().startsWith(DEVICE_ID_PREFIX)) {
        clearTimeout(timer);
        resolve(p);
      }
    });
  });
  await new Promise((res, rej) => peripheral.connect((e) => (e ? rej(e) : res())));
  console.log("[connect] peripheral connected");
  await new Promise((res, rej) => peripheral.discoverServicesAsync([SERVICE_UUID]).then(() => res()).catch(rej));
  const service = peripheral.services.find((s) => s.uuid === "8888" || s.uuid.toLowerCase().startsWith("00008888"));
  if (!service) throw new Error("service 8888 not found");
  await service.discoverCharacteristicsAsync([]);
  const ch = service.characteristics.find((c) => c.uuid === "9999" || c.uuid.toLowerCase().startsWith("00009999"));
  if (!ch) throw new Error("char 9999 not found");
  console.log("[connect] services/char found");

  await new Promise((res, rej) => ch.notify(true, (e) => (e ? rej(e) : res())));
  ch.on("data", (data, isNotification) => {
    const hex = data.toString("hex").toUpperCase();
    allRx.push({ t: Date.now(), hex });
    console.log(`[rx ${isNotification ? "notif" : "ind"}] ${hex}`);
  });
  write = (hex) => new Promise((res, rej) => ch.write(Buffer.from(hex, "hex"), false, (e) => (e ? rej(e) : res())));
  console.log("[connect] notification subscribed");
  return peripheral;
}

function drain() { while (allRx.length) allRx.shift(); }
function waitForAnyRanged(kind, timeoutMs) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const tick = setInterval(() => {
      const now = process.hrtime.bigint();
      if ((Number(now - start) / 1e6) >= timeoutMs) {
        clearInterval(tick);
        return resolve(null);
      }
    }, 50);
  });
}

async function sendAndLog(label, hex, waitMs) {
  console.log(`\n>>> ${label}: TX ${hex}`);
  const before = allRx.length;
  await write(hex);
  await sleep(waitMs);
  const got = allRx.slice(before);
  if (got.length === 0) await sleep(waitMs);
  const final = allRx.slice(before);
  console.log(`<<< ${label}: ${final.length} rx packet(s)`);
  final.forEach((x) => console.log(`    RX ${x.hex}${x.hex.startsWith("555555") ? "  <-- 555555!!!" : ""}`));
  return final.some((x) => x.hex.startsWith("555555"));
}

(async () => {
  try {
    const p = await connect();

    console.log("\n=== STEP 0: listen for unsolicited traffic before any write (5s) ===");
    await sleep(5000);
    allRx.forEach((x) => console.log(`    UNSOLICITED RX ${x.hex}`));
    drain();

    console.log("\n=== STEP 1: getDeviceWifiInfo  (03 01) — app awaits reply up to 10s ===");
    await sendAndLog("wifi", "aaaaaa0d0300000000000101000100ee", 8000);

    console.log("\n=== STEP 2: getDeviceFactoryInfo (00 00) — app awaits reply up to 5s ===");
    await sendAndLog("factory", "aaaaaa0d0000000000000001000100f2", 8000);

    console.log("\n=== STEP 3: volume query (03 07) ===");
    await sendAndLog("volQ", "aaaaaa0d0300000000000701000100e8", 5000);

    console.log("\n=== STEP 4: brightness query (03 08) ===");
    await sendAndLog("briQ", "aaaaaa0d0300000000000801000100e7", 5000);

    console.log("\n=== STEP 5: status query (01 07) ===");
    await sendAndLog("statusQ", "aaaaaa0d0100000000000701000100ea", 5000);

    console.log("\n=== STEP 6: action flower (04 91 0d) ===");
    await sendAndLog("flower", "aaaaaa0f04000000000091010001000d4e", 6000);

    console.log("\n=== STEP 7: action open-chat (04 91 01) ===");
    await sendAndLog("opchat", "aaaaaa0d0400000000009101000100f1", 6000);

    console.log("\n=== STEP 8: action drink-tea (04 91 13) ===");
    await sendAndLog("tea", "aaaaaa0d0400000000009101000100e5", 6000);

    console.log("\n=== STEP 9: action sandwich (04 91 0e) ===");
    await sendAndLog("sandwich", "aaaaaa0e04000000000091010001000e21", 6000);

    console.log("\n=== STEP 10: volume set 30% (04 07 1e00) ===");
    await sendAndLog("volSet", "aaaaaa1104000000000007010001001e00cf", 5000);

    console.log("\n=== STEP 11: write-without-response attempt (04 91 0d) ===");
    await new Promise((res, rej) => write && console.log("[writeWithoutResponse not exposed]"));
    await sleep(4000);

    console.log("\n=== STEP 12: battery/energy probe (02 07)? ===");
    await sendAndLog("batt2-07", "aaaaaa0d0200000000000701000100e9", 4000);

    console.log("\n=== STEP 13: device-config probe (03 02)? ===");
    await sendAndLog("cfg3-02", "aaaaaa0d0300000000000201000100ed", 4000);

    console.log("\n=== STEP 14: heartbeat probe (01 08)? ===");
    await sendAndLog("hb1-08", "aaaaaa0d0100000000000801000100e9", 4000);

    console.log("\n=== DONE ===");
  } catch (e) {
    console.error("FATAL:", e.message);
  } finally {
    try { await noble.stopScanningAsync(); } catch (_) {}
    process.exit(0);
  }
})();