import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentInfo } from "../core/agent-manager.js";
import { ensureDir } from "../core/fs-utils.js";
import type { SessionLocator } from "../core/session-keys.js";
import type { AttachmentRef } from "./protocol.js";

export interface MaterializedAttachment {
  ref: AttachmentRef;
  localPath: string;
}

export interface PendingUploadArtifact {
  localPath: string;
  name: string;
  mediaType?: string;
}

export class FileTransferService {
  async downloadInboundAttachments(
    agent: AgentInfo,
    locator: SessionLocator,
    messageId: string,
    attachments: AttachmentRef[],
  ): Promise<MaterializedAttachment[]> {
    const downloaded: MaterializedAttachment[] = [];
    for (const attachment of attachments) {
      const fileName = sanitizeFileName(attachment.name);
      const localPath = path.join(
        agent.workspaceDir,
        "sessions",
        locator.sessionId,
        "inbox",
        locator.threadId,
        messageId,
        fileName,
      );
      await ensureDir(path.dirname(localPath));
      await this.runAws([
        "--endpoint-url",
        this.requiredEnv("MINIOS_S3_ENDPOINT"),
        "s3",
        "cp",
        buildS3Uri(attachment.bucket, attachment.key),
        localPath,
        "--only-show-errors",
      ]);
      const downloadOptions: {
        name: string;
        mediaType?: string;
      } = {
        name: fileName,
      };
      if (attachment.mediaType) {
        downloadOptions.mediaType = attachment.mediaType;
      }
      downloaded.push({
        ref: await this.buildAttachmentRef(localPath, attachment.bucket, attachment.key, downloadOptions),
        localPath,
      });
    }
    return downloaded;
  }

  async uploadReplyArtifacts(
    agent: AgentInfo,
    locator: SessionLocator,
    turnId: string,
    downloaded: MaterializedAttachment[],
  ): Promise<MaterializedAttachment[]> {
    const prepared: PendingUploadArtifact[] = [];
    for (const item of downloaded) {
      const fileName = `processed-${sanitizeFileName(item.ref.name)}`;
      const localPath = path.join(
        agent.workspaceDir,
        "sessions",
        locator.sessionId,
        "outbox",
        locator.threadId,
        turnId,
        fileName,
      );
      await ensureDir(path.dirname(localPath));
      await copyFile(item.localPath, localPath);
      const artifact: PendingUploadArtifact = {
        localPath,
        name: fileName,
      };
      if (item.ref.mediaType) {
        artifact.mediaType = item.ref.mediaType;
      }
      prepared.push(artifact);
    }

    return this.uploadExistingArtifacts(locator, turnId, prepared);
  }

  async uploadExistingArtifacts(
    locator: SessionLocator,
    turnId: string,
    artifacts: PendingUploadArtifact[],
  ): Promise<MaterializedAttachment[]> {
    const uploaded: MaterializedAttachment[] = [];
    const bucketOut = this.requiredEnv("MINIOS_S3_BUCKET_OUT");

    for (const artifact of artifacts) {
      const fileName = sanitizeFileName(artifact.name);
      const localPath = artifact.localPath;
      const key = `${locator.agentId}/${locator.sessionId}/${locator.threadId}/${turnId}/${fileName}`;
      const args = [
        "--endpoint-url",
        this.requiredEnv("MINIOS_S3_ENDPOINT"),
        "s3",
        "cp",
        localPath,
        buildS3Uri(bucketOut, key),
        "--only-show-errors",
      ];
      if (artifact.mediaType) {
        args.push("--content-type", artifact.mediaType);
      }
      await this.runAws(args);
      const uploadOptions: {
        name: string;
        mediaType?: string;
      } = {
        name: fileName,
      };
      if (artifact.mediaType) {
        uploadOptions.mediaType = artifact.mediaType;
      }

      uploaded.push({
        ref: await this.buildAttachmentRef(localPath, bucketOut, key, uploadOptions),
        localPath,
      });
    }

    return uploaded;
  }

  private requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value || value.length === 0) {
      throw new Error(`missing required env for file transfer: ${name}`);
    }
    return value;
  }

  private async runAws(args: string[]): Promise<void> {
    const accessKey = this.requiredEnv("MINIOS_S3_ACCESS_KEY");
    const secretKey = this.requiredEnv("MINIOS_S3_SECRET_KEY");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("aws", args, {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: accessKey,
          AWS_SECRET_ACCESS_KEY: secretKey,
          AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
          AWS_EC2_METADATA_DISABLED: "true",
        },
      });
      let stderr = "";

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        reject(error);
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`aws ${args.join(" ")} failed with exit code ${code}: ${stderr.trim()}`));
      });
    });
  }

  private async buildAttachmentRef(
    localPath: string,
    bucket: string,
    key: string,
    options: {
      name: string;
      mediaType?: string;
    },
  ): Promise<AttachmentRef> {
    const fileBuffer = await readFile(localPath);
    const fileStat = await stat(localPath);
    const ref: AttachmentRef = {
      bucket,
      key,
      name: options.name,
      size: fileStat.size,
      sha256: createHash("sha256").update(fileBuffer).digest("hex"),
    };
    if (options.mediaType) {
      ref.mediaType = options.mediaType;
    }
    return ref;
  }
}

function sanitizeFileName(name: string): string {
  const baseName = path.basename(name).trim();
  return baseName.length > 0 ? baseName : "file.bin";
}

function buildS3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}
