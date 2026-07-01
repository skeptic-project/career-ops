---
type: epic
id: 001
status: dev-done
owner: product
tags:
  - dev-done
  - career-ops
  - jd-persistence
  - pipeline-integrity
---

# Epic 001: Persist Job Descriptions and Link Them Across Career-Ops

## Problem

Career-ops currently evaluates and tracks jobs, but the original job description can be lost or remain tied only to an external URL. This creates weak auditability: reports, tracker rows, scan history, and pipeline entries may not all point to the exact JD text that was evaluated.

## Goal

When `career-ops` runs with `scan` or with a job-description URL argument, the extracted job description should be persisted once as Markdown under `jds/`, then referenced consistently from pipeline, scan history, tracker additions, merged tracker rows, and reports.

## Scope

- Store extracted JD Markdown at `jds/<company-name>-<role>.md`.
- Add or update `data/pipeline.md` entries using `local:jds/<company-name>-<role>.md | Company | Role`.
- Add a `jd_path` reference to `data/scan-history.tsv`; preserve compatibility with the current 7-column format.
- Update tracker-addition TSV generation so JD path is carried through the evaluation workflow in a documented 10-column format.
- Update `merge-tracker.mjs` and shared tracker readers so `data/applications.md` preserves a `JD` column after `Report`.
- Ensure `data/applications.md` stores tracker-relative JD paths such as `../jds/<company-name>-<role>.md`.

## Engineering Findings

- `modes/pipeline.md` already documents `local:` input support, and `modes/scan.md` already mentions private URLs saved under `jds/`; implementation must align code with those docs.
- `scan.mjs` currently writes pipeline rows from `formatPipelineOffer()` and scan-history rows from `formatScanHistoryRow()` using `url`, not a persisted JD path.
- `data/scan-history.tsv` is currently written as 7 columns: `url`, `first_seen`, `portal`, `title`, `company`, `status`, `location`.
- `tracker-parse.mjs` already maps tracker columns by header name, which should make the `JD` column safe for many readers once `jd` is added to `HEADER_ALIASES`.
- `verify-pipeline.mjs` still carries its own local header map and must be updated separately or refactored to use `tracker-parse.mjs`.
- `merge-tracker.mjs` already supports optional `location`; JD should follow the same header-aware pattern.

## Non-Goals

- Do not submit applications automatically.
- Do not rewrite existing CV or profile content.
- Do not change evaluation scoring logic except where JD persistence is needed for provenance.

## Acceptance Criteria

- A scanned or URL-evaluated job produces a Markdown JD file in `jds/`.
- The same JD file path is visible in `data/pipeline.md`, `data/scan-history.tsv`, tracker addition TSVs, and `data/applications.md`.
- `merge-tracker.mjs` accepts both old tracker-addition rows without JD and new rows with JD.
- Existing tracker rows can be migrated or rendered without breaking.
- `node verify-pipeline.mjs` passes after adding and merging a JD-backed evaluation.

## Dev-Done Tasks

- [Task 001.01: Persist extracted JD Markdown](001.01-persist-extracted-jd.md)
- [Task 001.02: Reference local JD files from pipeline entries](001.02-pipeline-local-jd-reference.md)
- [Task 001.03: Add JD path to scan history](001.03-scan-history-jd-column.md)
- [Task 001.04: Carry JD path through tracker TSV generation](001.04-tracker-tsv-jd-field.md)
- [Task 001.05: Add JD column to applications tracker merge](001.05-applications-jd-column.md)
