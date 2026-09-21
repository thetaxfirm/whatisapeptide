# whatisapeptide.ai

The Peptide Playbook — an evidence-graded reference guide to peptides.

A static site. Every compound is graded by the strength of its published **human**
evidence (Approved / Clinical / Preclinical / Speculative) and labelled with its
current regulatory status. Factual claims about FDA action are sourced to the
agency's own documents rather than secondary commentary.

## Editorial rules

- No dosing is published for compounds that are not FDA-approved, because no
  authoritative human dosing data exists for them.
- Nothing is sold here. No products, no affiliate links.
- Regulatory status changes; statements are accurate as of the build date and
  should be re-checked against the primary sources in `/references`.

## Structure

```
playbook.md        Source manuscript — the single source of truth
build_site.py      Static site generator (markdown -> HTML)
index.html         Landing page
<chapter>/         One directory per chapter, each with index.html
style.css          Stylesheet
vercel.json        Clean URLs + security headers
sitemap.xml        Generated at build time
```

## Editing

Edit `playbook.md`, then regenerate:

```bash
pip install markdown
python3 build_site.py
```

The generator splits the manuscript on `#` headings into chapters, converts the
`APPROVED` / `CLINICAL` / `PRECLINICAL` / `SPECULATIVE` leads into rating stamps,
and turns `[n]` markers into links to the matching entry on `/references`.

## Deploying

Pushes to `main` deploy automatically via Vercel. No build step is required —
the repository root is the site root.
