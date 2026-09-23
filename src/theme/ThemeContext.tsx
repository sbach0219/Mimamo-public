import React, { createContext, useContext, useMemo } from 'react';
import { darkColor, themeColors, type ThemeColor, type ThemeMode } from './tokens';

// 役割別2テーマの解決レイヤー（docs/design-pink-proposal B案）。
// 既定は夜。Provider で包まなかった画面・コンポーネントは従来どおりダークのまま動く。
type ThemeValue = { mode: ThemeMode; color: ThemeColor };

const DARK: ThemeValue = { mode: 'dark', color: darkColor };

const ThemeContext = createContext<ThemeValue>(DARK);

export function ThemeProvider({ mode, children }: { mode: ThemeMode; children: React.ReactNode }) {
  const value = useMemo<ThemeValue>(() => ({ mode, color: themeColors[mode] }), [mode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

// StyleSheet はテーマごとに1回だけ作る。factory はモジュール定数を渡すこと。
export function useThemedStyles<T>(factory: (c: ThemeColor, mode: ThemeMode) => T): T {
  const { color, mode } = useTheme();
  return useMemo(() => factory(color, mode), [factory, color, mode]);
}

// 画面単位でテーマを固定する（画面本体は useTheme を使える）。
export function withTheme<P extends object>(mode: ThemeMode, Screen: React.ComponentType<P>) {
  const Themed = (props: P) => (
    <ThemeProvider mode={mode}>
      <Screen {...props} />
    </ThemeProvider>
  );
  Themed.displayName = `withTheme(${mode})(${Screen.displayName ?? Screen.name})`;
  return Themed;
}
