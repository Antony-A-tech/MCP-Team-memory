import { describe, it, expect } from 'vitest';
import { computeImportanceScore } from '../memory/importance.js';

const FIXED_NOW = new Date('2026-04-28T00:00:00Z');

describe('computeImportanceScore', () => {
  it('zero confirmations + no marker + no authors → 0.05 (recency only, score=0.3*1)', () => {
    const score = computeImportanceScore({
      confirmationCount: 0,
      lastConfirmedAt: FIXED_NOW.toISOString(),
      explicitMarkerStrength: null,
      uniqueAuthors: 0,
    }, FIXED_NOW);
    // 0.4*0 + 0.3*exp(0/60)=0.3 + 0.2*0.5 (default) + 0.1*0 = 0.4
    expect(score).toBeCloseTo(0.4, 3);
  });

  it('5 confirmations cap at 1.0; recent; strong marker; 3 authors → 1.0', () => {
    const score = computeImportanceScore({
      confirmationCount: 5,
      lastConfirmedAt: FIXED_NOW.toISOString(),
      explicitMarkerStrength: 1.0,
      uniqueAuthors: 3,
    }, FIXED_NOW);
    // 0.4*1 + 0.3*1 + 0.2*1 + 0.1*1 = 1.0
    expect(score).toBeCloseTo(1.0, 3);
  });

  it('7 confirmations clamped to 1.0', () => {
    const score = computeImportanceScore({
      confirmationCount: 7,
      lastConfirmedAt: FIXED_NOW.toISOString(),
      explicitMarkerStrength: 1.0,
      uniqueAuthors: 5,
    }, FIXED_NOW);
    expect(score).toBeCloseTo(1.0, 3);
  });

  it('60 days since confirmation → recency ~ 1/e', () => {
    const past = new Date(FIXED_NOW.getTime() - 60 * 86400_000);
    const score = computeImportanceScore({
      confirmationCount: 0,
      lastConfirmedAt: past.toISOString(),
      explicitMarkerStrength: 0,
      uniqueAuthors: 0,
    }, FIXED_NOW);
    // 0 + 0.3 * exp(-1) + 0 + 0 ≈ 0.110
    expect(score).toBeCloseTo(0.3 / Math.E, 3);
  });

  it('null lastConfirmedAt treated as 0 days', () => {
    const score = computeImportanceScore({
      confirmationCount: 0,
      lastConfirmedAt: null,
      explicitMarkerStrength: 0,
      uniqueAuthors: 0,
    }, FIXED_NOW);
    expect(score).toBeCloseTo(0.3, 3);
  });
});
