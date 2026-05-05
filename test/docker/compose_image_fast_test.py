#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable


@dataclass
class StepResult:
    name: str
    passed: bool
    duration_ms: int
    details: str


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def run_command(args: list[str], cwd: Path, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def run_json_command(args: list[str], cwd: Path, timeout: int = 120) -> dict:
    result = run_command(args, cwd, timeout=timeout)
    require(result.returncode == 0, f"command failed: {' '.join(args)}\nstdout={result.stdout}\nstderr={result.stderr}")
    return json.loads(result.stdout)


def timestamp_label() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def create_output_dir(root: Path) -> Path:
    out_dir = root / ".tmp" / f"docker-image-test-{timestamp_label()}"
    out_dir.mkdir(parents=True, exist_ok=False)
    return out_dir


def write_summary(root: Path, out_dir: Path, results: list[StepResult], started_at: datetime, ended_at: datetime) -> None:
    passed = sum(1 for result in results if result.passed)
    failed = len(results) - passed
    summary = {
        "suite": "docker-compose-fast",
        "repoRoot": str(root),
        "outputDir": str(out_dir),
        "startedAt": started_at.isoformat(),
        "endedAt": ended_at.isoformat(),
        "passed": passed,
        "failed": failed,
        "results": [asdict(result) for result in results],
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "MiniOS Docker Compose Fast Test Report",
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


def run_step(name: str, func: Callable[[Path, Path], str], root: Path, out_dir: Path) -> StepResult:
    started = time.perf_counter()
    try:
        details = func(root, out_dir)
        passed = True
    except Exception as exc:  # noqa: BLE001
        details = str(exc)
        passed = False
    duration_ms = int((time.perf_counter() - started) * 1000)
    return StepResult(name=name, passed=passed, duration_ms=duration_ms, details=details)


def compose_args(root: Path, out_dir: Path, *extra: str) -> list[str]:
    state = read_state(out_dir)
    return ["docker", "compose", "--env-file", str(state["envFile"]), *extra]


def init_compose_data(root: Path, data_dir: Path, openai_api_key: str) -> None:
    result = run_command(["bash", "scripts/init-compose-data.sh", str(data_dir)], root, timeout=60)
    require(result.returncode == 0, f"compose data init failed\nstdout={result.stdout}\nstderr={result.stderr}")
    rewrite_env_json_value(data_dir / "config" / "env.json", "gateway", "OC_OPENAI_API_KEY", openai_api_key)
    rerender_result = run_command(["node", "scripts/render-runtime-env.mjs", str(data_dir)], root, timeout=60)
    require(rerender_result.returncode == 0, f"runtime env render failed\nstdout={rerender_result.stdout}\nstderr={rerender_result.stderr}")


def rewrite_env_json_value(file_path: Path, section: str, key: str, value: str) -> None:
    payload = json.loads(file_path.read_text(encoding="utf-8"))
    require(isinstance(payload, dict), f"{file_path} must contain a json object")
    block = payload.get(section)
    require(isinstance(block, dict), f"{file_path} missing object section: {section}")
    block[key] = value
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def prepare_fixture(root: Path, out_dir: Path) -> str:
    key = os.environ.get("OC_OPENAI_API_KEY", "").strip()
    require(key, "OC_OPENAI_API_KEY must be set in the test environment")

    compose_data_dir = out_dir / "compose-data"
    init_compose_data(root, compose_data_dir, key)

    run_name = "fast-run"
    run_root_host = compose_data_dir / "gateway" / "test-runs" / run_name
    fixture_root = run_root_host / "fixture"
    runtime_root = run_root_host / "root"
    results_dir = run_root_host / "results"
    template_dir = runtime_root / "data" / "platform" / "templates" / "basic"
    input_dir = fixture_root / "input"
    template_dir.mkdir(parents=True, exist_ok=True)
    input_dir.mkdir(parents=True, exist_ok=True)
    results_dir.mkdir(parents=True, exist_ok=True)

    (template_dir / "manifest.json").write_text(
        json.dumps({"id": "basic", "name": "Basic Template"}, indent=2) + "\n",
        encoding="utf-8",
    )
    (template_dir / "AGENTS.md").write_text("# Agents\n\nDocker compose template.\n", encoding="utf-8")
    (template_dir / "SOUL.md").write_text("# Soul\n\nDocker compose soul.\n", encoding="utf-8")
    (template_dir / "USER.md").write_text("# User\n\nDocker compose user.\n", encoding="utf-8")
    (input_dir / "sample.txt").write_text("compose file transfer payload\n", encoding="utf-8")

    (fixture_root / "text-payload.json").write_text(
        json.dumps(
            {
                "messageId": "msg-text-001",
                "sessionId": "sess-compose-001",
                "threadId": "thread-main",
                "text": "/remember docker compose test memory",
                "traceId": "trace-text-001",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (fixture_root / "file-payload.json").write_text(
        json.dumps(
            {
                "messageId": "msg-file-001",
                "sessionId": "sess-compose-001",
                "threadId": "thread-file",
                "text": "请处理这个文件",
                "attachments": [
                    {
                        "bucket": "agents-in",
                        "key": "agent-compose/sess-compose-001/thread-file/msg-file-001/sample.txt",
                        "name": "sample.txt",
                        "mediaType": "text/plain",
                        "size": 12,
                    }
                ],
                "traceId": "trace-file-001",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    env_file = out_dir / "compose-test.env"
    env_file.write_text(
        "\n".join(
            [
                f"MINIOS_GATEWAY_IMAGE={TEST_IMAGE}",
                f"MINIOS_DATA_DIR={compose_data_dir}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    state = {
        "fixtureRootHost": str(fixture_root),
        "runtimeRootHost": str(runtime_root),
        "resultsDirHost": str(results_dir),
        "composeDataDir": str(compose_data_dir),
        "envFile": str(env_file),
        "gatewayContainer": "minios-gateway",
        "runtimeRootContainer": f"/data/minios/test-runs/{run_name}/root",
        "fixtureRootContainer": f"/data/minios/test-runs/{run_name}/fixture",
    }
    (out_dir / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return f"prepared persistent fixture root at {fixture_root}"


def read_state(out_dir: Path) -> dict:
    return json.loads((out_dir / "state.json").read_text(encoding="utf-8"))


def ensure_compose_stack(root: Path, out_dir: Path) -> str:
    for image in ["redis:7-alpine", "emqx/emqx:5.8.6", "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z"]:
        inspect_result = run_command(["docker", "image", "inspect", image], root, timeout=30)
        require(inspect_result.returncode == 0, f"required compose image missing locally: {image}")

    run_command(compose_args(root, out_dir, "down", "--remove-orphans"), root, timeout=180)
    result = run_command(compose_args(root, out_dir, "up", "-d", "--no-build"), root, timeout=300)
    require(result.returncode == 0, f"docker compose up failed\nstdout={result.stdout}\nstderr={result.stderr}")
    return "docker compose stack is running"


def wait_for_gateway(root: Path, out_dir: Path) -> str:
    state = read_state(out_dir)
    container_name = state["gatewayContainer"]
    deadline = time.time() + 180
    last = ""
    while time.time() < deadline:
        result = run_command(["docker", "exec", container_name, "curl", "-fsS", "http://127.0.0.1:8080/healthz"], root, timeout=20)
        last = result.stdout or result.stderr
        if result.returncode == 0:
            payload = json.loads(result.stdout)
            require(payload["ok"] is True, "gateway healthz did not return ok=true")
            return f"gateway healthz ready in {container_name}"
        time.sleep(2)
    raise AssertionError(f"gateway did not become ready; last={last}")


def prepare_gateway_test_root(root: Path, out_dir: Path) -> str:
    state = read_state(out_dir)
    container_name = state["gatewayContainer"]
    fixture_root_container = state["fixtureRootContainer"]

    shell = (
        "set -euo pipefail\n"
        "for bucket in agents-in agents-out; do\n"
        "  if aws --endpoint-url http://minio:9000 s3api head-bucket --bucket \"$bucket\" >/dev/null 2>&1; then\n"
        "    echo \"present:$bucket\"\n"
        "  else\n"
        "    aws --endpoint-url http://minio:9000 s3api create-bucket --bucket \"$bucket\" >/dev/null\n"
        "    echo \"created:$bucket\"\n"
        "  fi\n"
        "done\n"
        f"aws --endpoint-url http://minio:9000 s3 cp {fixture_root_container}/input/sample.txt "
        "s3://agents-in/agent-compose/sess-compose-001/thread-file/msg-file-001/sample.txt --only-show-errors\n"
    )
    result = run_command(["docker", "exec", container_name, "/bin/bash", "-lc", shell], root, timeout=120)
    require(result.returncode == 0, f"gateway fixture bootstrap failed\nstdout={result.stdout}\nstderr={result.stderr}")
    return result.stdout.strip() or "gateway fixture and buckets prepared in persistent volume"


def platform_checks(root: Path, out_dir: Path) -> str:
    container_name = read_state(out_dir)["gatewayContainer"]
    doctor = run_json_command(["docker", "exec", container_name, "node", "dist/cli.js", "platform", "doctor"], root, timeout=120)
    require(doctor["ok"] is True, "platform doctor returned ok=false")
    require(doctor["result"]["ok"] is True, f"platform doctor checks failed: {json.dumps(doctor['result'], ensure_ascii=False)}")

    config_validate = run_json_command(
        ["docker", "exec", container_name, "node", "dist/cli.js", "platform", "config", "validate", "--path", "/data/minios/config/llm.json"],
        root,
        timeout=120,
    )
    require(config_validate["ok"] is True, f"platform config validate failed: {json.dumps(config_validate, ensure_ascii=False)}")
    backups = config_validate["result"]["config"]["agents"]["defaults"]["model"]["backups"]
    require(isinstance(backups, list), "model backups must be an array")
    return "platform doctor and config validation passed"


def runtime_cli_flow(root: Path, out_dir: Path) -> str:
    state = read_state(out_dir)
    container_name = state["gatewayContainer"]
    runtime_root_container = state["runtimeRootContainer"]
    fixture_root_container = state["fixtureRootContainer"]
    results_dir_host = Path(state["resultsDirHost"])
    runtime_root_host = Path(state["runtimeRootHost"])

    added = run_json_command(
        [
            "docker", "exec", container_name,
            "node", "dist/cli.js",
            "agents", "add",
            "--root", runtime_root_container,
            "--id", "agent-compose",
            "--template", "basic",
        ],
        root,
        timeout=120,
    )
    require(added["ok"] is True, "agents add failed in compose gateway")
    (results_dir_host / "agents-add.json").write_text(json.dumps(added, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    text_published = run_json_command(
        [
            "docker", "exec", container_name,
            "node", "dist/cli.js",
            "runtime", "publish",
            "--root", runtime_root_container,
            "--topic", "agents/text/inbound/agent-compose",
            f"{fixture_root_container}/text-payload.json",
        ],
        root,
        timeout=120,
    )
    require(text_published["ok"] is True, "text publish failed in compose gateway")
    require("已写入会话记忆" in text_published["result"]["events"][-1]["text"], "text flow missing memory write marker")
    (results_dir_host / "text-publish.json").write_text(json.dumps(text_published, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    file_published = run_json_command(
        [
            "docker", "exec", container_name,
            "node", "dist/cli.js",
            "runtime", "publish",
            "--root", runtime_root_container,
            "--topic", "agents/file/inbound/agent-compose",
            f"{fixture_root_container}/file-payload.json",
        ],
        root,
        timeout=120,
    )
    require(file_published["ok"] is True, "file publish failed in compose gateway")
    tool_text = file_published["result"]["events"][1]["text"]
    require("独立文件入站链路" in tool_text, "file flow did not use dedicated file topic behavior")
    final_event = file_published["result"]["events"][-1]
    require(final_event["kind"] == "final", "file flow final event missing")
    require(len(final_event["attachments"]) == 1, "file flow should return exactly one output attachment")
    output_attachment = final_event["attachments"][0]
    require(output_attachment["bucket"] == "agents-out", "output attachment should be uploaded to agents-out")
    require(output_attachment["key"].startswith("agent-compose/sess-compose-001/thread-file/"), "output attachment key mismatch")
    (results_dir_host / "file-publish.json").write_text(json.dumps(file_published, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    turn_id = final_event["turnId"]
    local_inbox = f"{runtime_root_container}/data/agents/agent-compose/workspace/sessions/sess-compose-001/inbox/thread-file/msg-file-001/sample.txt"
    download_check = run_command(["docker", "exec", container_name, "test", "-f", local_inbox], root, timeout=60)
    require(download_check.returncode == 0, "downloaded file missing from agent inbox")

    read_download = run_command(["docker", "exec", container_name, "cat", local_inbox], root, timeout=60)
    require(read_download.returncode == 0, "failed to read downloaded file")
    require("compose file transfer payload" in read_download.stdout, "downloaded file content mismatch")

    local_outbox = f"{runtime_root_container}/data/agents/agent-compose/workspace/sessions/sess-compose-001/outbox/thread-file/{turn_id}/processed-sample.txt"
    outbox_check = run_command(["docker", "exec", container_name, "test", "-f", local_outbox], root, timeout=60)
    require(outbox_check.returncode == 0, "processed file missing from agent outbox")

    read_outbox = run_command(["docker", "exec", container_name, "cat", local_outbox], root, timeout=60)
    require(read_outbox.returncode == 0, "failed to read outbox file")
    require(read_outbox.stdout == read_download.stdout, "outbox file should mirror downloaded input content")

    output_head = run_command(
        [
            "docker",
            "exec",
            container_name,
            "/bin/bash",
            "-lc",
            f"aws --endpoint-url http://minio:9000 s3api head-object --bucket agents-out --key '{output_attachment['key']}' >/dev/null",
        ],
        root,
        timeout=120,
    )
    require(output_head.returncode == 0, "uploaded output object missing from MinIO")
    require("已下载文件数: 1" in final_event["text"], "final text should mention downloaded file count")
    require("已上传结果文件数: 1" in final_event["text"], "final text should mention uploaded file count")

    logs = run_json_command(
        [
            "docker", "exec", container_name,
            "node", "dist/cli.js",
            "agents", "logs",
            "--root", runtime_root_container,
            "--id", "agent-compose",
            "--session", "sess-compose-001",
            "--tail", "50",
        ],
        root,
        timeout=120,
    )
    require(logs["ok"] is True, "agents logs failed in compose gateway")
    require(logs["result"]["count"] >= 4, "compose logs should contain runtime events")
    (results_dir_host / "logs.json").write_text(json.dumps(logs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    restarted = run_json_command(
        [
            "docker", "exec", container_name,
            "node", "dist/cli.js",
            "agents", "restart",
            "--root", runtime_root_container,
            "--id", "agent-compose",
        ],
        root,
        timeout=120,
    )
    require(restarted["ok"] is True, "agents restart failed in compose gateway")
    (results_dir_host / "agents-restart.json").write_text(json.dumps(restarted, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    host_inbox = runtime_root_host / "data" / "agents" / "agent-compose" / "workspace" / "sessions" / "sess-compose-001" / "inbox" / "thread-file" / "msg-file-001" / "sample.txt"
    host_outbox = runtime_root_host / "data" / "agents" / "agent-compose" / "workspace" / "sessions" / "sess-compose-001" / "outbox" / "thread-file" / turn_id / "processed-sample.txt"
    require(host_inbox.is_file(), f"persistent inbox file missing on host: {host_inbox}")
    require(host_outbox.is_file(), f"persistent outbox file missing on host: {host_outbox}")

    state["lastTurnId"] = turn_id
    state["lastOutputObjectKey"] = output_attachment["key"]
    (out_dir / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return "agent add/text publish/file publish/logs/restart passed with persistent inputs and outputs"


def restart_persistence(root: Path, out_dir: Path) -> str:
    state = read_state(out_dir)
    container_name = state["gatewayContainer"]
    runtime_root_container = state["runtimeRootContainer"]
    runtime_root_host = Path(state["runtimeRootHost"])
    results_dir_host = Path(state["resultsDirHost"])
    turn_id = state["lastTurnId"]
    compose_data_dir = Path(state["composeDataDir"])

    restart_result = run_command(["docker", "restart", container_name], root, timeout=180)
    require(restart_result.returncode == 0, f"docker restart gateway failed\nstdout={restart_result.stdout}\nstderr={restart_result.stderr}")
    wait_message = wait_for_gateway(root, out_dir)

    info = run_json_command(
        ["docker", "exec", container_name, "node", "dist/cli.js", "agents", "info", "--root", runtime_root_container, "--id", "agent-compose"],
        root,
        timeout=120,
    )
    require(info["ok"] is True, "agents info failed after gateway restart")
    (results_dir_host / "agents-info-after-restart.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    host_inbox = runtime_root_host / "data" / "agents" / "agent-compose" / "workspace" / "sessions" / "sess-compose-001" / "inbox" / "thread-file" / "msg-file-001" / "sample.txt"
    host_outbox = runtime_root_host / "data" / "agents" / "agent-compose" / "workspace" / "sessions" / "sess-compose-001" / "outbox" / "thread-file" / turn_id / "processed-sample.txt"
    require(host_inbox.is_file(), f"inbox file lost after restart: {host_inbox}")
    require(host_outbox.is_file(), f"outbox file lost after restart: {host_outbox}")
    require((runtime_root_host / "data" / "platform" / "templates" / "basic" / "manifest.json").is_file(), "template manifest missing after restart")
    require((compose_data_dir / "config" / "llm.json").is_file(), "persisted llm config missing after restart")
    require((compose_data_dir / "config" / "env.json").is_file(), "persisted env config missing after restart")
    return f"{wait_message}; persisted config, templates and workspace files survived docker restart"


def cleanup(root: Path, out_dir: Path) -> str:
    state_path = out_dir / "state.json"
    if state_path.exists():
        run_command(compose_args(root, out_dir, "down", "--remove-orphans"), root, timeout=180)
    return "docker compose stack stopped"


TEST_IMAGE = ""


def main() -> int:
    global TEST_IMAGE

    parser = argparse.ArgumentParser(description="Run fast regression checks against a built MiniOS image through docker compose.")
    parser.add_argument("--image", default="minios-gateway:test-current")
    parser.add_argument("--output-file", default="")
    args = parser.parse_args()

    TEST_IMAGE = args.image
    root = repo_root()
    out_dir = create_output_dir(root)
    started_at = datetime.now()

    image_check = run_command(["docker", "image", "inspect", TEST_IMAGE], root, timeout=30)
    if image_check.returncode != 0:
        print(f"missing image: {TEST_IMAGE}\n{image_check.stderr}", file=sys.stderr)
        return 1

    tests: list[tuple[str, Callable[[Path, Path], str]]] = [
        ("prepare_fixture", prepare_fixture),
        ("compose_stack", ensure_compose_stack),
        ("wait_for_gateway", wait_for_gateway),
        ("prepare_gateway_test_root", prepare_gateway_test_root),
        ("platform_checks", platform_checks),
        ("runtime_cli_flow", runtime_cli_flow),
        ("restart_persistence", restart_persistence),
    ]

    results: list[StepResult] = []
    try:
        for name, func in tests:
            results.append(run_step(name, func, root, out_dir))
            if not results[-1].passed:
                break
    finally:
        results.append(run_step("cleanup", cleanup, root, out_dir))

    ended_at = datetime.now()
    write_summary(root, out_dir, results, started_at, ended_at)

    if args.output_file:
        target = Path(args.output_file)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out_dir / "report.txt", target)

    print(f"Test report written to {out_dir / 'report.txt'}")
    return 0 if all(result.passed for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
