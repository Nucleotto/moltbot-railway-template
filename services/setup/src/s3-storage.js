/**
 * S3 Storage Module for Moltbot Railway Template
 * 
 * Provides sync between local filesystem and S3 bucket.
 * S3 is the source of truth - local /tmp is ephemeral cache.
 * 
 * Usage:
 *   const storage = new S3Storage({ bucket, prefix, localDir });
 *   await storage.downloadAll();  // On startup
 *   await storage.uploadFile('moltbot.json');  // After changes
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export class S3Storage {
  constructor(options = {}) {
    // Use RAILWAY_S3_* to avoid AWS SDK auto-detecting credentials for other services (like Bedrock)
    this.bucket = options.bucket || process.env.RAILWAY_S3_BUCKET || process.env.AWS_S3_BUCKET_NAME || process.env.S3_BUCKET;
    this.prefix = options.prefix || process.env.S3_PREFIX || "moltbot/";
    // Use HOME as base - moltbot writes to $HOME/.moltbot/
    this.localDir = options.localDir || process.env.HOME || "/data";
    
    // Railway Object Storage credentials - use RAILWAY_S3_* to not conflict with AWS SDK defaults
    const endpoint = options.endpoint || process.env.RAILWAY_S3_ENDPOINT || process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT;
    const region = options.region || process.env.RAILWAY_S3_REGION || process.env.AWS_DEFAULT_REGION || process.env.S3_REGION || "auto";
    const accessKeyId = options.accessKeyId || process.env.RAILWAY_S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = options.secretAccessKey || process.env.RAILWAY_S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;
    
    // Log configuration for debugging
    console.log(`[s3] Initializing S3Storage:`);
    console.log(`[s3]   bucket: ${this.bucket || "(not set)"}`);
    console.log(`[s3]   prefix: ${this.prefix}`);
    console.log(`[s3]   endpoint: ${endpoint || "(not set)"}`);
    console.log(`[s3]   region: ${region}`);
    console.log(`[s3]   accessKeyId: ${accessKeyId ? accessKeyId.slice(0, 8) + "..." : "(not set)"}`);
    console.log(`[s3]   secretAccessKey: ${secretAccessKey ? "***" : "(not set)"}`);
    
    if (!this.bucket) {
      console.error(`[s3] WARNING: No S3 bucket configured! Set AWS_S3_BUCKET_NAME env var.`);
    }
    if (!endpoint) {
      console.error(`[s3] WARNING: No S3 endpoint configured! Set AWS_ENDPOINT_URL env var.`);
    }
    
    this.client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: false, // Railway uses virtual-hosted-style URLs
    });
    
    // Ensure prefix ends with /
    if (this.prefix && !this.prefix.endsWith("/")) {
      this.prefix += "/";
    }
  }

  /**
   * Get the S3 key for a local file path
   */
  getS3Key(localPath) {
    const relativePath = path.relative(this.localDir, localPath);
    return this.prefix + relativePath.replace(/\\/g, "/");
  }

  /**
   * Get the local path for an S3 key
   */
  getLocalPath(s3Key) {
    const relativePath = s3Key.startsWith(this.prefix) 
      ? s3Key.slice(this.prefix.length) 
      : s3Key;
    return path.join(this.localDir, relativePath);
  }

  /**
   * Download all files from S3 to local directory
   * Called on startup to hydrate local state
   */
  async downloadAll() {
    console.log(`[s3] Downloading all files from s3://${this.bucket}/${this.prefix} to ${this.localDir}`);
    
    // Ensure local directory exists
    fs.mkdirSync(this.localDir, { recursive: true });
    
    let continuationToken;
    let totalFiles = 0;
    
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.prefix,
        ContinuationToken: continuationToken,
      });
      
      const listResponse = await this.client.send(listCommand);
      
      if (listResponse.Contents) {
        for (const object of listResponse.Contents) {
          // Skip "directory" markers
          if (object.Key.endsWith("/")) continue;
          
          await this.downloadFile(object.Key);
          totalFiles++;
        }
      }
      
      continuationToken = listResponse.NextContinuationToken;
    } while (continuationToken);
    
    console.log(`[s3] Downloaded ${totalFiles} files`);
    return totalFiles;
  }

  /**
   * Download a single file from S3
   */
  async downloadFile(s3Key) {
    const localPath = this.getLocalPath(s3Key);
    const localDir = path.dirname(localPath);
    
    // Ensure directory exists
    fs.mkdirSync(localDir, { recursive: true });
    
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
    });
    
    try {
      const response = await this.client.send(command);
      const writeStream = fs.createWriteStream(localPath);
      await pipeline(response.Body, writeStream);
      console.log(`[s3] Downloaded: ${s3Key} -> ${localPath}`);
      return true;
    } catch (err) {
      if (err.name === "NoSuchKey") {
        console.log(`[s3] File not found: ${s3Key}`);
        return false;
      }
      throw err;
    }
  }

  /**
   * Upload a single file to S3
   * @param {string} relativePath - Path relative to localDir (e.g., "moltbot.json" or ".moltbot/moltbot.json")
   */
  async uploadFile(relativePath) {
    const localPath = path.join(this.localDir, relativePath);
    const s3Key = this.prefix + relativePath.replace(/\\/g, "/");
    
    if (!fs.existsSync(localPath)) {
      console.log(`[s3] Local file not found: ${localPath}`);
      return false;
    }
    
    const fileContent = fs.readFileSync(localPath);
    
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      Body: fileContent,
      ContentType: this.getContentType(localPath),
    });
    
    await this.client.send(command);
    console.log(`[s3] Uploaded: ${localPath} -> s3://${this.bucket}/${s3Key}`);
    return true;
  }

  /**
   * Upload all files from local directory to S3
   */
  async uploadAll() {
    console.log(`[s3] Uploading all files from ${this.localDir} to s3://${this.bucket}/${this.prefix}`);
    
    const files = this.walkDir(this.localDir);
    let totalFiles = 0;
    
    for (const file of files) {
      const relativePath = path.relative(this.localDir, file);
      await this.uploadFile(relativePath);
      totalFiles++;
    }
    
    console.log(`[s3] Uploaded ${totalFiles} files`);
    return totalFiles;
  }

  /**
   * Upload specific directory (e.g., workspace)
   */
  async uploadDir(relativeDirPath) {
    const localDirPath = path.join(this.localDir, relativeDirPath);
    
    if (!fs.existsSync(localDirPath)) {
      console.log(`[s3] Local directory not found: ${localDirPath}`);
      return 0;
    }
    
    const files = this.walkDir(localDirPath);
    let totalFiles = 0;
    
    for (const file of files) {
      const relativePath = path.relative(this.localDir, file);
      await this.uploadFile(relativePath);
      totalFiles++;
    }
    
    console.log(`[s3] Uploaded ${totalFiles} files from ${relativeDirPath}`);
    return totalFiles;
  }

  /**
   * Check if a file exists in S3
   */
  async exists(relativePath) {
    const s3Key = this.prefix + relativePath.replace(/\\/g, "/");
    
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
      }));
      return true;
    } catch (err) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Delete a file from S3
   */
  async deleteFile(relativePath) {
    const s3Key = this.prefix + relativePath.replace(/\\/g, "/");
    
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
    }));
    
    console.log(`[s3] Deleted: s3://${this.bucket}/${s3Key}`);
    return true;
  }

  /**
   * Recursively walk a directory and return all file paths
   */
  walkDir(dir) {
    const files = [];
    
    if (!fs.existsSync(dir)) return files;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.walkDir(fullPath));
      } else {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  /**
   * Get content type for a file
   */
  getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".json": "application/json",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".js": "application/javascript",
      ".ts": "application/typescript",
      ".yaml": "application/yaml",
      ".yml": "application/yaml",
    };
    return types[ext] || "application/octet-stream";
  }
}

/**
 * Create a singleton storage instance
 */
let storageInstance = null;

export function getStorage(options = {}) {
  if (!storageInstance) {
    storageInstance = new S3Storage(options);
  }
  return storageInstance;
}

/**
 * Initialize storage - download all from S3 on startup
 */
export async function initStorage(options = {}) {
  const storage = getStorage(options);
  
  try {
    await storage.downloadAll();
    console.log("[s3] Storage initialized successfully");
    return storage;
  } catch (err) {
    // If bucket is empty or doesn't exist yet, that's OK for first run
    if (err.name === "NoSuchBucket") {
      console.log("[s3] Bucket does not exist yet - will create on first upload");
      return storage;
    }
    if (err.Code === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      console.log("[s3] No existing state in S3 - starting fresh");
      return storage;
    }
    console.error("[s3] Failed to initialize storage:", err);
    throw err;
  }
}

export default S3Storage;
