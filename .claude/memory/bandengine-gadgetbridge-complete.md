---
name: bandengine-gadgetbridge-complete
description: "BandEngine + Gadgetbridge full analysis, autoReconnect fix, and GB MOD implementation - complete summary"
metadata:
  node_type: memory
  type: project
  tags:
    - band-engine
    - gadgetbridge
    - xiaomi-band-9
    - bluetooth
    - web-bluetooth
    - auto-reconnect
    - pairing-fix
  originSessionId: session-2026-07-24
  modified: 2026-07-24T14:32:01.016Z
---

# BandEngine + Gadgetbridge Complete Project Summary

## 📍 Project Info
- **Repo:** https://github.com/Rion43/BandEngine
- **Deploy:** https://rion43.github.io/BandEngine/
- **Branch:** master
- **Latest Commit:** `9ae143b` → `842262c` → `b1b347f` (current)

## 🎯 Proje Hedefi
Xiaomi Smart Band 9 için Web Bluetooth tabanlı Gadgetbridge portu. Auth başarılı ama band ~70-100ms sonra disconnect ediyordu. Gadgetbridge'in auto-reconnect mantığını Web Bluetooth'a port et.

## ✅ Yapılan İşler

### 1. Gadgetbridge Derin Analizi (Tamamlandı)
**Dosya:** `sonuç-gadgetbridge-deep-analysis.txt` + `sonuç-gadgetbridge-analiz.txt`

**Kritik Bulgular (Kaynak Kod Kanıtlı):**
- **Auth Success sonrası ~30+ encrypted komut** gönderiliyor (Clock sync → System init 9 komut → Health 8 komut → Notification → Schedule → Weather → Calendar)
- **Gadgetbridge'de disconnect NORMAL** - `autoReconnect=true` ile `gatt.connect()` çağırıp state restore ediyor
- **BandEngine'de auto-reconnect YOK** → bağlantı kalıcı ölüyor
- **Kritik eksikler:** write callback zinciri, CCCD callback, requestMtu, service discovery delay, **auto-reconnect YOK**, state restore YOK

### 2. GB MOD (TEST 14) Implementation

#### Yeni Dosyalar:
- `demo/src/GadgetbridgeMode.ts` - Gadgetbridge akışının birebir portu + autoReconnect

#### Değiştirilen Dosyalar:
- `demo/src/main.ts` - TEST 14 entegrasyonu, btnConnect callback'i
- `src/SppAuthCrypto.ts` - asmcrypto.js AES-CTR (BouncyCastle uyumlu)
- `src/SppAuthProtocol.ts` - Auth protocol
- `src/SppPacketV2.ts` - SPPv2 encoding
- `src/SppSystemMessages.ts` - Clock protobuf encoder

### 3. Auto-Reconnect Fix (Son Durum - 9ae143b)

**GadgetbridgeMode.ts - handleDisconnected fonksiyonu:**

```typescript
// Sadece FULL INIT TAMAMLANDIKTAN SONRA reconnect et (pairing bozulmasın)
if (handle.state === State.INITIALIZED && handle.autoReconnect && handle.fullyInitialized && handle.device?.gatt) {
  // 60sn güvenlik: İlk 60sn içinde reconnect ETME (pairing tamamlanıyor olabilir)
  const timeSinceInit = Date.now() - handle.initCompleteTime;
  if (timeSinceInit < 60000) {
    handle.state = State.NOT_CONNECTED;
    return;
  }

  log('info', `[GB] autoReconnect: device.gatt.connect()`);
  await handle.device!.gatt!.connect();  // DOĞRU: device.gatt.connect()
  
  // CRITICAL: Reconnect sonrası gattServer referansını GÜNCELLE
  handle.gattServer = handle.device!.gatt!;
  
  // Servis/karakteristik yeniden keşfet + notification re-enable
  // State restore
}
```

**Kritik Fixler:**
1. `gattServer.connect()` → `device.gatt.connect()` (Web Bluetooth doğru API)
2. `handle.gattServer = handle.device!.gatt!` - reconnect sonrası referans güncelleme
3. `fullyInitialized` flag - pairing sırasında reconnect engelleme
4. `fullyInitialized = true` - service init tamamlandığında set edilir
5. 60sn güvenlik süresi - pairing sırasında reconnect engelleme

### 4. Gadgetbridge Analiz Sonuçları (Kanıtlı)

**Dosya:** `sonuç-gadgetbridge-deep-analysis.txt`

**Kesin Bulgular:**
1. **Auth Success sonrası ~30+ encrypted komut** gönderiliyor (Clock sync → System init 9 komut → Health 8 komut → Notification → Schedule → Weather → Calendar)
2. **Gadgetbridge'de disconnect NORMAL** - autoReconnect ile anında kurtarılır (`BtLEQueue.java:447-464`)
3. **BandEngine'de auto-reconnect YOK** → bağlantı kalıcı ölür
4. **Kritik eksikler:** write callback zinciri, CCCD callback, requestMtu, service discovery delay, **auto-reconnect YOK**, state restore, MTU

**Çözüm:** `device.gatt.connect()` + servis/char rediscovery + notification re-enable + state restore implement et. GB MOD (TEST 14) bunu test ediyor.

## 📁 İlgili Dosyalar

### Kaynak Kod:
- `demo/src/GadgetbridgeMode.ts` - Ana implementasyon
- `demo/src/main.ts` - TEST 14 entegrasyonu
- `src/SppAuthCrypto.ts` - asmcrypto AES-CTR
- `src/SppAuthProtocol.ts` - Auth protocol
- `src/SppPacketV2.ts` - SPPv2 encoding

### Analiz Raporları:
- `sonuç-gadgetbridge-deep-analysis.txt` - Tam analiz raporu
- `sonuç-gadgetbridge-analiz.txt` - Özet analiz

### Commit Geçmişi:
- `9ae143b` - 6.0-gbmod-v6
- `b1b347f` - 6.0-gbmod-v5
- `842262c` - 6.0-gbmod-v7 (current)

## 🎯 Test Planı
1. GitHub Pages deploy bekle (~1-2 dk)
2. Bluefy → **TEST 14 (GB MOD)** seç
3. **Connect** → cihaz seç → Auth → **disconnect → autoReconnect** loglarını izle

**Beklenen Loglar:**
```
[GB] autoReconnect: device.gatt.connect()
[GB] autoReconnect OK - gatt connected
[GB] Re-discovered chars: W=... N=...
[GB] Notifications re-enabled
[GB] autoReconnect FULLY RESTORED
[1s] connected=true
```

## 🔗 Links
- **Repo:** https://github.com/Rion43/BandEngine
- **Deploy:** https://rion43.github.io/BandEngine/
- **Latest Commit:** `9ae143b` (6.0-gbmod-v7)