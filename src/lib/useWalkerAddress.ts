import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { coarsePlaceLabel } from './placeLabel';

// 110 番通報のいちばんの障害は「どこにいるか言えない」こと。
// 地図は見えていても口頭で伝えられる形になっていないため、緊急時だけ座標を
// 住所へ直す（§4-D）。失敗したときは座標を出さない — 緯度経度を読み上げても
// 通信指令には伝わらず、かえって時間を失うため「地図の場所を伝える」へ倒す。
//
// 重要な制約: 古い住所を「いまの場所」として残さない。取得に失敗したら必ず
// null に戻す（前の場所を伝えさせるのは、住所が無いことより危険）。
const MOVE_THRESHOLD = 0.0005; // 約50m。これ未満の変化では引き直さない
const RETRY_DELAYS_MS = [15_000, 30_000, 30_000]; // 失敗しても数回は諦めない

export type WalkerAddress = {
  // 110番通報で読み上げるための最大精度の住所（番地・建物名まで）。
  // **画面に出すためだけのもので、保存してはいけない**（D-14 / ADR E-5）。
  text: string | null;
  // 保存してよい粗さの地名（都道府県・市区町村・町名まで）。ペアの「最終確認」に
  // 残すのはこちら。番地付き住所は実質的に座標なので、器を分けて取り違えを防ぐ。
  coarseText: string | null;
  // 取得できない理由。画面の文言を変えるために使う
  reason: 'ok' | 'pending' | 'unavailable' | 'no-permission';
};

export function useWalkerAddress(
  coord: { latitude: number; longitude: number } | null,
  enabled: boolean,
): WalkerAddress {
  const [state, setState] = useState<WalkerAddress>({ text: null, coarseText: null, reason: 'pending' });
  const lastRef = useRef<{ latitude: number; longitude: number } | null>(null);

  const lat = coord?.latitude;
  const lng = coord?.longitude;

  useEffect(() => {
    if (!enabled) {
      lastRef.current = null;
      setState({ text: null, coarseText: null, reason: 'pending' });
      return;
    }
    if (lat == null || lng == null) return;

    const here = { latitude: lat, longitude: lng };
    const last = lastRef.current;
    if (
      last &&
      Math.abs(last.latitude - here.latitude) < MOVE_THRESHOLD &&
      Math.abs(last.longitude - here.longitude) < MOVE_THRESHOLD
    ) {
      return; // ほぼ同じ場所。前回の結果をそのまま使う
    }
    lastRef.current = here;

    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const resolve = async () => {
      // 端末によっては逆ジオコーディングに位置情報の権限が要る。見守り側の端末は
      // 位置を共有しないので権限を持っていないことがあり、その場合は住所を出さない
      // （権限をここで要求しない。見守るために自分の位置を渡す必要はないため）。
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (cancelled) return;
        if (!perm.granted && perm.canAskAgain === false) {
          setState({ text: null, coarseText: null, reason: 'no-permission' });
          return;
        }
      } catch {
        // 権限を確認できなくても、続けて試す価値はある
      }

      try {
        const results = await Location.reverseGeocodeAsync(here);
        if (cancelled) return;
        const r = results?.[0];
        const text = r
          ? [r.region, r.city, r.district, r.street, r.streetNumber, r.name]
              .filter((v): v is string => typeof v === 'string' && v.length > 0)
              .filter((v, i, arr) => arr.indexOf(v) === i)
              .join(' ')
          : '';
        if (text.length > 0) {
          setState({ text, coarseText: coarsePlaceLabel(r), reason: 'ok' });
          return;
        }
        throw new Error('empty result');
      } catch {
        if (cancelled) return;
        // 失敗した場所を覚えたままにしない（次のサンプルで必ず引き直せるように）
        lastRef.current = null;
        setState({ text: null, coarseText: null, reason: 'unavailable' });
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay != null) {
          attempt += 1;
          timer = setTimeout(resolve, delay);
        }
      }
    };

    resolve();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, lat, lng]);

  return state;
}
