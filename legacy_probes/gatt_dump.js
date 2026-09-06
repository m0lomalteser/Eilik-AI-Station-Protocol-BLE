const noble = require("@abandonware/noble");
const PRODUCTCODES = ["QL", "ES", "SB", "ML", "SX"];
const SERVICE_UUID = "00008888-0000-1000-8000-00805f9b34fb";
let peripheral = null;

function promt(fn, ms = 12000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    fn((err, v) => { clearTimeout(t); err ? rej(err) : res(v); });
  });
}

noble.on("stateChange", async (state) => {
  if (state !== "poweredOn") return;
  await noble.startScanning([], true);
  console.log("scanning...");
});

noble.on("discover", (p) => {
  if (peripheral) return;
  const md = p.advertisement.manufacturerData;
  if (!md || md.length < 2) return;
  const rev = Buffer.from([md[1], md[0]]).toString("ascii");
  if (!PRODUCTCODES.includes(rev)) return;
  if (md[2] !== 0x40) return;
  peripheral = p;
  console.log("Found:", p.advertisement.localName, p.id);
  noble.stopScanning().then(() => start());
});

async function start() {
  try {
    await promt((cb) => peripheral.connectAsync().then(() => cb()).catch(cb));
    console.log("connected");
    const svcs = await promt((cb) => peripheral.discoverServicesAsync([SERVICE_UUID]).then((s) => cb(null, s)).catch(cb));
    const svc = svcs[0] || (await promt((cb) => peripheral.discoverServicesAsync([]).then((s) => cb(null, s)).catch(cb))).find((s) => s.uuid.toLowerCase().startsWith("8888"));
    console.log("service:", svc.uuid);
    const chars = await promt((cb) => svc.discoverCharacteristicsAsync([]).then((c) => cb(null, c)).catch(cb), 15000);
    for (const ch of chars) {
      let descs = [];
      try { descs = await promt((cb) => ch.discoverDescriptorsAsync().then((d) => cb(null, d)).catch(cb), 6000); } catch (e) { descs = [{ uuid: "ERR:" + e.message }]; }
      console.log(`  char ${ch.uuid}  props:{${Object.keys(ch.properties).filter((k) => ch.properties[k]).join(",")}}  descs:[${descs.map((d) => d.uuid).join(", ")}]`);
    }
  } catch (e) {
    console.error("ERR:", e);
  }
  try { await peripheral.disconnectAsync().catch(() => {}); } catch (e) {}
  process.exit(0);
}