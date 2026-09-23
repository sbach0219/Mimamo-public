// 危険エリアアラート（Phase 3）の同梱メッシュデータ（assets/data/*.bin）を
// アセットとしてバンドルに含めるため、既定の assetExts に 'bin' を足す。
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('bin')) {
  config.resolver.assetExts.push('bin');
}

module.exports = config;
