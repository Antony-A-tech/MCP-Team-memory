#!/usr/bin/env node

/**
 * Backfill session titles and tags from existing summaries.
 * Uses Ollama LLM to generate a short title + semantic tags from each session's summary.
 * Safe to re-run — only updates sessions with auto-generated names (Session xxxxxxxx).
 *
 * Usage:
 *   node scripts/backfill-session-titles.cjs [--dry-run]
 *
 * Environment:
 *   OLLAMA_URL  — Ollama base URL (default: http://localhost:11434)
 *   OLLAMA_MODEL — model name (default: qwen3.5:4b)
 *   PG_URL — PostgreSQL connection string (default: postgresql://dbadmin:dbadmin@127.0.0.1:5432/team_memory)
 */

const http = require('http');
const https = require('https');

// === Config ===
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';
const PG_URL = process.env.PG_URL || 'postgresql://dbadmin:dbadmin@127.0.0.1:5432/team_memory';
const DRY_RUN = process.argv.includes('--dry-run');

// === Main ===
async function main() {
  let pg;
  try {
    pg = require('pg');
  } catch {
    console.error('pg module not found. Run: npm install pg');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: PG_URL });

  // Find sessions with auto-generated names (Session xxxxxxxx)
  const { rows } = await pool.query(
    `SELECT id, name, summary, tags FROM sessions
     WHERE name ~ '^Session [0-9a-f]{8}' AND summary IS NOT NULL AND summary != 'Pending summarization...'
     ORDER BY created_at DESC`
  );

  console.log(`Found ${rows.length} sessions with auto-generated names\n`);
  if (rows.length === 0) { await pool.end(); return; }

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const session = rows[i];
    const shortId = session.id.substring(0, 8);
    process.stdout.write(`[${i + 1}/${rows.length}] ${shortId} `);

    try {
      const { title, tags } = await generateTitleAndTags(session.summary);

      if (!title) {
        console.log('— skip (no title generated)');
        failed++;
        continue;
      }

      // Merge new tags with existing, keep import source tags
      const existingTags = session.tags || [];
      const mergedTags = [...new Set([...existingTags, ...tags])];

      if (DRY_RUN) {
        console.log(`— "${title}" [${tags.join(', ')}]`);
        updated++;
        continue;
      }

      await pool.query(
        'UPDATE sessions SET name = $1, tags = $2 WHERE id = $3',
        [title, mergedTags, session.id]
      );
      console.log(`— ✅ "${title}" [${tags.join(', ')}]`);
      updated++;

      // Small delay to not overload Ollama
      await sleep(500);
    } catch (err) {
      console.log(`— ❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Updated: ${updated}, Failed: ${failed}`);
  if (DRY_RUN) console.log('⚠️  DRY RUN — nothing was actually changed');

  await pool.end();
}

// === LLM ===
async function generateTitleAndTags(summary) {
  // Detect language
  const letters = summary.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  const cyrCount = (letters.match(/[а-яА-ЯёЁ]/g) || []).length;
  const lang = letters.length > 0 && cyrCount / letters.length > 0.15 ? 'Russian' : 'English';

  const prompt = `Based on this session summary, generate a short title and relevant tags. Write in ${lang}.

Format your response EXACTLY as:
Title: <short descriptive title, 5-10 words, no quotes>
Tags: <3-6 lowercase tags separated by commas>

Summary: ${summary.slice(0, 2000)}

Title:`;

  const response = await ollamaGenerate(prompt);

  // Parse response
  const titleMatch = response.match(/^(.+?)(?:\n|Tags:)/s);
  const tagsMatch = response.match(/Tags:\s*(.+)/s);

  const title = titleMatch?.[1]?.replace(/^Title:\s*/i, '').trim() || null;
  const tags = tagsMatch?.[1]?.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) || [];

  return { title, tags };
}

function ollamaGenerate(prompt) {
  const url = new URL(OLLAMA_URL + '/api/generate');
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 150 },
    });

    const req = transport.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response?.trim() || '');
        } catch { reject(new Error('Failed to parse Ollama response')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
