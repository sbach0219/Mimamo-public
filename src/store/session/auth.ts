import { signInAnonymously, onAuthStateChanged } from '@react-native-firebase/auth';
import { doc, updateDoc } from '@react-native-firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, db } from '../../lib/firebase';
import type { StoreApi } from 'zustand';
import type { SessionState } from './types';

export function createSessionAuth(
  set: StoreApi<SessionState>['setState'],
  get: () => SessionState,
  subscribe: StoreApi<SessionState>['subscribe'],
) {
  // cold start では既存の匿名ユーザーの復元を待つ。先に新規サインインすると
  // 旧 uid に結び付いた参加権限や履歴を失うため、initAuth の購読結果を使う。
  const AUTH_READY_TIMEOUT_MS = 3000;

  // true = authReady が立った / false = タイムアウトで諦めた
  function waitForAuthReady(): Promise<boolean> {
    if (get().authReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        resolve(ready);
      };
      const unsub = subscribe((state) => {
        if (state.authReady) finish(true);
      });
      const timer = setTimeout(() => finish(false), AUTH_READY_TIMEOUT_MS);
    });
  }

  // この端末が一度でも匿名ユーザーを持ったことがあるか。
  // 持ったことがあるなら、authReady のタイムアウトで新しい uid を発行してはいけない
  // （旧 uid の参加権限・履歴・進行中セッションを恒久的に失うため。待たせる方が安い）。
  const AUTH_SEEN_KEY = 'authUidSeen';

  let authSeenCache: boolean | null = null;

  async function hasSignedInBefore(): Promise<boolean> {
    if (authSeenCache !== null) return authSeenCache;
    try {
      authSeenCache = (await AsyncStorage.getItem(AUTH_SEEN_KEY)) === '1';
    } catch {
      authSeenCache = false;
    }
    return authSeenCache;
  }

  async function rememberSignedIn(): Promise<void> {
    if (authSeenCache) return;
    authSeenCache = true;
    await AsyncStorage.setItem(AUTH_SEEN_KEY, '1').catch(() => { });
  }

  // 匿名認証の完了を待つ。起動直後に「見守る/歩く」を素早くタップしても
  // 「認証エラー」にならないよう、サインインを1本に集約して待ち合わせる。
  let authPromise: Promise<string> | null = null;

  function ensureSignedIn(): Promise<string> {
    const current = auth.currentUser?.uid;
    if (current) return Promise.resolve(current);
    if (!authPromise) {
      // 即座に signInAnonymously() せず、まず authReady（永続化セッションの復元有無が
      // 判明するタイミング）を待ってから再確認する。復元できていればそのuidを使い、
      // できていなければ（本当に未認証）従来どおり匿名サインインする。
      authPromise = waitForAuthReady()
        .then(async (ready) => {
          const uid = auth.currentUser?.uid ?? null;
          if (uid) return uid;
          // 復元を待ちきれなかっただけの可能性がある。過去に uid を持っていた端末で
          // ここから新規サインインすると、旧 uid を踏み潰して二度と戻れない。
          if (!ready && (await hasSignedInBefore())) {
            throw new Error('認証の準備中です。少し待って、もう一度お試しください');
          }
          const cred = await signInAnonymously(auth);
          return cred.user.uid;
        })
        .then(async (uid) => { await rememberSignedIn(); return uid; })
        .finally(() => { authPromise = null; });
    }
    return authPromise;
  }

  const actions: Pick<SessionState, 'initAuth' | 'setFcmToken'> = {
    initAuth: () => {
      onAuthStateChanged(auth, (user) => {
        set({ uid: user?.uid ?? null, authReady: true });
        if (user) rememberSignedIn();
      });
      ensureSignedIn().catch((e) => console.warn('anon sign-in failed', e));
    },

    setFcmToken: (token) => {
      set({ fcmToken: token });
      // すでにセッション参加中なら、自分の役割のトークン欄を更新
      const { sessionId, myRole } = get();
      if (sessionId && myRole && token) {
        const field = myRole === 'watcher' ? 'watcherFcmToken' : 'walkerFcmToken';
        updateDoc(doc(db, 'sessions', sessionId), { [field]: token }).catch(() => { });
      }
    },
  };
  return { actions, ensureSignedIn };
}
