import Foundation
import CoreBluetooth

// Eilik probe harness (macOS CoreBluetooth = same BT stack as the iOS app)
let SERVICE_CBUUID  = CBUUID(string: "00008888-0000-1000-8000-00805F9B34FB")
let CHAR_CBUUID     = CBUUID(string: "00009999-0000-1000-8000-00805F9B34FB")
let TARGET_ID_PREFIX = "04ca7748".uppercased()

func hex(_ d: Data) -> String { d.map { String(format: "%02X", $0) }.joined() }

func decimalToHexString(_ num: Int, _ len: Int, _ bigEndian: Bool) -> String {
    var h = String(num, radix: 16).uppercased()
    while h.count < len { h = "0" + h }
    if !bigEndian {
        var out = ""
        var i = h.count
        while i > 0 { let s = max(0, i - 2); out += h[h.index(h.startIndex, offsetBy: s)..<h.index(h.startIndex, offsetBy: i)]; i -= 2 }
        h = out
    }
    return h
}

func formatData_v2(_ inst: String, _ child: String, _ data: String) -> String {
    let lenHex = decimalToHexString(13 + data.count / 2, 2, false)
    let curPack = decimalToHexString(1, 4, false)
    let totalPack = decimalToHexString(1, 4, false)
    var result = "aaaaaa" + lenHex + inst + "0000000000" + child + curPack + totalPack
    if !data.isEmpty { result += data }
    let body = String(result.dropFirst(6))
    var sum = 0
    var i = body.startIndex
    while i < body.endIndex {
        let n = body.index(i, offsetBy: 2)
        sum += Int(body[i..<n], radix: 16)!
        i = n
    }
    let ck = String((~sum) & 0xff, radix: 16).uppercased().leftPad(2)
    return result + ck
}

extension String {
    func leftPad(_ n: Int) -> String { self.count >= n ? self : String(repeating: "0", count: n - self.count) + self }
}

let EMOTE_NAMES: [String: String] = [
    "01": "smallChat", "02": "doctor", "03": "weather", "04": "rps", "05": "divination",
    "06": "fishing", "07": "thunder", "08": "fairyTail", "09": "eilikLegend", "0b": "coffee",
    "0c": "wine", "0d": "flower", "0e": "sandwich", "0f": "iceCream", "10": "spWater",
    "11": "painting", "12": "end-chat", "14": "power_off", "15": "quiet", "16": "theme",
    "17": "onlineChat",
]

func bytes(_ h: String) -> [UInt8] {
    var out = [UInt8](); var i = h.startIndex
    while i < h.endIndex { let n = h.index(i, offsetBy: 2); out.append(UInt8(h[i..<n], radix: 16)!); i = n }
    return out
}

func ascii(_ d: [UInt8]) -> String {
    String(d.compactMap { (32...126).contains($0) ? Character(UnicodeScalar($0)) : nil })
}

func describeReply(_ h: String) -> String {
    let up = h.uppercased()
    guard up.hasPrefix("555555"), up.count >= 40 else { return "" }
    let arr = bytes(up)
    let lenVal = Int(arr[3])
    let inst = String(format: "%02X", arr[4])
    let child = String(format: "%02X", arr[10])
    let cur = Int(arr[11]) | (Int(arr[12]) << 8)
    let tot = Int(arr[13]) | (Int(arr[14]) << 8)
    guard arr.count >= 16 else { return "" }
    let data = Array(arr.dropFirst(15).dropLast())
    var s = "555555:LEN=\(lenVal) INST=\(inst) CHILD=\(child) PACK=\(cur)/\(tot) DATA=\(hex(Data(data)))"
    let pr = ascii(data)
    if !pr.isEmpty { s += " ascii=\"\(pr)\"" }
    if inst == "03", child == "01" {
        let st = data.count > 1 ? String(format: "%02X", data[1]) : "?"
        var wifi = "unknown"
        if data.count > 1 { wifi = ["", "connecting", "fail", "failPwd", "connected", "", "", "", "", "skip"][Int(data[1]) < 10 ? Int(data[1]) : 0] }
        var ssid = ""
        if data.count > 3 { let l = Int(data[3]); if data.count >= 4 + l { ssid = ascii(Array(data[4..<(4 + l)])) } }
        s += "  [wifiState=\(st)/\(wifi) ssid=\"\(ssid)\" rssiData=\(data.first.map { String(format: "%02X", $0) } ?? "")]"
    } else if inst == "00", child == "00" {
        if data.count >= 31 {
            let cpu = ascii(Array(data[0..<16]))
            let mode = data[16] | (data[17] << 8) | (data[18] << 16) | (data[19] << 24)
            let ver = String(format: "%d.%d", data[20], data[21])
            let serial = data[26] | (data[27] << 8) | (data[28] << 16) | (data[29] << 24)
            let nl = Int(data[30])
            let name = data.count >= 31 + nl ? ascii(Array(data[31..<(31 + nl)])) : ""
            s += "  [cpu=\"\(cpu)\" mode=\(mode) ver=\(ver) appState=\(String(format: "%02X%02X%02X%02X", data[22], data[23], data[24], data[25])) serial=\(serial) name=\"\(name)\"]"
        }
    } else if inst == "04", child == "91" {
        if let d = data.first { s += "  [ack=\(String(format: "%02X", d))] " + (EMOTE_NAMES[String(format: "%02X", d)] ?? "") }
    } else if inst == "03", ["07", "08"].contains(child) {
        if let d = data.first { s += "  [value=\(String(format: "%02X", d))]"}
    }
    return s
}

class Probe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var cm: CBCentralManager!
    var centralReady = false
    var peripheral: CBPeripheral?
    var writeChar: CBCharacteristic?
    var notified = false
    var seqScheduled = false
    var lastTX = ""
    let seqQueue = DispatchQueue(label: "seq")
    var done = false
    let modeGattdump = CommandLine.arguments.contains("gattdump")
    let modeDemo = CommandLine.arguments.contains("demo")

    func start() {
        cm = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: false])
        while !centralReady { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1)) }
        print("[core] poweredOn; starting scan (all)")
        cm.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
            if self.peripheral == nil { print("[core] FATAL: no Eilik found in 30s"); exit(2) }
        }
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        centralReady = (central.state == .poweredOn)
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = peripheral.name ?? "(nil)"
        print("[scan] id=\(peripheral.identifier.uuidString) name=\(name) rssi=\(RSSI) svcs=\((advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.map{$0.uuidString} ?? [])")
        var match = peripheral.identifier.uuidString.uppercased().hasPrefix(TARGET_ID_PREFIX)
        if !match { match = name.lowercased().contains("eilik") || name.lowercased().contains("ai station") }
        if match && self.peripheral == nil {
            print("[core] connecting to \(name) (\(peripheral.identifier.uuidString)) ...")
            self.peripheral = peripheral
            peripheral.delegate = self
            central.stopScan()
            central.connect(peripheral, options: [CBConnectPeripheralOptionNotifyOnConnectionKey: true])
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        print("[core] CONNECTED")
        let wl = peripheral.maximumWriteValueLength(for: .withResponse)
        print("[core] maxWriteLength(withResponse)=\(wl) => ATT MTU ~= \(wl + 3)")
        print("[core] canSendWriteWithoutResponse=\(peripheral.canSendWriteWithoutResponse)")
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        print("[core] FAILED TO CONNECT: \(error?.localizedDescription ?? "?")")
        exit(1)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral: CBPeripheral, error: Error?) {
        print("[core] DISCONNECTED: \(error?.localizedDescription ?? "clean")")
        if !done { exit(3) }
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let services = peripheral.services, error == nil else { print("[core] svc err \(error!)"); exit(1) }
        print("[gatt] \(services.count) service(s):")
        for s in services {
            print("[gatt]   service \(s.uuid.uuidString)")
            peripheral.discoverCharacteristics(nil, for: s)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let chars = service.characteristics else { return }
        print("[gatt]   characteristics of \(service.uuid.uuidString):")
        for (i, c) in chars.enumerated() {
            var props = [String]()
            if c.properties.contains(.read) { props.append("read") }
            if c.properties.contains(.write) { props.append("write") }
            if c.properties.contains(.writeWithoutResponse) { props.append("writeWithoutResponse") }
            if c.properties.contains(.notify) { props.append("notify") }
            if c.properties.contains(.indicate) { props.append("indicate") }
            print("[gatt]     [\(i)] char \(c.uuid.uuidString) props={\(props.joined(separator: ","))} desc=\(c.descriptors ?? [])")
            if service.uuid.uuidString.hasSuffix("8888") && i == 0 && modeGattdump {
                writeChar = c
                print("[gatt]     ^ gattdump: using char[0] of 8888 as write/read/monitor target (app tmp15[0] equivalent)")
            }
            if !modeGattdump && (c.uuid.uuidString.hasPrefix("00009999") || c.uuid.uuidString.hasSuffix("9999")) { writeChar = c }
            if c.properties.contains(.notify) || c.properties.contains(.indicate) {
                peripheral.setNotifyValue(true, for: c)
            }
            if c.properties.contains(.read) {
                peripheral.readValue(for: c)
            }
        }
        if service.uuid.uuidString.hasSuffix("8888") || service.uuid.uuidString == "8888" {
            if !modeGattdump && writeChar == nil { writeChar = chars.first }
        }
        if writeChar != nil && !seqScheduled {
            seqScheduled = true
            DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { self.beginSequence() }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        print("[gatt] notify state for \(characteristic.uuid.uuidString): enabled=\(characteristic.isNotifying) err=\(error?.localizedDescription ?? "nil")")
        if characteristic.isNotifying { notified = true }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let data = characteristic.value {
            let h = hex(data)
            var line = "[rx@\(characteristic.uuid.uuidString)] \(h)"
            if h.hasPrefix("555555") {
                line += "  " + describeReply(h)
            } else if h == lastTX {
                line += "  <ECHO>"
            } else {
                line += "  <NON-ECHO>"
            }
            print(line, terminator: "")
            if let s = String(data: data, encoding: .ascii) {
                let filtered = s.unicodeScalars.filter { (32...126).contains($0.value) }.map(Character.init)
                if filtered.count > 0 { print("  (\"\(filtered)\")") } else { print("") }
            } else { print("") }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        print("[core] write ack for \(characteristic.uuid.uuidString): \(error?.localizedDescription ?? "OK")")
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        print("[core] readyToSendWriteWithoutResponse")
    }

    // MARK: sequence

    func beginSequence() {
        seqQueue.async {
            guard let ch = self.writeChar else { print("[core] no write char"); exit(1) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 135) {
                if !self.done { print("\n[core] GLOBAL TIMEOUT"); exit(4) }
            }
            print("\n[core] == replay app sequence ==")
            Thread.sleep(forTimeInterval: 2.0)

            var steps: [(String, String, Double)] = []
            if let ci = CommandLine.arguments.firstIndex(of: "cmd") {
                let a = CommandLine.arguments
                guard ci + 2 < a.count else { print("usage: ./eilikprobe cmd INST CHILD [DATAHEX]"); exit(2) }
                let inst = a[ci + 1], child = a[ci + 2]
                let data = (ci + 3 < a.count) ? a[ci + 3] : ""
                let pkt = formatData_v2(inst, child, data)
                steps = [("CMD \(inst) \(child) \(data)", pkt, 5.0)]
            } else if self.modeDemo {
                let emotes: [(String, String)] = [
                    ("01", "smallChat"), ("02", "doctor"), ("03", "weather"), ("04", "rps"),
                    ("05", "divination"), ("06", "fishing"), ("07", "thunder"), ("08", "fairyTail"),
                    ("09", "eilikLegend"), ("0b", "coffee"), ("0c", "wine"), ("0d", "flower"),
                    ("0e", "sandwich"), ("0f", "iceCream"), ("10", "spWater"), ("11", "painting"),
                    ("16", "theme"), ("15", "quiet"),
                ]
                for (sub, name) in emotes {
                    steps.append(("EM 04 91 \(sub) \(name)", formatData_v2("04", "91", sub), 3.0))
                }
                steps.append(("EM 02 82 set screen", formatData_v2("02", "82", decimalToHexString(80, 4, false)), 3.0))
                steps.append(("EM 04 08 light set", formatData_v2("04", "08", decimalToHexString(80, 4, false)), 3.0))
                steps.append(("EM 04 07 vol 40", formatData_v2("04", "07", decimalToHexString(40, 4, false)), 3.0))
                steps.append(("EM 04 91 14 power_off", formatData_v2("04", "91", "14"), 5.0))
            } else if self.modeGattdump {
                steps = [
                    ("GD1 wifi     03 01    ", formatData_v2("03", "01", ""), 6.0),
                    ("GD2 factory  00 00    ", formatData_v2("00", "00", ""), 6.0),
                    ("GD3 volQ     03 07    ", formatData_v2("03", "07", ""), 4.0),
                    ("GD4 briQ     03 08    ", formatData_v2("03", "08", ""), 4.0),
                    ("GD5 statusQ  01 07    ", formatData_v2("01", "07", ""), 4.0),
                    ("GD6 flower   04 91 0d ", formatData_v2("04", "91", "0d"), 6.0),
                    ("GD7 chat     04 91 01 ", formatData_v2("04", "91", "01"), 6.0),
                    ("GD8 volume30 04 07 1e00", formatData_v2("04", "07", decimalToHexString(30, 4, false)), 5.0),
                ]
            } else if CommandLine.arguments.contains("sweep") {
                let combos: [(String, String)] = [
                    ("03","01"),("03","02"),("03","03"),("03","04"),("03","05"),("03","06"),
                    ("03","07"),("03","08"),("03","09"),("03","0a"),("03","85"),
                    ("01","02"),("01","03"),("01","04"),("01","05"),("01","07"),("01","08"),("01","09"),("01","84"),("01","85"),("01","87"),
                    ("02","02"),("02","04"),("02","05"),("02","06"),("02","07"),("02","08"),("02","09"),("02","90"),
                    ("00","01"),("00","02"),
                    ("05","01"),("05","02"),("05","03"),("05","04"),
                    ("04","02"),("04","03"),("04","04"),("04","07"),
                ]
                for c in combos {
                    steps.append(("SW \(c.0) \(c.1)", formatData_v2(c.0, c.1, ""), 1.2))
                }
                steps.append(("SW 04 01 wifi-empty", formatData_v2("04","01","01000200"), 4.0))
            } else if let wi = CommandLine.arguments.firstIndex(of: "wifi") {
                var wifiPkt = ""
                let a = CommandLine.arguments
                if wi + 2 < a.count {
                    let ssid = a[wi + 1], pwd = a[wi + 2]
                    var data = "01" + decimalToHexString(ssid.count, 2, false)
                    for b in ssid.utf8 { data += String(format: "%02X", b) }
                    data += "02" + decimalToHexString(pwd.count, 2, false)
                    for b in pwd.utf8 { data += String(format: "%02X", b) }
                    wifiPkt = formatData_v2("04", "01", data)
                }
                steps = [
                    ("WF  04 01 wifi-config \(wifiPkt.isEmpty ? "(none)" : "")", wifiPkt, 8.0),
                    ("Q   03 01 wifi          ", formatData_v2("03","01",""), 5.0),
                    ("Q   00 00 factory       ", formatData_v2("00","00",""), 5.0),
                    ("A   04 91 0d flower     ", formatData_v2("04","91","0d"), 7.0),
                    ("Q   03 07 vol           ", formatData_v2("03","07",""), 5.0),
                ]
            } else {
                steps = [
                    ("STEP1 wifi     03 01    ", formatData_v2("03", "01", ""), 6.0),
                    ("STEP2 factory  00 00    ", formatData_v2("00", "00", ""), 6.0),
                    ("STEP3 volQ     03 07    ", formatData_v2("03", "07", ""), 4.0),
                    ("STEP4 briQ     03 08    ", formatData_v2("03", "08", ""), 4.0),
                    ("STEP5 statusQ  01 07    ", formatData_v2("01", "07", ""), 4.0),
                    ("STEP6 flower   04 91 0d ", formatData_v2("04", "91", "0d"), 6.0),
                    ("STEP7 chat     04 91 01 ", formatData_v2("04", "91", "01"), 6.0),
                    ("STEP8 tea      04 91 13 ", formatData_v2("04", "91", "13"), 6.0),
                    ("STEP9 set30%   04 07 1e00", formatData_v2("04", "07", decimalToHexString(30, 4, false)), 5.0),
                ]
            }
            for (label, packet, wait) in steps {
                print("\n>>> \(label) TX \(packet)", terminator: " ")
                fflush(stdout)
                var buf = [UInt8]()
                var idx = packet.startIndex
                while idx < packet.endIndex {
                    let n = packet.index(idx, offsetBy: 2)
                    buf.append(UInt8(packet[idx..<n], radix: 16)!)
                    idx = n
                }
                DispatchQueue.main.sync {
                    self.peripheral!.readValue(for: ch)
                    usleep(200_000)
                    self.lastTX = packet
                    self.peripheral!.writeValue(Data(buf), for: ch, type: .withResponse)
                }
                let chunks = Int(wait / 1.0)
                for _ in 0..<chunks {
                    Thread.sleep(forTimeInterval: 1.0)
                    print(".", terminator: "")
                    fflush(stdout)
                }
                print(" wait done")
            }

            let specialMode = self.modeGattdump || self.modeDemo || CommandLine.arguments.contains("sweep") || CommandLine.arguments.contains("wifi") || (CommandLine.arguments.firstIndex(of: "cmd") != nil)
            if !specialMode {
                // sanity write-without-response
                print("\n>>> sanity 04 91 0d writeWithoutResponse", terminator: " ")
                fflush(stdout)
                var buf2 = [UInt8]()
                let packet = formatData_v2("04", "91", "0d")
                var i = packet.startIndex
                while i < packet.endIndex {
                    let n = packet.index(i, offsetBy: 2)
                    buf2.append(UInt8(packet[i..<n], radix: 16)!)
                    i = n
                }
                DispatchQueue.main.sync {
                    self.peripheral!.writeValue(Data(buf2), for: ch, type: .withoutResponse)
                }
                for _ in 0..<2 {
                    Thread.sleep(forTimeInterval: 1.0)
                    print(".", terminator: "")
                    fflush(stdout)
                }
                print(" wait done")
            }

            print("\n[core] DONE")
            self.done = true
            exit(0)
        }
    }
}

let probe = Probe()
probe.start()
RunLoop.main.run()