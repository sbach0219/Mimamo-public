
// 地名ラベル（D-14）の受け入れ検証。歩く人の端末が書いた1語をペアへ転記する前に、
// 座標が紛れ込んでいないかをここでも見る（クライアント側の normalizePlaceLabel と
// 二重の防波堤。ペアは7日 purge の外にある文書なので、入口を厳しくする価値がある）。
const PLACE_LABEL_MAX = 60;

const DESTINATION_LABEL_MAX = 30;

// 座標が混じっている「らしさ」の検出（M-4）。
// 以前は「数字と記号だけの文字列」しか弾いておらず、`自宅 35.681236,139.767125` のように
// 文字が1つでも混ざれば通り抜けた。除去ではなく**検出したら丸ごと捨てる**方針にする
// ——地名として意味のある文字列に十進度が入っている理由が無く、部分的に削って
// 「それらしい地名」に仕立てるほうが、どこまで消えたか分からず危ない。
//
// この式は src/lib/placeLabel.ts の COORD_LIKE と同じもの。ビルド境界が違って
// import できないので、片方を直すときは必ず両方直すこと（sessionStatus.ts と同じ規約）。
const COORD_LIKE = /\d+\.\d{3,}|\d{1,3}\s*°|[NSEW]\s*\d{1,3}\.\d/;

function sanitizePlaceLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, PLACE_LABEL_MAX);
  if (text.length === 0) return null;
  if (COORD_LIKE.test(text)) return null;
  // 数字・記号だけなら、そもそも地名ではない
  if (!/[^\d.,\-+\s°'"NSEW]/.test(text)) return null;
  return text;
}

// 目的地ラベルはユーザー入力。rules 側でも30文字に切っているが、サーバーでも器を
// 固定する（D-14 の「入口を厳しくする」方針。ペアは7日 purge の外にある文書）。
function sanitizeDestinationLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, DESTINATION_LABEL_MAX);
  return text.length > 0 ? text : null;
}

exports.sanitizeDestinationLabel = sanitizeDestinationLabel;

exports.sanitizePlaceLabel = sanitizePlaceLabel;
