// 地名ラベル（D-14）の純ロジック。
//
// ペアの「最終確認」に残す1語を作る／受け入れる側の器。ここが緩むと、セッションの
// 7日 purge の外にある文書（pairs）へ位置が運び込まれる。
//
// 同じ判定は functions/index.js の COORD_LIKE / sanitizePlaceLabel にもある。
// ビルド境界が違って import できないので、片方を直すときは必ず両方直すこと
// （sessionStatus.ts と同じ規約）。

export const PLACE_LABEL_MAX = 60;

// 座標が混じっている「らしさ」。十進度（小数3桁以上）・度記号・NSEW付きの数値を見る。
// 検出したら部分的に削らず**丸ごと捨てる**——地名として意味のある文字列に十進度が
// 入っている理由が無く、削って「それらしい地名」に仕立てるほうが、どこまで消えたか
// 分からず危ない。
export const COORD_LIKE = /\d+\.\d{3,}|\d{1,3}\s*°|[NSEW]\s*\d{1,3}\.\d/;

export function normalizePlaceLabel(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, PLACE_LABEL_MAX);
  if (trimmed.length === 0) return null;
  if (COORD_LIKE.test(trimmed)) return null;
  // 数字・記号だけなら、そもそも地名ではない
  if (!/[^\d.,\-+\s°'"NSEW]/.test(trimmed)) return null;
  return trimmed;
}

// 逆ジオコーディングの結果から「保存してよい粗さ」の地名を組み立てる。
//
// 110番通報に使う住所（useWalkerAddress の text）は street・streetNumber・name まで
// 連結する最大精度の文字列で、「東京都 世田谷区 三軒茶屋 2-1-5 ○○ハイツ」級になる。
// **番地付き住所は実質的に座標**であり、それをペア文書に7日残すのは
// 「lastSessionSummary に住所文字列は残さない」（ADR E-5）の趣旨に反する。
// 保存用はここで region / city / district までに落とす。
//
// 引数は expo-location の LocationGeocodedAddress のうち、ここで使う3つだけを取る
// （テストから呼べるように、フックではなく純関数として切り出してある）。
export type CoarsePlaceParts = {
  region?: string | null;
  city?: string | null;
  district?: string | null;
};

export function coarsePlaceLabel(parts: CoarsePlaceParts | null | undefined): string | null {
  if (!parts) return null;
  const text = [parts.region, parts.city, parts.district]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(' ');
  return normalizePlaceLabel(text);
}
