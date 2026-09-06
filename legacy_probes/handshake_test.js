const noble = require("@abandonware/noble");

const SERVICE_UUID = "00008888-0000-1000-8000-00805f9b34fb";
const CHAR_UUID = "00009999-0000-1000-8000-00805f9b34fb";
const PRODUCTCODES = ["QL", "ES", "SB", "ML", "SX"];

function generalCheckSum(text) {
  let sum = 0;
  const arr = text.match(/.{2}/g) || [];
  for (const b of arr) sum += parseInt(b, 16);
  return (~sum & 0xff).toString(16).padStart(2, "0");
}
function decimalToHexString(value, numChars, flag = false) {
  const modulus = Math.pow(2, 4 * numChars);
  let result = (value % modulus).toString(16).padStart(numChars, "0");
  if (!flag) {
    const pairs = result.split(/(..)/).filter(Boolean).reverse();
    result = pairs.join("").toLowerCase();
  }
  return result;
}
function char2Hex(str) {
  let hex = "";
  for (const c of str) hex += c.charCodeAt(0).toString(16);
  return hex.toLowerCase();
}
function formatData_v2(arg0, arg1, arg2) {
  const dataArr = arg2.match(/.{2}/g) || [];
  let num = 1;
  if (arg2.length) num = Math.ceil(dataArr.length / 112);
  const packs = [];
  for (let i = 0; i < num; i++) {
    const chunk = (dataArr.slice(i * 112, (i + 1) * 112) || []).join("");
    const dataBytes = chunk.length;
    const sum6 = 13 + dataBytes;
    const text = `${decimalToHexString(sum6, 2, false)}${arg0}0000000000${arg1}${decimalToHexString(i + 1, 4, false)}${decimalToHexString(num, 4, false)}${chunk}`;
    const totalHex = "aaaaaa" + text;
    packs.push(totalHex + generalCheckSum(totalHex));
  }
  return packs[0];
}

function pkt(inst, cmd, data = "") {
  return formatData_v2(inst, cmd, data);
}

const SEND = (label, hex) =>
  new Promise((resolve) => {
    const buf = Buffer.from(hex, "hex");
    console.log(`\n<< ${label}: ${hex} (${buf.length}B)`);
    writeChar.write(buf, false, (err) => {
      if (err) console.error("write err", err);
      setTimeout(resolve, 4000);
    });
  });

let peripheral = null, svc = null, writeChar = null;

noble.on("stateChange", async (state) => {
  if (state !== "poweredOn") return;
  await noble.startScanning([], true);
  console.log("scanning...");
});

noble.on("discover", async (p) => {
  if (peripheral) return;
  const md = p.advertisement.manufacturerData;
  if (!md || md.length < 2) return;
  const code = md[0].toString(16).padStart(2, "0") + md[1].toString(16).padStart(2, "0");
  const rev = Buffer.from([md[1], md[0]]).toString("ascii");
  if (!PRODUCTCODES.includes(rev)) return;
  if (p.advertisement.localName === "AI Station 08XI" || rev === "ES" && md[2] === 0x40) {
    peripheral = p;
    console.log("Found Eilik:", p.advertisement.localName, p.id);
    await noble.stopScanning();
    await mkConnect(p);
  }
});

async function mkConnect(p) {
  try {
    await p.connectAsync();
    console.log("connected");
    const ss = await p.discoverServicesAsync([SERVICE_UUID]);
    svc = ss[0] || (await p.discoverServicesAsync([])).find((s) => s.uuid.toLowerCase().startsWith("8888"));
    console.log("service:", svc && svc.uuid);
    const allChars = await svc.discoverCharacteristicsAsync([]);
    console.log("ALL CHARS in 8888:");
    for (const c of allChars) {
      let descs = [];
      try { descs = await c.discoverDescriptorsAsync(); } catch (e) { descs = [{ uuid: "ERR" }]; }
      console.log(`   char ${c.uuid}  props:{${Object.keys(c.properties).filter((k) => c.properties[k]).join(",")}}  descs:[${descs.map((d) => d.uuid).join(", ")}]`);
    }
    writeChar = allChars.find((c) => c.uuid.toLowerCase().startsWith("9999")) || allChars[0];
    console.log("using char:", writeChar && writeChar.uuid);
    await writeChar.subscribeAsync();
    console.log("subscribed");

    writeChar.on("data", (d, isNotification) => {
      const hex = d.toString("hex");
      console.log(`    RX ${isNotification ? "notif" : "ind"}: ${hex}`);
    });

    await SEND("devFactoryInfo 00/00", pkt("00", "00"));
    await SEND("wifiCheck 03/01", pkt("03", "01"));
    await SEND("qVol 03/07", pkt("03", "07"));
    await SEND("qBright 03/08", pkt("03", "08"));
    await SEND("qStatus 01/07", pkt("01", "07"));
    await SEND("runAction flower 04/91/0d", pkt("04", "91", "0d"));

    console.log("\ndone. staying connected 20s for late replies...");
    setTimeout(async () => {
      await p.disconnectAsync();
      process.exit(0);
    }, 20000);
  } catch (e) {
    console.error("ERR", e);
    process.exit(1);
  }
}