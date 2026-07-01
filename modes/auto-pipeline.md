# Mode: auto-pipeline — Full Automatic Pipeline

When the user pastes a JD (text or URL) without an explicit sub-command, execute the ENTIRE pipeline in sequence:

## Step 0 — Extract JD

If the input is a **URL** (not pasted JD text), follow this strategy to extract the content:

**Priority order:**

1. **Playwright (preferred):** Most job portals (Lever, Ashby, Greenhouse, Workday) are SPAs. Use `browser_navigate` + `browser_snapshot` to render and read the JD.
2. **WebFetch (fallback):** For static pages (ZipRecruiter, WeLoveProduct, company career pages).
3. **WebSearch (last resort):** Search for the role title + company in secondary portals that index the JD in static HTML.

**If no method works:** Ask the candidate to paste the JD manually or share a screenshot.

**If the input is JD text** (not a URL): use directly, without needing to fetch.

## Step 0.5 — Liveness gate

Before running any evaluation, confirm the posting is still live. The Step 0 Playwright snapshot already holds the evidence — judge it now, before spending tokens on the A-G evaluation, the report, or a PDF. A 404/expired page silently served as a static fallback ("position filled", empty shell) otherwise scores a full evaluation against phantom content.

1. From the Step 0 snapshot/fetched content, classify the posting:
   - **active posting evidence:** title/role + a real job description or an application/apply path
   - **closed posting evidence:** expired/closed/"no longer accepting applications", missing JD with only nav/footer, hard redirect to a generic careers/search page, or 404/410
2. If the posting appears closed or the page is a dead/fallback shell, **stop here**: do not run Step 1–Step 4. Tell the candidate the link is dead, and if the entry came from `data/pipeline.md`, mark it `- [x] ~~Company | Role~~ — oferta nieaktywna`.
3. If only JD text was pasted (no URL), there is no link to verify — skip the gate and proceed.

Do not continue to Step 1 until this gate is resolved.

## Step 1 — A-G Evaluation

Execute the same as the `oferta` mode (read `modes/oferta.md` for all A-F blocks + Block G Posting Legitimacy).

The evaluation inherits `oferta`'s bounded research budget. Company, compensation, and hiring-signal lookup must not invoke `deep-research`, must not spawn subagents, and must stop at the shared query cap instead of escalating into open-ended research.

## Step 2 — Save Report .md

Save the full evaluation in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (see format in `modes/oferta.md`).
Include Block G in the saved report. Add **URL:** {url} and **Legitimacy:** {tier} to the report header.
If the input was a URL, save the extracted JD Markdown under `jds/{company-role}.md` and carry that path into tracker TSV column `jd`.

## Step 2.5 — Generate Tailored Resume Markdown & Calculate final-score (if generating PDF)

If the evaluation score is high enough to trigger PDF generation (score >= `auto_pdf_score_threshold` in `config/profile.yml` or defaults to 3.0):
1. **Generate tailored resume Markdown through `resume-md` mode:** Execute the `modes/resume-md.md` workflow for this JD. Do not use deterministic keyword appending from `resume-md-core.mjs` as a substitute. The agent must decide the tailoring changes and apply them as targeted string replacements.
2. **Save tailored resume Markdown:** Save it at `output/cv-{candidate}-{company}.md`.
3. **Calculate final-score:** Re-evaluate the JD against this tailored Markdown resume (rather than base `cv.md`) to calculate the `final-score`.
4. **Include in Tracker:** Update the `resume-md` column in the tracker TSV addition with this file path, and the `final-score` column with this new score.
5. **PDF Generation Base:** Use this newly generated tailored Markdown resume as the base content when generating the PDF resume in Step 3.

## Step 3 — Generate PDF

Read `config/profile.yml`. Check `cv.output_format`:

- If `"latex"`, execute the full pipeline from `modes/latex.md`
- Otherwise (default), execute the full pipeline from `modes/pdf.md`

## Step 4 — Draft Application Answers (only if score >= 4.5)

If the final score is >= 4.5, generate a draft of responses for the application form:

1. **Extract form questions**: Use Playwright to navigate to the form and take a snapshot. If they cannot be extracted, use the generic questions.
2. **Generate responses** following the tone (see below).
3. **Save in the report** as section `## H) Draft Application Answers`.

### Generic questions (use if they cannot be extracted from the form)

- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement
- What makes you a good fit for this position?
- How did you hear about this role?

### Tone for Form Answers

**Position: "I'm choosing you."** The candidate has options and is choosing this company for specific reasons.

**Tone rules:**
- **Confident without arrogance**: "I've spent the past year building production AI agent systems — your role is where I want to apply that experience next"
- **Selective without arrogance**: "I've been intentional about finding a team where I can contribute meaningfully from day one"
- **Specific and concrete**: Always reference something REAL from the JD or the company, and something REAL from the candidate's experience
- **Direct, without fluff**: 2-4 sentences per response. No "I'm passionate about..." or "I would love the opportunity to..."
- **The hook is the proof, not the statement**: Instead of "I'm great at X", say "I built X that does Y"

**Framework per question:**
- **Why this role?** → "Your [specific thing] maps directly to [specific thing I built]."
- **Why this company?** → Mention something specific about the company. "I've been using [product] for [time/purpose]."
- **Relevant experience?** → A quantified proof point. "Built [X] that [metric]. Sold the company in 2025."
- **Good fit?** → "I sit at the intersection of [A] and [B], which is exactly where this role lives."
- **How did you hear?** → Honest: "Found through [portal/scan], evaluated against my criteria, and it scored highest."

**Language**: Always in the language of the JD (EN default). Apply `/tech-translate`.

## Step 5 — Update Tracker

Record it in `data/applications.md` with all columns populated. If a tailored Markdown resume and final-score were calculated in Step 2.5, include the path in the `resume-md` column (normalized relative to the tracker) and the score in the `final-score` column; otherwise use `—` for both.
Include the JD column when a local JD file exists.

**If any step fails**, continue with the next ones and mark the failed step as pending in the tracker.
