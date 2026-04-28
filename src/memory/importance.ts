export interface ImportanceInput {
  confirmationCount: number;
  lastConfirmedAt: string | null;
  explicitMarkerStrength: number | null;  // null → default 0.5
  uniqueAuthors: number;
}

export function computeImportanceScore(input: ImportanceInput, now: Date = new Date()): number {
  const confirmationsTerm = Math.min(input.confirmationCount / 5, 1.0);
  const days = input.lastConfirmedAt
    ? Math.max(0, (now.getTime() - new Date(input.lastConfirmedAt).getTime()) / 86400_000)
    : 0;
  const recencyTerm = Math.exp(-days / 60);
  const markerTerm = input.explicitMarkerStrength ?? 0.5;
  const authorsTerm = Math.min(input.uniqueAuthors / 3, 1.0);

  return 0.4 * confirmationsTerm
       + 0.3 * recencyTerm
       + 0.2 * markerTerm
       + 0.1 * authorsTerm;
}

export function uniqueAuthorsFromEvidence(
  evidence: Array<{ agent_token_id?: string; shared_by?: string }>,
): number {
  const ids = new Set<string>();
  for (const e of evidence) {
    const id = e.agent_token_id ?? e.shared_by;
    if (id) ids.add(id);
  }
  return ids.size;
}
