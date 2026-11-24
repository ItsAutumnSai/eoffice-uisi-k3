-- 001_init: divisional workspaces (FR-10) and centralized archive numbering (FR-05 / FR-02).
-- All timestamps are stored in UTC; the numbering period is computed in APP_TZ (Asia/Jakarta).

CREATE TABLE divisions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(10)  NOT NULL COMMENT 'Used in the archive number, e.g. KI',
  name        VARCHAR(150) NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_divisions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  division_id    INT UNSIGNED NOT NULL,
  name           VARCHAR(150) NOT NULL,
  email          VARCHAR(190) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('STAFF','HEAD') NOT NULL DEFAULT 'STAFF',
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_division (division_id),
  CONSTRAINT fk_users_division FOREIGN KEY (division_id) REFERENCES divisions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reference catalog of archive codes per letter category (FR-05).
-- archive_code NULL = not configured yet: submission is blocked.
CREATE TABLE document_categories (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(150) NOT NULL,
  archive_code  VARCHAR(20)  NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_document_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per division per month. Locked FOR UPDATE while a number is issued,
-- which serializes concurrent submissions of the same division (FR-02).
CREATE TABLE number_sequences (
  id            INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  division_id   INT UNSIGNED      NOT NULL,
  period_year   SMALLINT UNSIGNED NOT NULL,
  period_month  TINYINT UNSIGNED  NOT NULL,
  last_seq      INT UNSIGNED      NOT NULL DEFAULT 0,
  updated_at    DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_number_sequences_period (division_id, period_year, period_month),
  CONSTRAINT fk_number_sequences_division FOREIGN KEY (division_id) REFERENCES divisions (id),
  CONSTRAINT ck_number_sequences_month CHECK (period_month BETWEEN 1 AND 12)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every number ever issued. RESERVED = held by a submitted document,
-- USED = document approved (never recycled), AVAILABLE = released back to the pool.
CREATE TABLE letter_numbers (
  id            BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  division_id   INT UNSIGNED      NOT NULL,
  period_year   SMALLINT UNSIGNED NOT NULL,
  period_month  TINYINT UNSIGNED  NOT NULL,
  seq           INT UNSIGNED      NOT NULL,
  number        VARCHAR(40)       NOT NULL COMMENT 'Base number without revision, e.g. 5/KI/12.26',
  status        ENUM('RESERVED','USED','AVAILABLE') NOT NULL DEFAULT 'RESERVED',
  created_at    DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_letter_numbers_seq (division_id, period_year, period_month, seq),
  UNIQUE KEY uq_letter_numbers_number (number),
  KEY ix_letter_numbers_pool (division_id, period_year, period_month, status, seq),
  CONSTRAINT fk_letter_numbers_division FOREIGN KEY (division_id) REFERENCES divisions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE documents (
  id                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  division_id       INT UNSIGNED      NOT NULL COMMENT 'Owning workspace (FR-10)',
  category_id       INT UNSIGNED      NOT NULL,
  created_by        INT UNSIGNED      NOT NULL,
  title             VARCHAR(255)      NOT NULL,
  content           LONGTEXT          NULL COMMENT 'Editor content (HTML)',
  status            ENUM('DRAFT','SUBMITTED','REVISION_REQUESTED','APPROVED','REJECTED','CANCELLED')
                                      NOT NULL DEFAULT 'DRAFT',
  letter_number_id  BIGINT UNSIGNED   NULL,
  revision_no       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  archive_number    VARCHAR(60)       NULL COMMENT 'Full number incl. revision, e.g. 5/KI/12.26/REV.1',
  archive_code      VARCHAR(20)       NULL COMMENT 'Category archive code captured at submission',
  submitted_at      DATETIME          NULL,
  created_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_letter_number (letter_number_id),
  UNIQUE KEY uq_documents_archive_number (archive_number),
  KEY ix_documents_workspace (division_id, status, created_at),
  KEY ix_documents_created_by (created_by),
  KEY ix_documents_category (category_id),
  CONSTRAINT fk_documents_division      FOREIGN KEY (division_id)      REFERENCES divisions (id),
  CONSTRAINT fk_documents_category      FOREIGN KEY (category_id)      REFERENCES document_categories (id),
  CONSTRAINT fk_documents_created_by    FOREIGN KEY (created_by)       REFERENCES users (id),
  CONSTRAINT fk_documents_letter_number FOREIGN KEY (letter_number_id) REFERENCES letter_numbers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cross-division access grants (KORIN). Filled by FR-11; FR-10 already honours it
-- when deciding whether a user may open a document of another division.
CREATE TABLE document_recipients (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id  BIGINT UNSIGNED NOT NULL,
  division_id  INT UNSIGNED    NULL,
  user_id      INT UNSIGNED    NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_document_recipients_document (document_id),
  KEY ix_document_recipients_division (division_id),
  KEY ix_document_recipients_user (user_id),
  CONSTRAINT fk_document_recipients_document FOREIGN KEY (document_id) REFERENCES documents (id),
  CONSTRAINT fk_document_recipients_division FOREIGN KEY (division_id) REFERENCES divisions (id),
  CONSTRAINT fk_document_recipients_user     FOREIGN KEY (user_id)     REFERENCES users (id),
  CONSTRAINT ck_document_recipients_target CHECK (division_id IS NOT NULL OR user_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail, written in the same transaction as every status change (FR-07 columns).
-- archive_number keeps the number a document held even after it was released.
CREATE TABLE document_logs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id     BIGINT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED    NOT NULL,
  action_type     VARCHAR(30)     NOT NULL,
  status_from     VARCHAR(30)     NULL,
  status_to       VARCHAR(30)     NULL,
  archive_number  VARCHAR(60)     NULL,
  note            TEXT            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_document_logs_document (document_id, created_at),
  KEY ix_document_logs_user (user_id),
  CONSTRAINT fk_document_logs_document FOREIGN KEY (document_id) REFERENCES documents (id),
  CONSTRAINT fk_document_logs_user     FOREIGN KEY (user_id)     REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
