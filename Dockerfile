FROM node:24-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:24-bookworm AS qmd

ARG QMD_VERSION=2.1.0

RUN npm install -g @tobilu/qmd@${QMD_VERSION}

FROM node:24-bookworm AS bundled-node-tools

ARG MQTT_BASH_EXEC_CHANNEL_VERSION=0.2.0

RUN npm install -g mqtt-bash-exec-channel@${MQTT_BASH_EXEC_CHANNEL_VERSION}

FROM ubuntu:26.04 AS runtime

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG TARGETARCH
ARG QMD_VERSION=2.1.0
ARG CHROME_FOR_TESTING_VERSION=147.0.7727.57

WORKDIR /app

ENV NODE_ENV=production
ENV MINIOS_VENDOR_DIR=/opt/minios/vendor
ENV MINIOS_BOOTSTRAP_SKILLS_DIR=/opt/minios/bootstrap-skills
ENV MINIOS_BUNDLED_SKILLS_DIR=/opt/minios/bundled-skills
ENV CHROME_FOR_TESTING_ROOT=/opt/chrome-for-testing
ENV CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox
ENV QMD_MODELS_DIR=/opt/minios/vendor/qmd-models
ENV QMD_EMBED_MODEL=/opt/minios/vendor/qmd-models/embeddinggemma-300M-Q8_0.gguf
ENV QMD_RERANK_MODEL=/opt/minios/vendor/qmd-models/qwen3-reranker-0.6b-q8_0.gguf
ENV QMD_GENERATE_MODEL=/opt/minios/vendor/qmd-models/qmd-query-expansion-1.7B-q4_k_m.gguf
ENV QMD_CACHE_HOME=/opt/minios/qmd-cache
ENV HOME=/data/minios

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-freefont-ttf \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    groff \
    jq \
    less \
    libasound2t64 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo-gobject2 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libfontconfig1 \
    libfreetype6 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    python3 \
    python3-pip \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-chi-sim \
    tesseract-ocr-eng \
    libx11-6 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxcb-shm0 \
    libxcb1 \
    unzip \
    xz-utils \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && ln -sf /usr/bin/pip3 /usr/local/bin/pip \
  && rm -rf /var/lib/apt/lists/*

COPY --from=qmd /usr/local /usr/local
COPY --from=bundled-node-tools /usr/local /usr/local

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY bootstrap-skills /opt/minios/bootstrap-skills
COPY bundled-skills /opt/minios/bundled-skills
COPY vendor /opt/minios/vendor

RUN case "${TARGETARCH}" in \
    amd64) aws_arch="x86_64" ;; \
    arm64) aws_arch="aarch64" ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && aws_local_zip="/opt/minios/vendor/aws/awscli-exe-linux-${aws_arch}.zip" \
  && if [ -f "${aws_local_zip}" ]; then \
       echo "Using local AWS CLI archive: ${aws_local_zip}" \
       && cp "${aws_local_zip}" /tmp/awscliv2.zip; \
     else \
       echo "Local AWS CLI archive not found, falling back to upstream download" \
       && curl -fsSLo /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip"; \
     fi \
  && unzip -q /tmp/awscliv2.zip -d /tmp/aws-install \
  && /tmp/aws-install/aws/install \
  && rm -rf /tmp/aws-install /tmp/awscliv2.zip

RUN qmd --version >/dev/null \
  && mqtt-bash-exec-channel --help >/dev/null \
  && aws --version >/dev/null \
  && python --version >/dev/null \
  && pip --version >/dev/null \
  && python -m venv --help >/dev/null

RUN case "${TARGETARCH}" in \
    amd64) \
      chrome_install_dir="${CHROME_FOR_TESTING_ROOT}/${CHROME_FOR_TESTING_VERSION}" \
      && chrome_local_zip="/opt/minios/vendor/chrome/${CHROME_FOR_TESTING_VERSION}/chrome-linux64.zip" \
      && rm -rf "${chrome_install_dir}" \
      && mkdir -p "${chrome_install_dir}" \
      && if [ -f "${chrome_local_zip}" ]; then \
           echo "Using local Chrome for Testing archive: ${chrome_local_zip}" \
           && unzip -q "${chrome_local_zip}" -d "${chrome_install_dir}"; \
         else \
           echo "Missing local Chrome for Testing archive: ${chrome_local_zip}" >&2 \
           && exit 1; \
         fi \
      && test -x "${chrome_install_dir}/chrome-linux64/chrome" \
      && test -f "${chrome_install_dir}/chrome-linux64/chrome_sandbox" \
      && cp "${chrome_install_dir}/chrome-linux64/chrome_sandbox" "${CHROME_DEVEL_SANDBOX}" \
      && chown root:root "${CHROME_DEVEL_SANDBOX}" \
      && chmod 4755 "${CHROME_DEVEL_SANDBOX}" \
      && ln -sf "${chrome_install_dir}/chrome-linux64/chrome" /usr/local/bin/google-chrome \
      && ln -sf "${chrome_install_dir}/chrome-linux64/chrome" /usr/local/bin/google-chrome-stable ;; \
    arm64) echo "Skipping Chrome install on arm64: no Linux arm64 Chrome bundle provided" ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac

RUN mkdir -p /data/minios "${QMD_CACHE_HOME}/qmd/models"

RUN env HOME=${HOME} XDG_CACHE_HOME=${QMD_CACHE_HOME} node --input-type=module <<'EOF'
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  pullModels,
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  DEFAULT_MODEL_CACHE_DIR,
  DEFAULT_RERANK_MODEL_URI
} from "/usr/local/lib/node_modules/@tobilu/qmd/dist/llm.js";

const modelUris = [
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI
];
const localVendorDir = "/opt/minios/vendor/qmd-models";

mkdirSync(DEFAULT_MODEL_CACHE_DIR, { recursive: true });

const fallbackUris = [];
const results = [];

for (const modelUri of modelUris) {
  const filename = modelUri.split("/").pop();
  const localVendorPath = filename ? join(localVendorDir, filename) : "";

  if (filename && existsSync(localVendorPath)) {
    const cachePath = join(DEFAULT_MODEL_CACHE_DIR, filename);
    copyFileSync(localVendorPath, cachePath);
    results.push({
      model: modelUri,
      path: cachePath,
      sizeBytes: statSync(cachePath).size,
      source: "local"
    });
  } else {
    fallbackUris.push(modelUri);
  }
}

if (fallbackUris.length > 0) {
  const pulledResults = await pullModels(fallbackUris, { cacheDir: DEFAULT_MODEL_CACHE_DIR });
  results.push(...pulledResults.map((result) => ({ ...result, source: "remote" })));
}

for (const result of results) {
  console.log(`Prepared ${result.model} -> ${result.path} (${result.sizeBytes} bytes, ${result.source})`);
}
EOF

RUN qmd search "test" >/tmp/qmd-warmup.log 2>&1 \
  || { cat /tmp/qmd-warmup.log; exit 1; } \
  && rm -f /tmp/qmd-warmup.log

EXPOSE 8080

CMD ["node", "dist/gateway/server.js"]
