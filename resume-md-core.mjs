import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { fetchJobDescriptionText, readJobDescriptionMetadata } from './jd-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const STOPWORDS = new Set([
  'about', 'above', 'across', 'after', 'again', 'against', 'also', 'and', 'any', 'are',
  'based', 'been', 'being', 'between', 'business', 'candidate', 'company', 'could',
  'development', 'each', 'engineer', 'engineering', 'experience', 'from', 'have', 'into',
  'job', 'looking', 'management', 'manager', 'more', 'must', 'our', 'role', 'should',
  'software', 'team', 'teams', 'that', 'the', 'their', 'this', 'through', 'using', 'with',
  'will', 'work', 'working', 'years', 'your',
]);

export function slugifyName(value, fallback = 'unknown') {
  const slug = String(value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || fallback;
}

export function loadCandidateName(profilePath = 'config/profile.yml') {
  try {
    const profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    return profile?.candidate?.full_name || profile?.candidate?.name || 'candidate';
  } catch {
    return 'candidate';
  }
}

export function extractJobContext(jdText = '', source = '') {
  const text = String(jdText || '');
  const metadata = source && source.startsWith('local:') ? readJobDescriptionMetadata(source) : {};
  const companyPatterns = [
    /^-\s*Company:\s*(.+)$/im,
    /^Company:\s*(.+)$/im,
    /\bat\s+([A-Z][A-Za-z0-9&.,' -]{2,50})\b/,
  ];
  const rolePatterns = [
    /^-\s*Role:\s*(.+)$/im,
    /^Role:\s*(.+)$/im,
    /^#\s*(?:.+?\s+-\s+)?(.+)$/m,
    /\b(?:hiring|seeking|looking for)\s+(?:an?\s+)?([A-Z][A-Za-z0-9&.,' /+-]{3,70})/i,
  ];

  const firstMatch = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return cleanTitle(match[1]);
    }
    return '';
  };

  let company = metadata.company || firstMatch(companyPatterns);
  let role = metadata.role || firstMatch(rolePatterns);

  if (!company && source && /^https?:\/\//i.test(source)) {
    try {
      const host = new URL(source).hostname.replace(/^www\./, '');
      company = host.split('.')[0];
    } catch {}
  }
  if (!role) role = 'tailored-resume';
  if (!company) company = 'company';
  return { company, role };
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[|•].*$/, '')
    .trim()
    .slice(0, 90);
}

export function extractKeywords(text = '', limit = 18) {
  const counts = new Map();
  const normalized = String(text)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  for (const token of normalized.match(/[a-z][a-z0-9+#.-]{2,}/g) || []) {
    const clean = token.replace(/^[^a-z0-9]+|[^a-z0-9+#.-]+$/g, '');
    if (clean.length < 3 || STOPWORDS.has(clean)) continue;
    counts.set(clean, (counts.get(clean) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

export function createTargetedReplacements(cvMarkdown, jdText) {
  const replacements = [];
  const keywords = extractKeywords(jdText, 12);
  const summaryMatch = cvMarkdown.match(/(## Professional Summary\n\n)([\s\S]*?)(\n\n---|\n\n## )/);
  if (summaryMatch) {
    const current = summaryMatch[2];
    const selected = keywords.slice(0, 8).join(', ');
    const focusSentence = selected
      ? ` Role-relevant focus areas include ${selected}.`
      : '';
    const replacement = !focusSentence || current.includes('Role-relevant focus areas include')
      ? current
      : `${current}${focusSentence}`;
    if (replacement !== current) replacements.push({ before: current, after: replacement });
  }
  return replacements;
}

export function applyTargetedReplacements(baseMarkdown, replacements) {
  let output = baseMarkdown;
  for (const { before, after } of replacements) {
    if (!before || before === after) continue;
    if (!output.includes(before)) {
      throw new Error('Targeted replacement source text was not found in cv.md');
    }
    output = output.replace(before, after);
  }
  return output;
}

export function tailorResumeMarkdown(cvMarkdown, jdText) {
  const replacements = createTargetedReplacements(cvMarkdown, jdText);
  return {
    markdown: applyTargetedReplacements(cvMarkdown, replacements),
    replacements,
    keywords: extractKeywords(jdText, 18),
  };
}

export function estimateResumeMatchScore(jdText, resumeMarkdown) {
  const keywords = extractKeywords(jdText, 24);
  if (keywords.length === 0) return { score: 'N/A', coverage: 0, matched: [], total: 0 };
  const resume = String(resumeMarkdown || '').toLowerCase();
  const matched = keywords.filter(keyword => resume.includes(keyword.toLowerCase()));
  const coverage = matched.length / keywords.length;
  const score = Math.max(1, Math.min(5, 2.5 + coverage * 2.5));
  return { score: `${score.toFixed(1)}/5`, coverage, matched, total: keywords.length };
}

export function buildResumeMarkdownPath({ candidateName, company }) {
  return join('output', `cv-${slugifyName(candidateName, 'candidate')}-${slugifyName(company, 'company')}.md`);
}

function assertSafeRemoteUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTP(S) URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const blocked = host === 'localhost' || host === '::1' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error(`Refusing private/loopback host: ${host}`);
}

function readWorkspaceFile(relPath, allowedPrefixes) {
  const normalized = String(relPath || '').replace(/^local:/, '');
  const full = resolve(ROOT, normalized);
  const rel = relative(ROOT, full).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to read outside the workspace: ${normalized}`);
  }
  if (!allowedPrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) {
    throw new Error(`Unsupported local input path: ${normalized}`);
  }
  return { text: readFileSync(full, 'utf-8'), rel };
}

export async function resolveJobDescriptionInput(input) {
  const source = String(input || '').trim();
  if (!source) throw new Error('No job description input provided');
  if (source.startsWith('local:')) {
    const local = readWorkspaceFile(source, ['jds', 'reports']);
    return { text: local.text, source: `local:${local.rel}`, jdPath: local.rel.startsWith('jds/') ? local.rel : '' };
  }
  if (/^jds\/.+\.md$/i.test(source)) {
    const local = readWorkspaceFile(source, ['jds']);
    return { text: local.text, source: `local:${local.rel}`, jdPath: local.rel };
  }
  if (/^reports\/.+\.md$/i.test(source)) {
    const local = readWorkspaceFile(source, ['reports']);
    return { text: local.text, source: local.rel, jdPath: '' };
  }
  if (/^https?:\/\//i.test(source)) {
    assertSafeRemoteUrl(source);
    const text = await fetchJobDescriptionText(source);
    if (!text) throw new Error(`Could not extract job description from URL: ${source}`);
    return { text: `URL: ${source}\n\n${text}`, source, jdPath: '' };
  }
  return { text: source, source: 'pasted', jdPath: '' };
}

export async function writeTailoredResumeMarkdown({
  input,
  cvPath = 'cv.md',
  profilePath = 'config/profile.yml',
} = {}) {
  const resolved = await resolveJobDescriptionInput(input);
  const cvMarkdown = readFileSync(cvPath, 'utf-8');
  const candidateName = loadCandidateName(profilePath);
  const { company, role } = extractJobContext(resolved.text, resolved.source);
  const tailored = tailorResumeMarkdown(cvMarkdown, resolved.text);
  const final = estimateResumeMatchScore(resolved.text, tailored.markdown);
  const outputPath = buildResumeMarkdownPath({ candidateName, company });
  mkdirSync(resolve(ROOT, 'output'), { recursive: true });
  writeFileSync(resolve(ROOT, outputPath), tailored.markdown, 'utf-8');
  return {
    path: outputPath,
    company,
    role,
    finalScore: final.score,
    coverage: final.coverage,
    matchedKeywords: final.matched,
    totalKeywords: final.total,
    replacements: tailored.replacements,
    jdPath: resolved.jdPath,
    source: resolved.source,
  };
}

export function inferCompanySlugFromResumePath(resumePath) {
  const name = basename(String(resumePath || ''), '.md');
  return name.replace(/^cv-[^-]+(?:-[^-]+)?-/, '') || 'company';
}
