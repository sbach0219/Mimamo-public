// deleteSessionCompletely() の削除順序テスト。
//
// これは「親ドキュメントより先にサブコレクションを消し切る」という順序そのものを固定する
// ための回帰テスト。db.recursiveDelete(親ドキュメント) を使うと、子孫の列挙が一時的に
// 失敗したときでも SDK が親の削除を発行してしまい、messages / route（チャット本文と
// GPS経路）だけが取り残される。purge は親を起点に走査するため、その残骸は二度と
// 回収できない。順序が逆に戻ったらここで落ちる。
//
// 実行: cd functions && npm test  （= node --test）
const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteSessionCompletely, SESSION_SUBCOLLECTIONS } = require('../index.js');

// 呼び出し順を記録するだけの最小スタブ。
// failOn に指定したサブコレクション名で recursiveDelete を失敗させられる。
function makeFakes({ failOn = null } = {}) {
  const calls = [];
  const sessionRef = {
    id: 'session-1',
    collection(name) {
      return { __subcollection: name };
    },
    async delete() {
      calls.push('delete:parent');
    },
  };
  const db = {
    async recursiveDelete(ref) {
      const name = ref.__subcollection;
      if (name === failOn) {
        calls.push(`recursiveDelete:${name}:FAILED`);
        const err = new Error('Failed to fetch children documents');
        err.code = 14; // UNAVAILABLE
        throw err;
      }
      calls.push(`recursiveDelete:${name}`);
    },
  };
  return { db, sessionRef, calls };
}

test('サブコレクションを全て削除してから親ドキュメントを削除する', async () => {
  const { db, sessionRef, calls } = makeFakes();
  await deleteSessionCompletely(db, sessionRef);

  assert.deepEqual(calls, [
    ...SESSION_SUBCOLLECTIONS.map((n) => `recursiveDelete:${n}`),
    'delete:parent',
  ]);
});

test('親ドキュメントの削除は必ず最後（サブコレクションより後）', async () => {
  const { db, sessionRef, calls } = makeFakes();
  await deleteSessionCompletely(db, sessionRef);

  const parentIndex = calls.indexOf('delete:parent');
  assert.equal(parentIndex, calls.length - 1);
  assert.equal(parentIndex, SESSION_SUBCOLLECTIONS.length);
});

test('対象サブコレクションは messages と route（rules の match と一致）', () => {
  assert.deepEqual([...SESSION_SUBCOLLECTIONS].sort(), ['messages', 'route']);
});

// ここが M1 の核心：サブコレクション削除が失敗したら親を消してはいけない。
// 親が残っていれば次回の purge で同じセッションがまた対象になり再試行される。
for (const failing of ['messages', 'route']) {
  test(`${failing} の削除が失敗したら親ドキュメントを削除しない`, async () => {
    const { db, sessionRef, calls } = makeFakes({ failOn: failing });

    await assert.rejects(() => deleteSessionCompletely(db, sessionRef));
    assert.ok(!calls.includes('delete:parent'), '親を消してはいけない（孤児化する）');
  });
}

test('先頭のサブコレクション削除が失敗したら後続のサブコレクションにも進まない（失敗は即座に伝播）', async () => {
  const { db, sessionRef, calls } = makeFakes({ failOn: SESSION_SUBCOLLECTIONS[0] });

  await assert.rejects(() => deleteSessionCompletely(db, sessionRef));
  assert.deepEqual(calls, [`recursiveDelete:${SESSION_SUBCOLLECTIONS[0]}:FAILED`]);
});

test('失敗はエラーとして呼び出し元へ伝わる（握り潰さない）', async () => {
  const { db, sessionRef } = makeFakes({ failOn: 'messages' });

  await assert.rejects(
    () => deleteSessionCompletely(db, sessionRef),
    (err) => err instanceof Error && err.code === 14,
  );
});
