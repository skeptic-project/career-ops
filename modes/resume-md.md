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
6. Read candidate `name` from `config/profile.yml` → normalize to kebab-case lowercase (e.g. "John Doe" → "john-doe") → `{candidate}`.
7. Extract the company name from the JD/URL and normalize to lowercase kebab-case `{company}`.
8. Store the tailored Markdown resume at `output/cv-{candidate}-{company}.md`.
9. Calculate the score of the tailored resume:
   - Perform the A-G evaluation blocks on the job description against this newly generated tailored resume markdown file.
   - Output the A-G evaluation blocks and summary.
   - The score computed here is the **final-score**.
10. Save the standard evaluation report in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.
11. Write a TSV addition to `batch/tracker-additions/{num}-{company-slug}.tsv` using a header-based schema:
    ```tsv
    num	date	company	role	status	score	resume-md	final-score	pdf	report	jd	notes
    {num}	{date}	{company}	{role}	Evaluated	{score}/5	output/cv-{candidate}-{company}.md	{final-score}/5	❌	[num](reports/{filename})	jds/{company-role}.md	Tailored markdown resume generated
    ```
12. Run `node merge-tracker.mjs` to merge the addition into `data/applications.md`.
13. Output the path of the generated Markdown file, the initial score, the final score, and the improvement difference.
