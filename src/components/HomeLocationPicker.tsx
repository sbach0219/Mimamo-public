import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Region } from 'react-native-maps';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { Icon } from './Icon';
import { palette } from '../theme/tokens';
import { useTheme } from '../theme/ThemeContext';
import { haptics } from '../lib/haptics';
import type { Coord } from '../store/sessionStore';

const DEFAULT_REGION: Region = {
  latitude: 35.681, // 東京駅
  longitude: 139.767,
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

export function HomeLocationPicker({
  visible,
  onCancel,
  onSelect,
}: {
  visible: boolean;
  onCancel: () => void;
  onSelect: (coord: Coord) => void;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView>(null);
  const centerRef = useRef<Coord>({ latitude: DEFAULT_REGION.latitude, longitude: DEFAULT_REGION.longitude });
  const [ready, setReady] = useState(false);

  const goToCurrentLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const region: Region = {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      latitudeDelta: 0.005,
      longitudeDelta: 0.005,
    };
    centerRef.current = { latitude: region.latitude, longitude: region.longitude };
    mapRef.current?.animateToRegion(region, 500);
  };

  return (
    <Modal visible={visible} animationType="slide" onShow={() => { if (!ready) { setReady(true); goToCurrentLocation(); } }}>
      {/* 地図タイルは常に明るいので、この画面のあいだだけ時計や電池を暗い字にする
          （アプリ全体は StatusBar style="light"。Modal を閉じると元に戻る） */}
      {visible && <StatusBar style="dark" />}
      <View style={{ flex: 1 }}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={DEFAULT_REGION}
          onRegionChangeComplete={(r) => { centerRef.current = { latitude: r.latitude, longitude: r.longitude }; }}
          showsUserLocation
        />
        {/* 中央固定ピン */}
        <View pointerEvents="none" style={styles.pinWrap}>
          <View style={styles.pin}><Icon name="pin" size={40} /></View>
        </View>

        {/* Modal の中は別のビュー階層なので SafeAreaView が自分でインセットを
            測れず 0 になる（Dynamic Island に文字が食い込む）。Provider 配下の
            この画面で読んだ値を明示的に効かせる */}
        <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.topBtn} onPress={onCancel}>
            <Text style={styles.topBtnText}>キャンセル</Text>
          </Pressable>
          <Text style={styles.topTitle}>自宅をピン留め</Text>
          <Pressable style={styles.topBtn} onPress={goToCurrentLocation}>
            <Text style={styles.topBtnText}>📍現在地</Text>
          </Pressable>
        </View>

        <View style={[styles.bottom, { paddingBottom: insets.bottom + 16 }]}>
          <Pressable
            style={[styles.confirm, { backgroundColor: color.info }]}
            onPress={() => { haptics.success(); onSelect(centerRef.current); }}
          >
            <Text style={[styles.confirmText, { color: color.inkOnAccent }]}>この場所を自宅に設定</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  pinWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  pin: { marginBottom: 44 },
  top: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, paddingHorizontal: 12, paddingBottom: 8,
  },
  // 地図の上に重ねる操作系は昼夜とも黒すりガラス＋白文字（地図タイルは常に明るいため）
  topBtn: {
    minHeight: 44, justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
  },
  topBtnText: { color: palette.white, fontWeight: '600' },
  topTitle: { color: palette.white, fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 16, paddingTop: 16 },
  confirm: { minHeight: 56, justifyContent: 'center', paddingVertical: 14, borderRadius: 16, alignItems: 'center' },
  confirmText: { fontSize: 17, fontWeight: '700' },
});
