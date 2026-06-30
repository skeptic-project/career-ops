---
type: epic
id: 001
status: triage
owner: product
tags:
  - triage
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
- Add a JD reference to `data/scan-history.tsv`, including schema migration if a new column is needed.
- Update tracker-addition TSV generation so JD path is carried through the evaluation workflow.
- Update `merge-tracker.mjs` so `data/applications.md` preserves a `JD` column after `Report`.
- Ensure `data/applications.md` stores tracker-relative JD paths such as `../jds/<company-name>-<role>.md`.

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

## Triage Tasks

- [Task 001.01: Persist extracted JD Markdown](001.01-persist-extracted-jd.md)
- [Task 001.02: Reference local JD files from pipeline entries](001.02-pipeline-local-jd-reference.md)
- [Task 001.03: Add JD path to scan history](001.03-scan-history-jd-column.md)
- [Task 001.04: Carry JD path through tracker TSV generation](001.04-tracker-tsv-jd-field.md)
- [Task 001.05: Add JD column to applications tracker merge](001.05-applications-jd-column.md)
