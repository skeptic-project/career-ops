#!/usr/bin/env node

import { readFileSync } from 'fs';
import { writeTailoredResumeMarkdown } from './resume-md-core.mjs';

function usage() {
  console.error(`Usage:
  node resume-md.mjs <job-description-url|local:jds/file.md|jds/file.md|reports/file.md|jd text>
  node resume-md.mjs --file <job-description.md>`);
}

const args = process.argv.slice(2);
let input = args.join(' ').trim();

if (args[0] === '--file') {
  if (!args[1]) {
    usage();
    process.exit(1);
  }
  input = readFileSync(args[1], 'utf-8');
}

if (!input) {
  usage();
  process.exit(1);
}

try {
  const result = await writeTailoredResumeMarkdown({ input });
  console.log(`Markdown resume: ${result.path}`);
  console.log(`Company: ${result.company}`);
  console.log(`Role: ${result.role}`);
  console.log(`final-score: ${result.finalScore}`);
  console.log(`Targeted replacements: ${result.replacements.length}`);
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(1);
}
