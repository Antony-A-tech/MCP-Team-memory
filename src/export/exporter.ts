import type { MemoryEntry } from '../memory/types.js';

export type ExportFormat = 'markdown' | 'json';

export function exportEntries(entries: MemoryEntry[], format: ExportFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(entries, null, 2);

    case 'markdown':
      return exportAsMarkdown(entries);

    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

function exportAsMarkdown(entries: MemoryEntry[]): string {
  const grouped = new Map<string, MemoryEntry[]>();

  for (const e of entries) {
    const cat = e.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(e);
  }

  const categoryTitles: Record<string, string> = {
    architecture: 'Architecture',
    tasks: 'Tasks',
    decisions: 'Decisions',
    issues: 'Issues',
    progress: 'Progress',
  };

  const priorityIcon: Record<string, string> = {
    critical: '[CRITICAL]',
    high: '[HIGH]',
    medium: '',
    low: '[LOW]',
  };

  let md = `# Team Memory Export\n\n`;
  md += `> Exported at ${new Date().toISOString()}\n`;
  md += `> Total entries: ${entries.length}\n\n---\n\n`;

  for (const [category, items] of grouped) {
    md += `## ${categoryTitles[category] || category}\n\n`;

    for (const e of items) {
      const prio = priorityIcon[e.priority] || '';
      const domain = e.domain ? ` [${e.domain}]` : '';
      const tags = e.tags.length > 0 ? `\n\nTags: ${e.tags.join(', ')}` : '';
      const pinned = e.pinned ? ' (pinned)' : '';

      md += `### ${prio} ${e.title}${domain}${pinned}\n\n`;
      md += `**Status:** ${e.status} | **Author:** ${e.author} | **Updated:** ${e.updatedAt}\n\n`;
      md += `${e.content}${tags}\n\n---\n\n`;
    }
  }

  return md;
}
