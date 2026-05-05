#!/usr/bin/env python3

from __future__ import annotations

import json
import platform
import subprocess
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


def test_bundled_skills_exist(root: Path, _out_dir: Path) -> str:
    skill_dir = root / "bundled-skills" / "ocr-tesseract"
    skill_md = skill_dir / "SKILL.md"
    script_path = skill_dir / "scripts" / "ocr_extract.py"
    require(skill_dir.is_dir(), "ocr bundled skill directory is missing")
    require(skill_md.is_file(), "ocr bundled skill SKILL.md is missing")
    require(script_path.is_file(), "ocr bundled skill script is missing")
    content = skill_md.read_text(encoding="utf-8")
    require("tesseract-ocr" in content, "ocr skill description missing tesseract reference")
    return "ocr bundled skill exists with skill definition and helper script"


def test_bootstrap_skills_exist(root: Path, _out_dir: Path) -> str:
    bootstrap_dir = root / "bootstrap-skills" / "file-transfer-bootstrap"
    skill_md = bootstrap_dir / "SKILL.md"
    require(bootstrap_dir.is_dir(), "bootstrap skill directory is missing")
    require(skill_md.is_file(), "bootstrap skill SKILL.md is missing")
    content = skill_md.read_text(encoding="utf-8")
    require("every agent session automatically" in content, "bootstrap skill missing auto-load contract")
    return "bootstrap skill repository layout exists"


def test_python_runtime(_root: Path, _out_dir: Path) -> str:
    require(sys.version_info >= (3, 10), "python 3.10+ is required")
    return f"python={platform.python_version()} platform={platform.platform()}"


def test_output_directory_is_writable(_root: Path, out_dir: Path) -> str:
    probe = out_dir / "write-probe.txt"
    payload = f"created_at={datetime.now().isoformat()}\n"
    probe.write_text(payload, encoding="utf-8")
    require(probe.read_text(encoding="utf-8") == payload, "output directory probe mismatch")
    return f"wrote {probe.name}"


def run_command(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )


def run_json_command(args: list[str], cwd: Path) -> dict:
    result = run_command(args, cwd)
    require(result.returncode == 0, f"command failed: {' '.join(args)}\nstdout={result.stdout}\nstderr={result.stderr}")
    return json.loads(result.stdout)


def create_fixture_root(out_dir: Path) -> Path:
    fixture_root = out_dir / "fixture-root"
    template_dir = fixture_root / "data" / "platform" / "templates" / "basic"
    skill_dir = out_dir / "sample-skill" / "sample-skill"

    template_dir.mkdir(parents=True, exist_ok=True)
    (template_dir / "manifest.json").write_text(
        json.dumps({"id": "basic", "name": "Basic Template"}, indent=2) + "\n",
        encoding="utf-8",
    )
    (template_dir / "AGENTS.md").write_text("# Agents\n\nBase agent instructions.\n", encoding="utf-8")
    (template_dir / "SOUL.md").write_text("# Soul\n\nBase soul instructions.\n", encoding="utf-8")
    (template_dir / "USER.md").write_text("# User\n\nBase user instructions.\n", encoding="utf-8")

    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: sample-skill\ndescription: sample skill for smoke tests\n---\n\n# Sample Skill\n",
        encoding="utf-8",
    )

    return fixture_root


def test_typescript_build(root: Path, _out_dir: Path) -> str:
    result = run_command(["npm", "run", "build"], root)
    require(result.returncode == 0, f"npm run build failed\nstdout={result.stdout}\nstderr={result.stderr}")
    dist_cli = root / "dist" / "cli.js"
    dist_index = root / "dist" / "index.js"
    require(dist_cli.is_file(), "dist/cli.js missing after build")
    require(dist_index.is_file(), "dist/index.js missing after build")
    return "typescript build completed and dist artifacts exist"


def test_agent_cli_flow(root: Path, out_dir: Path) -> str:
    fixture_root = create_fixture_root(out_dir)
    cli = root / "dist" / "cli.js"

    added = run_json_command(
        [
            "node",
            str(cli),
            "agents",
            "add",
            "--root",
            str(fixture_root),
            "--id",
            "agent-alpha",
            "--template",
            "basic",
        ],
        root,
    )
    require(added["ok"] is True, "agent add did not return ok=true")

    info = run_json_command(
        ["node", str(cli), "agents", "info", "--root", str(fixture_root), "--id", "agent-alpha"],
        root,
    )
    require(info["agent"]["templateId"] == "basic", "agent template mismatch")
    agent_workspace = Path(info["agent"]["workspaceDir"])
    require((agent_workspace / "AGENTS.md").is_file(), "AGENTS.md missing after add")
    require((agent_workspace / "MEMORY.md").is_file(), "MEMORY.md missing after add")

    agents_md = agent_workspace / "AGENTS.md"
    agents_md.write_text("# Agents\n\nMutated during test.\n", encoding="utf-8")

    restored = run_json_command(
        ["node", str(cli), "agents", "restore", "--root", str(fixture_root), "--id", "agent-alpha"],
        root,
    )
    require(restored["ok"] is True, "agent restore did not return ok=true")
    require("Base agent instructions." in agents_md.read_text(encoding="utf-8"), "restore did not replace AGENTS.md")

    listed = run_json_command(["node", str(cli), "agents", "list", "--root", str(fixture_root)], root)
    require(len(listed["agents"]) == 1, "unexpected agent count after add")

    deleted = run_json_command(
        ["node", str(cli), "agents", "delete", "--root", str(fixture_root), "--id", "agent-alpha"],
        root,
    )
    require(deleted["ok"] is True, "agent delete did not return ok=true")
    require(not (fixture_root / "data" / "agents" / "agent-alpha").exists(), "agent directory still exists after delete")
    return "agent CLI add/info/restore/list/delete flow succeeded"


def test_skill_cli_flow(root: Path, out_dir: Path) -> str:
    fixture_root = create_fixture_root(out_dir)
    cli = root / "dist" / "cli.js"
    sample_skill = out_dir / "sample-skill" / "sample-skill"

    run_json_command(
        [
            "node",
            str(cli),
            "agents",
            "add",
            "--root",
            str(fixture_root),
            "--id",
            "agent-beta",
            "--template",
            "basic",
        ],
        root,
    )

    installed_global = run_json_command(
        ["node", str(cli), "skills", "install", "--root", str(fixture_root), "-g", str(sample_skill)],
        root,
    )
    require(installed_global["skill"]["scope"] == "global", "global skill install scope mismatch")

    installed_agent = run_json_command(
        [
            "node",
            str(cli),
            "skills",
            "install",
            "--root",
            str(fixture_root),
            "-a",
            "agent-beta",
            str(sample_skill),
        ],
        root,
    )
    require(installed_agent["skill"]["agentId"] == "agent-beta", "agent skill install target mismatch")

    global_list = run_json_command(["node", str(cli), "skills", "list", "--root", str(fixture_root)], root)
    require(len(global_list["skills"]) == 1, "unexpected global skill count")

    agent_list = run_json_command(
        ["node", str(cli), "skills", "list", "--root", str(fixture_root), "--agent", "agent-beta"],
        root,
    )
    require(len(agent_list["skills"]) == 1, "unexpected agent skill count")

    run_json_command(
        ["node", str(cli), "skills", "uninstall", "--root", str(fixture_root), "-g", "sample-skill"],
        root,
    )
    run_json_command(
        [
          "node",
          str(cli),
          "skills",
          "uninstall",
          "--root",
          str(fixture_root),
          "-a",
          "agent-beta",
          "sample-skill",
        ],
        root,
    )

    global_skill_dir = fixture_root / "data" / "platform" / "skills" / "global" / "sample-skill"
    agent_skill_dir = fixture_root / "data" / "agents" / "agent-beta" / "skills" / "sample-skill"
    require(not global_skill_dir.exists(), "global skill directory still exists after uninstall")
    require(not agent_skill_dir.exists(), "agent skill directory still exists after uninstall")
    return "skill CLI install/list/uninstall flow succeeded"


def test_runtime_modules(root: Path, out_dir: Path) -> str:
    script = f"""
import {{
  parseAgentTopic,
  sessionDedupeKey,
  sessionEventsKey,
  sessionLockKey,
  sessionMetaKey,
  sessionSnapshotKey,
  ToolPolicyEngine,
}} from {json.dumps(str(root / "dist" / "index.js"))};

const topic = parseAgentTopic("agents/control/inbound/agent-alpha");
const locator = {{ agentId: "agent-alpha", sessionId: "sess-1", threadId: "branch-2" }};
const engine = new ToolPolicyEngine({{
  tools: {{
    bash: {{
      defaultAction: "block",
      commands: [
        {{
          id: "opsctl-run",
          match: ["opsctl", "run"],
          inject: ["--sessionId", "${{sessionId}}", "--threadId", "${{threadId}}"]
        }}
      ],
      paths: {{
        read: [{json.dumps(str(out_dir / "allowed-read"))}],
        write: [{json.dumps(str(out_dir / "allowed-write"))}]
      }},
      network: [
        {{ host: "10.0.0.10", ports: [443] }},
        {{ cidr: "10.10.0.0/16", ports: [80, 443] }}
      ]
    }}
  }}
}});

const ok = engine.rewriteBashCall({{
  argv: ["opsctl", "run", "deploy"],
  context: locator,
  pathAccesses: [
    {{ mode: "read", path: {json.dumps(str(out_dir / "allowed-read" / "file.txt"))} }},
    {{ mode: "write", path: {json.dumps(str(out_dir / "allowed-write" / "out.txt"))} }}
  ],
  networkAccesses: [
    {{ host: "10.0.0.10", port: 443 }},
    {{ host: "10.10.9.3", port: 80 }}
  ]
}});

const blocked = engine.rewriteBashCall({{
  argv: ["opsctl", "run"],
  context: locator,
  pathAccesses: [
    {{ mode: "write", path: {json.dumps(str(out_dir / "denied" / "blocked.txt"))} }}
  ]
}});

process.stdout.write(JSON.stringify({{
  topic,
  keys: {{
    meta: sessionMetaKey(locator),
    events: sessionEventsKey(locator),
    snapshot: sessionSnapshotKey(locator),
    lock: sessionLockKey(locator),
    dedupe: sessionDedupeKey(locator, "msg-1")
  }},
  ok,
  blocked
}}));
"""
    (out_dir / "allowed-read").mkdir(parents=True, exist_ok=True)
    (out_dir / "allowed-write").mkdir(parents=True, exist_ok=True)
    result = run_command(["node", "--input-type=module", "-e", script], root)
    require(result.returncode == 0, f"node module test failed\nstdout={result.stdout}\nstderr={result.stderr}")
    payload = json.loads(result.stdout)

    require(payload["topic"]["agentId"] == "agent-alpha", "topic router agent mismatch")
    require(payload["topic"]["channel"] == "control", "topic router channel mismatch")
    require(payload["keys"]["meta"].endswith(":meta"), "meta key suffix mismatch")
    require(payload["keys"]["events"].endswith(":events"), "events key suffix mismatch")
    require(payload["keys"]["snapshot"].endswith(":snapshot"), "snapshot key suffix mismatch")
    require(payload["keys"]["lock"].endswith(":lock"), "lock key suffix mismatch")
    require(payload["keys"]["dedupe"].endswith(":dedupe:msg-1"), "dedupe key suffix mismatch")
    require(payload["ok"]["allowed"] is True, "policy engine should have allowed matching command")
    require(payload["ok"]["ruleId"] == "opsctl-run", "policy engine rule mismatch")
    require(payload["ok"]["argv"][-4:] == ["--sessionId", "sess-1", "--threadId", "branch-2"], "policy injection mismatch")
    require(payload["blocked"]["allowed"] is False, "policy engine should have blocked denied path")
    return "topic router, session keys and tool policy engine behaved as expected"


def test_local_runtime_flow(root: Path, out_dir: Path) -> str:
    fixture_root = create_fixture_root(out_dir)
    cli = root / "dist" / "cli.js"

    run_json_command(
        [
            "node",
            str(cli),
            "agents",
            "add",
            "--root",
            str(fixture_root),
            "--id",
            "agent-runtime",
            "--template",
            "basic",
        ],
        root,
    )

    payload_one = out_dir / "payload-one.json"
    payload_one.write_text(
        json.dumps(
            {
                "messageId": "msg-001",
                "sessionId": "sess-001",
                "threadId": "thread-main",
                "text": "/remember team prefers csv reports",
                "traceId": "trace-001",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    payload_two = out_dir / "payload-two.json"
    payload_two.write_text(
        json.dumps(
            {
                "messageId": "msg-002",
                "sessionId": "sess-001",
                "threadId": "thread-alt",
                "text": "继续处理",
                "traceId": "trace-002",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    publish_one = run_json_command(
        [
            "node",
            str(cli),
            "runtime",
            "publish",
            "--root",
            str(fixture_root),
            "--topic",
            "agents/text/inbound/agent-runtime",
            str(payload_one),
        ],
        root,
    )
    require(publish_one["result"]["deduped"] is False, "first publish should not dedupe")
    first_events = publish_one["result"]["events"]
    require(first_events[0]["kind"] == "thinking", "first runtime event kind mismatch")
    require("已写入会话记忆" in first_events[-1]["text"], "remember flow did not persist memory note")

    publish_two = run_json_command(
        [
            "node",
            str(cli),
            "runtime",
            "publish",
            "--root",
            str(fixture_root),
            "--topic",
            "agents/text/inbound/agent-runtime",
            str(payload_two),
        ],
        root,
    )
    second_final = publish_two["result"]["events"][-1]["text"]
    require("当前 session 共享记忆条数: 1" in second_final, "session memory should be shared across threads")

    publish_duplicate = run_json_command(
        [
            "node",
            str(cli),
            "runtime",
            "publish",
            "--root",
            str(fixture_root),
            "--topic",
            "agents/text/inbound/agent-runtime",
            str(payload_one),
        ],
        root,
    )
    require(publish_duplicate["result"]["deduped"] is True, "duplicate publish should dedupe")

    doctor = run_json_command(
        ["node", str(cli), "agents", "doctor", "--root", str(fixture_root), "--id", "agent-runtime"],
        root,
    )
    require(doctor["result"]["sessionCount"] == 1, "doctor should report one session")
    require(doctor["result"]["sessionThreadCount"] == 2, "doctor should report two thread runtimes")

    logs = run_json_command(
        [
            "node",
            str(cli),
            "agents",
            "logs",
            "--root",
            str(fixture_root),
            "--id",
            "agent-runtime",
            "--session",
            "sess-001",
            "--tail",
            "20",
        ],
        root,
    )
    require(logs["result"]["count"] >= 4, "logs should include persisted runtime events")

    restart = run_json_command(
        ["node", str(cli), "agents", "restart", "--root", str(fixture_root), "--id", "agent-runtime"],
        root,
    )
    require(restart["result"]["clearedRuntimeCache"] is True, "restart should clear runtime cache")
    return "local runtime publish/dedupe/session-memory/control flow succeeded"


def test_gateway_http_api(root: Path, out_dir: Path) -> str:
    fixture_root = create_fixture_root(out_dir)
    cli = root / "dist" / "cli.js"
    run_json_command(
        [
            "node",
            str(cli),
            "agents",
            "add",
            "--root",
            str(fixture_root),
            "--id",
            "agent-http",
            "--template",
            "basic",
        ],
        root,
    )

    script = f"""
import {{
  LocalGatewayRuntime,
  createPlatformPaths,
}} from {json.dumps(str(root / "dist" / "index.js"))};

const gateway = new LocalGatewayRuntime(createPlatformPaths({json.dumps(str(fixture_root))}));
const business = await gateway.publish("agents/text/inbound/agent-http", {{
  messageId: "msg-http-001",
  sessionId: "sess-http-001",
  threadId: "thread-main",
  text: "hello from gateway runtime",
  traceId: "trace-http-001"
}});
const control = await gateway.control("agents/control/inbound/agent-http", {{
  command: "doctor",
  requestId: "ctl-001",
  traceId: "trace-ctl-001",
  args: {{}}
}});

process.stdout.write(JSON.stringify({{ business, control }}));
"""
    result = run_command(["node", "--input-type=module", "-e", script], root)
    require(result.returncode == 0, f"gateway runtime script failed\nstdout={result.stdout}\nstderr={result.stderr}")
    payload = json.loads(result.stdout)
    require(payload["business"]["events"][-1]["kind"] == "final", "gateway runtime final event missing")
    require(payload["control"]["success"] is True, "gateway control success mismatch")
    require(payload["control"]["data"]["agentId"] == "agent-http", "gateway control agent mismatch")
    return "gateway runtime accepted business and control requests"


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
        ("bundled_skills_exist", test_bundled_skills_exist),
        ("bootstrap_skills_exist", test_bootstrap_skills_exist),
        ("python_runtime", test_python_runtime),
        ("output_directory_is_writable", test_output_directory_is_writable),
        ("typescript_build", test_typescript_build),
        ("agent_cli_flow", test_agent_cli_flow),
        ("skill_cli_flow", test_skill_cli_flow),
        ("runtime_modules", test_runtime_modules),
        ("local_runtime_flow", test_local_runtime_flow),
        ("gateway_http_api", test_gateway_http_api),
    ]

    results = [run_test(name, func, root, out_dir) for name, func in tests]
    ended_at = datetime.now()
    write_summary(root, out_dir, results, started_at, ended_at)

    return 0 if all(result.passed for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
