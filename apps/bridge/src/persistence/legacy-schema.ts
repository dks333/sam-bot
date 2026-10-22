export const legacyMigrations = [
  {
    sql: `
      CREATE TABLE IF NOT EXISTS conversation_mappings (
        slack_conversation_key TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        slack_thread_ts TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        workspace_alias TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        risk_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);
      CREATE INDEX IF NOT EXISTS pending_approvals_status_idx
        ON pending_approvals(status, expires_at);
        `,
    version: 1,
  },
  {
    sql: `
          ALTER TABLE conversation_mappings ADD COLUMN profile_name TEXT;
          CREATE TABLE conversation_profiles (
            conversation_key TEXT PRIMARY KEY,
            profile_name TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `,
    version: 2,
  },
  {
    sql: `
          CREATE TABLE active_runs (
            event_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            slack_thread_ts TEXT NOT NULL,
            slack_message_ts TEXT,
            progress_message_ts TEXT,
            started_at TEXT NOT NULL
          );
        `,
    version: 3,
  },
  {
    sql: `
          CREATE TABLE tracked_runs (
            event_id TEXT PRIMARY KEY,
            conversation_key TEXT NOT NULL,
            team_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            slack_thread_ts TEXT NOT NULL,
            slack_message_ts TEXT,
            progress_message_ts TEXT,
            codex_thread_id TEXT,
            workspace_alias TEXT NOT NULL,
            title TEXT NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN (
                'waiting', 'queued', 'running', 'completed', 'failed', 'stopped', 'interrupted'
              )
            ),
            current_label TEXT NOT NULL,
            created_at TEXT NOT NULL,
            started_at TEXT,
            updated_at TEXT NOT NULL,
            completed_at TEXT
          );

          CREATE INDEX tracked_runs_updated_at_idx ON tracked_runs(updated_at DESC);
          CREATE INDEX tracked_runs_conversation_idx
            ON tracked_runs(conversation_key, updated_at DESC);

          CREATE TABLE tracked_run_steps (
            event_id TEXT NOT NULL REFERENCES tracked_runs(event_id) ON DELETE CASCADE,
            item_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            label TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (event_id, item_id)
          );

          CREATE INDEX tracked_run_steps_updated_at_idx
            ON tracked_run_steps(event_id, updated_at DESC);
        `,
    version: 4,
  },
  {
    sql: `
          CREATE TABLE processed_messages (
            channel_id TEXT NOT NULL,
            message_ts TEXT NOT NULL,
            processed_at TEXT NOT NULL,
            PRIMARY KEY (channel_id, message_ts)
          );

          INSERT OR IGNORE INTO processed_messages (channel_id, message_ts, processed_at)
          SELECT channel_id, slack_message_ts, MIN(created_at)
            FROM tracked_runs
           WHERE slack_message_ts IS NOT NULL
           GROUP BY channel_id, slack_message_ts;
        `,
    version: 5,
  },
  {
    sql: `
          CREATE TABLE routing_decisions (
            event_id TEXT PRIMARY KEY,
            route TEXT NOT NULL,
            model TEXT NOT NULL,
            reasoning_effort TEXT NOT NULL,
            confidence REAL,
            latency_ms INTEGER NOT NULL,
            fallback_reason TEXT,
            applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
            input_tokens INTEGER,
            output_tokens INTEGER,
            created_at TEXT NOT NULL
          );

          CREATE TABLE capability_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE INDEX capability_snapshots_created_at_idx
            ON capability_snapshots(created_at DESC);

          CREATE TABLE browser_audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation TEXT NOT NULL,
            route TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `,
    version: 6,
  },
  {
    sql: `
          CREATE TABLE jev_hook_decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            event_name TEXT NOT NULL,
            decision TEXT NOT NULL,
            confidence REAL,
            latency_ms INTEGER NOT NULL,
            fallback_reason TEXT,
            applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
            tool_family TEXT,
            trigger TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            created_at TEXT NOT NULL
          );

          CREATE INDEX jev_hook_decisions_created_at_idx
            ON jev_hook_decisions(created_at DESC);
          CREATE INDEX jev_hook_decisions_event_id_idx
            ON jev_hook_decisions(event_id, id);
        `,
    version: 7,
  },
  {
    sql: `
          ALTER TABLE routing_decisions ADD COLUMN codex_input_tokens INTEGER;
          ALTER TABLE routing_decisions ADD COLUMN cached_input_tokens INTEGER;
          ALTER TABLE routing_decisions ADD COLUMN cache_write_input_tokens INTEGER;
          ALTER TABLE routing_decisions ADD COLUMN codex_output_tokens INTEGER;
          ALTER TABLE routing_decisions ADD COLUMN codex_reasoning_tokens INTEGER;
          ALTER TABLE routing_decisions ADD COLUMN codex_duration_ms INTEGER;
        `,
    version: 8,
  },
  {
    sql: `
          CREATE TABLE post_terra_decisions (
            event_id TEXT PRIMARY KEY,
            decision TEXT NOT NULL,
            confidence REAL,
            latency_ms INTEGER NOT NULL,
            fallback_reason TEXT,
            hard_risk TEXT,
            applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
            repository_count INTEGER NOT NULL,
            finding_count INTEGER NOT NULL,
            unresolved_evidence_count INTEGER NOT NULL,
            failed_check_count INTEGER NOT NULL,
            input_tokens INTEGER,
            output_tokens INTEGER,
            sol_input_tokens INTEGER,
            sol_cached_input_tokens INTEGER,
            sol_cache_write_input_tokens INTEGER,
            sol_output_tokens INTEGER,
            sol_reasoning_tokens INTEGER,
            sol_duration_ms INTEGER,
            created_at TEXT NOT NULL
          );

          CREATE INDEX post_terra_decisions_created_at_idx
            ON post_terra_decisions(created_at DESC);
        `,
    version: 9,
  },
  {
    sql: `
          CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY,
            conversation_key TEXT NOT NULL,
            state TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            active_attempt_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX tasks_conversation_idx ON tasks(conversation_key, updated_at DESC);
          CREATE INDEX tasks_state_idx ON tasks(state, updated_at);
          CREATE TABLE task_run_events (
            event_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            request_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE task_attempts (
            attempt_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            event_id TEXT NOT NULL REFERENCES task_run_events(event_id),
            attempt_number INTEGER NOT NULL,
            completed_at TEXT,
            payload_json TEXT NOT NULL,
            UNIQUE(task_id, attempt_number)
          );
          CREATE TABLE task_commands (
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            native_item_id TEXT NOT NULL,
            state TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY(attempt_id, native_item_id)
          );
          CREATE TABLE task_artifacts (
            artifact_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            kind TEXT NOT NULL,
            url TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            UNIQUE(task_id, attempt_id, kind, url)
          );
          CREATE TABLE task_pending_inputs (
            input_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            native_request_id TEXT NOT NULL,
            state TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            UNIQUE(attempt_id, native_request_id)
          );
          CREATE TABLE task_outbox (
            outbox_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            deduplication_key TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL,
            next_attempt_at TEXT NOT NULL,
            lease_owner TEXT,
            lease_expires_at TEXT,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX task_outbox_pending_idx ON task_outbox(state, next_attempt_at);
        `,
    version: 10,
  },
  {
    sql: `
          CREATE TABLE task_workspace_leases (
            lease_key TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            workspace_path TEXT NOT NULL UNIQUE,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            state TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX task_workspace_leases_owner_idx ON task_workspace_leases(task_id);
          CREATE TABLE task_managed_checks (
            check_key TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            execution_id TEXT NOT NULL UNIQUE,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            state TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX task_managed_checks_owner_idx ON task_managed_checks(task_id);
          CREATE TABLE task_checkpoints (
            task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            task_revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE TABLE task_queue (
            queue_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            event_id TEXT NOT NULL UNIQUE REFERENCES task_run_events(event_id),
            conversation_key TEXT NOT NULL,
            depends_on_task_id TEXT REFERENCES tasks(task_id),
            state TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            available_at TEXT NOT NULL,
            claimed_by TEXT,
            lease_expires_at TEXT,
            updated_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX task_queue_pending_idx ON task_queue(state, available_at);
          CREATE INDEX task_queue_conversation_idx ON task_queue(conversation_key, state);
        `,
    version: 11,
  },
  {
    sql: `
          CREATE TABLE runtime_owner (
            slot INTEGER PRIMARY KEY CHECK (slot = 1),
            owner_id TEXT NOT NULL UNIQUE,
            pid INTEGER NOT NULL CHECK (pid > 0),
            acquired_at TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL
          );
        `,
    version: 12,
  },
  {
    sql: `
          CREATE TABLE task_ui_captures (
            capture_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            workspace_key TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX task_ui_captures_task_idx ON task_ui_captures(task_id, attempt_id);
          CREATE TABLE task_ui_attachments (
            attachment_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            artifact_id TEXT NOT NULL REFERENCES task_artifacts(artifact_id),
            payload_json TEXT NOT NULL
          );
          CREATE TABLE task_ui_attachment_intents (
            intent_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            artifact_id TEXT NOT NULL REFERENCES task_artifacts(artifact_id),
            payload_json TEXT NOT NULL
          );
          CREATE UNIQUE INDEX task_preview_origin_active_idx
            ON task_commands(json_extract(payload_json, '$.previewOrigin'))
            WHERE json_extract(payload_json, '$.previewOrigin') IS NOT NULL
              AND json_type(payload_json, '$.exitCode') IS NULL
              AND COALESCE(json_extract(payload_json, '$.neverLaunched'), 0) != 1;
        `,
    version: 13,
  },
  {
    sql: `
          CREATE TABLE task_pull_request_status (
            artifact_id TEXT PRIMARY KEY REFERENCES task_artifacts(artifact_id),
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            observed_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE INDEX task_pull_request_status_task_idx ON task_pull_request_status(task_id);
          CREATE TABLE bot_native_threads (
            thread_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(task_id),
            created_attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
            payload_json TEXT NOT NULL,
            knowledge_json TEXT
          );
          CREATE INDEX bot_native_threads_task_idx ON bot_native_threads(task_id);
          CREATE TABLE knowledge_native_thread_blocks (
            thread_id TEXT PRIMARY KEY,
            registered_at TEXT NOT NULL
          );
        `,
    version: 14,
  },
];
