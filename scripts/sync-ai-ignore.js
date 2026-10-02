import { readFileSync, writeFileSync } from 'node:fs';

const targets = [
  { path: '.cursorignore', label: 'Cursor' },
  { path: '.cursorindexingignore', label: 'Cursor indexing' },
  { path: '.geminiignore', label: 'Gemini' },
  { path: '.aiexclude', label: 'AI exclude' },
  { path: '.codexignore', label: 'Codex' },
  { path: '.codeiumignore', label: 'Codeium' },
];

const source = readFileSync('.aiignore', 'utf8');
const body = source.replace(/^# Shared[\s\S]*?\n(?=# Dependencies)/, '');

for (const target of targets) {
  const header = `# ${target.label} - Agent context exclusions.
# GENERATED from .aiignore - do not edit by hand.
# Edit .aiignore and run: npm run sync:ai-ignore

`;

  writeFileSync(target.path, `${header}${body}`);
}
