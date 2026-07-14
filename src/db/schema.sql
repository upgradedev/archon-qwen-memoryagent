-- ═════════════════════════════════════════════════════════════════════════════
-- Archon MemoryAgent — pgvector schema
--
-- Ported from the Archon PostgreSQL schema (pg-wire) and extended with the piece
-- that makes this a MemoryAgent-track entry: a pgvector memory index so the
-- agent RECALLS prior financial facts by MEANING across sessions, not just by key.
--
-- vector(1024) matches Qwen text-embedding-v4's default output dimension — keep
-- the two in lockstep. Runs identically on local pgvector docker, CI, and
-- Alibaba Cloud AnalyticDB for PostgreSQL / ApsaraDB RDS for PostgreSQL.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────────────────────────────
-- Finance domain tables (ported 1:1 from the Archon PostgreSQL schema) — kept
-- for provenance and as the structured counterpart to the semantic memory.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id        TEXT NOT NULL,
    period           TEXT NOT NULL,
    source_file      TEXT NOT NULL,
    doc_type         TEXT NOT NULL,
    detected_lang    TEXT,
    total_amount     DECIMAL(14,2) NOT NULL,
    confidence       DECIMAL(4,3),
    extraction_model TEXT,
    created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_period ON documents (period);

CREATE TABLE IF NOT EXISTS payroll_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period              TEXT NOT NULL,
    company_name        TEXT,
    net_total           DECIMAL(12,2),
    gross_total         DECIMAL(12,2),
    employer_cost_total DECIMAL(12,2),
    employee_count      INT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE (period, company_name)
);

CREATE TABLE IF NOT EXISTS validation_results (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period       TEXT NOT NULL,
    rule         TEXT NOT NULL,
    passed       BOOLEAN NOT NULL,
    severity     TEXT NOT NULL,
    message      TEXT,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- Shared Qwen-heavy request quotas. PostgreSQL makes the increment/check atomic across
-- every API replica; rows are naturally partitionable/cleanable by quota_day.
CREATE TABLE IF NOT EXISTS api_daily_quota (
    quota_day DATE NOT NULL,
    bucket    VARCHAR(64) NOT NULL,
    subject   VARCHAR(128) NOT NULL,
    count     INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (quota_day, bucket, subject)
);
CREATE INDEX IF NOT EXISTS idx_api_daily_quota_day ON api_daily_quota (quota_day);

-- ═════════════════════════════════════════════════════════════════════════════
-- AGENT MEMORY  ← the persistent, cross-session memory layer (pgvector)
--
-- Every durable fact the agent learns — an extracted document, a fused payroll
-- event, a validation finding, a narrated insight — is written here as a
-- natural-language "memory" plus its Qwen embedding. The agent RECALLS by
-- semantic similarity (cosine) over the HNSW vector index, giving the pipeline a
-- persistent, queryable memory instead of a stateless per-request run.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_memory (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Security boundary. HTTP principals are mapped to this server-side; callers
    -- cannot select another tenant with a body/query parameter.
    tenant_id     TEXT NOT NULL DEFAULT '_public',
    -- Scope / retrieval filters (exact-match, via the btree indexes below).
    kind          TEXT NOT NULL,            -- document | payroll_event | validation | insight
    company       TEXT NOT NULL DEFAULT '_global',
    period        TEXT,
    source_ref    TEXT,
    -- The recallable content.
    content       TEXT NOT NULL,            -- natural-language statement of the fact
    metadata      JSONB,                    -- structured payload (amounts, doc_type, …)
    embedding     VECTOR(1024) NOT NULL,    -- Qwen text-embedding-v4 embedding of `content`
    embed_model   TEXT NOT NULL,
    -- Producer-supplied retry key. Null for ordinary facts; event pipeline writes
    -- use stable keys so a retried request returns the existing rows.
    idempotency_key TEXT,
    -- Memory lifecycle (consolidation / forgetting).
    importance    REAL NOT NULL DEFAULT 0.5,   -- 0..1 salience, low + old = forgettable
    superseded_at TIMESTAMPTZ,                 -- non-null → consolidated away (a duplicate/stale)
    superseded_by UUID,                        -- the memory that replaced this one
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- Additive migration for databases created before the lifecycle columns existed
-- (e.g. the live deployment). Idempotent — safe to re-run the whole schema.
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS importance    REAL NOT NULL DEFAULT 0.5;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS superseded_by UUID;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '_public';
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- HNSW cosine index — no training step, built incrementally as rows are inserted.
-- `ORDER BY embedding <=> $q LIMIT k` is index-accelerated for semantic recall.
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
    ON agent_memory USING hnsw (embedding vector_cosine_ops);

-- Full-text index for the LEXICAL half of hybrid retrieval (BM25-style ts_rank).
-- Dense recall blurs exact tokens (ids, euro figures, company names); FTS keeps
-- them, and the store fuses the two rankings with Reciprocal Rank Fusion.
CREATE INDEX IF NOT EXISTS idx_agent_memory_content_fts
    ON agent_memory USING gin (to_tsvector('simple', content));

-- Conventional secondary indexes for exact-match filtering / housekeeping.
CREATE INDEX IF NOT EXISTS idx_agent_memory_kind ON agent_memory (kind);
CREATE INDEX IF NOT EXISTS idx_agent_memory_company ON agent_memory (company);
CREATE INDEX IF NOT EXISTS idx_agent_memory_tenant_company ON agent_memory (tenant_id, company);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source_ref ON agent_memory (source_ref);
CREATE INDEX IF NOT EXISTS idx_agent_memory_period ON agent_memory (period);
-- Recall skips superseded memories; this partial index keeps that filter cheap.
CREATE INDEX IF NOT EXISTS idx_agent_memory_active
    ON agent_memory (tenant_id, company) WHERE superseded_at IS NULL;

-- A null key deliberately permits distinct memories about the same source. Only
-- producer operations that opt into retry safety participate in this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_idempotency
    ON agent_memory (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Durable, idempotent human feedback provenance. The JSON result preserves the
-- before/after state returned to the reviewer and makes retries deterministic.
CREATE TABLE IF NOT EXISTS memory_feedback (
    tenant_id     TEXT NOT NULL,
    feedback_id   VARCHAR(128) NOT NULL,
    request_hash  CHAR(64) NOT NULL,
    memory_id     UUID NOT NULL,
    outcome       TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect')),
    correction_id UUID,
    result        JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, feedback_id)
);
-- Additive migration for feedback rows created by the earlier schema. Legacy
-- null fingerprints fail closed on retry instead of being treated as a match.
ALTER TABLE memory_feedback ADD COLUMN IF NOT EXISTS request_hash CHAR(64);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory
    ON memory_feedback (tenant_id, memory_id);
