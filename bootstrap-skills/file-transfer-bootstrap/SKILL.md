---
name: file-transfer-bootstrap
description: Built-in bootstrap skill for per-session object-storage file download and upload. Load for every MiniOS agent session automatically.
disable-model-invocation: true
---

# File Transfer Bootstrap

This is a MiniOS bootstrap skill. It is not a normal optional skill and must be loaded for every agent session automatically.

## Purpose

Provide the baseline file transfer workflow for every session:

1. Download inbound attachments from S3-compatible object storage
2. Materialize files into the current session workspace
3. Upload generated outputs back to object storage
4. Track object reference to local path mappings for audit

## Runtime Contract

The runtime is expected to expose tools for:

- resolving attachment metadata from inbound MQTT payloads
- downloading attachments into the session `inbox/`
- uploading generated files from the session `outbox/`
- returning object references into outbound MQTT payloads

## Loading Rules

1. Load this skill for every session automatically.
2. Do not rely on users to install or enable it.
3. Do not allow normal uninstall operations to remove it.
4. Keep it isolated from bundled business skills.

## Expected Workspace Layout

- `workspace/inbox/`
- `workspace/outbox/`
- `workspace/tmp/`

## Notes

This skill defines the bootstrap contract only. The actual runtime behavior lives in MiniOS gateway/worker and object-storage integration code.
