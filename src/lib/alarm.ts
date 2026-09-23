import { Vibration } from 'react-native';

// SOSアラーム。
// 【役割1: 現場での周知】遠隔の見守りだけでなく、その場の周囲にも
//   サイレン音で気づいてもらう（抑止・助けを呼ぶ）。
// 【役割2: 誤発信の自覚】本人の端末が鳴るので、まちがえて送った場合に
//   すぐ気づいて とりけせる。鳴り続けていれば「本物のSOS」の裏付けになる。
//
// 音声は expo-audio（ネイティブ依存）。モジュールを含まない旧ネイティブ
// ビルドに OTA でこのコードが配られてもクラッシュしないよう、実行時に
// 読み込みを試し、ダメならバイブレーションのみに劣化する。
let audioModule: any = null;
try {
  audioModule = require('expo-audio');
} catch {
  audioModule = null;
}

let player: any = null;

export async function startSOSAlarm(): Promise<void> {
  // バイブは常に鳴らす（ポケット内でも本人が気づけるように）。
  // 先頭 0 は iOS で即時開始するためのウェイト。true = 繰り返し
  Vibration.vibrate([0, 600, 400], true);
  if (!audioModule) return;
  try {
    // マナーモード／サイレントスイッチ中でも鳴らす（アラーム用途のため）
    await audioModule.setAudioModeAsync({ playsInSilentMode: true });
    if (!player) {
      player = audioModule.createAudioPlayer(require('../../assets/sounds/sos-siren.wav'));
      player.loop = true;
    }
    player.volume = 1;
    player.seekTo(0);
    player.play();
  } catch {
    // 音が出せなくてもSOS自体はFirestore側で継続している（バイブのみ）
  }
}

export function stopSOSAlarm(): void {
  Vibration.cancel();
  try {
    player?.pause();
  } catch {
    // すでに解放済みなどは無視
  }
}
