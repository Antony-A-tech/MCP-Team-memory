/**
 * Centralized configuration from environment variables
 */

export interface AppConfig {
  databaseUrl: string;
  transport: 'http' | 'stdio';
  port: number;
  autoArchiveEnabled: boolean;
  autoArchiveDays: number;
  apiToken: string | undefined;
  logLevel: string;
  // Decay config — undefined means use old time-based archival
  decayThreshold: number | undefined;
  decayDays: number;
  decayWeights: [number, number, number, number];
  // FTS config
  ftsLanguage: string;  // PostgreSQL text search config: 'simple', 'russian', 'english', etc.
  // Embedding config (Ollama only)
  ollamaUrl: string;
  ollamaEmbeddingModel: string;
  ollamaLlmModel: string;
  // Qdrant / Vector Store
  vectorStore: 'qdrant' | 'pgvector';
  qdrantUrl: string;
  qdrantApiKey: string | undefined;
  // RAG chat config
  geminiApiKey: string | undefined;
  geminiModel: string;
  ragMaxIterations: number;
  ragToolResponseMaxChars: number;
  // Gemini pricing per 1M tokens, USD — used to attribute chat cost to each agent
  geminiInputUsdPerMtok: number;
  geminiOutputUsdPerMtok: number;
  allowReadonly: boolean;
  // === v4.5 Auto-notes extraction ===
  extractNotesEnabled: boolean;
  extractLlmProvider: 'gemini' | 'ollama';
  extractMinConfidence: number;
  // Events extractor (v5) — separate threshold because event-mentions in
  // routine sessions yield lower confidence than WHY-facts. See
  // scope-note 0593646d for the calibration story.
  eventsMinConfidence: number;
  extractMinMarkerStrength: number;
  extractMinFactLen: number;
  extractMaxFactLen: number;
  extractMaxNotesPerSession: number;
  extractMaxMergesPerSession: number;
  // Dedup thresholds (cosine similarity)
  dedupConfirmThreshold: number;
  dedupMergeThreshold: number;
  // Singleton-auto-record decay
  autoDecayDays: number;
  // Importance score recompute job
  importanceRecomputeIntervalHours: number;
}

/** Parse float with fallback to default on NaN */
export function parseFloatSafe(value: string, defaultValue: number): number {
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/** Parse integer with fallback to default on NaN */
export function parseIntSafe(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}


export function loadConfig(): AppConfig {
  const decayWeightsRaw = process.env.MEMORY_DECAY_WEIGHTS || '0.3,0.2,0.3,0.2';
  const decayWeights = decayWeightsRaw.split(',').map(Number) as [number, number, number, number];

  return {
    databaseUrl: process.env.DATABASE_URL || 'postgresql://memory:memory@localhost:5432/team_memory',
    transport: (process.env.MEMORY_TRANSPORT as 'http' | 'stdio') || 'http',
    port: parseIntSafe(process.env.MEMORY_PORT || '3846', 3846),
    autoArchiveEnabled: process.env.MEMORY_AUTO_ARCHIVE !== 'false',
    autoArchiveDays: parseIntSafe(process.env.MEMORY_AUTO_ARCHIVE_DAYS || '14', 14),
    apiToken: process.env.MEMORY_API_TOKEN || undefined,
    logLevel: process.env.LOG_LEVEL || 'info',
    decayThreshold: process.env.MEMORY_DECAY_THRESHOLD
      ? parseFloat(process.env.MEMORY_DECAY_THRESHOLD)
      : undefined,
    decayDays: parseIntSafe(process.env.MEMORY_DECAY_DAYS || '30', 30),
    decayWeights,
    ftsLanguage: process.env.MEMORY_FTS_LANGUAGE || 'simple',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text-v2-moe',
    ollamaLlmModel: process.env.OLLAMA_LLM_MODEL || 'qwen3.5:4b',
    vectorStore: (process.env.VECTOR_STORE as 'qdrant' | 'pgvector') || 'pgvector',
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY || undefined,
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    ragMaxIterations: parseIntSafe(process.env.RAG_MAX_ITERATIONS || '5', 5),
    ragToolResponseMaxChars: parseIntSafe(process.env.RAG_TOOL_RESPONSE_MAX_CHARS || '20000', 20_000),
    // Gemini 2.5 Flash pricing (Apr 2026): $0.30 / 1M input, $2.50 / 1M output.
    // Override via env if model or pricing changes.
    geminiInputUsdPerMtok: parseFloatSafe(process.env.GEMINI_INPUT_USD_PER_MTOK || '0.30', 0.30),
    geminiOutputUsdPerMtok: parseFloatSafe(process.env.GEMINI_OUTPUT_USD_PER_MTOK || '2.50', 2.50),
    allowReadonly: process.env.MEMORY_ALLOW_READONLY === 'true',
    // v4.5 Auto-notes extraction (defaults match the spec).
    extractNotesEnabled: process.env.EXTRACT_NOTES_ENABLED !== 'false',
    extractLlmProvider:
      (process.env.EXTRACT_LLM_PROVIDER as 'gemini' | 'ollama') ?? 'gemini',
    extractMinConfidence: parseFloatSafe(process.env.EXTRACT_MIN_CONFIDENCE || '0.6', 0.6),
    // 0.55 default — calibrated against the 1000-session backfill of
    // 0593646d. EVENTS_MIN_CONFIDENCE env override available.
    eventsMinConfidence: parseFloatSafe(process.env.EVENTS_MIN_CONFIDENCE || '0.55', 0.55),
    extractMinMarkerStrength: parseFloatSafe(
      process.env.EXTRACT_MIN_MARKER_STRENGTH || '0.3',
      0.3,
    ),
    extractMinFactLen: parseIntSafe(process.env.EXTRACT_MIN_FACT_LEN || '30', 30),
    extractMaxFactLen: parseIntSafe(process.env.EXTRACT_MAX_FACT_LEN || '500', 500),
    extractMaxNotesPerSession: parseIntSafe(
      process.env.EXTRACT_MAX_NOTES_PER_SESSION || '5',
      5,
    ),
    extractMaxMergesPerSession: parseIntSafe(
      process.env.EXTRACT_MAX_MERGES_PER_SESSION || '3',
      3,
    ),
    dedupConfirmThreshold: parseFloatSafe(
      process.env.DEDUP_CONFIRM_THRESHOLD || '0.85',
      0.85,
    ),
    dedupMergeThreshold: parseFloatSafe(process.env.DEDUP_MERGE_THRESHOLD || '0.7', 0.7),
    autoDecayDays: parseIntSafe(process.env.AUTO_DECAY_DAYS || '30', 30),
    importanceRecomputeIntervalHours: parseIntSafe(
      process.env.IMPORTANCE_RECOMPUTE_INTERVAL_HOURS || '24',
      24,
    ),
  };
}
