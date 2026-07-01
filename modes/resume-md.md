# Mode: resume-md — Tailored Markdown Resume Generation

## Full pipeline

1. Read `cv.md` as the source of truth.
2. Ask the user for the JD if it is not in context (text or URL).
3. If the JD was passed as a URL, extract it first (using Playwright browser navigation or WebFetch).
4. Save the job description under `jds/<company-name>-<role>.md` if a URL was evaluated.
5. Personalize/tailor the CV content to the JD:
   - Identify the most relevant achievements, keywords, and framing adjustments needed based on the JD.
   - Use `cv.md` as the exact base.
   - Preserve all markdown formatting, whitespace, heading levels, and structure exactly.
   - While applying changes, use **targeted string replacements (targeted `str_replace` operations)** — never rewrite the file from scratch!
6. Produce an explicit replacement plan before writing files. Each replacement MUST contain:
   ```json
   {
     "before": "exact text copied from cv.md",
     "after": "replacement text",
     "reason": "JD requirement addressed",
     "source": "CV/JD evidence used",
     "risk": "overstatement risk or 'none'"
   }
   ```
   Validation rules:
   - `before` must appear exactly once in `cv.md`.
   - `after` must only reformulate sourced claims; never add unsupported metrics, tools, employers, projects, or authorship.
   - Heading order and markdown structure must remain unchanged.
   - Top-level sections must not be added or removed unless the user explicitly approves.
7. Apply the replacement plan using targeted edits. The deterministic scripts may validate/apply a plan, but they must not generate resume content by appending JD keywords.
8. Read candidate `name` from `config/profile.yml` → normalize to kebab-case lowercase (e.g. "John Doe" → "john-doe") → `{candidate}`.
9. Extract the company name from the JD/URL and normalize to lowercase kebab-case `{company}`.
10. Store the tailored Markdown resume at `output/cv-{candidate}-{company}.md`.
11. Calculate the score of the tailored resume:
   - Perform the A-G evaluation blocks on the job description against this newly generated tailored resume markdown file.
   - Output the A-G evaluation blocks and summary.
   - The score computed here is the **final-score**.
12. Save the standard evaluation report in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.
13. Write a TSV addition to `batch/tracker-additions/{num}-{company-slug}.tsv` using a header-based schema:
    ```tsv
    num	date	company	role	status	score	resume-md	final-score	pdf	report	jd	notes
    {num}	{date}	{company}	{role}	Evaluated	{score}/5	output/cv-{candidate}-{company}.md	{final-score}/5	❌	[num](reports/{filename})	jds/{company-role}.md	Tailored markdown resume generated
    ```
14. Run `node merge-tracker.mjs` to merge the addition into `data/applications.md`.
15. Output the path of the generated Markdown file, the initial score, the final score, and the improvement difference.

## Important

`resume-md-core.mjs` is not a content generator. It may be used only for safe utilities such as path building, metadata handling, scoring diagnostics, and applying an agent-produced replacement plan. Do not use deterministic keyword appending as a substitute for this mode.
