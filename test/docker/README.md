# Docker Image Tests

These tests run against a built Docker image instead of the source tree process.

They reuse the repository `docker-compose.yml` dependencies for:

- `redis`
- `emqx`
- `minio`

Run:

```bash
bash scripts/init-compose-data.sh ./data
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
mkdir -p ./data/config
cp config/llm.json ./data/config/llm.json
cp config/env.json ./data/config/env.json
docker compose up -d
```

Output:

- `.tmp/docker-image-test-{ts}/report.txt`
- `.tmp/docker-image-test-{ts}/summary.json`
- `./data/config/llm.json`、`./data/config/env.json` 是仅有的两个用户配置文件
- `./data/runtime-env/` 是自动生成的容器运行工件
- `./data/gateway/test-runs/*/fixture/` 保存测试 input
- `./data/gateway/test-runs/*/results/` 保存 publish、logs、restart 等 JSON output
- `./data/gateway/test-runs/*/root/data/agents/...` 保存下载文件、生成文件、session、memory
