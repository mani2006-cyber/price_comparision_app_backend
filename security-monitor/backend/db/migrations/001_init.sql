-- Security Monitor schema (MySQL 8 / MariaDB 10.5+). Safe to re-run.
-- Stored data policy: NO passwords, tokens, cookies, request bodies or query strings.
-- Login identifiers exist only as keyed one-way hashes.

CREATE TABLE IF NOT EXISTS access_logs (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_uid        VARCHAR(64)  NOT NULL,
  ts               DATETIME(3)  NOT NULL,
  ip               VARCHAR(45)  NOT NULL,
  method           VARCHAR(10)  NOT NULL,
  endpoint         VARCHAR(255) NOT NULL,
  status_code      SMALLINT UNSIGNED NOT NULL,
  response_time_ms DECIMAL(12,2) NOT NULL DEFAULT 0,
  kind             ENUM('normal','preflight','stream') NOT NULL DEFAULT 'normal',
  user_agent       VARCHAR(255) NULL,
  blocked          TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_access_event_uid (event_uid),
  KEY idx_access_ts (ts),
  KEY idx_access_ip_ts (ip, ts),
  KEY idx_access_endpoint_ts (endpoint(120), ts),
  KEY idx_access_status_ts (status_code, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS security_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at  DATETIME(3) NOT NULL,
  ip          VARCHAR(45) NOT NULL,
  event_type  VARCHAR(40) NOT NULL,
  severity    ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL,
  endpoint    VARCHAR(255) NULL,
  description VARCHAR(500) NOT NULL,
  action      VARCHAR(20) NOT NULL DEFAULT 'LOGGED',
  meta        JSON NULL,
  KEY idx_events_created (created_at),
  KEY idx_events_ip_created (ip, created_at),
  KEY idx_events_type_created (event_type, created_at),
  KEY idx_events_sev_created (severity, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS blocked_ips_history (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ip               VARCHAR(45)  NOT NULL,
  reason           VARCHAR(255) NOT NULL,
  rule             VARCHAR(40)  NULL,
  source           ENUM('AUTO','MANUAL') NOT NULL,
  blocked_by       VARCHAR(64)  NULL,
  detected_at      DATETIME(3)  NOT NULL,
  duration_seconds INT UNSIGNED NOT NULL,
  expires_at       DATETIME(3)  NOT NULL,
  status           ENUM('ACTIVE','EXPIRED','UNBLOCKED') NOT NULL DEFAULT 'ACTIVE',
  unblocked_at     DATETIME(3)  NULL,
  unblocked_by     VARCHAR(64)  NULL,
  KEY idx_blocked_ip_detected (ip, detected_at),
  KEY idx_blocked_status_expires (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS security_alerts (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at  DATETIME(3) NOT NULL,
  ip          VARCHAR(45) NOT NULL,
  rule        VARCHAR(40) NOT NULL,
  severity    ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL,
  title       VARCHAR(160) NOT NULL,
  message     VARCHAR(500) NOT NULL,
  status      ENUM('OPEN','RESOLVED') NOT NULL DEFAULT 'OPEN',
  resolved_at DATETIME(3) NULL,
  resolved_by VARCHAR(64) NULL,
  event_id    BIGINT UNSIGNED NULL,
  meta        JSON NULL,
  KEY idx_alerts_status_created (status, created_at),
  KEY idx_alerts_created (created_at),
  KEY idx_alerts_ip_created (ip, created_at),
  KEY idx_alerts_sev_status (severity, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at     DATETIME(3) NOT NULL,
  admin_id       INT UNSIGNED NULL,
  admin_username VARCHAR(64) NULL,
  action         VARCHAR(60) NOT NULL,
  target         VARCHAR(255) NULL,
  ip             VARCHAR(45) NULL,
  details        JSON NULL,
  KEY idx_audit_created (created_at),
  KEY idx_audit_admin_created (admin_id, created_at),
  KEY idx_audit_action_created (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS security_settings (
  setting_key   VARCHAR(80) NOT NULL PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by    VARCHAR(64) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_users (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(64)  NOT NULL,
  password_hash   VARCHAR(100) NOT NULL,
  role            ENUM('viewer','analyst','admin') NOT NULL DEFAULT 'viewer',
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME(3)  NULL,
  last_login_at   DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
