// 純ロジック（src/lib）のユニットテスト用。RNコンポーネントは対象外なので
// jest-expo ではなく軽量な ts-jest を使う。tsconfig はテスト専用のものを指定
// （expo/tsconfig.base は module:preserve のため ts-jest では使えない）。
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
