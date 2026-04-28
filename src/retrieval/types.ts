// src/retrieval/types.ts
export type SourceType =
  | 'entries' | 'sessions' | 'session_messages'
  | 'code' | 'pr' | 'wiki' | 'work_item' | 'review';

export interface KnowledgeChunk {
  source_type: SourceType;
  source_id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalFilters {
  project_id: string;
  agent_token_id?: string;
  categories?: string[];
  /**
   * Allow-list of `entries.status` values. Defaults to ['active'] if omitted.
   * Set to broader values (e.g. ['active','completed','archived']) when the
   * retrieval case wants historical / completed work.
   */
  statuses?: Array<'active' | 'completed' | 'archived'>;
  date_from?: string;
  date_to?: string;
}

export interface KnowledgeSource {
  readonly type: SourceType;
  search(query: string, filters: RetrievalFilters, limit: number): Promise<KnowledgeChunk[]>;
}
