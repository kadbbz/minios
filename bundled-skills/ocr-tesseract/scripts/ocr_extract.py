#!/usr/bin/env python3

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract text from an image with Tesseract OCR.")
    parser.add_argument("input_file", help="Path to the source image or PDF file")
    parser.add_argument("--output", help="Optional output text file path")
    parser.add_argument("--lang", default="chi_sim+eng", help="Tesseract language pack selection")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input_file).resolve()
    if not input_path.is_file():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 1

    command = [
        "tesseract",
        str(input_path),
        "stdout",
        "-l",
        args.lang,
    ]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        return result.returncode

    if args.output:
        output_path = Path(args.output).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(result.stdout, encoding="utf-8")
    else:
        sys.stdout.write(result.stdout)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
