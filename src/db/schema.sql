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
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- HNSW cosine index — no training step, built incrementally as rows are inserted.
-- `ORDER BY embedding <=> $q LIMIT k` is index-accelerated for semantic recall.
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
    ON agent_memory USING hnsw (embedding vector_cosine_ops);

-- Conventional secondary indexes for exact-match filtering / housekeeping.
CREATE INDEX IF NOT EXISTS idx_agent_memory_kind ON agent_memory (kind);
CREATE INDEX IF NOT EXISTS idx_agent_memory_company ON agent_memory (company);
CREATE INDEX IF NOT EXISTS idx_agent_memory_source_ref ON agent_memory (source_ref);
CREATE INDEX IF NOT EXISTS idx_agent_memory_period ON agent_memory (period);
