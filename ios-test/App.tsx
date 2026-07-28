import 'react-native-get-random-values';
import React, { useState, useRef, useCallback } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
} from 'react-native';
import { BandBleManager } from './src/BandBleManager';
import { SppAuthProtocol } from './src/SppAuthProtocol';
import { SppPacketV2, SppChannel, SppDataOpcode, SppPacketType } from './src/SppPacketV2';
import { bytesToHex } from './src/SppAuthMessages';

type AppPhase =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'session_config'
  | 'phone_nonce'
  | 'watch_nonce'
  | 'auth_step3'
  | 'auth_success'
  | 'idle_10s'
  | 'done'
  | 'error';

interface LogEntry {
  ts: string;
  text: string;
  level: 'info' | 'warn' | 'error' | 'data' | 'send' | 'recv';
}

export default function App() {
  const [ltk, setLtk] = useState('');
  const [phase, setPhase] = useState<AppPhase>('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [idleElapsed, setIdleElapsed] = useState(0);
  const [connectionStayed, setConnectionStayed] = useState<boolean | null>(null);

  const bleRef = useRef<BandBleManager | null>(null);
  const authRef = useRef<SppAuthProtocol | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const log = useCallback(
    (text: string, level: LogEntry['level'] = 'info') => {
      const ts = new Date().toISOString().slice(11, 23);
      setLogs(prev => [...prev, { ts, text, level }]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
    },
    [],
  );

  const addLog = useCallback(
    (text: string, level: LogEntry['level'] = 'info') => log(text, level),
    [log],
  );

  const isValidLtk = /^[0-9a-f]{32}$/i.test(ltk);

  const handleConnect = async () => {
    if (!isValidLtk) return;

    setLogs([]);
    setIdleElapsed(0);
    setConnectionStayed(null);
    setPhase('scanning');

    const ltkBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      ltkBytes[i] = parseInt(ltk.substring(i * 2, i * 2 + 2), 16);
    }

    const ble = new BandBleManager();
    bleRef.current = ble;
    ble.onLog = (msg: string) => addLog(msg);

    try {
      // ── 1. Scan & Connect ──
      addLog('[1/5] Scanning + connecting...', 'info');
      setPhase('connecting');
      await ble.scanAndConnect(15000);
      addLog('✓ Connected to FE95', 'info');

      // ── 2. Session Config ──
      addLog('[2/5] Session Config...', 'info');
      setPhase('session_config');
      SppPacketV2.resetSequence();
      const scPacket = SppPacketV2.buildSessionConfigRequest();
      addLog(`SessionConfig (${scPacket.length}B): ${bytesToHex(scPacket)}`, 'send');
      await ble.write(scPacket);
      // Drain notifications — SPP layer inside BandBleManager already feeds them
      await ble.drainNotifications(15000);
      addLog('✓ Session Config done', 'info');

      // ── 3. Auth: PhoneNonce → WatchNonce ──
      addLog('[3/5] Auth PhoneNonce...', 'info');
      setPhase('phone_nonce');
      const auth = new SppAuthProtocol(ltkBytes);
      authRef.current = auth;
      const { nonce, packet: pnPacket } = auth.buildPhoneNonce();

      // Build SPP data packet AND WRITE IT (bug fix: was missing write)
      const sppPn = SppPacketV2.buildDataPacket(
        SppChannel.AUTHENTICATION,
        SppDataOpcode.SEND_PLAINTEXT,
        pnPacket,
      );
      addLog(`PhoneNonce seq=${sppPn[3]}: ${bytesToHex(pnPacket)}`, 'send');
      await ble.write(sppPn); // <-- CRITICAL: was missing!

      // Wait for WatchNonce response
      setPhase('watch_nonce');
      const wnRaw = await ble.waitForNotification(10000);
      addLog(`WatchNonce raw (${wnRaw.length}B): ${bytesToHex(wnRaw)}`, 'recv');

      // Parse SPP frame to extract auth payload (bug fix: was passing raw frame)
      const wnSpp = SppPacketV2.decode(wnRaw);
      if (!wnSpp || wnSpp.packetType !== SppPacketType.DATA) {
        throw new Error('WatchNonce: expected SPP DATA packet');
      }
      addLog(`WatchNonce decoded: ch=${wnSpp.channel} op=${wnSpp.opcode} payload(${wnSpp.payload.length}B)`, 'info');

      const step3 = await auth.processWatchNonce(wnSpp.payload);
      if (!step3) {
        throw new Error('WatchNonce decode/verify failed');
      }
      addLog('✓ WatchNonce processed, HMAC verified', 'info');

      // ── 4. AuthStep3 (CMD_AUTH=27) ──
      addLog('[4/5] Auth Step 3...', 'info');
      setPhase('auth_step3');
      const sppA3 = SppPacketV2.buildDataPacket(
        SppChannel.AUTHENTICATION,
        SppDataOpcode.SEND_PLAINTEXT,
        step3.authStep3Packet,
      );
      addLog(`AuthStep3 seq=${sppA3[3]}: ${bytesToHex(step3.authStep3Packet)}`, 'send');
      await ble.write(sppA3); // <-- CRITICAL: was missing!

      const authRaw = await ble.waitForNotification(10000);
      addLog(`Auth response raw (${authRaw.length}B): ${bytesToHex(authRaw)}`, 'recv');

      // Parse SPP frame for auth response
      const authSpp = SppPacketV2.decode(authRaw);
      if (!authSpp || authSpp.packetType !== SppPacketType.DATA) {
        throw new Error('Auth response: expected SPP DATA packet');
      }

      const authOk = auth.processAuthResponse(authSpp.payload);
      if (!authOk) {
        throw new Error('Auth FAILED - band rejected credentials');
      }

      addLog('AUTH SUCCESS!', 'info');
      setPhase('auth_success');

      // ── 5. Idle 10s watch ──
      addLog('[5/5] Idle 10s - watching connection...', 'info');
      setPhase('idle_10s');

      let disconnectedAt: number | null = null;

      for (let i = 1; i <= 10; i++) {
        await delay(1000);
        const stillConnected = ble.isConnected;
        setIdleElapsed(i);
        addLog(`  [${i}s] connected=${stillConnected}`, stillConnected ? 'info' : 'warn');

        if (!stillConnected) {
          disconnectedAt = i;
          setConnectionStayed(false);
          addLog(`Connection LOST at ${i}s`, 'error');
          break;
        }
      }

      if (disconnectedAt === null) {
        setConnectionStayed(true);
        addLog('Connection stayed alive for 10s!', 'info');
        addLog('RESULT: Band 9 keeps BLE alive via CoreBluetooth', 'info');
      } else {
        addLog(`RESULT: Band 9 dropped BLE at ${disconnectedAt}s via CoreBluetooth`, 'warn');
      }

      setPhase('done');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      addLog(`ERROR: ${msg}`, 'error');
      setPhase('error');
    }
  };

  const handleDisconnect = () => {
    bleRef.current?.disconnect();
    setPhase('idle');
  };

  const handleReset = () => {
    bleRef.current?.disconnect();
    bleRef.current = null;
    authRef.current = null;
    setPhase('idle');
    setLogs([]);
    setIdleElapsed(0);
    setConnectionStayed(null);
  };

  const isRunning =
    phase !== 'idle' && phase !== 'done' && phase !== 'error';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>BandEngine</Text>
        <Text style={styles.subtitle}>iOS BLE Auth Test</Text>
        <View style={styles.phaseRow}>
          <View
            style={[
              styles.phaseDot,
              {
                backgroundColor:
                  phase === 'error'
                    ? '#ff4444'
                    : phase === 'idle'
                    ? '#666'
                    : phase === 'done'
                    ? '#44ff44'
                    : '#ffcc00',
              },
            ]}
          />
          <Text style={styles.phaseText}>{phase.replace(/_/g, ' ').toUpperCase()}</Text>
        </View>
      </View>

      <View style={styles.ltkRow}>
        <Text style={styles.label}>LTK (32 hex):</Text>
        <TextInput
          style={[styles.input, !isValidLtk && ltk.length > 0 ? styles.inputError : null]}
          value={ltk}
          onChangeText={t => setLtk(t.replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 32))}
          placeholder="abcdef0123456789..."
          placeholderTextColor="#555"
          autoCapitalize="none"
          editable={!isRunning}
          maxLength={32}
        />
        <Text style={styles.counter}>{ltk.length}/32</Text>
      </View>

      <View style={styles.btnRow}>
        {!isRunning ? (
          <TouchableOpacity
            style={[styles.btn, !isValidLtk ? styles.btnDisabled : null]}
            disabled={!isValidLtk}
            onPress={handleConnect}>
            <Text style={styles.btnText}>
              {phase === 'error' ? 'Retry' : 'Connect & Auth'}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={handleDisconnect}>
            <Text style={styles.btnText}>Disconnect</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.btnReset} onPress={handleReset}>
          <Text style={styles.btnText}>Reset</Text>
        </TouchableOpacity>
      </View>

      {connectionStayed !== null && (
        <View
          style={[
            styles.resultBanner,
            connectionStayed ? styles.resultSuccess : styles.resultFail,
          ]}>
          <Text style={styles.resultText}>
            {connectionStayed
              ? 'Band 9 BLE stayed connected 10s'
              : `Band 9 dropped BLE at ${idleElapsed}s`}
          </Text>
        </View>
      )}

      {phase === 'idle_10s' && (
        <View style={styles.timerBar}>
          <View style={[styles.timerFill, { width: `${idleElapsed * 10}%` }]} />
          <Text style={styles.timerText}>{idleElapsed}s / 10s</Text>
        </View>
      )}

      <View style={styles.logContainer}>
        <Text style={styles.logTitle}>Log</Text>
        <ScrollView ref={scrollRef} style={styles.logScroll}>
          {logs.map((entry, i) => (
            <Text key={i} style={[styles.logLine, styles[`log_${entry.level}`] ?? null]}>
              <Text style={styles.logTs}>{entry.ts}</Text> {entry.text}
            </Text>
          ))}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
    padding: 12,
  },
  header: { marginBottom: 12 },
  title: { color: '#58a6ff', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8b949e', fontSize: 13 },
  phaseRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  phaseDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  phaseText: { color: '#c9d1d9', fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  ltkRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  label: { color: '#8b949e', fontSize: 13, marginRight: 8 },
  input: {
    flex: 1, backgroundColor: '#161b22', color: '#c9d1d9', fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6,
    borderWidth: 1, borderColor: '#30363d',
  },
  inputError: { borderColor: '#ff4444' },
  counter: { color: '#8b949e', fontSize: 12, marginLeft: 6, width: 36, textAlign: 'right' },
  btnRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  btn: { flex: 1, backgroundColor: '#238636', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  btnDisabled: { opacity: 0.4 },
  btnDanger: { backgroundColor: '#da3633' },
  btnReset: { backgroundColor: '#21262d', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  resultBanner: { padding: 10, borderRadius: 8, marginBottom: 8 },
  resultSuccess: { backgroundColor: '#1a3a1a' },
  resultFail: { backgroundColor: '#3a1a1a' },
  resultText: { color: '#c9d1d9', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  timerBar: {
    height: 24, backgroundColor: '#161b22', borderRadius: 12, overflow: 'hidden',
    marginBottom: 8, position: 'relative', justifyContent: 'center',
  },
  timerFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#1f6feb', borderRadius: 12 },
  timerText: { color: '#c9d1d9', fontSize: 12, fontWeight: '700', textAlign: 'center', zIndex: 1 },
  logContainer: {
    flex: 1, backgroundColor: '#161b22', borderRadius: 8, padding: 8,
    borderWidth: 1, borderColor: '#30363d',
  },
  logTitle: { color: '#8b949e', fontSize: 11, fontWeight: '600', marginBottom: 4, textTransform: 'uppercase' },
  logScroll: { flex: 1 },
  logLine: { color: '#c9d1d9', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 16 },
  logTs: { color: '#484f58' },
  log_info: {},
  log_warn: { color: '#d29922' },
  log_error: { color: '#ff4444' },
  log_data: { color: '#58a6ff' },
  log_send: { color: '#7ee787' },
  log_recv: { color: '#79c0ff' },
});
