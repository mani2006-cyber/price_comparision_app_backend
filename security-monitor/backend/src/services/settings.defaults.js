'use strict';
/** Default thresholds, calibrated from your logs (peak real traffic ~29 req/min). Editable from the Settings page. */
module.exports = {
  detection: {
    loginPaths: ['/api/auth/login'],
    alertCooldownSec: 600,
    bruteForce: {
      enabled: true, ipWindowSec: 300, ipAlertThreshold: 5, ipBlockThreshold: 10,
      accountWindowSec: 900, accountAlertThreshold: 5, blockMinutes: 15,
    },
    highRate: {
      enabled: true, windowSec: 60, defaultLimit: 120, blockMultiplier: 3, blockMinutes: 15,
      groups: [
        { name: 'auth', prefixes: ['/api/auth'], limit: 10 },
        { name: 'search', prefixes: ['/api/search', '/api/compare-url'], limit: 40 },
      ],
    },
    endpointScan: {
      enabled: true, notFoundWindowSec: 120, notFoundThreshold: 15, notFoundBlockThreshold: 40,
      sensitiveWindowSec: 300, sensitiveThreshold: 3, sensitiveBlockThreshold: 6, blockMinutes: 30,
      sensitivePaths: ['/.env', '/.git', '/.aws', '/.ds_store', '/wp-admin', '/wp-login', '/xmlrpc.php', '/phpmyadmin',
        '/cgi-bin', '/etc/passwd', '/actuator', '/server-status', '/vendor/phpunit', '/backup', '/config.json', '/admin', '..'],
    },
    suspiciousUrl: { enabled: true, windowSec: 600, threshold: 5, blockThreshold: 15, blockMinutes: 30 },
    unauthorized: { enabled: true, windowSec: 300, threshold: 10, blockThreshold: 30, blockMinutes: 15 },
  },
  blocking: {
    allowlist: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    defaultManualMinutes: 60,
    maxMinutes: 1440,
  },
  retention: { accessLogsDays: 14, securityEventsDays: 90, alertsDays: 90, auditDays: 365, blockHistoryDays: 365 },
};
