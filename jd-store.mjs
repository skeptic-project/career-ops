import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const JDS_DIR = 'jds';
const MIN_JD_TEXT_LENGTH = 250;
const FETCH_TIMEOUT_MS = 15_000;

function cleanScalar(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForCompare(value) {
  return cleanScalar(value).toLowerCase();
}

function shortHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 10);
}

export function slugifyJob(company, role) {
  const slug = `${company || 'unknown-company'}-${role || 'unknown-role'}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'unknown-company-unknown-role';
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|section|article|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function extractOfferDescription(offer = {}) {
  const candidates = [
    offer.description,
    offer.descriptionPlain,
    offer.description_plain,
    offer.content,
    offer.jobDescription,
    offer.job_description,
    offer.body,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.includes('<') ? stripHtml(candidate) : candidate.trim();
    if (text.length >= MIN_JD_TEXT_LENGTH) return text;
  }
  return '';
}

export async function fetchJobDescriptionText(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'career-ops/1.0 (+https://github.com/santifer/career-ops)',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      },
      signal: controller.signal,
    });
    if (!response.ok) return '';
    const raw = await response.text();
    const text = stripHtml(raw);
    return text.length >= MIN_JD_TEXT_LENGTH ? text : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

export function buildJobDescriptionMarkdown({
  company,
  role,
  sourceUrl,
  capturedAt,
  extractionMethod,
  text,
}) {
  const safeCompany = cleanScalar(company) || 'Unknown';
  const safeRole = cleanScalar(role) || 'Unknown';
  const safeSource = cleanScalar(sourceUrl);
  const safeDate = cleanScalar(capturedAt);
  const safeMethod = cleanScalar(extractionMethod) || 'unknown';
  const body = String(text ?? '').trim();

  return [
    `# ${safeCompany} - ${safeRole}`,
    '',
    `- Company: ${safeCompany}`,
    `- Role: ${safeRole}`,
    `- Source URL: ${safeSource}`,
    `- Date captured: ${safeDate}`,
    `- Extraction method: ${safeMethod}`,
    '',
    '## Job Description',
    '',
    body,
    '',
  ].join('\n');
}

export function readJobDescriptionMetadata(jdPath) {
  if (!jdPath) return {};
  const normalizedPath = String(jdPath).replace(/^local:/, '');
  if (!existsSync(normalizedPath)) return {};
  const text = readFileSync(normalizedPath, 'utf-8');
  const meta = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^- (Company|Role|Source URL|Date captured|Extraction method):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/\s+/g, '_');
    meta[key] = match[2].trim();
  }
  return meta;
}

export async function persistJobDescriptionForOffer(offer, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const sourceUrl = cleanScalar(offer?.url);
  const providerText = extractOfferDescription(offer);
  const fetchedText = providerText ? '' : await fetchJobDescriptionText(sourceUrl);
  const text = providerText || fetchedText;
  if (!text || text.length < MIN_JD_TEXT_LENGTH) {
    return { ...offer, jdPath: '', jdExtractionStatus: 'unavailable' };
  }

  const company = cleanScalar(offer?.company) || 'Unknown';
  const role = cleanScalar(offer?.title || offer?.role) || 'Unknown';
  const baseSlug = slugifyJob(company, role);
  const extractionMethod = providerText ? 'provider-description' : 'fetch-html';
  const markdown = buildJobDescriptionMarkdown({
    company,
    role,
    sourceUrl,
    capturedAt: date,
    extractionMethod,
    text,
  });

  mkdirSync(JDS_DIR, { recursive: true });
  const basePath = join(JDS_DIR, `${baseSlug}.md`);
  let targetPath = basePath;
  if (existsSync(basePath)) {
    const existing = readFileSync(basePath, 'utf-8');
    if (normalizeForCompare(existing) !== normalizeForCompare(markdown)) {
      targetPath = join(JDS_DIR, `${baseSlug}-${shortHash(`${sourceUrl}\n${text}`)}.md`);
    }
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  if (!existsSync(targetPath)) writeFileSync(targetPath, markdown, 'utf-8');
  return { ...offer, jdPath: targetPath, jdExtractionStatus: 'available' };
}

export async function persistJobDescriptionsForOffers(offers, options = {}) {
  const persisted = [];
  for (const offer of offers) {
    persisted.push(await persistJobDescriptionForOffer(offer, options));
  }
  return persisted;
}
