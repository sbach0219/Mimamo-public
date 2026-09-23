import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigatorScreenParams } from '@react-navigation/native';

// 見守り側（昼テーマ）だけがタブを持つ（design-v3-watcher-redesign §2.2）。
// 歩く側（夜テーマ）は従来どおりルートスタックの全画面のまま。
export type WatcherTabParamList = {
  HomeTab: undefined;
  MapTab: undefined;
  MessagesTab: undefined;
  SettingsTab: undefined;
};

// Swift版の NavigationStack の遷移先に対応
export type RootStackParamList = {
  Onboarding: undefined;
  RoleSelect: undefined;
  WatcherTabs: NavigatorScreenParams<WatcherTabParamList> | undefined;
  WatcherSetup: undefined;
  WatcherMonitor: undefined;
  // 緊急画面はタブの中に入れず、タブの上に全画面で積む（§2.2）
  WatcherSos: undefined;
  Start: undefined;
  Main: { estimatedMinutes: number };
  MainSentinel: { estimatedMinutes: number };
  Chat: undefined;
  History: undefined;
  Settings: undefined;
  // 恒久ペア（ADR P3 Stage 1 = v3 Phase 2 の土台）。
  // v3 のタブIA（ホーム/ちず/メッセージ/設定）に移るとき、この画面の中身が
  // ホームタブの「見守り対象リスト」へ吸収される。
  Pairs: undefined;
  Profile: undefined;
  // ペア起点の見守り依頼を歩く人が受ける画面（2026-08-26 決定①）。
  // ここが立っている間、位置はまだ1点も流れていない。
  WatchRequest: { sessionId: string };
  // グループ機能（月額サブスク D-11）の購入画面。
  // APIキー未設定の環境では導線を出さない（entitlementStore.canShowPaywall）
  Paywall: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
