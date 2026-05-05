---
name: ocr-tesseract
description: Extract text from image or PDF files with Tesseract OCR. Use when the task requires reading screenshots, scans, receipts, or image-based documents.
---

# OCR Tesseract

This is a bundled MiniOS skill for OCR tasks. Prefer this skill when a file is image-based or a PDF has no usable embedded text.

## Capabilities

- OCR on PNG, JPG, JPEG, TIFF, BMP, WEBP
- OCR in Simplified Chinese and English
- Plain text extraction into stdout or a target file

## Runtime Notes

- The container image preinstalls `tesseract-ocr`
- The image also preinstalls:
  - `tesseract-ocr-chi-sim`
  - `tesseract-ocr-eng`

## Usage

Use the helper script:

```bash
python bundled-skills/ocr-tesseract/scripts/ocr_extract.py <input-file>
```

Write OCR output to a file:

```bash
python bundled-skills/ocr-tesseract/scripts/ocr_extract.py <input-file> --output result.txt
```

Override OCR languages:

```bash
python bundled-skills/ocr-tesseract/scripts/ocr_extract.py <input-file> --lang chi_sim+eng
```

## Guidance

1. Prefer OCR only when normal text extraction is unavailable or poor.
2. Keep outputs in the current agent workspace when saving results.
3. If OCR quality is low, ask for a higher-resolution image or a cleaner scan.
