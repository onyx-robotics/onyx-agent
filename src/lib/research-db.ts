import { createHash, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Database } from "bun:sqlite"

import type {
  LocalResearchCampaignExperimentLoggedRecord,
  LocalResearchCampaignStartedRecord,
  LocalResearchHistoryRecord,
  ResearchHypothesisPlan,
  ResearchSetupFile,
} from "../protocol"

import type {
  ApiCampaign,
  ApiCampaignExperiment,
  ApiHypothesis,
  ApiKnowledge,
  ApiProjectDeletions,
  ApiResearchSyncResponse,
  ApiSession,
  ApiSessionState,
  ApiSummary,
  ApiWorker,
} from "./api"
import { currentCommit } from "./git"
import {
  onyxStateDir,
  withOnyxLock,
  type LastRunRecord,
  type LastRunSelector,
} from "./outbox"

type Db = Database

export type ResearchSyncEventStatus = "pending" | "acked" | "conflict"

export type ResearchSyncEvent = {
  eventId: string
  sequence: number
  type:
    | "campaign.upserted"
    | "session.started"
    | "session.stopped"
    | "hypothesis.upserted"
    | "worker.registered"
    | "worker.heartbeat"
    | "experiment.logged"
    | "summary.upserted"
    | "knowledge.created"
    | "entity.deleted"
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  status: ResearchSyncEventStatus
  attempts: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type LocalCampaign = ApiCampaign & {
  status: "active" | "completed" | "archived"
  projectPath: string
  setup: ResearchSetupFile | Record<string, unknown>
  humanFeedback: string | null
  bestExperimentId: string | null
  createdAt: string
  updatedAt: string
}

export type LocalWorkflowRunStatus =
  | "running"
  | "paused"
  | "blocked"
  | "abandoned"
  | "superseded"
  | "failed"
  | "checks_failed"
  | "setup_violation"
  | "succeeded"

export type LocalWorkflowStepStatus =
  | "pending"
  | "paused"
  | "running"
  | "passed"
  | "failed"
  | "skipped"

export type LocalWorkflowRun = {
  id: string
  campaignId: string | null
  campaignName: string
  projectPath: string
  runRef: string
  baseCommitSha: string
  resultCommitSha: string | null
  resultRef: string
  setupHash: string
  status: LocalWorkflowRunStatus
  currentStepIndex: number
  metrics: Record<string, number>
  blockReason: string | null
  createdAt: string
  startedAt: string
  completedAt: string | null
  updatedAt: string
  sessionId?: string
  workerId?: string
  hypothesisId?: string
}

export type WorkflowRunSelector = {
  campaignName?: string
  projectPath?: string
  sessionId?: string
  workerId?: string
  hypothesisId?: string
  statuses?: LocalWorkflowRunStatus[]
}

export type LocalWorkflowStep = {
  runId: string
  stepId: string
  stepIndex: number
  kind: "agent" | "run"
  toolId: string | null
  status: LocalWorkflowStepStatus
  attempt: number
  exitCode: number | null
  timedOut: boolean
  outputSummary: string | null
  metrics: Record<string, number>
  logPath: string | null
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

type Row = Record<string, unknown>

type LocalSummaryKind = ApiSummary["summaryKind"]
type LocalKnowledgeKind = ApiKnowledge["kind"]
type LocalTombstoneInput = {
  entityType: string
  entityId: string
  campaignId: string | null
  name: string | null
  runRef: string | null
  reason: string | null
  deletedAt: string
}

const dbCache = new Map<string, Database>()
const CURRENT_RESEARCH_DB_SCHEMA_VERSION = 4
const TERMINAL_WORKER_STATUSES = new Set(["completed", "failed", "stopped"])

function nowIso() {
  return new Date().toISOString()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sqliteBusyMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isSqliteBusyError(error: unknown) {
  const message = sqliteBusyMessage(error)
  return /SQLITE_(BUSY|LOCKED)|database is (locked|busy)|database table is locked/i.test(
    message
  )
}

async function withSqliteBusyRetry<T>(fn: () => T | Promise<T>): Promise<T> {
  const attempts = 6
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt === attempts - 1) throw error
      await sleep(50 * 2 ** attempt + Math.floor(Math.random() * 50))
    }
  }
  return fn()
}

async function withResearchDbWrite<T>(
  root: string,
  fn: (db: Db) => T | Promise<T>
): Promise<T> {
  return withOnyxLock(
    root,
    "research-db",
    () => withSqliteBusyRetry(async () => fn(await openDb(root))),
    { timeoutMs: 60_000, staleMs: 180_000 }
  )
}

function isTerminalWorkerStatus(status: unknown) {
  return typeof status === "string" && TERMINAL_WORKER_STATUSES.has(status)
}

function nextWorkerStatus({
  current,
  requested,
}: {
  current: unknown
  requested: ApiWorker["status"]
}): ApiWorker["status"] {
  if (isTerminalWorkerStatus(current) && !isTerminalWorkerStatus(requested)) {
    return current as ApiWorker["status"]
  }
  return requested
}

function json(value: unknown) {
  return JSON.stringify(value ?? {})
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function bool(value: unknown) {
  return value === 1 || value === true
}

function numericRecord(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => {
      const metric = entry[1]
      return typeof metric === "number" && Number.isFinite(metric)
    })
  )
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${sortedJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function experimentFingerprint(experiment: ApiCampaignExperiment) {
  return createHash("sha256")
    .update(
      sortedJson({
        runRef: experiment.runRef,
        campaignId: experiment.campaignId,
        sessionId: experiment.sessionId,
        hypothesisId: experiment.hypothesisId,
        workerId: experiment.workerId,
        baseCommitSha: experiment.baseCommitSha,
        resultCommitSha: experiment.resultCommitSha,
        resultRef: experiment.resultRef,
        status: experiment.status,
        setupCompliance: experiment.setupCompliance,
        primaryMetricName: experiment.primaryMetricName,
        primaryMetricValue: experiment.primaryMetricValue,
        secondaryMetrics: experiment.secondaryMetrics,
        artifactRefs: experiment.artifactRefs,
        agentNotes: experiment.agentNotes,
        checks: experiment.checks,
        durationMs: experiment.durationMs,
        outputSummary: experiment.outputSummary,
        startedAt: experiment.startedAt,
        completedAt: experiment.completedAt,
        createdAt: experiment.createdAt,
      })
    )
    .digest("hex")
}

function syncCampaignPayload(row: Row) {
  return {
    id: row.id as string,
    projectId:
      (row.server_project_id as string | null) ??
      "00000000-0000-0000-0000-000000000000",
    name: row.name as string,
    description: nullableString(row.description),
    baseCommitSha: row.base_commit_sha as string,
    status: row.status as LocalCampaign["status"],
    metricName: row.metric_name as string,
    metricUnit: nullableString(row.metric_unit),
    metricDirection: row.metric_direction as "maximize" | "minimize",
    promotionRefName: nullableString(row.promotion_ref_name),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function researchDbPath(root: string) {
  if (process.env.ONYX_RESEARCH_DB) return process.env.ONYX_RESEARCH_DB
  return join(await onyxStateDir(root), "research.db")
}

function configureDb(db: Db) {
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -4096")
}

function applyMigrations(db: Db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
  const row = db
    .query("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | null
  const currentVersion = Number(row?.version ?? 0)
  if (currentVersion > CURRENT_RESEARCH_DB_SCHEMA_VERSION) {
    throw new Error(
      `Local research DB schema version ${currentVersion} is newer than this Onyx CLI supports (${CURRENT_RESEARCH_DB_SCHEMA_VERSION}).`
    )
  }
  if (currentVersion >= CURRENT_RESEARCH_DB_SCHEMA_VERSION) return

  if (currentVersion < 1) {
    db.transaction(() => {
      db.run(`
    CREATE TABLE IF NOT EXISTS local_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      project_path TEXT NOT NULL DEFAULT '',
      base_commit_sha TEXT NOT NULL,
      setup_json TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_unit TEXT,
      metric_direction TEXT NOT NULL,
      human_feedback TEXT,
      promotion_ref_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      best_experiment_id TEXT,
      best_metric_value REAL,
      best_commit_sha TEXT,
      experiment_count INTEGER NOT NULL DEFAULT 0,
      last_experiment_at TEXT,
      server_project_id TEXT,
      synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_path, name)
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      worker_target INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      end_time_ms INTEGER,
      max_iterations INTEGER,
      max_experiments INTEGER,
      reserved_experiment_count INTEGER NOT NULL DEFAULT 0,
      terminal_experiment_count INTEGER NOT NULL DEFAULT 0,
      finalization_status TEXT NOT NULL DEFAULT 'not_started',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS hypotheses (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      created_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      base_commit_sha TEXT NOT NULL,
      best_experiment_id TEXT,
      best_metric_value REAL,
      last_worked_at TEXT,
      plan_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, name)
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id) ON DELETE RESTRICT,
      worker_name TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      runtime TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered',
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      current_experiment_id TEXT,
      phase TEXT,
      progress_message TEXT,
      git_label TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      session_id TEXT,
      hypothesis_id TEXT NOT NULL,
      experiment_id TEXT,
      status TEXT NOT NULL,
      phase TEXT,
      event TEXT,
      progress_message TEXT,
      git_label TEXT,
      resource_stats_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      hypothesis_id TEXT REFERENCES hypotheses(id) ON DELETE SET NULL,
      worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      run_ref TEXT NOT NULL,
      base_commit_sha TEXT NOT NULL,
      result_commit_sha TEXT NOT NULL,
      result_ref TEXT NOT NULL,
      git_status TEXT NOT NULL DEFAULT 'pending',
      git_verified_at TEXT,
      git_status_reason TEXT,
      status TEXT NOT NULL,
      setup_compliance_json TEXT,
      primary_metric_name TEXT NOT NULL,
      primary_metric_value REAL,
      secondary_metrics_json TEXT NOT NULL DEFAULT '{}',
      artifact_refs_json TEXT NOT NULL DEFAULT '{}',
      agent_notes_json TEXT NOT NULL DEFAULT '{}',
      checks_json TEXT,
      duration_ms INTEGER,
      output_summary TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, run_ref),
      UNIQUE(campaign_id, result_ref)
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      hypothesis_id TEXT REFERENCES hypotheses(id) ON DELETE SET NULL,
      authored_by_worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
      summary_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      hypothesis_id TEXT REFERENCES hypotheses(id) ON DELETE SET NULL,
      authored_by_worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
      experiment_id TEXT REFERENCES experiments(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      confidence REAL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS resource_leases (
      resource_name TEXT NOT NULL,
      slot INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(resource_name, slot)
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS tombstones (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      campaign_id TEXT,
      name TEXT,
      run_ref TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(entity_type, entity_id)
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS sync_events (
      event_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acked_at TEXT
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS sync_acks (
      event_id TEXT PRIMARY KEY,
      server_status TEXT NOT NULL,
      server_entity_id TEXT,
      acked_at TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS server_mappings (
      local_entity_type TEXT NOT NULL,
      local_entity_id TEXT NOT NULL,
      server_entity_id TEXT NOT NULL,
      server_project_id TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY(local_entity_type, local_entity_id)
    )
  `)

      db.run(`
    CREATE TABLE IF NOT EXISTS local_attempts (
      run_ref TEXT PRIMARY KEY,
      campaign_id TEXT,
      campaign_name TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      worker_id TEXT,
      hypothesis_id TEXT,
      result_commit_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

      db.run(
        "CREATE INDEX IF NOT EXISTS sync_events_pending_idx ON sync_events(status, sequence)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS experiments_campaign_created_idx ON experiments(campaign_id, created_at DESC)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS workers_campaign_seen_idx ON workers(campaign_id, status, last_seen_at DESC)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS hypotheses_campaign_status_idx ON hypotheses(campaign_id, status, last_worked_at DESC)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS summaries_campaign_kind_idx ON summaries(campaign_id, summary_kind, is_current)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS knowledge_campaign_created_idx ON knowledge(campaign_id, created_at DESC)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS local_attempts_context_idx ON local_attempts(campaign_name, project_path, session_id, worker_id, hypothesis_id, updated_at DESC)"
      )
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(1, nowIso())
      db.run("PRAGMA user_version = 1")
    })()
  }

  if (currentVersion < 2) {
    db.transaction(() => {
      db.run(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT,
        campaign_name TEXT NOT NULL,
        project_path TEXT NOT NULL DEFAULT '',
        run_ref TEXT NOT NULL,
        base_commit_sha TEXT NOT NULL,
        result_commit_sha TEXT,
        result_ref TEXT NOT NULL,
        setup_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step_index INTEGER NOT NULL DEFAULT 0,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        block_reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        session_id TEXT,
        worker_id TEXT,
        hypothesis_id TEXT,
        UNIQUE(run_ref)
      )
    `)

      db.run(`
      CREATE TABLE IF NOT EXISTS workflow_steps (
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        tool_id TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        timed_out INTEGER NOT NULL DEFAULT 0,
        output_summary TEXT,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        log_path TEXT,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, step_id)
      )
    `)

      db.run(
        "CREATE INDEX IF NOT EXISTS workflow_runs_active_idx ON workflow_runs(campaign_name, project_path, status, updated_at DESC)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS workflow_steps_run_idx ON workflow_steps(run_id, step_index)"
      )
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(2, nowIso())
      db.run("PRAGMA user_version = 2")
    })()
  }

  if (currentVersion < 3) {
    db.transaction(() => {
      db.run(`
      CREATE TABLE IF NOT EXISTS worker_launches (
        worker_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        worktree TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        prompt_path TEXT,
        log_path TEXT,
        activity_log_path TEXT,
        manifest_path TEXT,
        exit_code INTEGER,
        signal TEXT,
        timed_out INTEGER NOT NULL DEFAULT 0,
        startup_timed_out INTEGER NOT NULL DEFAULT 0,
        last_output_at TEXT,
        finalization_status TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      )
    `)
      db.run(
        "CREATE INDEX IF NOT EXISTS worker_launches_session_status_idx ON worker_launches(session_id, status, updated_at DESC)"
      )
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(3, nowIso())
      db.run("PRAGMA user_version = 3")
    })()
  }

  if (currentVersion < 4) {
    db.transaction(() => {
      for (const statement of [
        "ALTER TABLE sessions ADD COLUMN max_experiments INTEGER",
        "ALTER TABLE sessions ADD COLUMN reserved_experiment_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sessions ADD COLUMN terminal_experiment_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sessions ADD COLUMN finalization_status TEXT NOT NULL DEFAULT 'not_started'",
      ]) {
        try {
          db.run(statement)
        } catch (error) {
          if (!/duplicate column name/i.test(String(error))) throw error
        }
      }
      db.run("UPDATE workers SET status = 'registered' WHERE status = 'idle'")
      db.run(
        "UPDATE workers SET status = 'running' WHERE status IN ('stale', 'lost')"
      )
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(4, nowIso())
      db.run("PRAGMA user_version = 4")
    })()
  }
}

function setting(db: Db, key: string) {
  const row = db
    .query("SELECT value FROM local_settings WHERE key = ?")
    .get(key) as { value: string } | null
  return row?.value
}

function setSetting(db: Db, key: string, value: string) {
  const at = nowIso()
  db.query(
    `
      INSERT INTO local_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `
  ).run(key, value, at)
}

function ensureSiteId(db: Db) {
  const existing = setting(db, "site_id")
  if (existing) return existing
  const siteId = randomUUID()
  setSetting(db, "site_id", siteId)
  setSetting(db, "sync_sequence", "0")
  return siteId
}

function nextSequence(db: Db) {
  const current = Number(setting(db, "sync_sequence") ?? "0")
  const next = current + 1
  setSetting(db, "sync_sequence", String(next))
  return next
}

async function openDb(root: string) {
  const path = await researchDbPath(root)
  const cached = dbCache.get(path)
  if (cached) return cached
  let db: Database | null = null
  try {
    await mkdir(dirname(path), { recursive: true })
    db = new Database(path, { create: true })
    configureDb(db)
    applyMigrations(db)
    ensureSiteId(db)
    dbCache.set(path, db)
    return db
  } catch (error) {
    db?.close()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Unable to open local research ledger at ${path}. Ensure the git directory is writable or set ONYX_RESEARCH_DB to a writable SQLite path. ${message}`
    )
  }
}

export async function getResearchSiteId(root: string) {
  return ensureSiteId(await openDb(root))
}

function enqueueSyncEvent({
  db,
  type,
  entityType,
  entityId,
  payload,
}: {
  db: Db
  type: ResearchSyncEvent["type"]
  entityType: string
  entityId: string
  payload: Record<string, unknown>
}) {
  const at = nowIso()
  const siteId = ensureSiteId(db)
  const sequence = nextSequence(db)
  const eventId = `${siteId}:${sequence}:${randomUUID()}`
  db.query(
    `
      INSERT INTO sync_events (
        event_id, sequence, type, entity_type, entity_id, payload_json,
        status, attempts, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `
  ).run(
    eventId,
    sequence,
    type,
    entityType,
    entityId,
    json({ ...payload, origin: { siteId, sequence, eventId } }),
    at,
    at
  )
  return eventId
}

function campaignFromRow(row: Row): LocalCampaign {
  return {
    id: row.id as string,
    projectId: (row.server_project_id as string | null) ?? "",
    name: row.name as string,
    description: nullableString(row.description),
    baseCommitSha: row.base_commit_sha as string,
    metricName: row.metric_name as string,
    metricUnit: nullableString(row.metric_unit),
    metricDirection: row.metric_direction as "maximize" | "minimize",
    bestMetricValue: numberOrNull(row.best_metric_value),
    bestExperimentId: nullableString(row.best_experiment_id),
    bestCommitSha: nullableString(row.best_commit_sha),
    experimentCount: Number(row.experiment_count ?? 0),
    promotionRefName: nullableString(row.promotion_ref_name),
    status: row.status as LocalCampaign["status"],
    projectPath: (row.project_path as string) ?? "",
    setup: parseJson(row.setup_json, {}),
    humanFeedback: nullableString(row.human_feedback),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function sessionFromRow(row: Row): ApiSession {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    name: row.name as string,
    status: row.status as ApiSession["status"],
    workerTarget: numberOrNull(row.worker_target),
    maxExperiments: numberOrNull(row.max_experiments),
    reservedExperimentCount: Number(row.reserved_experiment_count ?? 0),
    terminalExperimentCount: Number(row.terminal_experiment_count ?? 0),
    finalizationStatus:
      (row.finalization_status as ApiSession["finalizationStatus"]) ??
      "not_started",
    metadata: parseJson(row.metadata_json, {}),
  }
}

function hypothesisFromRow(row: Row): ApiHypothesis {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    createdBySessionId: nullableString(row.created_by_session_id),
    name: row.name as string,
    description: nullableString(row.description),
    status: row.status as ApiHypothesis["status"],
    baseCommitSha: row.base_commit_sha as string,
    bestExperimentId: nullableString(row.best_experiment_id),
    bestMetricValue: numberOrNull(row.best_metric_value),
    lastWorkedAt: nullableString(row.last_worked_at),
    plan: parseJson<ResearchHypothesisPlan>(row.plan_json, {
      focus: row.name as string,
      statement: row.description as string,
      startingPoints: [],
      avoidList: [],
      successSignals: [],
      giveUpSignals: [],
    }),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function workerFromRow(row: Row): ApiWorker {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    sessionId: nullableString(row.session_id),
    hypothesisId: row.hypothesis_id as string,
    workerName: row.worker_name as string,
    agentKind: row.agent_kind as string,
    runtime: row.runtime as ApiWorker["runtime"],
    status:
      row.status === "idle"
        ? "registered"
        : (row.status as ApiWorker["status"]),
    liveness: ["completed", "failed", "stopped"].includes(String(row.status))
      ? "terminal"
      : "unknown",
    currentExperimentId: nullableString(row.current_experiment_id),
    phase: nullableString(row.phase),
    progressMessage: nullableString(row.progress_message),
    gitLabel: nullableString(row.git_label),
    lastSeenAt: row.last_seen_at as string,
    startedAt: row.started_at as string,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function experimentFromRow(row: Row): ApiCampaignExperiment {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    sessionId: nullableString(row.session_id),
    hypothesisId: nullableString(row.hypothesis_id),
    workerId: nullableString(row.worker_id),
    runRef: row.run_ref as string,
    name: row.name as string,
    description: nullableString(row.description),
    baseCommitSha: row.base_commit_sha as string,
    resultCommitSha: row.result_commit_sha as string,
    resultRef: row.result_ref as string,
    status: row.status as string,
    setupCompliance: parseJson(row.setup_compliance_json, null),
    gitStatus: (row.git_status as string) ?? "pending",
    gitVerifiedAt: nullableString(row.git_verified_at),
    gitStatusReason: nullableString(row.git_status_reason),
    primaryMetricName: row.primary_metric_name as string,
    primaryMetricValue: numberOrNull(row.primary_metric_value),
    secondaryMetrics: parseJson(row.secondary_metrics_json, {}),
    artifactRefs: parseJson(row.artifact_refs_json, {}),
    agentNotes: parseJson(row.agent_notes_json, {}),
    checks: parseJson(row.checks_json, null),
    durationMs:
      typeof row.duration_ms === "number" ? Number(row.duration_ms) : null,
    outputSummary: nullableString(row.output_summary),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function summaryFromRow(row: Row): ApiSummary {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    sessionId: nullableString(row.session_id),
    hypothesisId: nullableString(row.hypothesis_id),
    authoredByWorkerId: nullableString(row.authored_by_worker_id),
    summaryKind: row.summary_kind as LocalSummaryKind,
    title: row.title as string,
    body: row.body as string,
    isCurrent: bool(row.is_current),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

function knowledgeFromRow(row: Row): ApiKnowledge {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    sessionId: nullableString(row.session_id),
    hypothesisId: nullableString(row.hypothesis_id),
    authoredByWorkerId: nullableString(row.authored_by_worker_id),
    experimentId: nullableString(row.experiment_id),
    kind: row.kind as LocalKnowledgeKind,
    title: row.title as string,
    body: row.body as string,
    confidence: numberOrNull(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function setActiveLocalCampaign({
  root,
  projectPath,
  campaignName,
}: {
  root: string
  projectPath: string
  campaignName: string
}) {
  await withResearchDbWrite(root, (db) => {
    setSetting(db, "active_project_path", projectPath)
    setSetting(db, "active_campaign", campaignName)
  })
}

export async function getActiveLocalCampaignName(root: string) {
  return setting(await openDb(root), "active_campaign") ?? null
}

export async function createLocalCampaign({
  root,
  name,
  description,
  projectPath,
  baseCommitSha,
  setup,
  metricName,
  metricUnit,
  metricDirection,
  humanFeedback,
  promotionRefName,
}: {
  root: string
  name: string
  description?: string | null
  projectPath: string
  baseCommitSha: string
  setup: ResearchSetupFile
  metricName: string
  metricUnit?: string | null
  metricDirection: "maximize" | "minimize"
  humanFeedback?: string | null
  promotionRefName?: string | null
}) {
  const id = randomUUID()
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      db.query(
        `
        INSERT INTO campaigns (
          id, name, description, project_path, base_commit_sha, setup_json,
          metric_name, metric_unit, metric_direction, human_feedback,
          promotion_ref_name, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(project_path, name) DO UPDATE SET
          description = excluded.description,
          base_commit_sha = excluded.base_commit_sha,
          setup_json = excluded.setup_json,
          metric_name = excluded.metric_name,
          metric_unit = excluded.metric_unit,
          metric_direction = excluded.metric_direction,
          human_feedback = excluded.human_feedback,
          promotion_ref_name = excluded.promotion_ref_name,
          status = 'active',
          updated_at = excluded.updated_at
      `
      ).run(
        id,
        name,
        description ?? null,
        projectPath,
        baseCommitSha,
        json(setup),
        metricName,
        metricUnit ?? null,
        metricDirection,
        humanFeedback ?? null,
        promotionRefName ?? null,
        at,
        at
      )
      const campaign = db
        .query("SELECT * FROM campaigns WHERE project_path = ? AND name = ?")
        .get(projectPath, name) as Row
      enqueueSyncEvent({
        db,
        type: "campaign.upserted",
        entityType: "campaign",
        entityId: campaign.id as string,
        payload: { campaign: syncCampaignPayload(campaign) },
      })
      setSetting(db, "active_project_path", projectPath)
      setSetting(db, "active_campaign", name)
      return campaignFromRow(campaign)
    })
    return tx()
  })
}

export async function cacheLocalCampaign({
  root,
  campaign,
  projectPath,
  setup = {},
}: {
  root: string
  campaign: ApiCampaign
  projectPath: string
  setup?: ResearchSetupFile | Record<string, unknown>
}) {
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    db.query(
      `
      INSERT INTO campaigns (
        id, name, description, project_path, base_commit_sha, setup_json,
        metric_name, metric_unit, metric_direction, promotion_ref_name,
        server_project_id, status,
        best_experiment_id, best_metric_value, best_commit_sha,
        experiment_count, last_experiment_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        project_path = excluded.project_path,
        base_commit_sha = excluded.base_commit_sha,
        setup_json = excluded.setup_json,
        metric_name = excluded.metric_name,
        metric_unit = excluded.metric_unit,
        metric_direction = excluded.metric_direction,
        promotion_ref_name = excluded.promotion_ref_name,
        server_project_id = excluded.server_project_id,
        status = excluded.status,
        best_experiment_id = excluded.best_experiment_id,
        best_metric_value = excluded.best_metric_value,
        best_commit_sha = excluded.best_commit_sha,
        experiment_count = excluded.experiment_count,
        last_experiment_at = excluded.last_experiment_at,
        updated_at = excluded.updated_at
    `
    ).run(
      campaign.id,
      campaign.name,
      campaign.description,
      projectPath,
      campaign.baseCommitSha,
      json(setup),
      campaign.metricName,
      campaign.metricUnit,
      campaign.metricDirection,
      campaign.promotionRefName,
      campaign.projectId,
      campaign.status ?? "active",
      campaign.bestExperimentId ?? null,
      campaign.bestMetricValue,
      campaign.bestCommitSha,
      campaign.experimentCount,
      campaign.lastExperimentAt ?? null,
      campaign.createdAt ?? at,
      campaign.updatedAt ?? at
    )
  })
  return localCampaignById(root, campaign.id)
}

export async function completeLocalCampaign({
  root,
  campaignId,
}: {
  root: string
  campaignId: string
}) {
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      db.query(
        "UPDATE campaigns SET status = 'completed', updated_at = ? WHERE id = ? AND status != 'archived'"
      ).run(at, campaignId)
      const row = recomputeLocalCampaignProjectionForDb({
        db,
        campaignId,
        at,
      })
      if (!row) throw new Error("Local campaign not found")
      enqueueSyncEvent({
        db,
        type: "campaign.upserted",
        entityType: "campaign",
        entityId: campaignId,
        payload: { campaign: syncCampaignPayload(row) },
      })
      return campaignFromRow(row)
    })
    return tx()
  })
}

export async function localCampaignByName({
  root,
  projectPath,
  name,
}: {
  root: string
  projectPath: string
  name: string
}) {
  const db = await openDb(root)
  const row = db
    .query("SELECT * FROM campaigns WHERE project_path = ? AND name = ?")
    .get(projectPath, name) as Row | null
  return row ? campaignFromRowForDb(db, row) : null
}

export async function localCampaignById(root: string, campaignId: string) {
  const db = await openDb(root)
  const row = db
    .query("SELECT * FROM campaigns WHERE id = ?")
    .get(campaignId) as Row | null
  return row ? campaignFromRowForDb(db, row) : null
}

export async function listLocalCampaigns(root: string) {
  const db = await openDb(root)
  const rows = db
    .query(
      "SELECT * FROM campaigns WHERE status != 'archived' ORDER BY updated_at DESC"
    )
    .all() as Row[]
  return rows.map((row) => campaignFromRowForDb(db, row))
}

export async function deleteLocalCampaignWithTombstone({
  root,
  projectPath,
  name,
  reason = null,
}: {
  root: string
  projectPath: string
  name: string
  reason?: string | null
}) {
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      const campaign = db
        .query("SELECT * FROM campaigns WHERE project_path = ? AND name = ?")
        .get(projectPath, name) as Row | null
      if (!campaign) throw new Error(`Local campaign ${name} not found`)
      const campaignId = campaign.id as string
      const experiments = db
        .query("SELECT id, run_ref FROM experiments WHERE campaign_id = ?")
        .all(campaignId) as Row[]
      const insertTombstone = db.query(
        `
        INSERT INTO tombstones (
          id, entity_type, entity_id, campaign_id, name, run_ref, reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          campaign_id = excluded.campaign_id,
          name = excluded.name,
          run_ref = excluded.run_ref,
          reason = excluded.reason,
          created_at = excluded.created_at
      `
      )
      for (const experiment of experiments) {
        insertTombstone.run(
          `experiment:${experiment.id as string}`,
          "experiment",
          experiment.id as string,
          campaignId,
          name,
          experiment.run_ref as string,
          reason,
          at
        )
      }
      insertTombstone.run(
        `campaign:${campaignId}`,
        "campaign",
        campaignId,
        campaignId,
        name,
        null,
        reason,
        at
      )
      enqueueSyncEvent({
        db,
        type: "entity.deleted",
        entityType: "campaign",
        entityId: campaignId,
        payload: {
          entityType: "campaign",
          entityId: campaignId,
          campaignId,
          name,
          runRef: null,
          deletedAt: at,
          reason,
        },
      })
      db.query("DELETE FROM campaigns WHERE id = ?").run(campaignId)
      return { campaignId, deletedExperimentCount: experiments.length }
    })
    return tx()
  })
}

function defaultHypothesisName(index: number) {
  return `hypothesis-${index + 1}`
}

export async function createLocalSession({
  root,
  campaignId,
  name,
  workerTarget,
  hypotheses,
  metadata = {},
  maxIterations,
  maxExperiments,
  endTimeMs,
}: {
  root: string
  campaignId: string
  name: string
  workerTarget: number
  hypotheses?: ResearchHypothesisPlan[]
  metadata?: Record<string, unknown>
  maxIterations?: number
  maxExperiments?: number | null
  endTimeMs?: number
}) {
  const sessionId = randomUUID()
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      db.query(
        `
        INSERT INTO sessions (
          id, campaign_id, name, status, worker_target, metadata_json,
          end_time_ms, max_iterations, max_experiments, finalization_status,
          started_at, created_at, updated_at
        )
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, 'running', ?, ?, ?)
      `
      ).run(
        sessionId,
        campaignId,
        name,
        workerTarget,
        json(metadata),
        endTimeMs ?? null,
        maxIterations ?? null,
        maxExperiments ?? null,
        at,
        at,
        at
      )
      enqueueSyncEvent({
        db,
        type: "session.started",
        entityType: "session",
        entityId: sessionId,
        payload: {
          session: sessionFromRow(
            db
              .query("SELECT * FROM sessions WHERE id = ?")
              .get(sessionId) as Row
          ),
        },
      })
      const createdHypotheses = (hypotheses ?? []).map((plan, index) =>
        insertLocalHypothesis(db, {
          campaignId,
          createdBySessionId: sessionId,
          plan,
          name: defaultHypothesisName(index),
          description: plan.statement,
          baseCommitSha: null,
          metadata: {
            createdBy: "onyx-research",
            createdBySessionId: sessionId,
          },
        })
      )
      return {
        session: sessionFromRow(
          db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Row
        ),
        hypotheses: createdHypotheses,
      }
    })
    return tx()
  })
}

function insertLocalHypothesis(
  db: Db,
  input: {
    campaignId: string
    createdBySessionId?: string | null
    plan: ResearchHypothesisPlan
    name?: string
    description?: string | null
    baseCommitSha?: string | null
    metadata?: Record<string, unknown>
  }
) {
  const campaign = db
    .query("SELECT * FROM campaigns WHERE id = ?")
    .get(input.campaignId) as Row | null
  if (!campaign) throw new Error("Local campaign not found")
  const createdBySessionId =
    input.createdBySessionId &&
    db
      .query("SELECT id FROM sessions WHERE id = ?")
      .get(input.createdBySessionId)
      ? input.createdBySessionId
      : null
  const id = randomUUID()
  const at = nowIso()
  const name = input.name ?? input.plan.focus.slice(0, 80) ?? id
  db.query(
    `
      INSERT INTO hypotheses (
        id, campaign_id, created_by_session_id, name, description, status,
        base_commit_sha, plan_json, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `
  ).run(
    id,
    input.campaignId,
    createdBySessionId,
    name,
    input.description ?? input.plan.statement ?? null,
    input.baseCommitSha ?? (campaign.base_commit_sha as string),
    json(input.plan),
    json(input.metadata ?? {}),
    at,
    at
  )
  const row = db.query("SELECT * FROM hypotheses WHERE id = ?").get(id) as Row
  const hypothesis = hypothesisFromRow(row)
  enqueueSyncEvent({
    db,
    type: "hypothesis.upserted",
    entityType: "hypothesis",
    entityId: id,
    payload: { hypothesis },
  })
  return hypothesis
}

export async function createLocalHypothesis({
  root,
  campaignId,
  createdBySessionId,
  plan,
  name,
  description,
  baseCommitSha,
  metadata,
}: {
  root: string
  campaignId: string
  createdBySessionId?: string | null
  plan: ResearchHypothesisPlan
  name?: string
  description?: string | null
  baseCommitSha?: string | null
  metadata?: Record<string, unknown>
}) {
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() =>
      insertLocalHypothesis(db, {
        campaignId,
        createdBySessionId,
        plan,
        name,
        description,
        baseCommitSha,
        metadata,
      })
    )
    return tx()
  })
}

export async function getLocalSessionState(
  root: string,
  sessionId: string
): Promise<ApiSessionState> {
  const db = await openDb(root)
  const sessionRow = db
    .query("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as Row | null
  if (!sessionRow)
    throw new Error(`Local research session ${sessionId} not found`)
  const campaignRow = db
    .query("SELECT * FROM campaigns WHERE id = ?")
    .get(sessionRow.campaign_id as string) as Row | null
  if (!campaignRow) throw new Error("Local campaign not found")
  const visibleExperiments = listLocalExperimentsForDb(
    db,
    sessionRow.campaign_id as string
  )
  const campaign = campaignWithVisibleProjection(
    campaignFromRow(campaignRow),
    visibleExperiments
  )
  const latest = visibleExperiments.slice(0, 20)
  const best = bestVisibleExperimentForCampaign(campaign, visibleExperiments)
  const hypotheses = (
    db
      .query(
        "SELECT * FROM hypotheses WHERE campaign_id = ? ORDER BY created_at ASC"
      )
      .all(campaign.id) as Row[]
  ).map(hypothesisFromRow)
  const workers = (
    db
      .query(
        "SELECT * FROM workers WHERE campaign_id = ? ORDER BY last_seen_at DESC"
      )
      .all(campaign.id) as Row[]
  ).map(workerFromRow)
  const summaries = (
    db
      .query(
        "SELECT * FROM summaries WHERE campaign_id = ? ORDER BY updated_at DESC LIMIT 50"
      )
      .all(campaign.id) as Row[]
  ).map(summaryFromRow)
  const knowledge = (
    db
      .query(
        "SELECT * FROM knowledge WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 50"
      )
      .all(campaign.id) as Row[]
  ).map(knowledgeFromRow)
  return {
    session: sessionFromRow(sessionRow),
    campaign,
    latestExperiments: latest,
    bestExperiment: best,
    hypotheses,
    workers,
    summaries,
    knowledge,
    updatedAt: nowIso(),
  }
}

export async function listLocalHypotheses(root: string, campaignId: string) {
  const rows = (await openDb(root))
    .query(
      "SELECT * FROM hypotheses WHERE campaign_id = ? ORDER BY created_at ASC"
    )
    .all(campaignId) as Row[]
  return rows.map(hypothesisFromRow)
}

function activeWorkerStatus(status: string) {
  return status === "registered" || status === "running" || status === "idle"
}

export async function registerLocalWorker({
  root,
  campaignId,
  sessionId,
  hypothesisId,
  workerName,
  agentKind,
  runtime = "local",
  metadata = {},
}: {
  root: string
  campaignId: string
  sessionId?: string | null
  hypothesisId: string
  workerName: string
  agentKind: string
  runtime?: "local" | "hosted"
  metadata?: Record<string, unknown>
}) {
  const id = randomUUID()
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      if (sessionId) {
        const session = db
          .query("SELECT * FROM sessions WHERE id = ? AND campaign_id = ?")
          .get(sessionId, campaignId) as Row | null
        if (!session) throw new Error("Local research session not found")
        if (session.status !== "running") {
          throw new Error(`Research session ${sessionId} is ${session.status}`)
        }
        const workers = db
          .query("SELECT status FROM workers WHERE session_id = ?")
          .all(sessionId) as Row[]
        const occupied = workers.filter((worker) =>
          activeWorkerStatus(worker.status as string)
        ).length
        const target = Number(session.worker_target ?? 1)
        if (occupied >= target) {
          throw new Error(
            `Research session has no open worker slots (${occupied}/${target})`
          )
        }
      }

      const hypothesis = db
        .query("SELECT * FROM hypotheses WHERE id = ? AND campaign_id = ?")
        .get(hypothesisId, campaignId) as Row | null
      if (!hypothesis) throw new Error("Local research hypothesis not found")
      if (hypothesis.status !== "active") {
        throw new Error(`Hypothesis ${hypothesis.name} is ${hypothesis.status}`)
      }

      db.query(
        `
        INSERT INTO workers (
          id, campaign_id, session_id, hypothesis_id, worker_name,
          agent_kind, runtime, status, started_at, last_seen_at,
          metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        campaignId,
        sessionId ?? null,
        hypothesisId,
        workerName,
        agentKind,
        runtime,
        at,
        at,
        json(metadata),
        at,
        at
      )
      const row = db.query("SELECT * FROM workers WHERE id = ?").get(id) as Row
      const worker = workerFromRow(row)
      enqueueSyncEvent({
        db,
        type: "worker.registered",
        entityType: "worker",
        entityId: id,
        payload: { worker },
      })
      return worker
    })
    return tx()
  })
}

export async function recordLocalWorkerHeartbeat({
  root,
  workerId,
  status = "running",
  sessionId,
  hypothesisId,
  experimentId,
  phase,
  event,
  progressMessage,
  gitLabel,
  resourceStats = {},
  metadata = {},
}: {
  root: string
  workerId: string
  status?: ApiWorker["status"]
  sessionId?: string | null
  hypothesisId?: string | null
  experimentId?: string | null
  phase?: string | null
  event?: string | null
  progressMessage?: string | null
  gitLabel?: string | null
  resourceStats?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      const existing = db
        .query("SELECT * FROM workers WHERE id = ?")
        .get(workerId) as Row | null
      if (!existing) throw new Error("Local worker not found")
      const nextSessionId = sessionId ?? nullableString(existing.session_id)
      const nextHypothesisId =
        hypothesisId ?? (existing.hypothesis_id as string)
      const storedStatus = nextWorkerStatus({
        current: existing.status,
        requested: status,
      })
      const ignoredRegression =
        storedStatus !== status && !isTerminalWorkerStatus(status)
      if (ignoredRegression) {
        return workerFromRow(existing)
      }
      db.query(
        `
        UPDATE workers
        SET status = ?, session_id = ?, hypothesis_id = ?,
          current_experiment_id = ?, phase = ?, progress_message = ?,
          git_label = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `
      ).run(
        storedStatus,
        nextSessionId,
        nextHypothesisId,
        isTerminalWorkerStatus(storedStatus) ? null : (experimentId ?? null),
        phase ?? null,
        progressMessage ?? null,
        gitLabel ?? null,
        at,
        at,
        workerId
      )

      const shouldStoreHeartbeat =
        (event !== undefined && event !== "heartbeat") ||
        isTerminalWorkerStatus(storedStatus)
      let heartbeatId: string | null = null
      if (shouldStoreHeartbeat) {
        heartbeatId = randomUUID()
        db.query(
          `
          INSERT INTO worker_heartbeats (
            id, worker_id, campaign_id, session_id, hypothesis_id, experiment_id,
            status, phase, event, progress_message, git_label,
            resource_stats_json, metadata_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
          heartbeatId,
          workerId,
          existing.campaign_id as string,
          nextSessionId,
          nextHypothesisId,
          isTerminalWorkerStatus(storedStatus) ? null : (experimentId ?? null),
          storedStatus,
          phase ?? null,
          event ?? null,
          progressMessage ?? null,
          gitLabel ?? null,
          json(resourceStats),
          json(metadata),
          at
        )
        enqueueSyncEvent({
          db,
          type: "worker.heartbeat",
          entityType: "worker",
          entityId: workerId,
          payload: {
            workerId,
            heartbeatId,
            campaignId: existing.campaign_id,
            sessionId: nextSessionId,
            hypothesisId: nextHypothesisId,
            experimentId: isTerminalWorkerStatus(storedStatus)
              ? null
              : (experimentId ?? null),
            status: storedStatus,
            phase: phase ?? null,
            event: event ?? null,
            progressMessage: progressMessage ?? null,
            gitLabel: gitLabel ?? null,
            resourceStats,
            metadata,
            createdAt: at,
          },
        })
      }

      return workerFromRow(
        db.query("SELECT * FROM workers WHERE id = ?").get(workerId) as Row
      )
    })
    return tx()
  })
}

export async function stopLocalSession({
  root,
  sessionId,
  status,
  finalizationStatus,
  reason,
  metadata,
}: {
  root: string
  sessionId: string
  status: ApiSession["status"]
  finalizationStatus?: ApiSession["finalizationStatus"] | null
  reason?: string | null
  metadata?: Record<string, unknown>
}) {
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      const existing = db
        .query("SELECT metadata_json FROM sessions WHERE id = ?")
        .get(sessionId) as Row | null
      const mergedMetadata = {
        ...parseJson(existing?.metadata_json, {}),
        ...(metadata ?? {}),
      }
      db.query(
        "UPDATE sessions SET status = ?, finalization_status = COALESCE(?, finalization_status), metadata_json = ?, completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(
        status,
        finalizationStatus ?? null,
        json(mergedMetadata),
        status === "stop_requested" || status === "running" ? null : at,
        at,
        sessionId
      )
      const row = db
        .query("SELECT * FROM sessions WHERE id = ?")
        .get(sessionId) as Row | null
      if (!row) throw new Error("Local session not found")
      const session = sessionFromRow(row)
      enqueueSyncEvent({
        db,
        type: "session.stopped",
        entityType: "session",
        entityId: sessionId,
        payload: { session, reason: reason ?? null },
      })
      return session
    })
    return tx()
  })
}

function isBestEligible(experiment: ApiCampaignExperiment) {
  return (
    (experiment.gitStatus === "verified" ||
      experiment.gitStatus === "pending") &&
    experiment.primaryMetricValue !== null &&
    (experiment.status === "succeeded" || experiment.status === "accepted")
  )
}

function isBetter(
  direction: "maximize" | "minimize",
  current: number | null,
  next: number
) {
  if (current === null) return true
  return direction === "maximize" ? next > current : next < current
}

function timestampMs(value?: string | null) {
  if (!value) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function experimentImprovementMs(experiment: ApiCampaignExperiment) {
  return timestampMs(experiment.completedAt ?? experiment.createdAt)
}

function experimentCreatedMs(experiment: ApiCampaignExperiment) {
  return timestampMs(experiment.createdAt)
}

function isEarlierExperiment(
  candidate: ApiCampaignExperiment,
  current: ApiCampaignExperiment
) {
  const candidateImprovement = experimentImprovementMs(candidate)
  const currentImprovement = experimentImprovementMs(current)
  if (candidateImprovement !== currentImprovement) {
    return candidateImprovement < currentImprovement
  }

  const candidateCreated = experimentCreatedMs(candidate)
  const currentCreated = experimentCreatedMs(current)
  if (candidateCreated !== currentCreated) {
    return candidateCreated < currentCreated
  }

  return candidate.id < current.id
}

function visibleExperimentPredicateSql() {
  return `
    NOT EXISTS (
      SELECT 1
      FROM tombstones t
      WHERE
        (
          t.entity_type = 'experiment'
          AND (t.entity_id = e.id OR t.run_ref = e.run_ref)
        )
        OR (
          t.entity_type = 'campaign'
          AND (
            t.entity_id = e.campaign_id
            OR t.campaign_id = e.campaign_id
            OR t.name = c.name
          )
          AND e.created_at < t.created_at
        )
    )
  `
}

function bestVisibleExperimentForCampaign(
  campaign: Pick<LocalCampaign, "metricDirection">,
  experiments: ApiCampaignExperiment[]
) {
  return experiments.reduce<ApiCampaignExperiment | null>((current, next) => {
    if (!isBestEligible(next) || next.primaryMetricValue === null)
      return current
    if (!current || current.primaryMetricValue === null) return next
    if (
      isBetter(
        campaign.metricDirection,
        current.primaryMetricValue,
        next.primaryMetricValue
      )
    ) {
      return next
    }
    if (
      next.primaryMetricValue === current.primaryMetricValue &&
      isEarlierExperiment(next, current)
    ) {
      return next
    }
    return current
  }, null)
}

function bestVisibleExperimentForHypothesis(
  campaign: Pick<LocalCampaign, "metricDirection">,
  experiments: ApiCampaignExperiment[]
) {
  return bestVisibleExperimentForCampaign(campaign, experiments)
}

function campaignWithVisibleProjection(
  campaign: LocalCampaign,
  experiments: ApiCampaignExperiment[]
) {
  const best = bestVisibleExperimentForCampaign(campaign, experiments)
  return {
    ...campaign,
    bestExperimentId: best?.id ?? null,
    bestMetricValue: best?.primaryMetricValue ?? null,
    bestCommitSha: best?.resultCommitSha ?? null,
    experimentCount: experiments.length,
  }
}

function campaignFromRowForDb(db: Db, row: Row) {
  const campaign = campaignFromRow(row)
  return campaignWithVisibleProjection(
    campaign,
    listLocalExperimentsForDb(db, campaign.id)
  )
}

function recomputeLocalCampaignProjectionForDb({
  db,
  campaignId,
  at,
}: {
  db: Db
  campaignId: string
  at: string
}) {
  const campaignRow = db
    .query("SELECT * FROM campaigns WHERE id = ?")
    .get(campaignId) as Row | null
  if (!campaignRow) return null
  const campaign = campaignFromRow(campaignRow)
  const experiments = listLocalExperimentsForDb(db, campaignId)
  const best = bestVisibleExperimentForCampaign(campaign, experiments)
  const latest = experiments.at(0)
  db.query(
    `
      UPDATE campaigns
      SET best_experiment_id = ?, best_metric_value = ?, best_commit_sha = ?,
        experiment_count = ?, last_experiment_at = ?, updated_at = ?
      WHERE id = ?
    `
  ).run(
    best?.id ?? null,
    best?.primaryMetricValue ?? null,
    best?.resultCommitSha ?? null,
    experiments.length,
    latest?.completedAt ?? latest?.createdAt ?? null,
    at,
    campaignId
  )
  return db
    .query("SELECT * FROM campaigns WHERE id = ?")
    .get(campaignId) as Row | null
}

function listLocalExperimentsForHypothesisForDb(
  db: Db,
  campaignId: string,
  hypothesisId: string
) {
  const rows = db
    .query(
      `
        SELECT e.*
        FROM experiments e
        INNER JOIN campaigns c ON c.id = e.campaign_id
        WHERE e.campaign_id = ?
          AND e.hypothesis_id = ?
          AND ${visibleExperimentPredicateSql()}
        ORDER BY e.created_at ASC
      `
    )
    .all(campaignId, hypothesisId) as Row[]
  return rows.map(experimentFromRow)
}

function recomputeLocalHypothesisProjectionForDb({
  db,
  campaignId,
  hypothesisId,
  at,
}: {
  db: Db
  campaignId: string
  hypothesisId: string | null | undefined
  at: string
}) {
  if (!hypothesisId) return
  const campaignRow = db
    .query("SELECT * FROM campaigns WHERE id = ?")
    .get(campaignId) as Row | null
  if (!campaignRow) return
  const campaign = campaignFromRow(campaignRow)
  const experiments = listLocalExperimentsForHypothesisForDb(
    db,
    campaignId,
    hypothesisId
  )
  const latest = experiments.at(-1)
  const best = bestVisibleExperimentForHypothesis(campaign, experiments)
  db.query(
    `
      UPDATE hypotheses
      SET last_worked_at = ?, best_experiment_id = ?, best_metric_value = ?,
        updated_at = ?
      WHERE id = ? AND campaign_id = ?
    `
  ).run(
    latest?.completedAt ?? latest?.createdAt ?? null,
    best?.id ?? null,
    best?.primaryMetricValue ?? null,
    at,
    hypothesisId,
    campaignId
  )
}

export async function logLocalExperiment({
  root,
  record,
}: {
  root: string
  record: LocalResearchCampaignExperimentLoggedRecord
}) {
  const id = randomUUID()
  const at = record.createdAt || nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      const campaign = db
        .query(
          "SELECT * FROM campaigns WHERE project_path = ? AND name = ? AND status != 'archived'"
        )
        .get(record.projectPath ?? "", record.campaignName) as Row | null
      if (!campaign)
        throw new Error(`Local campaign ${record.campaignName} not found`)
      const campaignId = campaign.id as string
      let sessionId = record.sessionId ?? null
      let hypothesisId = record.hypothesisId ?? null
      let workerId = record.workerId ?? null

      if (
        sessionId &&
        !db.query("SELECT id FROM sessions WHERE id = ?").get(sessionId)
      ) {
        db.query(
          `
          INSERT INTO sessions (
            id, campaign_id, name, status, worker_target, metadata_json,
            started_at, created_at, updated_at
          )
          VALUES (?, ?, ?, 'running', 0, '{}', ?, ?, ?)
        `
        ).run(
          sessionId,
          campaignId,
          `session-${sessionId.slice(0, 8)}`,
          at,
          at,
          at
        )
      }

      if (
        hypothesisId &&
        !db.query("SELECT id FROM hypotheses WHERE id = ?").get(hypothesisId)
      ) {
        db.query(
          `
          INSERT INTO hypotheses (
            id, campaign_id, created_by_session_id, name, description, status,
            base_commit_sha, plan_json, metadata_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, NULL, 'active', ?, '{}', '{}', ?, ?)
        `
        ).run(
          hypothesisId,
          campaignId,
          sessionId,
          `hypothesis-${hypothesisId.slice(0, 8)}`,
          record.baseCommitSha,
          at,
          at
        )
      }

      if (
        workerId &&
        hypothesisId &&
        !db.query("SELECT id FROM workers WHERE id = ?").get(workerId)
      ) {
        db.query(
          `
          INSERT INTO workers (
            id, campaign_id, session_id, hypothesis_id, worker_name, agent_kind,
            runtime, status, started_at, last_seen_at, metadata_json, created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'unknown', 'local', 'completed', ?, ?, '{}', ?, ?)
        `
        ).run(
          workerId,
          campaignId,
          sessionId,
          hypothesisId,
          `worker-${workerId.slice(0, 8)}`,
          at,
          at,
          at,
          at
        )
      }

      if (
        sessionId &&
        !db.query("SELECT id FROM sessions WHERE id = ?").get(sessionId)
      ) {
        sessionId = null
      }
      if (
        hypothesisId &&
        !db.query("SELECT id FROM hypotheses WHERE id = ?").get(hypothesisId)
      ) {
        hypothesisId = null
      }
      if (
        workerId &&
        !db.query("SELECT id FROM workers WHERE id = ?").get(workerId)
      ) {
        workerId = null
      }
      const existing = db
        .query(
          "SELECT * FROM experiments WHERE campaign_id = ? AND run_ref = ?"
        )
        .get(campaignId, record.runRef) as Row | null
      if (existing) {
        const experiment = experimentFromRow(existing)
        recomputeLocalCampaignProjectionForDb({ db, campaignId, at })
        recomputeLocalHypothesisProjectionForDb({
          db,
          campaignId,
          hypothesisId: experiment.hypothesisId,
          at,
        })
        return experiment
      }

      const secondaryMetrics: Record<string, unknown> = { ...record.metrics }
      delete secondaryMetrics[record.primaryMetricName]
      db.query(
        `
        INSERT INTO experiments (
          id, campaign_id, session_id, hypothesis_id, worker_id, name,
          description, run_ref, base_commit_sha, result_commit_sha, result_ref,
          git_status, status, setup_compliance_json, primary_metric_name,
          primary_metric_value, secondary_metrics_json, artifact_refs_json,
          agent_notes_json, checks_json, duration_ms, output_summary,
          started_at, completed_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        campaignId,
        sessionId,
        hypothesisId,
        workerId,
        record.name,
        record.description ?? null,
        record.runRef,
        record.baseCommitSha,
        record.resultCommitSha,
        record.resultRef,
        record.status,
        json(record.setupCompliance),
        record.primaryMetricName,
        record.primaryMetricValue ?? null,
        json(secondaryMetrics),
        json(record.agentNotes),
        record.checks ? json(record.checks) : null,
        record.durationMs ?? null,
        record.outputSummary ?? null,
        record.startedAt ?? null,
        record.completedAt ?? null,
        at,
        at
      )
      const experiment = experimentFromRow(
        db.query("SELECT * FROM experiments WHERE id = ?").get(id) as Row
      )
      recomputeLocalCampaignProjectionForDb({ db, campaignId, at })
      recomputeLocalHypothesisProjectionForDb({
        db,
        campaignId,
        hypothesisId,
        at,
      })
      enqueueSyncEvent({
        db,
        type: "experiment.logged",
        entityType: "experiment",
        entityId: experiment.id,
        payload: {
          experiment,
          campaignName: record.campaignName,
          projectPath: record.projectPath ?? "",
          fingerprint: experimentFingerprint(experiment),
        },
      })
      return experiment
    })
    return tx()
  })
}

function listLocalExperimentsForDb(db: Db, campaignId: string, limit?: number) {
  const sql = `
    SELECT e.*
    FROM experiments e
    INNER JOIN campaigns c ON c.id = e.campaign_id
    WHERE e.campaign_id = ?
      AND ${visibleExperimentPredicateSql()}
    ORDER BY e.created_at DESC
    ${limit === undefined ? "" : "LIMIT ?"}
  `
  const rows =
    limit === undefined
      ? (db.query(sql).all(campaignId) as Row[])
      : (db.query(sql).all(campaignId, limit) as Row[])
  return rows.map(experimentFromRow)
}

export async function listLocalExperimentHistory(root: string) {
  const db = await openDb(root)
  const rows = db
    .query(
      `
        SELECT e.*, c.name AS campaign_name
        FROM experiments e
        INNER JOIN campaigns c ON c.id = e.campaign_id
        WHERE ${visibleExperimentPredicateSql()}
        ORDER BY e.created_at DESC
      `
    )
    .all() as Row[]
  return rows.map((row) => {
    const experiment = experimentFromRow(row)
    return {
      schemaVersion: 1,
      source: "local",
      campaignName: row.campaign_name as string,
      runRef: experiment.runRef,
      baseCommitSha: experiment.baseCommitSha,
      resultCommitSha: experiment.resultCommitSha,
      resultRef: experiment.resultRef,
      gitStatus:
        experiment.gitStatus as LocalResearchHistoryRecord["gitStatus"],
      status: experiment.status as LocalResearchHistoryRecord["status"],
      name: experiment.name,
      description: experiment.description,
      primaryMetricName: experiment.primaryMetricName,
      primaryMetricValue: experiment.primaryMetricValue,
      metrics: {
        ...numericRecord(experiment.secondaryMetrics),
        ...(experiment.primaryMetricValue === null
          ? {}
          : { [experiment.primaryMetricName]: experiment.primaryMetricValue }),
      },
      agentNotes: experiment.agentNotes,
      checks: experiment.checks,
      durationMs: experiment.durationMs,
      outputSummary: experiment.outputSummary,
      startedAt: experiment.startedAt,
      completedAt: experiment.completedAt,
      createdAt: experiment.createdAt,
      campaignId: experiment.campaignId,
      experimentId: experiment.id,
      sessionId: experiment.sessionId ?? undefined,
      workerId: experiment.workerId ?? undefined,
      hypothesisId: experiment.hypothesisId ?? undefined,
    } satisfies LocalResearchHistoryRecord
  })
}

export async function markExperimentRefsVerified({
  root,
  refs,
}: {
  root: string
  refs: Array<{ runRef: string; commitSha: string; ref: string }>
}) {
  if (refs.length === 0) return
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      for (const ref of refs) {
        db.query(
          `
          UPDATE experiments
          SET git_status = 'verified',
            git_verified_at = ?,
            git_status_reason = NULL,
            updated_at = ?
          WHERE run_ref = ?
            AND result_commit_sha = ?
            AND result_ref = ?
        `
        ).run(at, at, ref.runRef, ref.commitSha, ref.ref)
      }
    })
    tx()
  })
}

export async function applyRemoteExperimentGitStatuses({
  root,
  experiments,
}: {
  root: string
  experiments: ApiCampaignExperiment[]
}) {
  if (experiments.length === 0) return
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      for (const experiment of experiments) {
        db.query(
          `
          UPDATE experiments
          SET git_status = ?,
            git_verified_at = ?,
            git_status_reason = ?,
            updated_at = ?
          WHERE id = ? OR run_ref = ?
        `
        ).run(
          experiment.gitStatus,
          experiment.gitVerifiedAt,
          experiment.gitStatusReason,
          at,
          experiment.id,
          experiment.runRef
        )
      }
    })
    tx()
  })
}

function optionalExistingId(
  db: Db,
  table: "sessions" | "hypotheses" | "workers" | "experiments",
  id: string | null | undefined
) {
  if (!id) return null
  const row = db
    .query(`SELECT id FROM ${table} WHERE id = ?`)
    .get(id) as Row | null
  return row ? id : null
}

function upsertRemoteCampaignForDb(
  db: Db,
  campaign: ApiResearchSyncResponse["projectionDeltas"]["campaigns"][number],
  at: string
) {
  const existing = db
    .query(
      "SELECT project_path, setup_json, human_feedback FROM campaigns WHERE id = ?"
    )
    .get(campaign.id) as Row | null
  db.query(
    `
      INSERT INTO campaigns (
        id, name, description, project_path, base_commit_sha, setup_json,
        metric_name, metric_unit, metric_direction, human_feedback,
        promotion_ref_name, status, best_experiment_id, best_metric_value,
        best_commit_sha, experiment_count, last_experiment_at,
        server_project_id, synced_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        base_commit_sha = excluded.base_commit_sha,
        metric_name = excluded.metric_name,
        metric_unit = excluded.metric_unit,
        metric_direction = excluded.metric_direction,
        promotion_ref_name = excluded.promotion_ref_name,
        status = excluded.status,
        best_experiment_id = excluded.best_experiment_id,
        best_metric_value = excluded.best_metric_value,
        best_commit_sha = excluded.best_commit_sha,
        experiment_count = excluded.experiment_count,
        last_experiment_at = excluded.last_experiment_at,
        server_project_id = excluded.server_project_id,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at
    `
  ).run(
    campaign.id,
    campaign.name,
    campaign.description,
    nullableString(existing?.project_path) ?? "",
    campaign.baseCommitSha,
    typeof existing?.setup_json === "string" ? existing.setup_json : "{}",
    campaign.metricName,
    campaign.metricUnit,
    campaign.metricDirection,
    nullableString(existing?.human_feedback),
    campaign.promotionRefName,
    campaign.status ?? "active",
    campaign.bestExperimentId ?? null,
    campaign.bestMetricValue,
    campaign.bestCommitSha,
    campaign.experimentCount,
    campaign.lastExperimentAt ?? null,
    campaign.projectId,
    at,
    campaign.createdAt ?? at,
    campaign.updatedAt ?? at
  )
}

function upsertRemoteSessionForDb(
  db: Db,
  session: ApiResearchSyncResponse["projectionDeltas"]["sessions"][number],
  at: string
) {
  if (
    !db.query("SELECT id FROM campaigns WHERE id = ?").get(session.campaignId)
  )
    return
  db.query(
    `
      INSERT INTO sessions (
        id, campaign_id, name, status, worker_target, metadata_json,
        max_experiments, reserved_experiment_count, terminal_experiment_count,
        finalization_status, started_at, completed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        name = excluded.name,
        status = excluded.status,
        worker_target = excluded.worker_target,
        metadata_json = excluded.metadata_json,
        max_experiments = excluded.max_experiments,
        reserved_experiment_count = excluded.reserved_experiment_count,
        terminal_experiment_count = excluded.terminal_experiment_count,
        finalization_status = excluded.finalization_status,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `
  ).run(
    session.id,
    session.campaignId,
    session.name,
    session.status,
    session.workerTarget,
    json(session.metadata),
    session.maxExperiments ?? null,
    session.reservedExperimentCount ?? 0,
    session.terminalExperimentCount ?? 0,
    session.finalizationStatus ?? "not_started",
    session.startedAt ?? at,
    session.completedAt ?? null,
    session.createdAt ?? at,
    session.updatedAt ?? at
  )
}

function upsertRemoteHypothesisForDb(
  db: Db,
  hypothesis: ApiResearchSyncResponse["projectionDeltas"]["hypotheses"][number]
) {
  if (
    !db
      .query("SELECT id FROM campaigns WHERE id = ?")
      .get(hypothesis.campaignId)
  ) {
    return
  }
  db.query(
    `
      INSERT INTO hypotheses (
        id, campaign_id, created_by_session_id, name, description, status,
        base_commit_sha, best_experiment_id, best_metric_value, last_worked_at,
        plan_json, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        created_by_session_id = excluded.created_by_session_id,
        name = excluded.name,
        description = excluded.description,
        status = excluded.status,
        base_commit_sha = excluded.base_commit_sha,
        best_experiment_id = excluded.best_experiment_id,
        best_metric_value = excluded.best_metric_value,
        last_worked_at = excluded.last_worked_at,
        plan_json = excluded.plan_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `
  ).run(
    hypothesis.id,
    hypothesis.campaignId,
    optionalExistingId(db, "sessions", hypothesis.createdBySessionId),
    hypothesis.name,
    hypothesis.description,
    hypothesis.status,
    hypothesis.baseCommitSha,
    hypothesis.bestExperimentId,
    hypothesis.bestMetricValue,
    hypothesis.lastWorkedAt,
    json(hypothesis.plan),
    json(hypothesis.metadata),
    hypothesis.createdAt,
    hypothesis.updatedAt
  )
}

function upsertRemoteWorkerForDb(
  db: Db,
  worker: ApiResearchSyncResponse["projectionDeltas"]["workers"][number]
) {
  if (!db.query("SELECT id FROM campaigns WHERE id = ?").get(worker.campaignId))
    return
  if (
    !db.query("SELECT id FROM hypotheses WHERE id = ?").get(worker.hypothesisId)
  )
    return
  db.query(
    `
      INSERT INTO workers (
        id, campaign_id, session_id, hypothesis_id, worker_name, agent_kind,
        runtime, status, started_at, last_seen_at, current_experiment_id, phase,
        progress_message, git_label, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        session_id = excluded.session_id,
        hypothesis_id = excluded.hypothesis_id,
        worker_name = excluded.worker_name,
        agent_kind = excluded.agent_kind,
        runtime = excluded.runtime,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        current_experiment_id = excluded.current_experiment_id,
        phase = excluded.phase,
        progress_message = excluded.progress_message,
        git_label = excluded.git_label,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `
  ).run(
    worker.id,
    worker.campaignId,
    optionalExistingId(db, "sessions", worker.sessionId),
    worker.hypothesisId,
    worker.workerName,
    worker.agentKind,
    worker.runtime,
    worker.status,
    worker.startedAt,
    worker.lastSeenAt,
    optionalExistingId(db, "experiments", worker.currentExperimentId),
    worker.phase,
    worker.progressMessage,
    worker.gitLabel,
    json(worker.metadata),
    worker.createdAt,
    worker.updatedAt
  )
}

function upsertRemoteExperimentForDb(
  db: Db,
  experiment: ApiCampaignExperiment
) {
  if (
    !db
      .query("SELECT id FROM campaigns WHERE id = ?")
      .get(experiment.campaignId)
  ) {
    return
  }
  const existing = db
    .query(
      `
        SELECT id FROM experiments
        WHERE id = ? OR (campaign_id = ? AND run_ref = ?) OR
          (campaign_id = ? AND result_ref = ?)
        LIMIT 1
      `
    )
    .get(
      experiment.id,
      experiment.campaignId,
      experiment.runRef,
      experiment.campaignId,
      experiment.resultRef
    ) as Row | null
  const targetId = (existing?.id as string | undefined) ?? experiment.id
  const values = [
    targetId,
    experiment.campaignId,
    optionalExistingId(db, "sessions", experiment.sessionId),
    optionalExistingId(db, "hypotheses", experiment.hypothesisId),
    optionalExistingId(db, "workers", experiment.workerId),
    experiment.name,
    experiment.description,
    experiment.runRef,
    experiment.baseCommitSha,
    experiment.resultCommitSha,
    experiment.resultRef,
    experiment.gitStatus,
    experiment.gitVerifiedAt,
    experiment.gitStatusReason,
    experiment.status,
    experiment.setupCompliance ? json(experiment.setupCompliance) : null,
    experiment.primaryMetricName,
    experiment.primaryMetricValue,
    json(experiment.secondaryMetrics),
    json(experiment.artifactRefs),
    json(experiment.agentNotes),
    experiment.checks ? json(experiment.checks) : null,
    experiment.durationMs,
    experiment.outputSummary,
    experiment.startedAt,
    experiment.completedAt,
    experiment.createdAt,
    experiment.updatedAt,
  ]
  if (existing) {
    db.query(
      `
        UPDATE experiments
        SET campaign_id = ?, session_id = ?, hypothesis_id = ?, worker_id = ?,
          name = ?, description = ?, run_ref = ?, base_commit_sha = ?,
          result_commit_sha = ?, result_ref = ?, git_status = ?,
          git_verified_at = ?, git_status_reason = ?, status = ?,
          setup_compliance_json = ?, primary_metric_name = ?,
          primary_metric_value = ?, secondary_metrics_json = ?,
          artifact_refs_json = ?, agent_notes_json = ?, checks_json = ?,
          duration_ms = ?, output_summary = ?, started_at = ?,
          completed_at = ?, created_at = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(...values.slice(1), targetId)
    return
  }
  db.query(
    `
      INSERT INTO experiments (
        id, campaign_id, session_id, hypothesis_id, worker_id, name,
        description, run_ref, base_commit_sha, result_commit_sha, result_ref,
        git_status, git_verified_at, git_status_reason, status,
        setup_compliance_json, primary_metric_name, primary_metric_value,
        secondary_metrics_json, artifact_refs_json, agent_notes_json,
        checks_json, duration_ms, output_summary, started_at, completed_at,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(...values)
}

function upsertRemoteSummaryForDb(
  db: Db,
  summary: ApiResearchSyncResponse["projectionDeltas"]["summaries"][number]
) {
  if (
    !db.query("SELECT id FROM campaigns WHERE id = ?").get(summary.campaignId)
  )
    return
  db.query(
    `
      INSERT INTO summaries (
        id, campaign_id, session_id, hypothesis_id, authored_by_worker_id,
        summary_kind, title, body, is_current, metadata_json, created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        session_id = excluded.session_id,
        hypothesis_id = excluded.hypothesis_id,
        authored_by_worker_id = excluded.authored_by_worker_id,
        summary_kind = excluded.summary_kind,
        title = excluded.title,
        body = excluded.body,
        is_current = excluded.is_current,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `
  ).run(
    summary.id,
    summary.campaignId,
    optionalExistingId(db, "sessions", summary.sessionId),
    optionalExistingId(db, "hypotheses", summary.hypothesisId),
    optionalExistingId(db, "workers", summary.authoredByWorkerId),
    summary.summaryKind,
    summary.title,
    summary.body,
    summary.isCurrent ? 1 : 0,
    json(summary.metadata),
    summary.createdAt,
    summary.updatedAt
  )
}

function upsertRemoteKnowledgeForDb(
  db: Db,
  knowledge: ApiResearchSyncResponse["projectionDeltas"]["knowledge"][number]
) {
  if (
    !db.query("SELECT id FROM campaigns WHERE id = ?").get(knowledge.campaignId)
  )
    return
  db.query(
    `
      INSERT INTO knowledge (
        id, campaign_id, session_id, hypothesis_id, authored_by_worker_id,
        experiment_id, kind, title, body, confidence, metadata_json,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        session_id = excluded.session_id,
        hypothesis_id = excluded.hypothesis_id,
        authored_by_worker_id = excluded.authored_by_worker_id,
        experiment_id = excluded.experiment_id,
        kind = excluded.kind,
        title = excluded.title,
        body = excluded.body,
        confidence = excluded.confidence,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `
  ).run(
    knowledge.id,
    knowledge.campaignId,
    optionalExistingId(db, "sessions", knowledge.sessionId),
    optionalExistingId(db, "hypotheses", knowledge.hypothesisId),
    optionalExistingId(db, "workers", knowledge.authoredByWorkerId),
    optionalExistingId(db, "experiments", knowledge.experimentId),
    knowledge.kind,
    knowledge.title,
    knowledge.body,
    knowledge.confidence,
    json(knowledge.metadata),
    knowledge.createdAt,
    knowledge.updatedAt
  )
}

export async function applyRemoteProjectionDeltas({
  root,
  deltas,
}: {
  root: string
  deltas: ApiResearchSyncResponse["projectionDeltas"]
}) {
  const total =
    deltas.campaigns.length +
    deltas.sessions.length +
    deltas.hypotheses.length +
    deltas.workers.length +
    deltas.experiments.length +
    deltas.summaries.length +
    deltas.knowledge.length
  if (total === 0) return
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      for (const campaign of deltas.campaigns) {
        upsertRemoteCampaignForDb(db, campaign, at)
      }
      for (const session of deltas.sessions)
        upsertRemoteSessionForDb(db, session, at)
      for (const hypothesis of deltas.hypotheses) {
        upsertRemoteHypothesisForDb(db, hypothesis)
      }
      for (const worker of deltas.workers) upsertRemoteWorkerForDb(db, worker)
      for (const experiment of deltas.experiments) {
        upsertRemoteExperimentForDb(db, experiment)
      }
      // Server projection fields are authoritative; local experiment upserts do
      // not recompute campaign or hypothesis best pointers.
      for (const summary of deltas.summaries)
        upsertRemoteSummaryForDb(db, summary)
      for (const item of deltas.knowledge) upsertRemoteKnowledgeForDb(db, item)
    })
    tx()
  })
}

function attemptFromRow(row: Row): LastRunRecord {
  return parseJson<LastRunRecord>(row.record_json, {
    schemaVersion: 1,
    createdAt: row.created_at as string,
    runRef: row.run_ref as string,
    campaignName: row.campaign_name as string,
    projectPath: row.project_path as string,
    baseCommitSha: "",
    resultCommitSha: row.result_commit_sha as string,
    resultRef: "",
    status: row.status as LastRunRecord["status"],
    setupCompliance: {
      status: "passed",
      protectedPathsChanged: [],
      outOfScopePathsChanged: [],
      setupPathsChanged: [],
      notes: null,
    },
    primaryMetricName: "score",
    primaryMetricValue: null,
    metrics: {},
    agentNotes: {},
    checks: null,
    durationMs: 0,
    startedAt: null,
    completedAt: null,
    outputSummary: null,
  })
}

export async function writeLocalAttempt({
  root,
  record,
}: {
  root: string
  record: LastRunRecord
}) {
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    db.query(
      `
      INSERT INTO local_attempts (
        run_ref, campaign_id, campaign_name, project_path, session_id, worker_id,
        hypothesis_id, result_commit_sha, status, record_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_ref) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        campaign_name = excluded.campaign_name,
        project_path = excluded.project_path,
        session_id = excluded.session_id,
        worker_id = excluded.worker_id,
        hypothesis_id = excluded.hypothesis_id,
        result_commit_sha = excluded.result_commit_sha,
        status = excluded.status,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `
    ).run(
      record.runRef,
      null,
      record.campaignName,
      record.projectPath ?? "",
      record.sessionId ?? null,
      record.workerId ?? null,
      record.hypothesisId ?? null,
      record.resultCommitSha,
      record.status,
      json(record),
      record.createdAt,
      at
    )
  })
}

export async function readLocalAttempt(
  root: string,
  selector: LastRunSelector
) {
  if (selector.runRef) {
    const db = await openDb(root)
    const row = db
      .query("SELECT * FROM local_attempts WHERE run_ref = ?")
      .get(selector.runRef) as Row | null
    return row ? attemptFromRow(row) : null
  }

  const rows = await listLocalAttempts(root, selector)
  return rows[0] ?? null
}

function matchesLocalAttemptSelector(
  record: LastRunRecord,
  selector: LastRunSelector
) {
  return (
    (!selector.runRef || record.runRef === selector.runRef) &&
    (!selector.campaignName || record.campaignName === selector.campaignName) &&
    (selector.projectPath === undefined ||
      record.projectPath === selector.projectPath) &&
    (!selector.sessionId || record.sessionId === selector.sessionId) &&
    (!selector.workerId || record.workerId === selector.workerId) &&
    (!selector.hypothesisId || record.hypothesisId === selector.hypothesisId)
  )
}

export async function listLocalAttempts(
  root: string,
  selector: LastRunSelector = {}
) {
  const db = await openDb(root)
  if (selector.runRef) {
    const row = db
      .query("SELECT * FROM local_attempts WHERE run_ref = ?")
      .get(selector.runRef) as Row | null
    return row ? [attemptFromRow(row)] : []
  }

  const rows = db
    .query(
      `
        SELECT * FROM local_attempts
        ORDER BY updated_at DESC
      `
    )
    .all() as Row[]
  return rows.map(attemptFromRow).filter((record) =>
    matchesLocalAttemptSelector(record, selector)
  )
}

export async function clearLocalAttempt(
  root: string,
  selector: LastRunSelector
) {
  await withResearchDbWrite(root, (db) => {
    if (selector.runRef) {
      db.query("DELETE FROM local_attempts WHERE run_ref = ?").run(
        selector.runRef
      )
      return
    }
    const rows = db
      .query(
        `
          SELECT * FROM local_attempts
          WHERE campaign_name = ? AND project_path = ?
          ORDER BY updated_at DESC
        `
      )
      .all(selector.campaignName ?? "", selector.projectPath ?? "") as Row[]
    const match = rows.find((row) => {
      if (selector.sessionId && row.session_id !== selector.sessionId)
        return false
      if (selector.workerId && row.worker_id !== selector.workerId) return false
      if (
        selector.hypothesisId &&
        row.hypothesis_id !== selector.hypothesisId
      ) {
        return false
      }
      return true
    })
    if (match) {
      db.query("DELETE FROM local_attempts WHERE run_ref = ?").run(
        match.run_ref as string
      )
    }
  })
}

function workflowRunFromRow(row: Row): LocalWorkflowRun {
  return {
    id: row.id as string,
    campaignId: nullableString(row.campaign_id),
    campaignName: row.campaign_name as string,
    projectPath: row.project_path as string,
    runRef: row.run_ref as string,
    baseCommitSha: row.base_commit_sha as string,
    resultCommitSha: nullableString(row.result_commit_sha),
    resultRef: row.result_ref as string,
    setupHash: row.setup_hash as string,
    status: row.status as LocalWorkflowRunStatus,
    currentStepIndex: Number(row.current_step_index ?? 0),
    metrics: numericRecord(parseJson(row.metrics_json, {})),
    blockReason: nullableString(row.block_reason),
    createdAt: row.created_at as string,
    startedAt: row.started_at as string,
    completedAt: nullableString(row.completed_at),
    updatedAt: row.updated_at as string,
    sessionId: nullableString(row.session_id) ?? undefined,
    workerId: nullableString(row.worker_id) ?? undefined,
    hypothesisId: nullableString(row.hypothesis_id) ?? undefined,
  }
}

function workflowStepFromRow(row: Row): LocalWorkflowStep {
  return {
    runId: row.run_id as string,
    stepId: row.step_id as string,
    stepIndex: Number(row.step_index ?? 0),
    kind: row.kind as "agent" | "run",
    toolId: nullableString(row.tool_id),
    status: row.status as LocalWorkflowStepStatus,
    attempt: Number(row.attempt ?? 0),
    exitCode: typeof row.exit_code === "number" ? Number(row.exit_code) : null,
    timedOut: bool(row.timed_out),
    outputSummary: nullableString(row.output_summary),
    metrics: numericRecord(parseJson(row.metrics_json, {})),
    logPath: nullableString(row.log_path),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    updatedAt: row.updated_at as string,
  }
}

export async function upsertWorkflowRun({
  root,
  run,
}: {
  root: string
  run: LocalWorkflowRun
}) {
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    db.query(
      `
      INSERT INTO workflow_runs (
        id, campaign_id, campaign_name, project_path, run_ref, base_commit_sha,
        result_commit_sha, result_ref, setup_hash, status, current_step_index,
        metrics_json, block_reason, created_at, started_at, completed_at,
        updated_at, session_id, worker_id, hypothesis_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        campaign_name = excluded.campaign_name,
        project_path = excluded.project_path,
        run_ref = excluded.run_ref,
        base_commit_sha = excluded.base_commit_sha,
        result_commit_sha = excluded.result_commit_sha,
        result_ref = excluded.result_ref,
        setup_hash = excluded.setup_hash,
        status = excluded.status,
        current_step_index = excluded.current_step_index,
        metrics_json = excluded.metrics_json,
        block_reason = excluded.block_reason,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        session_id = excluded.session_id,
        worker_id = excluded.worker_id,
        hypothesis_id = excluded.hypothesis_id
    `
    ).run(
      run.id,
      run.campaignId,
      run.campaignName,
      run.projectPath,
      run.runRef,
      run.baseCommitSha,
      run.resultCommitSha,
      run.resultRef,
      run.setupHash,
      run.status,
      run.currentStepIndex,
      json(run.metrics),
      run.blockReason,
      run.createdAt,
      run.startedAt,
      run.completedAt,
      at,
      run.sessionId ?? null,
      run.workerId ?? null,
      run.hypothesisId ?? null
    )
  })
}

export async function readWorkflowRun(root: string, id: string) {
  const row = (await openDb(root))
    .query("SELECT * FROM workflow_runs WHERE id = ?")
    .get(id) as Row | null
  return row ? workflowRunFromRow(row) : null
}

export async function readLatestActiveWorkflowRun({
  root,
  campaignName,
  projectPath,
}: {
  root: string
  campaignName: string
  projectPath: string
}) {
  const row = (await openDb(root))
    .query(
      `
        SELECT * FROM workflow_runs
        WHERE campaign_name = ? AND project_path = ?
          AND status IN ('running', 'paused')
        ORDER BY updated_at DESC
        LIMIT 1
      `
    )
    .get(campaignName, projectPath) as Row | null
  return row ? workflowRunFromRow(row) : null
}

export async function listWorkflowRuns(
  root: string,
  selector: WorkflowRunSelector = {}
) {
  if (selector.statuses?.length === 0) return []
  const where: string[] = []
  const values: (string | number | null)[] = []
  const add = (column: string, value: string | undefined) => {
    if (value === undefined) return
    where.push(`${column} = ?`)
    values.push(value)
  }

  add("campaign_name", selector.campaignName)
  add("project_path", selector.projectPath)
  add("session_id", selector.sessionId)
  add("worker_id", selector.workerId)
  add("hypothesis_id", selector.hypothesisId)
  if (selector.statuses && selector.statuses.length > 0) {
    where.push(
      `status IN (${selector.statuses.map(() => "?").join(", ")})`
    )
    values.push(...selector.statuses)
  }

  const rows = (await openDb(root))
    .query(
      `
        SELECT * FROM workflow_runs
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY updated_at DESC
      `
    )
    .all(...values) as Row[]
  return rows.map(workflowRunFromRow)
}

export async function readLatestBlockedWorkflowRun({
  root,
  campaignName,
  projectPath,
}: {
  root: string
  campaignName: string
  projectPath: string
}) {
  const row = (await openDb(root))
    .query(
      `
        SELECT * FROM workflow_runs
        WHERE campaign_name = ? AND project_path = ?
          AND status = 'blocked'
        ORDER BY updated_at DESC
        LIMIT 1
      `
    )
    .get(campaignName, projectPath) as Row | null
  return row ? workflowRunFromRow(row) : null
}

export async function abandonBlockedWorkflowRunsForSession({
  root,
  sessionId,
  workerId = null,
  hypothesisId = null,
  reason,
}: {
  root: string
  sessionId: string
  workerId?: string | null
  hypothesisId?: string | null
  reason: string
}): Promise<string[]> {
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const rows = db
      .query(
        `
        SELECT run_ref AS runRef FROM workflow_runs
        WHERE session_id = ? AND status = 'blocked'
          AND (? IS NULL OR worker_id = ?)
          AND (? IS NULL OR hypothesis_id = ?)
      `
      )
      .all(sessionId, workerId, workerId, hypothesisId, hypothesisId) as Array<{
      runRef: string
    }>
    db.query(
      `
      UPDATE workflow_runs
      SET
        status = 'abandoned',
        block_reason = CASE
          WHEN block_reason IS NULL OR block_reason = '' THEN ?
          ELSE block_reason || '; ' || ?
        END,
        completed_at = COALESCE(completed_at, ?),
        updated_at = ?
      WHERE session_id = ? AND status = 'blocked'
        AND (? IS NULL OR worker_id = ?)
        AND (? IS NULL OR hypothesis_id = ?)
    `
    ).run(
      reason,
      reason,
      at,
      at,
      sessionId,
      workerId,
      workerId,
      hypothesisId,
      hypothesisId
    )
    return rows.map((row) => row.runRef)
  })
}

export async function readLatestWorkflowRun({
  root,
  campaignName,
  projectPath,
}: {
  root: string
  campaignName: string
  projectPath: string
}) {
  const row = (await openDb(root))
    .query(
      `
        SELECT * FROM workflow_runs
        WHERE campaign_name = ? AND project_path = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `
    )
    .get(campaignName, projectPath) as Row | null
  return row ? workflowRunFromRow(row) : null
}

export async function upsertWorkflowStep({
  root,
  step,
}: {
  root: string
  step: LocalWorkflowStep
}) {
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    db.query(
      `
      INSERT INTO workflow_steps (
        run_id, step_id, step_index, kind, tool_id, status, attempt, exit_code,
        timed_out, output_summary, metrics_json, log_path, started_at,
        completed_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, step_id) DO UPDATE SET
        step_index = excluded.step_index,
        kind = excluded.kind,
        tool_id = excluded.tool_id,
        status = excluded.status,
        attempt = excluded.attempt,
        exit_code = excluded.exit_code,
        timed_out = excluded.timed_out,
        output_summary = excluded.output_summary,
        metrics_json = excluded.metrics_json,
        log_path = excluded.log_path,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `
    ).run(
      step.runId,
      step.stepId,
      step.stepIndex,
      step.kind,
      step.toolId,
      step.status,
      step.attempt,
      step.exitCode,
      step.timedOut ? 1 : 0,
      step.outputSummary,
      json(step.metrics),
      step.logPath,
      step.startedAt,
      step.completedAt,
      at
    )
  })
}

export async function listWorkflowSteps(root: string, runId: string) {
  const rows = (await openDb(root))
    .query("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index")
    .all(runId) as Row[]
  return rows.map(workflowStepFromRow)
}

export async function upsertLocalSummary({
  root,
  campaignId,
  sessionId,
  hypothesisId,
  authoredByWorkerId,
  summaryKind,
  title,
  body,
  isCurrent = true,
  metadata = {},
}: {
  root: string
  campaignId: string
  sessionId?: string
  hypothesisId?: string
  authoredByWorkerId?: string
  summaryKind: LocalSummaryKind
  title: string
  body: string
  isCurrent?: boolean
  metadata?: Record<string, unknown>
}) {
  const id = randomUUID()
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      if (isCurrent) {
        db.query(
          `
          UPDATE summaries
          SET is_current = 0, updated_at = ?
          WHERE campaign_id = ? AND summary_kind = ?
            AND COALESCE(session_id, '') = COALESCE(?, '')
            AND COALESCE(hypothesis_id, '') = COALESCE(?, '')
        `
        ).run(
          at,
          campaignId,
          summaryKind,
          sessionId ?? null,
          hypothesisId ?? null
        )
      }
      db.query(
        `
        INSERT INTO summaries (
          id, campaign_id, session_id, hypothesis_id, authored_by_worker_id,
          summary_kind, title, body, is_current, metadata_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        campaignId,
        sessionId ?? null,
        hypothesisId ?? null,
        authoredByWorkerId ?? null,
        summaryKind,
        title,
        body,
        isCurrent ? 1 : 0,
        json(metadata),
        at,
        at
      )
      const summary = summaryFromRow(
        db.query("SELECT * FROM summaries WHERE id = ?").get(id) as Row
      )
      enqueueSyncEvent({
        db,
        type: "summary.upserted",
        entityType: "summary",
        entityId: id,
        payload: { summary, metadata },
      })
      return summary
    })
    return tx()
  })
}

export async function listLocalSummaries(root: string, campaignId: string) {
  const rows = (await openDb(root))
    .query(
      "SELECT * FROM summaries WHERE campaign_id = ? ORDER BY updated_at DESC"
    )
    .all(campaignId) as Row[]
  return rows.map(summaryFromRow)
}

export async function createLocalKnowledge({
  root,
  campaignId,
  sessionId,
  hypothesisId,
  authoredByWorkerId,
  experimentId,
  kind,
  title,
  body,
  confidence,
  metadata = {},
}: {
  root: string
  campaignId: string
  sessionId?: string
  hypothesisId?: string
  authoredByWorkerId?: string
  experimentId?: string
  kind: LocalKnowledgeKind
  title: string
  body: string
  confidence?: number | null
  metadata?: Record<string, unknown>
}) {
  const id = randomUUID()
  const at = nowIso()
  return withResearchDbWrite(root, (db) => {
    const tx = db.transaction(() => {
      db.query(
        `
        INSERT INTO knowledge (
          id, campaign_id, session_id, hypothesis_id, authored_by_worker_id,
          experiment_id, kind, title, body, confidence, metadata_json,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        campaignId,
        sessionId ?? null,
        hypothesisId ?? null,
        authoredByWorkerId ?? null,
        experimentId ?? null,
        kind,
        title,
        body,
        confidence ?? null,
        json(metadata),
        at,
        at
      )
      const knowledge = knowledgeFromRow(
        db.query("SELECT * FROM knowledge WHERE id = ?").get(id) as Row
      )
      enqueueSyncEvent({
        db,
        type: "knowledge.created",
        entityType: "knowledge",
        entityId: id,
        payload: { knowledge },
      })
      return knowledge
    })
    return tx()
  })
}

export async function listLocalKnowledge(root: string, campaignId: string) {
  const rows = (await openDb(root))
    .query(
      "SELECT * FROM knowledge WHERE campaign_id = ? ORDER BY created_at DESC"
    )
    .all(campaignId) as Row[]
  return rows.map(knowledgeFromRow)
}

export async function pendingResearchSyncEvents(root: string, limit = 100) {
  const rows = (await openDb(root))
    .query(
      `
        SELECT * FROM sync_events
        WHERE status = 'pending'
        ORDER BY sequence ASC
        LIMIT ?
      `
    )
    .all(limit) as Row[]
  return rows.map((row) => ({
    eventId: row.event_id as string,
    sequence: Number(row.sequence),
    type: row.type as ResearchSyncEvent["type"],
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    payload: parseJson(row.payload_json, {}),
    status: row.status as ResearchSyncEventStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: nullableString(row.last_error),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }))
}

export async function markResearchSyncAcked({
  root,
  eventId,
  serverStatus,
  serverEntityId,
  details = {},
}: {
  root: string
  eventId: string
  serverStatus: string
  serverEntityId?: string | null
  details?: Record<string, unknown>
}) {
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    db.transaction(() => {
      db.query(
        "UPDATE sync_events SET status = 'acked', updated_at = ?, acked_at = ? WHERE event_id = ?"
      ).run(at, at, eventId)
      db.query(
        `
        INSERT INTO sync_acks (event_id, server_status, server_entity_id, acked_at, details_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          server_status = excluded.server_status,
          server_entity_id = excluded.server_entity_id,
          acked_at = excluded.acked_at,
          details_json = excluded.details_json
      `
      ).run(eventId, serverStatus, serverEntityId ?? null, at, json(details))
    })()
  })
}

export async function applyRemoteTombstones({
  root,
  tombstones,
}: {
  root: string
  tombstones: ApiResearchSyncResponse["tombstones"]
}) {
  await insertLocalTombstones({
    root,
    tombstones: tombstones.map((tombstone) => ({
      entityType: tombstone.entityType,
      entityId: tombstone.entityId,
      campaignId: tombstone.campaignId,
      name: tombstone.name,
      runRef: tombstone.runRef,
      reason: tombstone.reason,
      deletedAt: tombstone.deletedAt,
    })),
  })
}

export async function applyProjectDeletions({
  root,
  deletions,
}: {
  root: string
  deletions: ApiProjectDeletions
}) {
  await insertLocalTombstones({
    root,
    tombstones: [
      ...deletions.campaigns.map((tombstone) => ({
        entityType: "campaign" as const,
        entityId: tombstone.campaignId,
        campaignId: tombstone.campaignId,
        name: tombstone.name,
        runRef: null,
        reason: null,
        deletedAt: tombstone.deletedAt,
      })),
      ...deletions.experiments.map((tombstone) => ({
        entityType: "experiment" as const,
        entityId: tombstone.experimentId,
        campaignId: tombstone.campaignId,
        name: tombstone.campaignName,
        runRef: tombstone.runRef,
        reason: null,
        deletedAt: tombstone.deletedAt,
      })),
    ],
  })
}

async function insertLocalTombstones({
  root,
  tombstones,
}: {
  root: string
  tombstones: LocalTombstoneInput[]
}) {
  if (tombstones.length === 0) return
  await withResearchDbWrite(root, (db) => {
    const insert = db.query(
      `
        INSERT INTO tombstones (
          id, entity_type, entity_id, campaign_id, name, run_ref, reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          campaign_id = excluded.campaign_id,
          name = excluded.name,
          run_ref = excluded.run_ref,
          reason = excluded.reason,
          created_at = excluded.created_at
      `
    )
    db.transaction(() => {
      const affectedHypotheses = new Map<string, Set<string>>()
      const affectedCampaigns = new Set<string>()
      const addAffectedHypothesis = (
        campaignId: string | null | undefined,
        hypothesisId: string | null | undefined
      ) => {
        if (!campaignId || !hypothesisId) return
        const set = affectedHypotheses.get(campaignId) ?? new Set<string>()
        set.add(hypothesisId)
        affectedHypotheses.set(campaignId, set)
      }
      for (const tombstone of tombstones) {
        if (tombstone.campaignId) {
          affectedCampaigns.add(tombstone.campaignId)
        }
        if (tombstone.entityType === "experiment") {
          const experiment = db
            .query(
              "SELECT campaign_id, hypothesis_id FROM experiments WHERE id = ? OR run_ref = ?"
            )
            .get(tombstone.entityId, tombstone.runRef ?? "") as Row | null
          const experimentCampaignId = nullableString(experiment?.campaign_id)
          if (experimentCampaignId) affectedCampaigns.add(experimentCampaignId)
          addAffectedHypothesis(
            experimentCampaignId,
            nullableString(experiment?.hypothesis_id)
          )
        } else if (tombstone.entityType === "campaign") {
          const hypotheses = db
            .query("SELECT id FROM hypotheses WHERE campaign_id = ?")
            .all(tombstone.campaignId) as Row[]
          for (const hypothesis of hypotheses) {
            addAffectedHypothesis(tombstone.campaignId, hypothesis.id as string)
          }
        }
        insert.run(
          `${tombstone.entityType}:${tombstone.entityId}`,
          tombstone.entityType,
          tombstone.entityId,
          tombstone.campaignId,
          tombstone.name,
          tombstone.runRef,
          tombstone.reason,
          tombstone.deletedAt
        )
      }
      const at = nowIso()
      for (const [campaignId, hypothesisIds] of affectedHypotheses) {
        for (const hypothesisId of hypothesisIds) {
          recomputeLocalHypothesisProjectionForDb({
            db,
            campaignId,
            hypothesisId,
            at,
          })
        }
      }
      for (const campaignId of affectedCampaigns) {
        recomputeLocalCampaignProjectionForDb({ db, campaignId, at })
      }
    })()
  })
}

export async function markResearchSyncError({
  root,
  eventIds,
  message,
}: {
  root: string
  eventIds: string[]
  message: string
}) {
  if (eventIds.length === 0) return
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    const update = db.query(
      `
        UPDATE sync_events
        SET attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE event_id = ?
      `
    )
    db.transaction(() => {
      for (const eventId of eventIds) update.run(message, at, eventId)
    })()
  })
}

export async function markResearchSyncConflict({
  root,
  eventId,
  message,
}: {
  root: string
  eventId: string
  message: string
}) {
  await withResearchDbWrite(root, (db) => {
    db.query(
      "UPDATE sync_events SET status = 'conflict', last_error = ?, updated_at = ? WHERE event_id = ?"
    ).run(message, nowIso(), eventId)
  })
}

export async function pendingResearchSyncCount(root: string) {
  const row = (await openDb(root))
    .query("SELECT COUNT(*) AS count FROM sync_events WHERE status = 'pending'")
    .get() as { count: number }
  return Number(row.count ?? 0)
}

export async function oldestPendingResearchSyncAgeMs(root: string) {
  const row = (await openDb(root))
    .query(
      "SELECT MIN(created_at) AS created_at FROM sync_events WHERE status = 'pending'"
    )
    .get() as { created_at?: string | null }
  if (!row?.created_at) return null
  const createdAt = Date.parse(row.created_at)
  if (!Number.isFinite(createdAt)) return null
  return Math.max(0, Date.now() - createdAt)
}

export async function researchSyncConflictCount(root: string) {
  const row = (await openDb(root))
    .query(
      "SELECT COUNT(*) AS count FROM sync_events WHERE status = 'conflict'"
    )
    .get() as { count: number }
  return Number(row.count ?? 0)
}

export async function listResearchSyncConflicts(root: string) {
  const rows = (await openDb(root))
    .query(
      `
        SELECT * FROM sync_events
        WHERE status = 'conflict'
        ORDER BY sequence ASC
      `
    )
    .all() as Row[]
  return rows.map((row) => ({
    eventId: row.event_id as string,
    sequence: Number(row.sequence),
    type: row.type as ResearchSyncEvent["type"],
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    payload: parseJson(row.payload_json, {}),
    status: row.status as ResearchSyncEventStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: nullableString(row.last_error),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }))
}

export async function retryResearchSyncConflicts(root: string) {
  return withResearchDbWrite(root, (db) => {
    const result = db
      .query(
        `
          UPDATE sync_events
          SET status = 'pending', updated_at = ?, last_error = NULL
          WHERE status = 'conflict'
        `
      )
      .run(nowIso())
    return result.changes
  })
}

export async function upsertWorkerLaunch({
  root,
  launch,
}: {
  root: string
  launch: {
    workerId: string
    sessionId: string
    hypothesisId: string
    status: string
    pid?: number | null
    worktree: string
    branchName: string
    promptPath?: string | null
    logPath?: string | null
    activityLogPath?: string | null
    manifestPath?: string | null
    exitCode?: number | null
    signal?: string | null
    timedOut?: boolean
    startupTimedOut?: boolean
    lastOutputAt?: string | null
    finalizationStatus?: string | null
    error?: string | null
    metadata?: Record<string, unknown>
    startedAt: string
    completedAt?: string | null
  }
}) {
  const at = nowIso()
  await withResearchDbWrite(root, (db) => {
    db.query(
      `
        INSERT INTO worker_launches (
          worker_id, session_id, hypothesis_id, status, pid, worktree,
          branch_name, prompt_path, log_path, activity_log_path, manifest_path,
          exit_code, signal, timed_out, startup_timed_out, last_output_at,
          finalization_status, error, metadata_json, started_at, completed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET
          session_id = excluded.session_id,
          hypothesis_id = excluded.hypothesis_id,
          status = excluded.status,
          pid = excluded.pid,
          worktree = excluded.worktree,
          branch_name = excluded.branch_name,
          prompt_path = excluded.prompt_path,
          log_path = excluded.log_path,
          activity_log_path = excluded.activity_log_path,
          manifest_path = excluded.manifest_path,
          exit_code = excluded.exit_code,
          signal = excluded.signal,
          timed_out = excluded.timed_out,
          startup_timed_out = excluded.startup_timed_out,
          last_output_at = excluded.last_output_at,
          finalization_status = excluded.finalization_status,
          error = excluded.error,
          metadata_json = excluded.metadata_json,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `
    ).run(
      launch.workerId,
      launch.sessionId,
      launch.hypothesisId,
      launch.status,
      launch.pid ?? null,
      launch.worktree,
      launch.branchName,
      launch.promptPath ?? null,
      launch.logPath ?? null,
      launch.activityLogPath ?? null,
      launch.manifestPath ?? null,
      launch.exitCode ?? null,
      launch.signal ?? null,
      launch.timedOut ? 1 : 0,
      launch.startupTimedOut ? 1 : 0,
      launch.lastOutputAt ?? null,
      launch.finalizationStatus ?? null,
      launch.error ?? null,
      json(launch.metadata ?? {}),
      launch.startedAt,
      launch.completedAt ?? null,
      at
    )
  })
}

export async function researchSyncStatus(root: string) {
  const db = await openDb(root)
  const rows = db
    .query(
      `
        SELECT status, COUNT(*) AS count
        FROM sync_events
        GROUP BY status
      `
    )
    .all() as Array<{ status: string; count: number }>
  const counts = Object.fromEntries(
    rows.map((row) => [row.status, Number(row.count)])
  )
  const version = db
    .query("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | null
  return {
    schemaVersion: Number(version?.version ?? 0),
    pending: counts.pending ?? 0,
    acked: counts.acked ?? 0,
    duplicate: counts.duplicate ?? 0,
    conflict: counts.conflict ?? 0,
    invalid: counts.invalid ?? 0,
  }
}

export async function researchDbDoctor(root: string) {
  const db = await openDb(root)
  const integrity = db.query("PRAGMA integrity_check").get() as
    | { integrity_check: string }
    | undefined
  const status = await researchSyncStatus(root)
  db.query("PRAGMA wal_checkpoint(TRUNCATE)").all()
  return {
    ok: integrity?.integrity_check === "ok",
    integrity: integrity?.integrity_check ?? "unknown",
    ...status,
  }
}

export async function acquireLocalResourceLease({
  root,
  resourceName,
  slots,
  ownerId,
  timeoutMs,
  leaseMs,
  metadata = {},
}: {
  root: string
  resourceName: string
  slots: number
  ownerId: string
  timeoutMs: number
  leaseMs: number
  metadata?: Record<string, unknown>
}) {
  const db = await openDb(root)
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const at = nowIso()
    const expiresAt = new Date(Date.now() + leaseMs).toISOString()
    const acquired = db.transaction(() => {
      db.query(
        "DELETE FROM resource_leases WHERE resource_name = ? AND expires_at <= ?"
      ).run(resourceName, at)
      for (let slot = 1; slot <= slots; slot += 1) {
        try {
          db.query(
            `
              INSERT INTO resource_leases (
                resource_name, slot, owner_id, acquired_at, expires_at, metadata_json
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `
          ).run(resourceName, slot, ownerId, at, expiresAt, json(metadata))
          return slot
        } catch {
          // Slot is held.
        }
      }
      return null
    })()
    if (acquired !== null) {
      return async () => {
        const releaseDb = await openDb(root)
        releaseDb
          .query(
            "DELETE FROM resource_leases WHERE resource_name = ? AND slot = ? AND owner_id = ?"
          )
          .run(resourceName, acquired, ownerId)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for tool resource ${resourceName}`)
}

export async function renewLocalResourceLease({
  root,
  resourceName,
  ownerId,
  leaseMs,
}: {
  root: string
  resourceName: string
  ownerId: string
  leaseMs: number
}) {
  const expiresAt = new Date(Date.now() + leaseMs).toISOString()
  const result = (await openDb(root))
    .query(
      `
        UPDATE resource_leases
        SET expires_at = ?
        WHERE resource_name = ? AND owner_id = ?
      `
    )
    .run(expiresAt, resourceName, ownerId)
  return result.changes
}

export async function cleanupExpiredResourceLeases(root: string) {
  const result = (await openDb(root))
    .query("DELETE FROM resource_leases WHERE expires_at <= ?")
    .run(nowIso())
  return result.changes
}

export async function listLocalResourceLeases(root: string) {
  await cleanupExpiredResourceLeases(root)
  const rows = (await openDb(root))
    .query("SELECT * FROM resource_leases ORDER BY resource_name, slot")
    .all() as Row[]
  return rows.map((row) => ({
    resourceName: row.resource_name as string,
    slot: Number(row.slot),
    ownerId: row.owner_id as string,
    acquiredAt: row.acquired_at as string,
    expiresAt: row.expires_at as string,
    metadata: parseJson(row.metadata_json, {}),
  }))
}

export async function localBriefMarkdown({
  root,
  campaignId,
  sessionId,
  hypothesisId,
}: {
  root: string
  campaignId: string
  sessionId?: string
  hypothesisId?: string
}) {
  const brief = await localResearchBrief({
    root,
    campaignId,
    sessionId,
    hypothesisId,
  })
  return brief.markdown
}

export type LocalResearchBrief = {
  campaign: ApiCampaign
  session: ApiSession | null
  currentHypothesis: ApiHypothesis | null
  bestExperiment: ApiCampaignExperiment | null
  recentExperiments: ApiCampaignExperiment[]
  hypotheses: ApiHypothesis[]
  workers: ApiWorker[]
  summaries: ApiSummary[]
  knowledge: ApiKnowledge[]
  updatedAt: string
  markdown: string
}

function renderLocalResearchBrief({
  campaign,
  session,
  currentHypothesis,
  bestExperiment,
  recentExperiments,
  hypotheses,
  workers,
  summaries,
  knowledge,
}: Omit<LocalResearchBrief, "markdown" | "updatedAt">) {
  const lines = [
    `# Onyx Research Brief: ${campaign.name}`,
    "",
    `Goal: ${campaign.description ?? "Not specified"}`,
    `Metric: ${campaign.metricName}${campaign.metricUnit ? ` (${campaign.metricUnit})` : ""}, ${campaign.metricDirection}`,
    `Base commit: ${campaign.baseCommitSha}`,
    session ? `Session: ${session.id} (${session.status})` : null,
    currentHypothesis ? `Hypothesis: ${currentHypothesis.name}` : null,
    currentHypothesis ? `Focus: ${currentHypothesis.plan.focus}` : null,
    currentHypothesis ? `Statement: ${currentHypothesis.plan.statement}` : null,
  ].filter((line) => line !== null)

  lines.push("", "## Best Result")
  lines.push(
    bestExperiment
      ? `${bestExperiment.name}: ${bestExperiment.primaryMetricName}=${bestExperiment.primaryMetricValue ?? "null"} (${bestExperiment.status}) ${bestExperiment.resultCommitSha.slice(0, 7)}`
      : "- none yet"
  )

  lines.push("", "## Recent Experiments")
  if (recentExperiments.length === 0) {
    lines.push("- none yet")
  } else {
    lines.push(
      ...recentExperiments
        .slice(0, 10)
        .map(
          (experiment) =>
            `- ${experiment.name}: ${experiment.primaryMetricName}=${experiment.primaryMetricValue ?? "null"} (${experiment.status}) ${experiment.resultCommitSha.slice(0, 7)}`
        )
    )
  }

  lines.push("", "## Current Summaries")
  const currentSummaries = summaries
    .filter((summary) => summary.isCurrent)
    .slice(0, 10)
  if (currentSummaries.length === 0) {
    lines.push("- none yet")
  } else {
    lines.push(
      ...currentSummaries.map(
        (summary) =>
          `- ${summary.summaryKind}: ${summary.title}\n${summary.body}`
      )
    )
  }

  lines.push("", "## Shared Knowledge")
  if (knowledge.length === 0) {
    lines.push("- none yet")
  } else {
    lines.push(
      ...knowledge
        .slice(0, 20)
        .map(
          (item) => `- ${item.kind}: ${item.title} - ${item.body.slice(0, 240)}`
        )
    )
  }

  lines.push("", "## Hypotheses")
  if (hypotheses.length === 0) {
    lines.push("- none yet")
  } else {
    lines.push(
      ...hypotheses.map(
        (hypothesis) =>
          `- ${hypothesis.name}: ${hypothesis.status}, base ${hypothesis.baseCommitSha}${hypothesis.lastWorkedAt ? `, last worked ${hypothesis.lastWorkedAt}` : ""}\n  Focus: ${hypothesis.plan.focus}\n  Statement: ${hypothesis.plan.statement}`
      )
    )
  }

  lines.push("", "## Workers")
  if (workers.length === 0) {
    lines.push("- none yet")
  } else {
    lines.push(
      ...workers.map(
        (worker) =>
          `- ${worker.workerName}: ${worker.status}${worker.hypothesisId ? ` on hypothesis ${worker.hypothesisId}` : ""}${worker.progressMessage ? ` - ${worker.progressMessage}` : ""}`
      )
    )
  }

  return lines.join("\n")
}

export async function localResearchBrief({
  root,
  campaignId,
  sessionId,
  hypothesisId,
}: {
  root: string
  campaignId: string
  sessionId?: string
  hypothesisId?: string
}): Promise<LocalResearchBrief> {
  const db = await openDb(root)
  const campaignRow = db
    .query("SELECT * FROM campaigns WHERE id = ?")
    .get(campaignId) as Row | null
  if (!campaignRow) throw new Error("Local campaign not found")
  const visibleExperiments = listLocalExperimentsForDb(db, campaignId)
  let session: ApiSession | null = null
  let campaign: ApiCampaign = campaignWithVisibleProjection(
    campaignFromRow(campaignRow),
    visibleExperiments
  )
  let recentExperiments = visibleExperiments.slice(0, 20)
  let bestExperiment = bestVisibleExperimentForCampaign(
    campaign,
    visibleExperiments
  )
  let hypotheses = (
    db
      .query(
        "SELECT * FROM hypotheses WHERE campaign_id = ? ORDER BY created_at ASC"
      )
      .all(campaignId) as Row[]
  ).map(hypothesisFromRow)
  let workers = (
    db
      .query(
        "SELECT * FROM workers WHERE campaign_id = ? ORDER BY last_seen_at DESC"
      )
      .all(campaignId) as Row[]
  ).map(workerFromRow)
  let summaries = await listLocalSummaries(root, campaignId)
  let knowledge = await listLocalKnowledge(root, campaignId)

  if (sessionId) {
    const state = await getLocalSessionState(root, sessionId)
    if (state.campaign.id !== campaignId) {
      throw new Error(
        `Local research session ${sessionId} belongs to campaign ${state.campaign.name}, not ${campaign.name}`
      )
    }
    session = state.session
    campaign = state.campaign
    recentExperiments = state.latestExperiments
    bestExperiment = state.bestExperiment
    hypotheses = state.hypotheses
    workers = state.workers
    summaries = state.summaries
    knowledge = state.knowledge
  }

  const currentHypothesis = hypothesisId
    ? (hypotheses.find((item) => item.id === hypothesisId) ?? null)
    : null
  if (hypothesisId && !currentHypothesis) {
    throw new Error(
      `Local hypothesis ${hypothesisId} was not found for campaign ${campaign.name}`
    )
  }

  const brief = {
    campaign,
    session,
    currentHypothesis,
    bestExperiment,
    recentExperiments,
    hypotheses,
    workers,
    summaries,
    knowledge,
    updatedAt: nowIso(),
    markdown: "",
  }
  brief.markdown = renderLocalResearchBrief(brief)
  return brief
}

export async function campaignRecordToLocal(
  root: string,
  record: LocalResearchCampaignStartedRecord
) {
  return createLocalCampaign({
    root,
    name: record.name,
    description: record.description ?? null,
    projectPath: record.projectPath ?? "",
    baseCommitSha: record.baseCommitSha,
    setup: record.setup,
    metricName: record.metricName,
    metricUnit: record.metricUnit ?? null,
    metricDirection: record.metricDirection,
    humanFeedback: record.humanFeedback ?? null,
    promotionRefName: record.promotionRefName ?? null,
  })
}

export async function createCampaignFromSetup({
  root,
  name,
  description,
  projectPath,
  setup,
  humanFeedback,
  promotionRefName,
}: {
  root: string
  name: string
  description?: string | null
  projectPath: string
  setup: ResearchSetupFile
  humanFeedback?: string | null
  promotionRefName?: string | null
}) {
  return createLocalCampaign({
    root,
    name,
    description,
    projectPath,
    baseCommitSha: await currentCommit(root),
    setup,
    metricName: setup.metric.name,
    metricUnit: setup.metric.unit,
    metricDirection: setup.metric.direction,
    humanFeedback,
    promotionRefName,
  })
}
