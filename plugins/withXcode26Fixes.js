// Xcode 26 向けの Podfile ワークアラウンドを prebuild 後に注入する config plugin。
// ios/ は git 管理外のため、`expo prebuild --clean` で消えないようここに集約している。
// あわせて、ネイティブプロジェクト名を ThousandSKY に保つため expo.name は "ThousandSKY" とし、
// ユーザーに見える表示名「みまも」は iOS は CFBundleDisplayName、Android は strings.xml で上書きする。
const { withDangerousMod, withStringsXml, AndroidConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const APP_DISPLAY_NAME = 'みまも';

const STATIC_FRAMEWORK_SNIPPET = `
# RNFirebase pods をフレームワーク化せず static library として扱う
# → framework module map によるモジュール境界エラーを回避
$RNFirebaseAsStaticFramework = true
`;

const POST_INSTALL_SNIPPET = `
    # Xcode 26 では古い最小iOSバージョン指定がエラーになるため、
    # 全Podをアプリ本体と同じ iOS 16.4 に引き上げる
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        current = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || current.to_f < 16.4
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.4'
        end
        # RNFirebase の Obj-C ヘッダが modular headers 境界を越えるためのワークアラウンド
        config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
        # Xcode 26 / Swift 6 では -swift-version 5 ビルド時に -enable-bare-slash-regex が
        # swift-frontend に漏れて "unknown argument" エラーになる。明示的に無効化して注入を防ぐ。
        config.build_settings['SWIFT_ENABLE_BARE_SLASH_REGEX'] = 'NO'
      end
    end
`;

// 旧 Podfile にあった「RNFB xcconfig から React-use-frameworks.modulemap フラグを除去する」
// workaround は移植していない: Expo 自身の CocoaPods フック (expo-modules-autolinking の
// inject_isystem_flags) が pod install の最後（Podfile フックより後）に必ず再注入するため
// 常に no-op であり、フラグが残った状態で Release ビルドが成功することを確認済み（2026-07-27）。

function withPodfileWorkarounds(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      if (!contents.includes('$RNFirebaseAsStaticFramework')) {
        if (!contents.includes('prepare_react_native_project!')) {
          throw new Error('withXcode26Fixes: prepare_react_native_project! not found in Podfile');
        }
        contents = contents.replace(
          'prepare_react_native_project!',
          () => `prepare_react_native_project!\n${STATIC_FRAMEWORK_SNIPPET}`
        );
      }

      if (!contents.includes('SWIFT_ENABLE_BARE_SLASH_REGEX')) {
        // react_native_post_install(...) の閉じ括弧の直後に挿入する
        const postInstallCall = /react_native_post_install\([\s\S]*?\n\s*\)\n/;
        if (!postInstallCall.test(contents)) {
          throw new Error('withXcode26Fixes: react_native_post_install call not found in Podfile');
        }
        contents = contents.replace(postInstallCall, (match) => `${match}${POST_INSTALL_SNIPPET}`);
      }

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

// Android のランチャー表示名を「みまも」に保つ（expo.name はプロジェクト名の ThousandSKY のため）
function withAndroidDisplayName(config) {
  return withStringsXml(config, (config) => {
    config.modResults = AndroidConfig.Strings.setStringItem(
      [{ $: { name: 'app_name' }, _: APP_DISPLAY_NAME }],
      config.modResults
    );
    return config;
  });
}

module.exports = function withXcode26Fixes(config) {
  config = withPodfileWorkarounds(config);
  config = withAndroidDisplayName(config);
  return config;
};
