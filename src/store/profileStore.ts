import { create } from 'zustand';
import { doc, getDoc, setDoc, serverTimestamp } from '@react-native-firebase/firestore';
import { auth, db } from '../lib/firebase';
import { DEFAULT_AVATAR_ID, parseAvatarId, type AvatarId } from '../lib/avatars';
import { normalizeDisplayName } from '../lib/pairs';

// users/{uid}（ADR P3 決定1・決定2）。
//
// 匿名 uid を「端末上の人」の恒久IDに昇格させ、この文書で肉付けする。
// 氏名・メール・電話番号は取得しない（プライバシーポリシー §2 の公開済みの約束）。
// 表示名は任意入力のニックネームで、相手ペアにのみ見える。
//
// この文書は本人以外 read できない（firestore.rules）。相手に見せる表示名・アバターは
// ペア文書へ複製する方式をとる。理由は2つ:
//   1. fcmToken を誰にも読ませない（現行の「セッション参加者はお互いのトークンを
//      read できる」より安全側へ改善する = architecture-review E-2）
//   2. uid からペアを逆引きする rules の get() が要らず、read 課金とレイテンシが減る
export type Profile = {
  displayName: string;
  avatar: AvatarId;
};

interface ProfileState {
  profile: Profile;
  loaded: boolean;

  load: () => Promise<Profile | null>;
  save: (patch: Partial<Profile>) => Promise<void>;
  // アプリ起動時に打つ死活の脈（I-5）。長期不達のペアを functions が見つける材料になる。
  touchLastSeen: () => Promise<void>;
  // FCM トークンの住所をセッション文書から users へ移す（E-2）。
  registerFcmToken: (token: string) => Promise<void>;
}

const EMPTY_PROFILE: Profile = { displayName: '', avatar: DEFAULT_AVATAR_ID };

// users 文書への書き込みは「あれば更新・なければ作成」。rules は create / update の
// どちらでも同じフィールド許可リストを課しているので merge で統一できる。
async function writeMyUserDoc(patch: Record<string, unknown>): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  await setDoc(doc(db, 'users', uid), patch, { merge: true });
}

export const useProfile = create<ProfileState>((set, get) => ({
  profile: EMPTY_PROFILE,
  loaded: false,

  load: async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return null;
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      const data = snap.exists() ? snap.data() ?? {} : {};
      const profile: Profile = {
        displayName: typeof data.displayName === 'string' ? data.displayName : '',
        avatar: parseAvatarId(data.avatar),
      };
      set({ profile, loaded: true });
      return profile;
    } catch {
      // オフライン等。既定のプロフィールのまま起動を続ける（表示名は任意項目）
      set({ loaded: true });
      return null;
    }
  },

  save: async (patch) => {
    const next: Profile = {
      displayName: normalizeDisplayName(patch.displayName ?? get().profile.displayName),
      avatar: parseAvatarId(patch.avatar ?? get().profile.avatar),
    };
    set({ profile: next, loaded: true });
    await writeMyUserDoc({ displayName: next.displayName, avatar: next.avatar });
  },

  touchLastSeen: async () => {
    await writeMyUserDoc({ lastSeenAt: serverTimestamp() }).catch(() => {});
  },

  registerFcmToken: async (token) => {
    if (!token) return;
    await writeMyUserDoc({ fcmToken: token }).catch(() => {});
  },
}));
