# Fonts

This repo includes a redistributable CJK font to avoid garbled Chinese text in generated PDFs.

- File: `./fonts/NotoSansCJKsc-Regular.otf`
- License: SIL Open Font License 1.1 (see `./fonts/OFL.txt`)

If you generate PDFs that include Chinese (CJK) text, set in `.env`:

- `PDF_CJK_FONT_PATH=./fonts/NotoSansCJKsc-Regular.otf`
