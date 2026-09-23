// Firebase entry point. Keep deployed names stable; implementations live in src/.
const { initializeApp } = require('firebase-admin/app');

initializeApp();

exports.sanitizeDestinationLabel = require('./src/labels').sanitizeDestinationLabel;
exports.sanitizePlaceLabel = require('./src/labels').sanitizePlaceLabel;
exports.onSessionStatusChange = require('./src/sessions').onSessionStatusChange;
exports.isWaitingExpired = require('./src/session-monitor').isWaitingExpired;
exports.WAITING_TIMEOUT_MS = require('./src/session-monitor').WAITING_TIMEOUT_MS;
exports.isOverdue = require('./src/session-monitor').isOverdue;
exports.watchSessions = require('./src/session-monitor').watchSessions;
exports.isPurgeable = require('./src/retention').isPurgeable;
exports.RETENTION_DAYS = require('./src/config').RETENTION_DAYS;
exports.TERMINAL_STATUSES = require('./src/config').TERMINAL_STATUSES;
exports.deleteSessionCompletely = require('./src/retention').deleteSessionCompletely;
exports.SESSION_SUBCOLLECTIONS = require('./src/retention').SESSION_SUBCOLLECTIONS;
exports.purgeExpiredSessions = require('./src/retention').purgeExpiredSessions;
exports.onNewMessage = require('./src/sessions').onNewMessage;
exports.onSessionCreated = require('./src/sessions').onSessionCreated;
exports.onPairChange = require('./src/pairs').onPairChange;
exports.scanAll = require('./src/pair-monitor').scanAll;
exports.watchPairs = require('./src/pair-monitor').watchPairs;
exports.isQuietHourJst = require('./src/notifications').isQuietHourJst;
exports.entitlementActive = require('./src/entitlements').entitlementActive;
exports.asUidList = require('./src/entitlements').asUidList;
exports.shouldApplyEvent = require('./src/entitlements').shouldApplyEvent;
exports.revenuecatWebhook = require('./src/entitlements').revenuecatWebhook;
exports.restoreEntitlement = require('./src/entitlements').restoreEntitlement;
