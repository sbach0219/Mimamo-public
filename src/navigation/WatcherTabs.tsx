import React, { useEffect } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../components/Icon';
import { useTheme, withTheme } from '../theme/ThemeContext';
import { useSession } from '../store/sessionStore';
import { useWatchList } from '../store/watchListStore';
import WatcherHomeScreen from '../screens/WatcherHomeScreen';
import WatcherMapScreen from '../screens/WatcherMapScreen';
import WatcherMessagesScreen from '../screens/WatcherMessagesScreen';
import WatcherSettingsScreen from '../screens/WatcherSettingsScreen';
import type { WatcherTabParamList } from './types';

const Tab = createBottomTabNavigator<WatcherTabParamList>();

// 見守り側だけがタブを持つ（design-v3-watcher-redesign §2.2）。
// 詳細（WatcherMonitor）・SOS・チャットはタブの中に入れず、ルートスタックで
// タブの上に積む。緊急画面にタブバーを残さないため、そして通知タップの
// ルーティングをネスト無しの単純な navigate に保つため。
function WatcherTabs() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const uid = useSession((s) => s.uid);
  const startWatchList = useWatchList((s) => s.startWatchList);
  const stopWatchList = useWatchList((s) => s.stopWatchList);

  // 見守り対象リストの購読はタブの生存期間に一致させる。
  // 画面ごとに張ると、タブを行き来するたびに購読が張り直されて読み取りが増える。
  useEffect(() => {
    if (!uid) return;
    startWatchList(uid);
    return () => stopWatchList();
  }, [uid, startWatchList, stopWatchList]);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.action,
        tabBarInactiveTintColor: color.textSub,
        tabBarStyle: {
          backgroundColor: color.white,
          borderTopColor: color.glassStroke,
          // fontScale 1.5x でラベルが切れないよう、バーの高さに余白を持たせる（C-1）
          height: 62 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom + 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tab.Screen
        name="HomeTab"
        component={WatcherHomeScreen}
        options={{ title: 'ホーム', tabBarIcon: tabIcon('home') }}
      />
      <Tab.Screen
        name="MapTab"
        component={WatcherMapScreen}
        options={{ title: 'ちず', tabBarIcon: tabIcon('pin') }}
      />
      <Tab.Screen
        name="MessagesTab"
        component={WatcherMessagesScreen}
        options={{ title: 'メッセージ', tabBarIcon: tabIcon('chat') }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={WatcherSettingsScreen}
        options={{ title: '設定', tabBarIcon: tabIcon('info') }}
      />
    </Tab.Navigator>
  );
}

// アイコンは選択状態を色だけで表さない（ラベルが常に出ているので文言が主）。
function tabIcon(name: IconName) {
  const TabIcon = ({ color: tint, focused }: { color: string; focused: boolean }) => (
    <Icon name={name} size={24} tint={tint} opacity={focused ? 1 : 0.75} />
  );
  return TabIcon;
}

export default withTheme('light', WatcherTabs);
