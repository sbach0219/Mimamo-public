import { useEffect } from 'react';
import { useWalkerAddress } from '../lib/useWalkerAddress';
import { useSession } from '../store/sessionStore';

// 歩く人の端末が、自分の現在地を地名に直してセッション文書へ置いていく（D-14）。
// 終端したときに Cloud Functions がこの1語をペアの「最終確認」へ転記する。
//
// なぜ歩く人の端末で地名化するのか:
//   - サーバーで地名化するには外部ジオコーディングAPIへ座標を送ることになり、
//     位置が第三者へ出る経路を1本増やしてしまう。逆ジオコーディングは端末（OS）が
//     持っている機能なので、外へ出さずに済む道がある。
//   - 見守り手の端末でも地名は出せるが、見守り手は位置情報の権限を持っていない
//     ことがあり（見守るために自分の位置を渡す必要はない）、取れたり取れなかったり
//     する値をペアの恒久データの元にはできない。
//
// 逆ジオコーディング自体の間引き（約50m移動するまで引き直さない）と失敗時の
// リトライは useWalkerAddress が持っている。ここは「取れた地名を書く」だけ。
export function usePlaceLabelReport(coord: { latitude: number; longitude: number } | null, enabled: boolean): void {
  // 保存するのは coarseText（都道府県・市区町村・町名まで）。text のほうは
  // 110番通報で読み上げるための番地・建物名まで含む住所で、**実質的に座標**なので
  // ペアの「最終確認」には決して渡さない（ADR E-5「住所文字列は残さない」）。
  const address = useWalkerAddress(coord, enabled);
  const text = address.reason === 'ok' ? address.coarseText : null;

  useEffect(() => {
    if (!enabled || !text) return;
    useSession.getState().reportPlaceLabel(text);
  }, [enabled, text]);
}
