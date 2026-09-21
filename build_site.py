#!/usr/bin/env python3
"""Build whatisapeptide.ai from the Peptide Playbook manuscript."""
import re, os, shutil, json, unicodedata
import markdown

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "playbook.md")
OUT = os.path.dirname(os.path.abspath(__file__))

raw = open(SRC).read()
raw = raw.split("FRONTMATTER", 1)[-1].lstrip("\n-").lstrip()

# ---------- split into chapters on H1 ----------
parts = re.split(r'^# (.+)$', raw, flags=re.M)
chapters = []
for i in range(1, len(parts), 2):
    chapters.append({"title": parts[i].strip(), "md": parts[i + 1].strip()})


def slugify(t):
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    t = re.sub(r'^Part\s+([IVX]+)\s*[-—–]\s*', r'part-\1-', t)
    t = re.sub(r'[^a-zA-Z0-9]+', '-', t).strip('-').lower()
    return t


for c in chapters:
    c["slug"] = slugify(c["title"])
    # short nav label
    m = re.match(r'Part\s+([IVX]+)\s*[-—–]\s*(.+)', c["title"])
    c["num"] = m.group(1) if m else None
    c["short"] = m.group(2) if m else c["title"]

RATINGS = ["APPROVED", "CLINICAL", "PRECLINICAL", "SPECULATIVE", "HISTORICAL"]


def render(md_text, is_refs=False):
    html = markdown.Markdown(extensions=["tables", "sane_lists", "attr_list"]).convert(md_text)

    # rating stamps: leading <strong>APPROVED.</strong> etc.
    def stamp(m):
        word = m.group(2).upper()
        if word not in RATINGS:
            return m.group(0)
        return ('<p><span class="stamp stamp--%s">%s</span>'
                % (word.lower(), word))
    html = re.sub(r'<p><strong>([A-Z]+)(\.)?</strong>\.?\s*', 
                  lambda m: ('<p><span class="stamp stamp--%s">%s</span> ' % (m.group(1).lower(), m.group(1)))
                  if m.group(1) in RATINGS else m.group(0), html)

    # mixed stamps like "CLINICAL for topical...; PRECLINICAL for injection."
    def inline_rating(m):
        w = m.group(1)
        return '<span class="rating rating--%s">%s</span>' % (w.lower(), w)
    html = re.sub(r'\b(APPROVED|CLINICAL|PRECLINICAL|SPECULATIVE|HISTORICAL)\b(?![^<]*</span>)',
                  inline_rating, html)

    # reference markers -> links (but on the references page itself, make them anchors)
    if is_refs:
        html = re.sub(r'<p>\[(\d+)\]\s*',
                      r'<p class="refitem" id="r\1"><span class="refnum">\1</span>', html)
    else:
        html = re.sub(r'\[(\d+)\]', r'<a class="ref" href="/references#r\1">[\1]</a>', html)

    # wrap tables so wide content scrolls inside its own container
    html = html.replace('<table>', '<div class="tablewrap"><table>').replace('</table>', '</table></div>')

    # rating cells in tables
    for r in RATINGS:
        html = html.replace('<td>%s</td>' % r.title(),
                            '<td><span class="rating rating--%s">%s</span></td>' % (r.lower(), r.title()))
    html = html.replace('<td>Clinical (RU)</td>',
                        '<td><span class="rating rating--clinical">Clinical</span> <span class="qual">RU</span></td>')
    return html


HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="What Is A Peptide">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="masthead">
  <a class="wordmark" href="/">What&nbsp;Is&nbsp;A&nbsp;Peptide</a>
  <nav class="masthead-nav">
    <a href="/#contents">Contents</a>
    <a href="/quick-reference">Compound index</a>
    <a href="/references">Sources</a>
  </nav>
</header>
"""

FOOT = """
<footer class="sitefoot">
  <p class="sitefoot-note">Educational and informational purposes only. Not medical advice, and not a
  recommendation to obtain or use any compound. Many substances described here are not approved for
  human use. This guide does not provide dosing for unapproved compounds.</p>
  <p class="sitefoot-meta">whatisapeptide.ai · <a href="/disclaimer">Full disclaimer</a> · <a href="/references">Sources</a></p>
</footer>
</body></html>"""


def sidebar(active_slug):
    rows = []
    for c in chapters:
        cls = ' class="on"' if c["slug"] == active_slug else ''
        label = ('<span class="pn">%s</span>%s' % (c["num"], c["short"])) if c["num"] else c["short"]
        rows.append('<li><a href="/%s"%s>%s</a></li>' % (c["slug"], cls, label))
    return '<nav class="sidebar" aria-label="Chapters"><ol>%s</ol></nav>' % "".join(rows)


os.makedirs(OUT, exist_ok=True)

# ---------- chapter pages ----------
for i, c in enumerate(chapters):
    body = render(c["md"], is_refs=(c["slug"]=="references"))
    prev_c = chapters[i - 1] if i > 0 else None
    next_c = chapters[i + 1] if i < len(chapters) - 1 else None
    pager = '<nav class="pager">'
    pager += ('<a class="pager-prev" href="/%s"><span>Previous</span>%s</a>' % (prev_c["slug"], prev_c["short"])) if prev_c else '<span></span>'
    pager += ('<a class="pager-next" href="/%s"><span>Next</span>%s</a>' % (next_c["slug"], next_c["short"])) if next_c else '<span></span>'
    pager += '</nav>'

    desc = re.sub(r'<[^>]+>', '', body)[:155].replace('"', '').strip()
    kicker = ('Part %s' % c["num"]) if c["num"] else 'The Peptide Playbook'
    page = HEAD.format(title=c["title"] + " — What Is A Peptide", desc=desc)
    page += '<div class="shell">' + sidebar(c["slug"])
    wide = " chapter--wide" if c["slug"] in ("quick-reference","references") else ""
    page += ('<main id="main" class="chapter%s">' % wide + '<p class="kicker">%s</p><h1>%s</h1>%s%s</main>'
             % (kicker, c["short"], body, pager))
    page += '</div>' + FOOT

    d = os.path.join(OUT, c["slug"])
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "index.html"), "w").write(page)

# ---------- landing page ----------
counts = [("APPROVED", 9, "Cleared by the FDA after large human trials."),
          ("CLINICAL", 13, "Published human trials exist and can be examined."),
          ("PRECLINICAL", 15, "Evidence is cells and animals. Most popular compounds sit here."),
          ("SPECULATIVE", 4, "Mechanism and theory, with little or no published data.")]
total = sum(c[1] for c in counts)

ramp = ""
for name, n, blurb in counts:
    pct = round(n / total * 100)
    ramp += ('<li class="tier tier--%s">'
             '<p class="tier-n">%d</p>'
             '<p class="tier-name">%s</p>'
             '<div class="tier-bar"><i style="width:%d%%"></i></div>'
             '<p class="tier-blurb">%s</p></li>') % (name.lower(), n, name, pct, blurb)

toc = ""
for c in chapters:
    label = ('<span class="pn">%s</span>' % c["num"]) if c["num"] else '<span class="pn pn--x">·</span>'
    toc += '<li><a href="/%s">%s<span class="tt">%s</span></a></li>' % (c["slug"], label, c["short"])

desc = ("An evidence-graded reference to peptides: what each compound is, what human research "
        "actually shows, and its current regulatory status. Sourced to FDA documents and "
        "peer-reviewed trials.")

idx = HEAD.format(title="What Is A Peptide — The Peptide Playbook", desc=desc)
idx += f"""
<main id="main">
<section class="hero">
  <h1>The Peptide Playbook</h1>
  <p class="lede">The word <em>peptide</em> covers insulin, which has saved lives for a century,
  and compounds sold online in vials labelled &ldquo;research use only&rdquo; whose entire human
  evidence base could be counted on two hands. This guide draws the line between them, compound
  by compound.</p>
</section>

<section class="ramp-wrap">
  <h2 class="ramp-head">Every compound in this guide, graded by what has actually been shown in humans</h2>
  <ol class="ramp">{ramp}</ol>
  <p class="ramp-foot">Ratings describe how much is known, not how promising something sounds.
  A low rating doesn&rsquo;t mean a compound is worthless &mdash; some of tomorrow&rsquo;s
  medicines sit at preclinical today. It means the certainty isn&rsquo;t there yet.</p>
</section>

<section class="promises">
  <h2>What this guide will not do</h2>
  <dl>
    <dt>It will not tell you what to take.</dt>
    <dd>That decision belongs with you and a licensed clinician who knows your history.</dd>
    <dt>It will not give injection protocols for unapproved compounds.</dt>
    <dd>For approved medicines we cite the label dose, because it came from trials and sits in a
    public regulatory document. For everything else there is no authoritative human dose, because
    the studies that would establish one have not been done.</dd>
    <dt>It will not sell you anything.</dt>
    <dd>No products, no affiliate links. Where evidence is weak we say so, including for
    bestsellers.</dd>
  </dl>
</section>

<section id="contents" class="contents">
  <h2>Contents</h2>
  <ol class="toc">{toc}</ol>
</section>
</main>
"""
idx += FOOT
open(os.path.join(OUT, "index.html"), "w").write(idx)

# ---------- favicon ----------
open(os.path.join(OUT, "favicon.svg"), "w").write(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    '<rect width="32" height="32" rx="6" fill="#1A1F1C"/>'
    '<path d="M7 20.5c2.2-9 4.4-9 6.6 0s4.4 9 6.6 0" fill="none" stroke="#7FB8A0" '
    'stroke-width="2.6" stroke-linecap="round"/>'
    '<circle cx="24.5" cy="11.5" r="2.2" fill="#C98A4B"/></svg>')

print("chapters:", len(chapters))
for c in chapters:
    print("  /%s" % c["slug"])
