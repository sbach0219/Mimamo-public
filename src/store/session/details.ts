import { collection, doc, updateDoc, getDocs, query, orderBy, where, limit, serverTimestamp, Timestamp } from '@react-native-firebase/firestore';
import { auth, db } from '../../lib/firebase';
import { saveWatcherPhonePreference } from '../../lib/watchPreferences';
import type { SessionContext, Role, HistoryItem, SessionState } from './types';
import { tsToDate } from './model';

export function createDetailsActions({ set, get }: SessionContext): Pick<SessionState,
  'updateStatus' | 'saveWalkerPhone' | 'extendTime' | 'fetchHistory'
> {
  return {
    updateStatus: (status) => {
      const { sessionId } = get();
      if (!sessionId) return;
      updateDoc(doc(db, 'sessions', sessionId), { status }).catch(() => { });
    },

    // 緊急連絡先の登録（見守る人が入力）。rules が未反映の環境では拒否されるが、
    // その場合も見守り自体は壊さず「電話行が出ないだけ」に劣化させる。
    saveWalkerPhone: async (phone) => {
      const { sessionId } = get();
      if (!sessionId) return false;
      const trimmed = phone.replace(/[^0-9+-]/g, '').slice(0, 20);
      if (trimmed.length < 6) return false;
      try {
        // 圏外では書き込みが解決しないので、待ちっぱなしにしない
        await Promise.race([
          updateDoc(doc(db, 'sessions', sessionId), { walkerPhone: trimmed }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]);
        set({ walkerPhone: trimmed });
        saveWatcherPhonePreference(trimmed).catch(() => { });
        return true;
      } catch (e) {
        if (__DEV__) console.warn('saveWalkerPhone failed', e);
        return false;
      }
    },

    // 歩く側の「+N分」。予定時間と有効期限をN分だけ後ろへずらす。
    // 以前は「今から合計分数+バッファ」で期限を再計算していたため、押すタイミングで
    // 期限が数十分単位でズレていた（issue #8）。既存の expiresAt に加算する方式に修正。
    extendTime: (minutes) => {
      const { sessionId, estimatedMinutes, expiresAt } = get();
      if (!sessionId) return;
      const newTotal = estimatedMinutes + minutes;
      // expiresAt が未取得（リスナー到着前）や既に過ぎている場合は
      // 「今+30分バッファ」を基準にフォールバックする
      const base = expiresAt && expiresAt.getTime() > Date.now()
        ? expiresAt.getTime()
        : Date.now() + 1_800_000;
      const newExpires = new Date(base + minutes * 60_000);
      updateDoc(doc(db, 'sessions', sessionId), {
        estimatedMinutes: newTotal,
        expiresAt: Timestamp.fromDate(newExpires),
        timeExtendedAt: serverTimestamp(),
      }).catch(() => { });
      set({ estimatedMinutes: newTotal, expiresAt: newExpires });
    },

    fetchHistory: async () => {
      const uid = get().uid ?? auth.currentUser?.uid;
      if (!uid) return [];
      const sessionsCol = collection(db, 'sessions');
      // B-5: orderBy なしの limit(50) はドキュメントID順に効くため、50件を超えると
      // 「最新の50件」ではなく「IDの若い50件」になる。恒久ペアで履歴が増えると
      // 顕在化するので、複合インデックス（firestore.indexes.json）を足して
      // createdAt 降順で取る。ただしインデックスの構築中・未デプロイの環境では
      // クエリが失敗するため、その場合だけ従来の順序なしクエリへ落として
      // 「履歴が真っ白になる」ことは避ける（並べ替えは下でどのみち行う）。
      const fetchFor = async (field: 'watcherUid' | 'walkerUid') => {
        try {
          return await getDocs(query(sessionsCol, where(field, '==', uid), orderBy('createdAt', 'desc'), limit(50)));
        } catch (e) {
          if (__DEV__) console.warn('fetchHistory ordered query failed; falling back', e);
          return getDocs(query(sessionsCol, where(field, '==', uid), limit(50)));
        }
      };
      const [asWatcher, asWalker] = await Promise.all([fetchFor('watcherUid'), fetchFor('walkerUid')]);
      const toItem = (d: { id: string; data: () => any }, role: Role): HistoryItem => {
        const x = d.data();
        return {
          id: d.id,
          role,
          mode: x.mode === 'sentinel' ? 'sentinel' as const : 'hold' as const,
          estimatedMinutes: typeof x.estimatedMinutes === 'number' ? x.estimatedMinutes : 0,
          createdAt: tsToDate(x.createdAt) ?? new Date(),
          endedAt: tsToDate(x.endedAt),
          finalStatus: (x.status as string) ?? 'unknown',
        };
      };
      const items = [
        ...asWatcher.docs.map((d) => toItem(d, 'watcher')),
        ...asWalker.docs.map((d) => toItem(d, 'walker')),
      ];
      return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
  };
}
