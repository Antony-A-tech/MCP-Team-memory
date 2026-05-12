// src/extraction/types.ts
import type { Category } from '../memory/types.js';

export type AutoCategory = Extract<Category, 'architecture' | 'decisions' | 'conventions'>;
export const AUTO_CATEGORIES: AutoCategory[] = ['architecture', 'decisions', 'conventions'];

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
