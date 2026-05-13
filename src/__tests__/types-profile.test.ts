import { describe, it, expect } from 'vitest';
import { CATEGORY_INFO, type Category } from '../memory/types.js';

describe('Category union includes profile', () => {
  it('Category union accepts profile', () => {
    const c: Category = 'profile';
    expect(c).toBe('profile');
  });

  it('CATEGORY_INFO has profile entry', () => {
    expect(CATEGORY_INFO.profile).toBeDefined();
    expect(CATEGORY_INFO.profile.icon).toBe('🗺️');
    expect(CATEGORY_INFO.profile.name).toBe('Профиль');
  });
});
