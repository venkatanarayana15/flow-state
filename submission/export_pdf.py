"""Export the built deck to PDF via the installed PowerPoint.

The submission form asks for a presentation *file*, and a .pptx upload is not
always accepted — some forms take only a PDF. This converts the deck the build
script produced, so the PDF and the pptx never drift apart.

    python submission/build_deck.py     # regenerate the deck
    python submission/export_pdf.py     # regenerate the PDF

Requires PowerPoint (COM automation) and pywin32. If PowerPoint is not
installed, upload the .pptx directly or convert it on any machine that has it.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "PayFlow-FlowState-Deck.pptx")
DST = os.path.join(HERE, "PayFlow-FlowState-Deck.pdf")

# PowerPoint's SaveAs format code for PDF.
ppSaveAsPDF = 32


def main():
    if not os.path.exists(SRC):
        sys.exit(f"no deck at {SRC} — run submission/build_deck.py first")
    if os.path.exists(DST):
        os.remove(DST)

    import win32com.client  # imported here so the error is unambiguous

    app = win32com.client.Dispatch("PowerPoint.Application")
    pres = None
    try:
        # ReadOnly, Untitled, WithWindow. PowerPoint refuses to open a file
        # with no window in some builds, so retry with a window before giving up.
        try:
            pres = app.Presentations.Open(SRC, True, False, False)
        except Exception:
            pres = app.Presentations.Open(SRC, True, False, True)
        pres.SaveAs(DST, ppSaveAsPDF)
        slides = pres.Slides.Count
    finally:
        if pres is not None:
            pres.Close()
        app.Quit()

    size = os.path.getsize(DST)
    if size == 0:
        sys.exit("PowerPoint wrote an empty PDF")
    print(f"wrote {DST}  ({slides} slides, {size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
