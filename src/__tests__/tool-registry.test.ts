import { describe, it, expect } from 'vitest';
import { TOOL_DECLARATIONS, TOOL_HANDLERS, getDeclaration } from '../rag/tool-registry.js';

describe('tool-registry', () => {
  const expectedTools = [
    'memory_onboard', 'memory_read', 'memory_cross_search', 'memory_sync',
    'memory_audit', 'memory_history',
    'note_read', 'note_search',
    'session_list', 'session_search', 'session_message_search', 'session_read',
  ];

  it('exports exactly 12 tool declarations', () => {
    expect(TOOL_DECLARATIONS.length).toBe(12);
    expect(TOOL_DECLARATIONS.map(d => d.name).sort()).toEqual([...expectedTools].sort());
  });

  it('every declaration has name, description, parameters object', () => {
    for (const d of TOOL_DECLARATIONS) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.description).toBe('string');
      expect(d.description.length).toBeGreaterThan(10);
      expect((d.parameters as any).type).toBe('object');
      expect((d.parameters as any).properties).toBeDefined();
    }
  });

  it('NO declaration exposes project_id parameter (adapter enforces it)', () => {
    for (const d of TOOL_DECLARATIONS) {
      const props = (d.parameters as any).properties ?? {};
      expect(props.project_id, `tool ${d.name} must not declare project_id`).toBeUndefined();
      expect(props.exclude_project_id, `tool ${d.name} must not declare exclude_project_id`).toBeUndefined();
    }
  });

  it('every declaration has a handler', () => {
    for (const d of TOOL_DECLARATIONS) {
      expect(TOOL_HANDLERS[d.name]).toBeTypeOf('function');
    }
  });

  it('getDeclaration returns undefined for unknown', () => {
    expect(getDeclaration('nonexistent')).toBeUndefined();
    expect(getDeclaration('memory_read')?.name).toBe('memory_read');
  });
});
