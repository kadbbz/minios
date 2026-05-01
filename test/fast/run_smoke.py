#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import platform
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable


@dataclass
class TestResult:
    name: str
    passed: bool
    duration_ms: int
    details: str


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def timestamp_label() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def create_output_dir(root: Path) -> Path:
    out_dir = root / ".tmp" / f"test-{timestamp_label()}"
    out_dir.mkdir(parents=True, exist_ok=False)
    return out_dir


def test_repository_layout(root: Path, _out_dir: Path) -> str:
    require((root / "doc").is_dir(), "missing doc/ directory")
    require((root / "doc" / "design").is_dir(), "missing doc/design/ directory")
    require((root / "test").is_dir(), "missing test/ directory")
    require((root / "test" / "fast").is_dir(), "missing test/fast/ directory")
    return "repository baseline directories are present"


def test_design_document_exists(root: Path, _out_dir: Path) -> str:
    design_doc = root / "doc" / "design" / "minios-detailed-design.md"
    require(design_doc.is_file(), "design document is missing")
    content = design_doc.read_text(encoding="utf-8")
    require(len(content) > 5000, "design document is unexpectedly short")
    for needle in ("MQTT", "Redis", "QMD", "Worker", "Session", "Memory"):
        require(needle in content, f"design document missing keyword: {needle}")
    return f"design doc found with {len(content)} characters"


def test_python_runtime(_root: Path, _out_dir: Path) -> str:
    require(sys.version_info >= (3, 10), "python 3.10+ is required")
    return f"python={platform.python_version()} platform={platform.platform()}"


def test_output_directory_is_writable(_root: Path, out_dir: Path) -> str:
    probe = out_dir / "write-probe.txt"
    payload = f"created_at={datetime.now().isoformat()}\n"
    probe.write_text(payload, encoding="utf-8")
    require(probe.read_text(encoding="utf-8") == payload, "output directory probe mismatch")
    return f"wrote {probe.name}"


def run_test(name: str, func: Callable[[Path, Path], str], root: Path, out_dir: Path) -> TestResult:
    started = time.perf_counter()
    try:
        details = func(root, out_dir)
        passed = True
    except Exception as exc:  # noqa: BLE001
        details = str(exc)
        passed = False
    duration_ms = int((time.perf_counter() - started) * 1000)
    return TestResult(name=name, passed=passed, duration_ms=duration_ms, details=details)


def write_summary(root: Path, out_dir: Path, results: list[TestResult], started_at: datetime, ended_at: datetime) -> None:
    passed = sum(1 for result in results if result.passed)
    failed = len(results) - passed

    summary = {
        "suite": "fast-smoke",
        "repoRoot": str(root),
        "outputDir": str(out_dir),
        "startedAt": started_at.isoformat(),
        "endedAt": ended_at.isoformat(),
        "passed": passed,
        "failed": failed,
        "results": [asdict(result) for result in results],
    }

    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    lines = [
        "MiniOS Fast Smoke Test Report",
        f"Started: {started_at.isoformat()}",
        f"Ended:   {ended_at.isoformat()}",
        f"Output:  {out_dir}",
        "",
        f"Passed: {passed}",
        f"Failed: {failed}",
        "",
    ]

    for result in results:
        status = "PASS" if result.passed else "FAIL"
        lines.append(f"[{status}] {result.name} ({result.duration_ms} ms)")
        lines.append(f"  {result.details}")

    (out_dir / "report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    root = repo_root()
    out_dir = create_output_dir(root)
    started_at = datetime.now()

    tests: list[tuple[str, Callable[[Path, Path], str]]] = [
        ("repository_layout", test_repository_layout),
        ("design_document_exists", test_design_document_exists),
        ("python_runtime", test_python_runtime),
        ("output_directory_is_writable", test_output_directory_is_writable),
    ]

    results = [run_test(name, func, root, out_dir) for name, func in tests]
    ended_at = datetime.now()
    write_summary(root, out_dir, results, started_at, ended_at)

    return 0 if all(result.passed for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
