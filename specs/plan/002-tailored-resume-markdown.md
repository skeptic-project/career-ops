---
type: epic
id: 002
status: triage
owner: product
tags:
  - triage
  - career-ops
  - tailored-resume
  - resume-md
---

# Epic 002: Tailored Resume Markdown Support

## Problem

Currently, `career-ops` evaluates job postings and generates tailored resumes in HTML and PDF formats. However, some users require tailored resumes in Markdown (`.md`) format directly. Furthermore, we need to record the path of the tailored Markdown resume and re-evaluate the candidate's score specifically against this tailored resume rather than the generic base `cv.md` file.

## Goal

Add a `resume-md` argument to the `career-ops` command to generate and save tailored resumes in Markdown format, add tracking columns in `data/applications.md` for the tailored resume path and the final score, and perform a re-evaluation of the JD against the tailored resume to populate the final score.

## Scope

- Add `resume-md` command argument/mode supporting LLM resume tailoring.
- Save the tailored Markdown resume in the `output/` directory as `output/cv-{candidate}-{company}.md`.
- Preserve the exact layout, formatting, whitespace, heading levels, and structure of `cv.md` using targeted string replacements (`str_replace` operations) rather than rewriting the file.
- Add `resume-md` and `final-score` columns to `data/applications.md` and support them in `merge-tracker.mjs` and `verify-pipeline.mjs`.
- Re-evaluate the JD against the tailored resume Markdown file to calculate the final score and record it.
- Integrate the same Markdown-resume generation into high-score auto-pipeline/PDF flows before PDF generation, then generate the PDF from the tailored Markdown content.
- Ensure tracker TSV generation carries `resume-md` and `final-score` through merge for both direct `resume-md` runs and URL/scan evaluations that proceed to PDF.

## Acceptance Criteria

- Running `career-ops` with `resume-md` argument successfully outputs the tailored Markdown file in `output/`.
- The tailored Markdown file preserves `cv.md`'s layout, structure, and formatting exactly.
- `data/applications.md` automatically migrates to include the `resume-md` and `final-score` columns.
- `merge-tracker.mjs` and `verify-pipeline.mjs` correctly parse and validate the new columns.
- Re-evaluating the JD against the tailored resume computes a final score and populates it.
- For a high-score job that triggers PDF generation, the pipeline generates `output/cv-{candidate}-{company}.md` first, evaluates that Markdown for `final-score`, then generates the PDF from the tailored Markdown resume.
- The tracker row for PDF-generating evaluations contains both `resume-md` and `final-score` before `PDF`.

## Triage Tasks

- [Task 002.01: Implement resume-md argument for career-ops command](002.01-resume-md-argument.md)
- [Task 002.02: Add applications tracker columns for resume-md and final-score](002.02-applications-tracker-columns.md)
- [Task 002.03: Re-evaluate and calculate final-score based on tailored resume md](002.03-tailored-resume-scoring.md)
- [Task 002.04: Generate tailored resume Markdown before high-score PDF generation](002.04-auto-pipeline-resume-md-before-pdf.md)
