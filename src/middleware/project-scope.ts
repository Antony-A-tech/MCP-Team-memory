import type { Request, Response } from 'express';

/**
 * Enforce that a request's target project matches the caller's token scope.
 *
 * The scope is set by the auth middleware from the `X-Project-Id` header.
 * Master tokens (scope includes 'admin') bypass the check. Tokens without
 * a scope (no header) also bypass — there's nothing to enforce.
 *
 * Returns `true` when the request may proceed; returns `false` after sending
 * a 403 response when the caller is trying to access a project outside its
 * scope.
 *
 * Use at the top of any handler that accepts an explicit project_id parameter
 * from query/body/path — it's defence-in-depth on top of the auth middleware.
 *
 * Phase 0.E of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.
 */
export function enforceProjectScope(
  req: Request,
  res: Response,
  targetProjectId: string | undefined | null,
): boolean {
  const auth = (req as any).auth as { projectId?: string; scopes?: string[] } | undefined;
  // Master/admin bypass — full cross-project access by design.
  if (auth?.scopes?.includes('admin')) return true;
  const tokenScope = auth?.projectId;
  // No scope on token → nothing to enforce. Calling this helper without a
  // bound scope is intentional: it keeps callsite code uniform.
  if (!tokenScope) return true;
  // No explicit target → handler will fall back to scope; that's fine.
  if (!targetProjectId) return true;
  if (tokenScope !== targetProjectId) {
    res.status(403).json({
      success: false,
      error: `Project scope mismatch: token is scoped to ${tokenScope}, request targets ${targetProjectId}`,
    });
    return false;
  }
  return true;
}
