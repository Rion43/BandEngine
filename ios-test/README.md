# BandEngine iOS Test

Native iOS BLE auth test for Xiaomi Smart Band 9.

**Purpose:** Verify whether Band 9 BLE disconnect after auth is a Web Bluetooth issue or a band firmware issue. Uses `react-native-ble-plx` (CoreBluetooth) directly — no Web Bluetooth.

## Prerequisites

- macOS with Xcode 15+
- Node.js 18+
- Apple Developer account (free or paid)
- Xiaomi Smart Band 9 + LTK key

## Getting LTK

LTK (Long Term Key) = 32 hex chars, established during first-ever BLE pairing. Extract from:

- **Mi Fitness app backup** → `encrypt_key` in iOS manifest (bplist00)
- **Android** → `device_key` tablosu
- Your previous BandEngine session key from `localStorage.be_ltk`

## Setup

```bash
cd ios-test

# Install dependencies
npm install

# iOS pods
cd ios && pod install && cd ..
```

## Run on Device

```bash
npx react-native run-ios --device
```

Uses CoreBluetooth — **iOS simulator does not support BLE**. Must run on a real iPhone.

## EAS Build (for .ipa)

Prerequisites:
```bash
npm install -g eas-cli
eas login
eas build:configure
```

Build:
```bash
eas build --platform ios --profile preview
```

This produces an `.ipa` you can install via TestFlight or internal distribution.

## How to Test

1. Launch app → enter LTK (32 hex chars) → tap "Connect & Auth"
2. App shows live log:
   - Scan → Connect → Session Config
   - PhoneNonce (CMD_NONCE=26) → WatchNonce response
   - AuthStep3 (CMD_AUTH=27) → Auth result
3. After auth success → 10s idle timer with second-by-second connection status
4. Result: "✅ stayed connected 10s" or "❌ dropped at N s"

## Project Structure

```
ios-test/
├── App.tsx              # Main UI: log view, LTK input, phase display
├── index.js             # RN entry point
├── package.json         # Dependencies (react-native-ble-plx, @noble/hashes, @noble/ciphers)
├── app.json             # Expo/EAS config
├── eas.json             # EAS Build profiles
└── src/
    ├── BandBleManager.ts    # BLE wrapper (scan, connect, notify, SPP reassembly)
    ├── SppAuthProtocol.ts   # Auth orchestrator (PhoneNonce → WatchNonce → AuthStep3)
    ├── SppAuthCrypto.ts     # Key derivation + crypto (HKDF, AES-CTR, AES-CCM)
    ├── SppAuthMessages.ts   # Protobuf encode/decode (varint-based, no protobufjs)
    ├── SppPacketV2.ts       # SPPv2 framing: preamble, CRC-16/ARC, sequence
    ├── types.ts             # UUIDs, constants
    └── crypto/
        ├── HKDF.ts          # HKDF-HMAC-SHA256 (@noble/hashes)
        ├── aes-ctr.ts       # AES-128-CTR (@noble/ciphers)
        ├── aes-ccm.ts       # AES-CCM (@noble/ciphers)
        └── index.ts
```

## Known Issues

- iOS BLE scan requires FE95 service UUID in advertising — Band 9 advertises with FE95.
- If band shows "Pairing required" on retry, forget device in iOS Bluetooth settings and re-enter LTK.
- After auth, some firmware versions may still drop BLE — that's what this test detects.

## Related

- Original BandEngine: https://github.com/Rion43/BandEngine
- Gadgetbridge: https://codeberg.org/Freeyourgadget/Gadgetbridge

## License

MIT
