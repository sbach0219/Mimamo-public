// アプリ情報の外部リンクと連絡先。夜テーマの「このアプリについて」と
// 見守り側タブの「設定」が同じ値を指すように、1箇所へ集約する。
export const PRIVACY_URL = 'https://thousandsky.com/mimamo/privacy.html';
export const TERMS_URL = 'https://thousandsky.com/mimamo/terms.html';
export const CONTACT = 'contact@thousandsky.com';
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const APP_VERSION: string = require('../../app.json').expo.version;
