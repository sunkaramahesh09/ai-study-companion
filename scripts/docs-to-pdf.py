"""
Renders a submission Markdown document to PDF.

Markdown -> HTML (python-markdown) -> PDF (headless Chrome) -> page numbers
stamped on with PyMuPDF.

WeasyPrint would have been the tidier route, but it needs GTK/pango native
libraries that are not installed here and Homebrew is blocked on this machine,
so Chrome — which is present — does the rendering. Chrome honours @page size
and margin but not the CSS paged-media margin boxes, hence the separate
stamping pass for "n / N".

Two things need care beyond a straight conversion:

1. ARCHITECTURE.md contains box-drawing diagrams up to ~150 columns wide. One
   fixed monospace size either clips them or shrinks the whole document, so
   every <pre> is measured and sized independently to fit the text column.
2. Relative links (DECISIONS.md, ../apps/api) are dead in a PDF. They are
   rewritten to absolute GitHub URLs so a reader can follow them.
"""
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

import markdown
import pymupdf

REPO = "https://github.com/sunkaramahesh09/ai-study-companion"
BLOB = f"{REPO}/blob/main"
LIVE = "https://ai-study-companion-ruby.vercel.app"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Text column width in points: A4 is 595pt wide, margins are 19mm a side.
COLUMN_PT = 595 - 2 * (19 * 72 / 25.4)
# Menlo / DejaVu Sans Mono advance width is ~0.602em.
CHAR_EM = 0.602
MAX_PRE_PT = 8.5
MIN_PRE_PT = 5.4


def rewrite_links(md: str) -> str:
    """Relative repo links -> absolute GitHub URLs, so they work from a PDF."""
    def repl(m: re.Match) -> str:
        target = m.group(1)
        if target.startswith(("http://", "https://", "#", "mailto:")):
            return m.group(0)
        if target.startswith("../"):
            return f"]({BLOB}/{target[3:]})"
        return f"]({BLOB}/docs/{target})"
    return re.sub(r"\]\(([^)]+)\)", repl, md)


LIST_ITEM = re.compile(r"^>\s*(?:[-*+]|\d+[.)])\s+")


def separate_quoted_lists(md: str) -> str:
    """Let a list inside a blockquote parse as a list.

    PROMPTS.md quotes real prompts verbatim, and a prompt typically writes a
    heading line straight onto its bullets with no blank line between:

        > TECH STACK - locked, do not suggest alternatives:
        > - Frontend: React + TypeScript

    Markdown treats those bullets as a lazy continuation of the paragraph, so
    the whole stack renders as one run-on sentence. Inserting the blank quote
    line the parser wants restores the structure without reflowing any prose.
    """
    out: list[str] = []
    for line in md.split("\n"):
        if (
            LIST_ITEM.match(line)
            and out
            and out[-1].startswith(">")
            and out[-1].strip() != ">"
            and not LIST_ITEM.match(out[-1])
        ):
            out.append(">")
        out.append(line)
    return "\n".join(out)


def fit_pre_blocks(html: str) -> str:
    """Size each code block so its widest line fits the column."""
    def repl(m: re.Match) -> str:
        body = m.group(2)
        plain = re.sub(r"<[^>]+>", "", body)
        plain = (plain.replace("&lt;", "<").replace("&gt;", ">")
                      .replace("&amp;", "&").replace("&quot;", '"'))
        widest = max((len(line) for line in plain.split("\n")), default=0)
        size = MAX_PRE_PT if widest == 0 else min(MAX_PRE_PT, COLUMN_PT / (widest * CHAR_EM))
        size = max(MIN_PRE_PT, size)
        return f'<pre style="font-size:{size:.2f}pt"{m.group(1)}>{body}</pre>'
    return re.sub(r"<pre([^>]*)>(.*?)</pre>", repl, html, flags=re.S)


CSS = """
@page { size: A4; margin: 18mm 19mm 16mm 19mm; }
html { font-size: 10.2pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  color: #1c1c22; line-height: 1.52; margin: 0;
}

.cover { break-after: page; padding-top: 52mm; }
.cover .eyebrow {
  font-size: 9pt; letter-spacing: .16em; text-transform: uppercase;
  color: #6d28d9; font-weight: 700; margin-bottom: 10mm;
}
.cover h1 { font-size: 30pt; line-height: 1.12; margin: 0 0 5mm; border: 0; padding: 0; }
.cover .sub { font-size: 12pt; color: #4a4a55; margin: 0 0 18mm; line-height: 1.45; }
.cover dl { font-size: 9.5pt; margin: 0; }
.cover dt {
  color: #8a8a94; font-size: 8pt; letter-spacing: .1em;
  text-transform: uppercase; margin-top: 5mm;
}
.cover dd { margin: 1mm 0 0; }

h1, h2, h3, h4 { font-weight: 700; break-after: avoid; line-height: 1.25; }
h1 { font-size: 19pt; margin: 0 0 6mm; padding-bottom: 2.5mm; border-bottom: 2px solid #6d28d9; }
h2 { font-size: 14pt; margin: 9mm 0 3mm; color: #2a1a5e; }
h3 { font-size: 11.5pt; margin: 6mm 0 2mm; }
h4 { font-size: 10.2pt; margin: 5mm 0 1.5mm; color: #4a4a55; }

p, ul, ol { margin: 0 0 3.2mm; }
li { margin-bottom: 1.2mm; }
strong { color: #10101a; }
a { color: #5b21b6; text-decoration: none; }
hr { border: 0; border-top: 1px solid #ddd; margin: 7mm 0; }

code {
  font-family: Menlo, "DejaVu Sans Mono", monospace;
  font-size: 8.6pt; background: #f4f2fb; padding: 0.4mm 1.1mm;
  border-radius: 2px; color: #3b1f8f;
}
pre {
  font-family: Menlo, "DejaVu Sans Mono", monospace;
  background: #f8f7fc; border: 1px solid #e6e3f2; border-left: 3px solid #6d28d9;
  border-radius: 3px; padding: 3mm 3.5mm; margin: 0 0 4mm;
  line-height: 1.34; white-space: pre; break-inside: avoid;
}
pre code { background: none; padding: 0; font-size: inherit; color: #1c1c22; }

table { border-collapse: collapse; width: 100%; margin: 0 0 4.5mm; font-size: 8.7pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th {
  background: #f1eefb; text-align: left; font-weight: 700;
  border: 1px solid #ddd8ee; padding: 1.7mm 2.2mm; color: #2a1a5e;
}
td { border: 1px solid #e6e3f2; padding: 1.7mm 2.2mm; vertical-align: top; }
td code, th code { font-size: 8pt; }

blockquote {
  margin: 0 0 4mm; padding: 1mm 0 1mm 4mm;
  border-left: 3px solid #d9d3f0; color: #4a4a55;
}
em { color: #3f3f4a; }
"""

COVER = """
<div class="cover">
  <div class="eyebrow">{eyebrow}</div>
  <h1>{title}</h1>
  <div class="sub">{sub}</div>
  <dl>
    <dt>Project</dt><dd>AI Study Companion (AI.Prof)</dd>
    <dt>Author</dt><dd>Sunkara Mahesh</dd>
    <dt>Repository</dt><dd><a href="{repo}">{repo}</a></dd>
    <dt>Deployed application</dt><dd><a href="{live}">{live}</a></dd>
    <dt>Generated</dt><dd>{today}</dd>
  </dl>
</div>
"""


def stamp_page_numbers(pdf_path: Path) -> int:
    """Chrome ignores CSS margin boxes, so the footer is drawn afterwards."""
    doc = pymupdf.open(pdf_path)
    total = doc.page_count
    for i, page in enumerate(doc):
        if i == 0:
            continue  # the cover carries no number
        label = f"{i + 1} / {total}"
        width = pymupdf.get_text_length(label, fontname="helv", fontsize=8)
        page.insert_text(
            pymupdf.Point((page.rect.width - width) / 2, page.rect.height - 28),
            label, fontname="helv", fontsize=8, color=(0.54, 0.54, 0.58),
        )
    doc.save(pdf_path.with_suffix(".stamped.pdf"))
    doc.close()
    shutil.move(pdf_path.with_suffix(".stamped.pdf"), pdf_path)
    return total


def convert(src: Path, out: Path, title: str, eyebrow: str, sub: str) -> None:
    md_text = separate_quoted_lists(rewrite_links(src.read_text()))
    # The H1 is replaced by the cover page, so drop it from the body.
    md_text = re.sub(r"\A#\s+.*?\n", "", md_text, count=1)

    body = fit_pre_blocks(
        markdown.markdown(
            md_text,
            extensions=["extra", "sane_lists", "admonition"],
            output_format="html5",
        )
    )
    cover = COVER.format(
        eyebrow=eyebrow, title=title, sub=sub, repo=REPO, live=LIVE,
        today=date.today().strftime("%-d %B %Y"),
    )
    html = (
        f"<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{title}</title><style>{CSS}</style></head>"
        f"<body>{cover}{body}</body></html>"
    )

    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "doc.html"
        page.write_text(html)
        # Chrome writes the PDF and then, with the newer headless mode, can sit
        # there without exiting. Poll for the file and kill it rather than
        # waiting out a timeout that the work has already finished inside.
        out.unlink(missing_ok=True)
        proc = subprocess.Popen(
            [CHROME, "--headless", "--disable-gpu", "--no-sandbox",
             f"--user-data-dir={tmp}/profile", "--no-pdf-header-footer",
             f"--print-to-pdf={out}", page.as_uri()],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 120
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            # Written AND stable: a non-zero size that has not changed in half a
            # second is a finished file, not one still being flushed.
            if out.exists() and out.stat().st_size > 0:
                size = out.stat().st_size
                time.sleep(0.5)
                if out.exists() and out.stat().st_size == size:
                    proc.terminate()
                    break
            time.sleep(0.25)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if not out.exists() or out.stat().st_size == 0:
            raise RuntimeError(f"Chrome produced no PDF for {src}")
    pages = stamp_page_numbers(out)
    print(f"{out.name}: {pages} pages, {out.stat().st_size / 1024:.0f} KB")


DOCS = [
    ("docs/ARCHITECTURE.md", "1-Architecture-Documentation.pdf",
     "Architecture Documentation", "Submission requirement 20.4",
     "System diagram, layer boundaries, data model, request flows, and the major "
     "architectural decisions with what was rejected in each case."),
    ("docs/AI_USAGE.md", "2-AI-Tools-and-Usage-Documentation.pdf",
     "AI Tools and Usage Documentation", "Submission requirement 20.5",
     "AI used to build the product, and AI used by the product, kept strictly apart."),
    ("docs/PROMPTS.md", "3-AI-Prompts-Used-During-Development.pdf",
     "AI Prompts Used During Development", "Submission requirement 20.6",
     "The actual prompts used with AI development tools, recovered from the session "
     "transcripts rather than written from memory."),
]

if __name__ == "__main__":
    # Default: all three submission documents into the given directory.
    #   python3 scripts/docs-to-pdf.py ~/Desktop/submission
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else "submission-pdfs")
    dest.mkdir(parents=True, exist_ok=True)
    for src, name, title, eyebrow, sub in DOCS:
        convert(Path(src), dest / name, title, eyebrow, sub)
