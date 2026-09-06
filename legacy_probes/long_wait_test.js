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
function decHex(v, n, f = false) {
  let r = (v % Math.pow(2, 4 * n)).toString(16).padStart(n, "0");
  if (!f) r = r.split(/(..)/).filter(Boolean).reverse().join("");
  return r;
}
function fv2(a0, a1, a2) {
  const d = a2.match(/.{2}/g) || [];
  const n = a2.length ? Math.ceil(d.length / 112) : 1;
  for (let i = 0; i < n; i++) {
    const c = (d.slice(i * 112, (i + 1) * 112) || []).join("");
    const l = 13 + c.length;
    const t = decHex(l, 2) + a0 + "0000000000" + a1 + decHex(i + 1, 4) + decHex(n, 4) + c;
    return "aaaaaa" + t + generalCheckSum("aaaaaa" + t);
  }
}

let peripheral = null;

noble.on("stateChange", async (s) => {
  if (s !== "poweredOn") return;
  await noble.startScanning([], true);
  console.log("scanning...");
});

noble.on("discover", (p) => {
  if (peripheral) return;
  const md = p.advertisement.manufacturerData;
  if (!md || md.length < 2) return;
  if (Buffer.from([md[1], md[0]]).toString("ascii") !== "ES") return;
  if (md[2] !== 0x40) return;
  peripheral = p;
  console.log("Found:", p.advertisement.localName);
  noble.stopScanning().then(() => go());
});

let notifCount = 0;

async function go() {
  await peripheral.connectAsync();
  console.log("connected");
  const ss = await peripheral.discoverServicesAsync([SERVICE_UUID]);
  const svc = ss[0];
  const cs = await svc.discoverCharacteristicsAsync([CHAR_UUID]);
  const ch = cs[0];
  await ch.subscribeAsync();
  console.log("subscribed, writing 00/00 and waiting 30s for late response...\n");

  ch.on("data", (d) => {
    notifCount++;
    const hex = d.toString("hex");
    const ts = Date.now();
    const prefix = hex.substring(0, 12);
    console.log(`[${ts}] notif#${notifCount}: ${hex}  prefix=${prefix}  isResponse=${prefix === "555555"}`);
  });

  // Write factory info command
  const hex = fv2("00", "00", "");
  console.log(">>", hex);
  await ch.writeAsync(Buffer.from(hex, "hex"), true);

  // Wait 30 seconds for any late notifications
  for (let i = 1; i <= 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i % 5 === 0) console.log(`... ${i}s elapsed, total notifs: ${notifCount}`);
  }

  console.log(`\nDone. Total notifications received: ${notifCount}`);
  await peripheral.disconnectAsync();
  process.exit(0);
}
