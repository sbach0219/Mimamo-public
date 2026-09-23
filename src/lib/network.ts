import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

// Swift版 NetworkMonitor 相当。オンライン/オフラインを購読するフック。
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    return () => unsub();
  }, []);
  return online;
}
