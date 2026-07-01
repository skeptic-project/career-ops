#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch tracker additions into applications.md
 *
 * Handles multiple TSV formats:
 * - 9-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes
 * - 8-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport (no notes)
 * - Pipe-delimited (markdown table row): | col | col | ... |
 *
 * Dedup: company normalized + role fuzzy match + report number match
 * If duplicate with higher score → update in-place, update report link
 * Validates status against states.yml (rejects non-canonical, logs warning)
 *
 * Run: node career-ops/merge-tracker.mjs [--dry-run] [--verify]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, rmSync, statSync, realpathSync } from 'fs';
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { normalizeReportLink as normalizeLink } from './tracker-links.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { LEGACY_COLMAP, detectColumns } from './tracker-parse.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original).
// CAREER_OPS_TRACKER overrides the path (used by tests and non-standard layouts).
const APPS_FILE_RAW = process.env.CAREER_OPS_TRACKER
  ? process.env.CAREER_OPS_TRACKER
  : existsSync(join(CAREER_OPS, 'data/applications.md'))
    ? join(CAREER_OPS, 'data/applications.md')
    : join(CAREER_OPS, 'applications.md');
const APPS_FILE = canonicalizeTrackerPath(APPS_FILE_RAW);
const TRACKER_DIR = dirname(APPS_FILE);
// CAREER_OPS_ADDITIONS overrides the additions dir (used by tests, mirrors CAREER_OPS_TRACKER).
const ADDITIONS_DIR = process.env.CAREER_OPS_ADDITIONS
  ? process.env.CAREER_OPS_ADDITIONS
  : join(CAREER_OPS, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');
const MIGRATE = process.argv.includes('--migrate');
const MERGE_HOLD_MS = Number(process.env.CAREER_OPS_MERGE_HOLD_MS) || 0;
const MERGE_READY_IPC = process.env.CAREER_OPS_MERGE_READY_IPC === '1';

const trackerLockKey = createHash('sha256').update(APPS_FILE).digest('hex').slice(0, 16);
const TRACKER_LOCK_DIR = resolveTrackerLockDir(process.env.CAREER_OPS_TRACKER_LOCK, trackerLockKey);

// The reports/ dir sits at the repo root, which is the tracker's parent in the
// data/ layout (data/applications.md) and the tracker's own dir at root layout.
const REPORTS_ROOT = basename(TRACKER_DIR) === 'data' ? dirname(TRACKER_DIR) : TRACKER_DIR;
const JDS_ROOT = basename(TRACKER_DIR) === 'data' ? dirname(TRACKER_DIR) : TRACKER_DIR;

/**
 * Normalize report links before writing them into the tracker file.
 *
 * TSV additions use root-relative report links so they are easy for agents to
 * generate. The tracker may live either at `data/applications.md` or at the
 * repository root, so this wrapper binds the correct tracker and reports
 * directories before delegating to the shared link normalizer.
 *
 * @param {string} reportField - Raw report cell from a TSV addition.
 * @returns {string} Markdown report link relative to the tracker file.
 */
const normalizeReportLink = (reportField) => normalizeLink(reportField, TRACKER_DIR, REPORTS_ROOT);

const normalizeJdLink = (jdField) => normalizePathLink(jdField, TRACKER_DIR, JDS_ROOT);

const normalizeResumeMdLink = (resumeField) => normalizePathLink(resumeField, TRACKER_DIR, CAREER_OPS);

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

/**
 * Convert the tracker path into one stable absolute spelling before hashing it.
 *
 * Equivalent tracker paths can be written in multiple ways, such as a relative
 * path from the current shell, an absolute path, or a path that travels through
 * a symlink. The lock key must be based on one canonical spelling so all merge
 * processes that target the same tracker also target the same lock directory.
 *
 * @param {string} path - Raw tracker path from config, env, or the default.
 * @returns {string} Absolute canonical path when the file exists, else resolved path.
 */
function canonicalizeTrackerPath(path) {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Check whether one absolute path stays inside another directory.
 *
 * This protects recursive lock cleanup from accepting paths that escape the
 * system temp directory through `..` segments or unrelated absolute roots.
 *
 * @param {string} childPath - Candidate path to validate.
 * @param {string} parentDir - Required parent directory boundary.
 * @returns {boolean} True when childPath is inside parentDir or equal to it.
 */
function pathIsInside(childPath, parentDir) {
  const relativePath = relative(parentDir, childPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Validate and resolve the tracker lock directory.
 *
 * `CAREER_OPS_TRACKER_LOCK` exists for tests and unusual local layouts, but the
 * merge script later removes the lock directory recursively. To keep that safe,
 * env-provided lock paths must be absolute, live under the OS temp directory,
 * and use the career-ops lock-name prefix. Invalid values are ignored and the
 * deterministic temp-dir default is used instead.
 *
 * @param {string|undefined} envValue - Optional lock path override.
 * @param {string} lockKey - Stable tracker hash suffix.
 * @returns {string} Safe lock directory path.
 */
function resolveTrackerLockDir(envValue, lockKey) {
  const tmpRoot = realpathSync(tmpdir());
  const fallback = join(tmpRoot, `career-ops-merge-tracker-${lockKey}.lock`);
  if (!envValue || !isAbsolute(envValue)) return fallback;

  const candidate = resolve(envValue);
  const parentDir = dirname(candidate);
  const canonicalParent = existsSync(parentDir) ? realpathSync(parentDir) : resolve(parentDir);
  if (!pathIsInside(canonicalParent, tmpRoot)) return fallback;
  if (!basename(candidate).startsWith('career-ops-merge-tracker-')) return fallback;
  return candidate;
}

/**
 * Pause the async merge flow for a fixed number of milliseconds.
 *
 * This is used in two places:
 * - the lock retry loop, where waiting briefly avoids a tight CPU spin while
 *   another `merge-tracker.mjs` process owns the tracker lock;
 * - the regression test hook (`CAREER_OPS_MERGE_HOLD_MS`), which deliberately
 *   holds the first merge after it reads `applications.md` so a second merge can
 *   try to enter the same critical section.
 *
 * @param {number} ms - Milliseconds to wait before resolving.
 * @returns {Promise<void>} Resolves after the requested delay.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determine whether a process id still belongs to a live process.
 *
 * The tracker lock stores the owner PID in `owner.json`. When another process
 * finds an existing lock, this check lets it distinguish a valid live owner from
 * a crashed process that left a stale lock directory behind. `EPERM` counts as
 * alive because the process exists even if the current user cannot signal it.
 *
 * @param {number} pid - Process id recorded by the lock owner.
 * @returns {boolean} True when the process appears to still exist.
 */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Read lock ownership metadata from a tracker lock directory.
 *
 * The metadata contains the owner PID, a unique release token, the acquisition
 * timestamp, and the tracker path. Invalid or missing metadata is treated as
 * unreadable so the stale-lock recovery path can fall back to directory age.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @returns {object|null} Parsed owner metadata, or null when unavailable.
 */
function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock can be safely recovered.
 *
 * Recovery is conservative: if the lock has an owner PID and that process is
 * still alive, the lock is never considered stale merely because it is old. If
 * the owner process is gone, or if the metadata cannot be read and the lock
 * directory itself is older than the stale threshold, the waiting process may
 * remove the lock and retry acquisition.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @param {number} staleMs - Age threshold for metadata-free lock recovery.
 * @returns {boolean} True when the caller may remove and recreate the lock.
 */
function lockCanRecover(lockDir, staleMs) {
  const owner = readLockOwner(lockDir);
  if (owner?.pid) return !processIsAlive(owner.pid);

  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

/**
 * Acquire an exclusive filesystem lock for one tracker merge.
 *
 * The critical section must cover the full read/modify/write/move sequence, not
 * just the final write. Otherwise two processes can read the same old tracker
 * snapshot, compute independent updates, and let the later writer erase rows
 * written by the earlier one. The lock is implemented with atomic directory
 * creation, owner metadata, retry/backoff, stale-owner recovery, and a release
 * token so one process cannot delete another process's newer lock.
 *
 * @param {string} lockDir - Directory path used as the lock sentinel.
 * @param {object} [options] - Lock timing options.
 * @param {number} [options.timeoutMs=60000] - Maximum time to wait for the lock.
 * @param {number} [options.retryMs=75] - Delay between acquisition attempts.
 * @param {number} [options.staleMs=600000] - Metadata-free stale-lock threshold.
 * @returns {Promise<{attempts:number,waitMs:number,staleRecovered:boolean,release:Function}>}
 * Lock handle with metadata and an idempotent release method.
 */
async function acquireTrackerLock(lockDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 75;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const startedAt = Date.now();
  let attempts = 0;
  let staleRecovered = false;

  while (Date.now() - startedAt < timeoutMs) {
    attempts++;
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        token,
        started_at: new Date().toISOString(),
        tracker: APPS_FILE,
      }, null, 2));

      let released = false;
      return {
        attempts,
        waitMs: Date.now() - startedAt,
        staleRecovered,
        release() {
          if (released) return;
          released = true;
          const owner = readLockOwner(lockDir);
          if (owner?.token === token) {
            rmSync(lockDir, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardErr) {
        if (guardErr?.code !== 'EEXIST') throw guardErr;
      }

      if (hasRecoverGuard) {
        try {
          if (lockCanRecover(lockDir, staleMs)) {
            rmSync(lockDir, { recursive: true, force: true });
            staleRecovered = true;
            continue;
          }
        } finally {
          rmSync(recoverGuardDir, { recursive: true, force: true });
        }
      }

      await sleep(retryMs);
    }
  }

  throw new Error(`Timed out waiting for tracker merge lock at ${lockDir}`);
}

/**
 * Replace a tracker file atomically using a same-directory temporary file.
 *
 * Writing into the same directory keeps the final `renameSync` atomic on normal
 * filesystems and avoids exposing a partially written `applications.md` to other
 * readers. If the write or rename fails, the temporary file is cleaned up before
 * the original error is rethrown.
 *
 * @param {string} path - Final file path to replace.
 * @param {string} content - Complete file content to write.
 * @returns {void}
 */
function writeFileAtomic(path, content) {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

let trackerLock;
try {
  trackerLock = await acquireTrackerLock(TRACKER_LOCK_DIR, {
    timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
    retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
    staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
  });
  process.once('exit', () => trackerLock?.release());
  if (trackerLock.waitMs > 0 || trackerLock.staleRecovered) {
    console.log(`🔒 Tracker merge lock acquired (wait_ms=${trackerLock.waitMs} | attempts=${trackerLock.attempts} | stale_recovered=${trackerLock.staleRecovered})`);
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

// Canonical states and aliases
const CANONICAL_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];

/**
 * Convert raw addition status text into one canonical tracker state.
 *
 * Batch workers and older tracker additions may emit Spanish labels, bold
 * Markdown, legacy date suffixes, or repost markers. The merge script normalizes
 * all of those variants here so applications.md keeps the states defined by
 * templates/states.yml.
 *
 * @param {string} status - Raw status string from a TSV or pipe-delimited row.
 * @returns {string} Canonical tracker status.
 */
function validateStatus(status) {
  const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  for (const valid of CANONICAL_STATES) {
    if (valid.toLowerCase() === lower) return valid;
  }

  // Aliases
  const aliases = {
    // Spanish → English
    'evaluada': 'Evaluated', 'condicional': 'Evaluated', 'hold': 'Evaluated', 'evaluar': 'Evaluated', 'verificar': 'Evaluated',
    'aplicado': 'Applied', 'enviada': 'Applied', 'aplicada': 'Applied', 'applied': 'Applied', 'sent': 'Applied',
    'respondido': 'Responded',
    'entrevista': 'Interview',
    'oferta': 'Offer',
    'rechazado': 'Rejected', 'rechazada': 'Rejected',
    'descartado': 'Discarded', 'descartada': 'Discarded', 'cerrada': 'Discarded', 'cancelada': 'Discarded',
    'no aplicar': 'SKIP', 'no_aplicar': 'SKIP', 'skip': 'SKIP', 'monitor': 'SKIP',
    'geo blocker': 'SKIP',
  };

  if (aliases[lower]) return aliases[lower];

  // DUPLICADO/Repost → Discarded
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

  console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}

/**
 * Normalize company names for duplicate lookup during tracker merges.
 *
 * Company names can contain spaces, punctuation, or branding variants in the
 * tracker and incoming TSV rows. Removing non-alphanumeric characters gives the
 * merge step a stable same-company key before it compares report numbers or
 * fuzzy role titles.
 *
 * @param {string} name - Company name from the tracker or addition row.
 * @returns {string} Lowercase alphanumeric company key.
 */
function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Extract the bracketed report number from a Markdown report link.
 *
 * Report-number equality is an exact duplicate signal, but only after company
 * equality is confirmed by the caller. This helper reads links such as
 * `[123](../reports/123-company-role-date.md)` and returns the numeric id.
 *
 * @param {string} reportStr - Raw report cell from applications.md or TSV input.
 * @returns {number|null} Parsed report number, or null when absent.
 */
function extractReportNum(reportStr) {
  const m = reportStr.match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Parse a score cell into a numeric value for score-upgrade decisions.
 *
 * The merge path compares old and new scores to decide whether to update an
 * existing duplicate row. Markdown bolding and `/5` suffixes are presentation
 * details, so only the first numeric value is used.
 *
 * @param {string} s - Raw score cell such as `4.2/5`.
 * @returns {number} Parsed score, or 0 when no numeric value is present.
 */
function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// Column layout for the applications.md table. The tracker may use the original
// 9-column layout, or a customized one with an extra/reordered column (e.g. a
// Location column after Role). We map columns by header NAME rather than fixed
// position so both work — fixed-position indexing would otherwise read, say,
// Location where it expects Score. Falls back to the legacy layout when no
// recognizable header row is found.
// LEGACY_COLMAP, HEADER_ALIASES and detectColumns are the shared header-name
// mapping, now sourced from tracker-parse.mjs so every tracker reader stays in
// lockstep (see imports above). COLMAP stays mutable here — it is reassigned to
// the detected layout once the table is read (below).
let COLMAP = LEGACY_COLMAP;

// Neutralize characters that would corrupt the applications.md table. Both this
// file and tracker-parse.mjs read rows with a raw `line.split('|')`, so a literal
// pipe or a newline in a free-text value (company/role/location/notes) would shift
// every later column. Replace rather than backslash-escape: `\|` would still split
// on the inner pipe. This is additive — normal cells are unchanged; only values
// that would already break the table get sanitized (also keeps the web reader safe).
function cell(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\s*\|\s*/g, ' / ').trim();
}

function splitMarkdownRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function buildMarkdownRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function ensureJdColumn(content) {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex((line) => {
    if (!line.startsWith('|')) return false;
    const cells = splitMarkdownRow(line).map(c => c.toLowerCase());
    return cells.includes('company') && cells.includes('role') && cells.includes('report');
  });
  if (headerIdx === -1) return { content, changed: false };
  const headerCells = splitMarkdownRow(lines[headerIdx]);
  const lower = headerCells.map(c => c.toLowerCase());
  if (lower.includes('jd')) return { content, changed: false };
  const reportIdx = lower.indexOf('report');
  if (reportIdx === -1) return { content, changed: false };

  const out = lines.map((line, idx) => {
    if (!line.startsWith('|')) return line;
    const cells = splitMarkdownRow(line);
    if (idx === headerIdx) {
      cells.splice(reportIdx + 1, 0, 'JD');
      return buildMarkdownRow(cells);
    }
    if (/^[-: ]+$/.test(cells.join(''))) {
      cells.splice(reportIdx + 1, 0, '----');
      return `|${cells.join('|')}|`;
    }
    const num = parseInt(cells[0], 10);
    if (Number.isNaN(num) || cells.length <= reportIdx) return line;
    cells.splice(reportIdx + 1, 0, '');
    return buildMarkdownRow(cells);
  });

  return { content: out.join('\n'), changed: true };
}

function ensureResumeAndScoreColumns(content) {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex((line) => {
    if (!line.startsWith('|')) return false;
    const cells = splitMarkdownRow(line).map(c => c.toLowerCase());
    return cells.includes('company') && cells.includes('role') && cells.includes('pdf');
  });
  if (headerIdx === -1) return { content, changed: false };
  const headerCells = splitMarkdownRow(lines[headerIdx]);
  const lower = headerCells.map(c => c.toLowerCase());
  
  const hasResume = lower.includes('resume-md');
  const hasScore = lower.includes('final-score');
  if (hasResume && hasScore) return { content, changed: false };

  const pdfIdx = lower.indexOf('pdf');
  if (pdfIdx === -1) return { content, changed: false };

  const out = lines.map((line, idx) => {
    if (!line.startsWith('|')) return line;
    const cells = splitMarkdownRow(line);
    
    if (idx === headerIdx) {
      if (!hasResume) {
        cells.splice(pdfIdx, 0, 'resume-md');
      }
      const currentPdfIdx = cells.map(c => c.toLowerCase()).indexOf('pdf');
      if (!hasScore) {
        cells.splice(currentPdfIdx, 0, 'final-score');
      }
      return buildMarkdownRow(cells);
    }
    
    if (/^[-: ]+$/.test(cells.join(''))) {
      if (!hasResume) {
        cells.splice(pdfIdx, 0, '---');
      }
      const currentPdfIdx = cells.length > pdfIdx ? pdfIdx + (!hasResume ? 1 : 0) : pdfIdx;
      if (!hasScore) {
        cells.splice(currentPdfIdx, 0, '---');
      }
      return `|${cells.join('|')}|`;
    }
    
    const num = parseInt(cells[0], 10);
    if (Number.isNaN(num) || cells.length <= pdfIdx) return line;
    
    if (!hasResume) {
      cells.splice(pdfIdx, 0, '—');
    }
    const currentPdfIdx = cells.length > pdfIdx ? pdfIdx + (!hasResume ? 1 : 0) : pdfIdx;
    if (!hasScore) {
      cells.splice(currentPdfIdx, 0, '—');
    }
    return buildMarkdownRow(cells);
  });

  return { content: out.join('\n'), changed: true };
}

function normalizePathLink(pathField, trackerDir, rootDir) {
  const raw = String(pathField ?? '').trim().replace(/^local:/, '');
  if (!raw || raw === '—') return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized.startsWith('./')) return normalized;
  return relative(trackerDir, join(rootDir, normalized)).split(sep).join('/');
}

// Build a tracker row string matching the detected layout (with or without the
// optional Location column) so writes round-trip through the same schema.
function buildRow(o) {
  const byIndex = new Map(Object.entries(COLMAP).map(([key, index]) => [index, key]));
  const maxIdx = Math.max(...Object.values(COLMAP));
  const values = {
    num: o.num,
    date: o.date,
    company: cell(o.company),
    role: cell(o.role),
    location: cell(o.location) || '—',
    score: o.score,
    status: o.status,
    resumeMd: cell(o.resumeMd) || '—',
    finalScore: o.finalScore || '—',
    pdf: o.pdf,
    report: o.report,
    jd: cell(o.jd),
    notes: cell(o.notes),
  };
  const cells = [];
  for (let i = 1; i <= maxIdx; i++) {
    const key = byIndex.get(i);
    if (key) cells.push(values[key] ?? '');
  }
  return `| ${cells.join(' | ')} |`;
}

/**
 * Parse one Markdown applications.md table row into a tracker object.
 *
 * Header/separator rows and malformed rows return null. Valid rows preserve the
 * original raw line so the merge logic can locate and replace the exact tracker
 * line when a higher-scored re-evaluation arrives.
 *
 * @param {string} line - One line from applications.md.
 * @returns {object|null} Parsed tracker row, or null for non-data rows.
 */
function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  const maxIdx = Math.max(...Object.values(COLMAP));
  if (parts.length <= maxIdx) return null;
  const num = parseInt(parts[COLMAP.num]);
  if (isNaN(num) || num === 0) return null;
  return {
    num,
    date: parts[COLMAP.date],
    company: parts[COLMAP.company],
    role: parts[COLMAP.role],
    location: COLMAP.location != null ? parts[COLMAP.location] : '',
    score: parts[COLMAP.score],
    status: parts[COLMAP.status],
    resumeMd: COLMAP.resumeMd != null ? parts[COLMAP.resumeMd] : '',
    finalScore: COLMAP.finalScore != null ? parts[COLMAP.finalScore] : '',
    pdf: parts[COLMAP.pdf],
    report: parts[COLMAP.report],
    jd: COLMAP.jd != null ? parts[COLMAP.jd] : '',
    notes: COLMAP.notes != null ? (parts[COLMAP.notes] || '') : '',
    raw: line,
  };
}

function looksLikeJdPath(value) {
  return /^(?:local:)?jds\/.+\.md$/i.test(String(value ?? '').trim());
}

function looksLikeResumeMdPath(value) {
  return /^output\/.+\.md$/i.test(String(value ?? '').trim());
}

function looksLikePdfCell(value) {
  const text = String(value ?? '').trim();
  return text === '' || text === '—' || text === '✅' || text === '❌' || /^output\/.+\.pdf$/i.test(text);
}

/**
 * Parse a TSV file content into a structured addition object.
 *
 * Handles 9-column TSV, 8-column TSV, and pipe-delimited Markdown rows. The
 * parser also tolerates old score/status column ordering, validates status, and
 * rejects additions without a usable tracker number so malformed batch output
 * cannot corrupt applications.md.
 *
 * @param {string} content - Raw file content from batch/tracker-additions.
 * @param {string} filename - Source filename used in warning messages.
 * @returns {object|null} Parsed tracker addition, or null when malformed.
 */
function parseTsvContent(content, filename) {
  content = content.trim();
  if (!content) return null;
  const contentLines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headerLine = contentLines.find(line => /^[a-z_#]+\t/i.test(line) && /\bcompany\b/i.test(line) && /\brole\b/i.test(line));
  const dataLine = contentLines.find(line => /^\d+\t/.test(line) || line.startsWith('|')) || contentLines[contentLines.length - 1];
  if (headerLine && dataLine && !dataLine.startsWith('|')) {
    const headers = headerLine.split('\t').map(h => h.trim().toLowerCase());
    const values = dataLine.split('\t');
    const get = (name) => {
      const idx = headers.indexOf(name);
      return idx === -1 ? '' : (values[idx] || '');
    };
    const statusRaw = get('status');
    const scoreRaw = get('score');
    const addition = {
      num: parseInt(get('num') || get('#')),
      date: get('date'),
      company: get('company'),
      role: get('role'),
      status: validateStatus(statusRaw),
      score: scoreRaw,
      resumeMd: get('resume-md') || get('resume_md'),
      finalScore: get('final-score') || get('final_score'),
      pdf: get('pdf'),
      report: get('report'),
      jd: get('jd'),
      notes: get('notes'),
      location: get('location'),
    };
    if (isNaN(addition.num) || addition.num === 0) {
      console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
      return null;
    }
    return addition;
  }
  if (contentLines.length > 1) {
    content = dataLine;
  }

  let parts;
  let addition;

  // Detect pipe-delimited (markdown table row)
  if (content.startsWith('|')) {
    parts = content.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
    // Format: num | date | company | role | score | status | pdf | report | notes [| location]
    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      score: parts[4],
      status: validateStatus(parts[5]),
      resumeMd: '',
      finalScore: '',
      pdf: parts[6],
      report: parts[7],
      jd: (looksLikeJdPath(parts[8]) || parts[8] === '') ? parts[8] : '',
      notes: (looksLikeJdPath(parts[8]) || parts[8] === '') ? (parts[9] || '') : (parts[8] || ''),
      location: (looksLikeJdPath(parts[8]) || parts[8] === '') ? (parts[10] || '').trim() : (parts[9] || '').trim(),
    };
  } else {
    // Tab-separated
    parts = content.split('\t');
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }

    // Detect column order: some TSVs have (status, score), others have (score, status)
    // Heuristic: if col4 looks like a score and col5 looks like a status, they're swapped
    const col4 = parts[4].trim();
    const col5 = parts[5].trim();
    const col4LooksLikeScore = /^\d+\.?\d*\/5$/.test(col4) || col4 === 'N/A' || col4 === 'DUP';
    const col5LooksLikeScore = /^\d+\.?\d*\/5$/.test(col5) || col5 === 'N/A' || col5 === 'DUP';
    const col4LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)/i.test(col4);
    const col5LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)/i.test(col5);

    let statusCol, scoreCol;
    if (col4LooksLikeStatus && !col4LooksLikeScore) {
      // Standard format: col4=status, col5=score
      statusCol = col4; scoreCol = col5;
    } else if (col4LooksLikeScore && col5LooksLikeStatus) {
      // Swapped format: col4=score, col5=status
      statusCol = col5; scoreCol = col4;
    } else if (col5LooksLikeScore && !col4LooksLikeScore) {
      // col5 is definitely score → col4 must be status
      statusCol = col4; scoreCol = col5;
    } else {
      // Default: standard format (status before score)
      statusCol = col4; scoreCol = col5;
    }

    let resumeMdCol = '';
    let finalScoreCol = '';
    let pdfCol = parts[6];
    let reportCol = parts[7];
    let jdCol = '';
    let notesCol = parts[8] || '';
    let locationCol = (parts[9] || '').trim();

    // Expanded tracker-addition TSV:
    // num date company role status score resume-md final-score pdf report jd notes [location]
    // Keep this before the legacy JD parser so `pdf`/`report` do not shift into
    // the wrong fields once resume-md/final-score are present.
    const hasExpandedResumeLayout = parts.length >= 12 && (
      looksLikeResumeMdPath(parts[6]) ||
      parts[6].trim() === '' ||
      parts[6].trim() === '—'
    ) && looksLikePdfCell(parts[8]);
    if (hasExpandedResumeLayout) {
      resumeMdCol = parts[6] || '';
      finalScoreCol = parts[7] || '';
      pdfCol = parts[8] || '';
      reportCol = parts[9] || '';
      jdCol = parts[10] || '';
      notesCol = parts[11] || '';
      locationCol = (parts[12] || '').trim();
    } else if (parts.length >= 10 && (looksLikeJdPath(parts[8]) || parts[8].trim() === '')) {
      jdCol = parts[8];
      notesCol = parts[9] || '';
      locationCol = (parts[10] || '').trim();
    }

    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      status: validateStatus(statusCol),
      score: scoreCol,
      resumeMd: resumeMdCol,
      finalScore: finalScoreCol,
      pdf: pdfCol,
      report: reportCol,
      jd: jdCol,
      notes: notesCol,
      // Optional trailing field: tab-separated TSVs may append a location.
      location: locationCol,
    };
  }

  if (isNaN(addition.num) || addition.num === 0) {
    console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  return addition;
}

// ---- Main ----

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to merge into.');
  process.exit(0);
}
let appContent = readFileSync(APPS_FILE, 'utf-8');
const schemaMigration = ensureJdColumn(appContent);
if (schemaMigration.changed) {
  appContent = schemaMigration.content;
  if (!DRY_RUN) writeFileAtomic(APPS_FILE, appContent);
  console.log('🧾 Added JD column to tracker schema.');
}
const schemaMigration2 = ensureResumeAndScoreColumns(appContent);
if (schemaMigration2.changed) {
  appContent = schemaMigration2.content;
  if (!DRY_RUN) writeFileAtomic(APPS_FILE, appContent);
  console.log('🧾 Added resume-md and final-score columns to tracker schema.');
}
// Test-only synchronization hook: the concurrent merge test waits for the
// first worker to read the tracker while still holding the lock, then starts a
// second worker to prove the lock prevents the old lost-update race.
if (MERGE_READY_IPC && typeof process.send === 'function') {
  process.send({ type: 'merge-tracker-ready' });
}
if (MERGE_HOLD_MS > 0) {
  await sleep(MERGE_HOLD_MS);
}

// One-time migration: rewrite existing report links so they resolve relative
// to the tracker file's directory (see #760). Run with: node merge-tracker.mjs --migrate
if (MIGRATE) {
  const migrated = appContent
    .split('\n')
    .map(line => (line.startsWith('|') ? normalizeReportLink(line) : line));
  const before = appContent.split('\n');
  const changed = migrated.filter((l, i) => l !== before[i]).length;

  if (DRY_RUN) {
    console.log(`🔎 Migration (dry-run): ${changed} row(s) would be rewritten in ${basename(APPS_FILE)}`);
  } else {
    writeFileAtomic(APPS_FILE, migrated.join('\n'));
    console.log(`✅ Migration: rewrote ${changed} report link(s) in ${basename(APPS_FILE)} relative to ${TRACKER_DIR === CAREER_OPS ? 'repo root' : 'data/'}`);
  }
  process.exit(0);
}

const appLines = appContent.split('\n');
// Detect the tracker's column layout via header names so parsing and writing
// both work whether the table uses the original 9-column layout or a customized
// one (e.g. with a Location column after Role). Falls back to the legacy layout.
COLMAP = detectColumns(appLines) || LEGACY_COLMAP;
if (COLMAP.location != null) console.log('🧭 Detected Location column.');
const existingApps = [];
let maxNum = 0;

for (const line of appLines) {
  if (line.startsWith('|') && !line.includes('---') && !line.includes('Empresa')) {
    const app = parseAppLine(line);
    if (app) {
      existingApps.push(app);
      if (app.num > maxNum) maxNum = app.num;
    }
  }
}

console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  const numA = parseInt(a.replace(/\D/g, '')) || 0;
  const numB = parseInt(b.replace(/\D/g, '')) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

let added = 0;
let updated = 0;
let skipped = 0;
const newLines = [];

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseTsvContent(content, file);
  if (!addition) { skipped++; continue; }

  // Normalize the report link to be relative to the tracker file's directory.
  // The TSV convention carries a root-relative `reports/...` link; rewrite it
  // so it resolves correctly when clicked from applications.md (see #760).
  addition.report = normalizeReportLink(addition.report);
  addition.jd = normalizeJdLink(addition.jd);
  addition.resumeMd = normalizeResumeMdLink(addition.resumeMd);

  // Check for duplicate by:
  // 1. Exact report number match
  // 2. Company + role fuzzy match
  const reportNum = extractReportNum(addition.report);
  let duplicate = null;

  if (reportNum) {
    // Report-number match must also confirm company (#912). Report-file
    // sequence and tracker-row sequence are independent, so the same number
    // appearing for two different companies is sequence drift, not a duplicate.
    // Without the company guard, a NewCo TSV with report [1] silently overwrites
    // the existing tracker row [1] belonging to an unrelated company.
    const normCompany = normalizeCompany(addition.company);
    duplicate = existingApps.find(app => {
      const existingReportNum = extractReportNum(app.report);
      return existingReportNum === reportNum && normalizeCompany(app.company) === normCompany;
    });
  }

  if (!duplicate) {
    // Exact entry number match — but only when the company also matches.
    // The TSV `num` doubles as the tracker row id, yet report-file numbering
    // and tracker-row numbering can drift out of sync (e.g. reports maxed at
    // 067 while the tracker was already at #69). A bare num collision across
    // *different* companies is that drift, not a duplicate — matching on num
    // alone silently merges a brand-new role into an unrelated existing row.
    const normCompany = normalizeCompany(addition.company);
    duplicate = existingApps.find(app =>
      app.num === addition.num && normalizeCompany(app.company) === normCompany
    );
  }

  if (!duplicate) {
    // Company + role fuzzy match
    const normCompany = normalizeCompany(addition.company);
    duplicate = existingApps.find(app => {
      if (normalizeCompany(app.company) !== normCompany) return false;
      return roleFuzzyMatch(addition.role, app.role);
    });
  }

  if (duplicate) {
    const newScore = parseScore(addition.score);
    const oldScore = parseScore(duplicate.score);

    if (newScore > oldScore) {
      console.log(`🔄 Update: #${duplicate.num} ${addition.company} — ${addition.role} (${oldScore}→${newScore})`);
      const lineIdx = appLines.indexOf(duplicate.raw);
      if (lineIdx >= 0) {
        const updatedLine = buildRow({
          num: duplicate.num, date: addition.date, company: addition.company, role: addition.role,
          location: addition.location || duplicate.location || '—',
          score: addition.score, status: duplicate.status,
          resumeMd: addition.resumeMd || duplicate.resumeMd || '—',
          finalScore: addition.finalScore || duplicate.finalScore || '—',
          pdf: duplicate.pdf,
          report: addition.report,
          jd: addition.jd || duplicate.jd || '',
          notes: `Re-eval ${addition.date} (${oldScore}→${newScore}). ${addition.notes}`,
        });
        appLines[lineIdx] = updatedLine;
        updated++;
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (existing #${duplicate.num} ${oldScore} >= new ${newScore})`);
      skipped++;
    }
  } else {
    // New entry — use the number from the TSV
    const entryNum = addition.num > maxNum ? addition.num : ++maxNum;
    if (addition.num > maxNum) maxNum = addition.num;

    const newLine = buildRow({
      num: entryNum, date: addition.date, company: addition.company, role: addition.role,
      location: addition.location || '—',
      score: addition.score, status: addition.status,
      resumeMd: addition.resumeMd || '—',
      finalScore: addition.finalScore || '—',
      pdf: addition.pdf,
      report: addition.report, jd: addition.jd || '', notes: addition.notes,
    });
    newLines.push(newLine);
    added++;
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
  }
}

// Insert new lines after the header (line index of first data row)
if (newLines.length > 0) {
  // Find header separator (|---|...) and insert after it
  let insertIdx = -1;
  for (let i = 0; i < appLines.length; i++) {
    if (appLines[i].includes('---') && appLines[i].startsWith('|')) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx >= 0) {
    appLines.splice(insertIdx, 0, ...newLines);
  }
}

// Write back
if (!DRY_RUN) {
  writeFileAtomic(APPS_FILE, appLines.join('\n'));

  // Move processed files to merged/
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');
trackerLock.release();

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [join(CAREER_OPS, 'verify-pipeline.mjs')], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
