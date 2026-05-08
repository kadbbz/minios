# Docker Image Tests

These tests run against a built Docker image instead of the source tree process.

They reuse `docker-compose.standalone.yml` dependencies for:

- `redis`
- `emqx`
- `minio`

Run:

```bash
npm run compose:init:standalone
python3 test/docker/compose_image_fast_test.py --image minios-gateway:latest
python3 test/docker/compose_image_full_test.py --image minios-gateway:latest
```

Prerequisite:

```bash
export OC_OPENAI_API_KEY=<your-key>
```

Without `OC_OPENAI_API_KEY`, both Docker test suites fail early in `prepare_fixture`.

Manual startup only requires:

```bash
npm run compose:standalone:up -- --no-build
```

Output:

- `.tmp/docker-image-test-{ts}/report.txt`
- `.tmp/docker-image-test-{ts}/summary.json`
- `./data/standalone/config/llm.json`、`./data/standalone/config/env.json` 是 standalone 模式的用户配置文件
- `./data/standalone/runtime-env/` 是自动生成的容器运行工件
- `./data/standalone/gateway/test-runs/*/fixture/` 保存测试 input
- `./data/standalone/gateway/test-runs/*/results/` 保存 publish、logs、restart 等 JSON output
- `./data/standalone/gateway/test-runs/*/root/data/agents/...` 保存下载文件、生成文件、session、memory
