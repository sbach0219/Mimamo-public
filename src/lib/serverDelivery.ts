export type DeliveryStatus = 'idle' | 'sending' | 'delivered' | 'unconfirmed' | 'failed';

export const SOS_DELIVERY_TIMEOUT_MS = 8_000;

type Callbacks = {
  onSending: () => void;
  onDelivered: () => void;
  onUnconfirmed: () => void;
  onFailed: (error: unknown) => void;
};

// Firestore の書き込み Promise は、オフライン時にはサーバー応答を待ったままになる。
// 8秒後に「未確認」を出しても、回線復帰後の成功は拾い直して「届いた」へ更新する。
export function monitorServerDelivery(
  write: Promise<unknown>,
  callbacks: Callbacks,
  timeoutMs = SOS_DELIVERY_TIMEOUT_MS,
): () => void {
  let finished = false;
  callbacks.onSending();

  const timer = setTimeout(() => {
    if (!finished) callbacks.onUnconfirmed();
  }, timeoutMs);

  write.then(
    () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callbacks.onDelivered();
    },
    (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callbacks.onFailed(error);
    },
  );

  return () => {
    finished = true;
    clearTimeout(timer);
  };
}
