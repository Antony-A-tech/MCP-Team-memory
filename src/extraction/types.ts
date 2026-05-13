// src/extraction/types.ts
import type { Category } from '../memory/types.js';

// v5: extractor produces 'knowledge' rows — the architecture/decision/convention
// distinction lives in tags.
export type AutoCategory = Extract<Category, 'knowledge'>;
export const AUTO_CATEGORIES: AutoCategory[] = ['knowledge'];

// Knowledge kind — encoded as a tag on the resulting knowledge entry.
// Useful for the prompt and for downstream grouping in onboard.
export type KnowledgeKind = 'architecture' | 'decision' | 'convention';
export const KNOWLEDGE_KINDS: KnowledgeKind[] = ['architecture', 'decision', 'convention'];

export interface CandidateNote {
  category: AutoCategory;
  title: string;
  fact: string;
  why: string;
  tags: string[];
  confidence: number;             // 0..1, from LLM
  explicit_marker_strength: number; // 0..1, from LLM
}

export interface EvidenceSource {
  type: 'session' | 'personal_note' | 'pr' | 'wiki' | 'code_review' | 'work_item';
  id: string;
  agent_token_id?: string;     // for session/personal_note
  shared_by?: string;          // public-safe alias for personal_note id-owner
  confirmed_at: string;        // ISO
}

export interface ExtractionResult {
  candidates: CandidateNote[];   // already filtered & capped to <=5
  rejected: Array<{ candidate: CandidateNote; reason: string }>;
  llm_input_chars: number;
  llm_output_chars: number;
}

export type DedupAction =
  | { type: 'CREATE_NEW'; candidate: CandidateNote }
  | { type: 'CONFIRM'; entry_id: string; candidate: CandidateNote; score: number }
  | { type: 'MERGE'; entry_id: string; candidate: CandidateNote; score: number };

export interface DedupResult {
  decisions: DedupAction[];
}
