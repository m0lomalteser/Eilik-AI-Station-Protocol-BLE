import asyncio
import base64
from bleak import BleakScanner, BleakClient

# Exakte UUIDs aus deinem extrahierten BleController.js
SERVICE_UUID = "00008888-0000-1000-8000-00805F9B34FB"
CHARACTERISTIC_UUID = "00009999-0000-1000-8000-00805F9B34FB"

def notification_handler(sender: int, data: bytearray):
    """Wird aufgerufen, wenn das Gerät Daten zurücksendet (Read/Notify)"""
    hex_data = data.hex()
    base64_data = base64.b64encode(data).decode('utf-8')
    print(f"\n📥 [Empfangen] Hex: {hex_data} | Base64: {base64_data}")

async def main():
    print("🔎 Suche nach Bluetooth-Geräten mit Service UUID: 00008888...")
    
    # Scannt nach Geräten, die den Service unterstützen
    devices = await BleakScanner.discover()
    target_device = None
    
    for d in devices:
        # Manche Geräte senden ihre UUIDs nicht im Werbe-Paket, wir listen daher alle nahen auf
        print(f" gefunden: {d.name} [{d.address}]")
        if d.name and "Awesome" in d.name:  # Falls du den Namen des Geräts kennst, hier anpassen
            target_device = d

    if not devices:
        print("❌ Keine Bluetooth-Geräte in der Nähe gefunden. Ist Bluetooth an?")
        return

    # Interaktive Auswahl, falls das Gerät nicht automatisch erkannt wurde
    print("\nVerfügbare Geräte:")
    for idx, d in enumerate(devices):
        print(f"[{idx}] {d.name or 'Unbekanntes Gerät'} - {d.address}")
    
    try:
        selection = int(input("\nWähle die Nummer des Geräts zum Verbinden: "))
        target_device = devices[selection]
    except (ValueError, IndexError):
        print("❌ Ungültige Auswahl.")
        return

    print(f"\n🔗 Verbinde mit {target_device.name} ({target_device.address})...")
    
    async with BleakClient(target_device.address) as client:
        if client.is_connected:
            print("✅ Erfolgreich verbunden!")
            
            # Starte das Lauschen auf Antworten (entspricht dem SetupStateMonitoring/Notify in React Native)
            try:
                await client.start_notify(CHARACTERISTIC_UUID, notification_handler)
                print("🎧 Lausche auf eingehende Daten auf Kanal 00009999...")
            except Exception as e:
                print(f"⚠️ Benachrichtigungen konnten nicht aktiviert werden: {e}")

            print("\n--- Interaktiver Modus ---")
            print("Gib Daten als HEX (z.B. 010203) oder Text ein.")
            print("Tippe 'exit' zum Beenden.\n")

            while True:
                user_input = input("📤 Senden > ").strip()
                if user_input.lower() == 'exit':
                    break
                if not user_input:
                    continue

                try:
                    # 1. Option: Versuch es als Hex-String zu interpretieren
                    payload = bytes.fromhex(user_input)
                except ValueError:
                    # 2. Option: Wenn es kein valides Hex ist, sende es als Klartext-Bytes
                    payload = user_input.encode('utf-8')

                # Zeige an, wie die React Native App das als Base64 verpacken würde
                base64_payload = base64.b64encode(payload).decode('utf-8')
                print(f"   [RN-Vorschau] App würde senden (Base64): '{base64_payload}'")

                # Daten an das Gerät senden (entspricht writeCharacteristic in der App)
                await client.write_gatt_char(CHARACTERISTIC_UUID, payload, response=True)
                print("   [Gesendet] Bytes erfolgreich übertragen.")
                await asyncio.sleep(0.5) # Kurze Pause für die Antwort

            await client.stop_notify(CHARACTERISTIC_UUID)
            print("\n🔌 Verbindung sauber getrennt.")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nAbgebrochen.")

