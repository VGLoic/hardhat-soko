import {
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NodeJsClient } from "@smithy/types";
import { Stream } from "stream";

export interface StorageProvider {
  listTags(project: string): Promise<string[]>;
  listIds(project: string): Promise<string[]>;
  hasArtifactByTag(project: string, tag: string): Promise<boolean>;
  hasArtifactById(project: string, tag: string): Promise<boolean>;
  uploadArtifact(
    project: string,
    id: string,
    tag: string | undefined,
    content: string,
  ): Promise<void>;
  downloadArtifactById(project: string, id: string): Promise<Stream>;
  downloadArtifactByTag(project: string, tag: string): Promise<Stream>;
}

type S3BucketProviderConfig = {
  bucketName: string;
  bucketRegion: string;
  accessKeyId: string;
  secretAccessKey: string;
  rootPath?: string;
};
export class S3BucketProvider implements StorageProvider {
  private readonly config: S3BucketProviderConfig;
  private readonly client: NodeJsClient<S3Client>;
  private readonly rootPath: string;

  constructor(config: S3BucketProviderConfig) {
    const s3Client: NodeJsClient<S3Client> = new S3Client({
      region: config.bucketRegion,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    this.rootPath = config.rootPath || "";
    this.config = config;
    this.client = s3Client;
  }

  public async listIds(project: string): Promise<string[]> {
    const listCommand = new ListObjectsV2Command({
      Bucket: this.config.bucketName,
      Prefix: `${this.rootPath}/${project}/ids/`,
    });
    const listResult = await this.client.send(listCommand);
    const contents = listResult.Contents;
    if (!contents) {
      return [];
    }
    const ids = [];
    for (const content of contents) {
      const key = content.Key;
      if (!key) continue;
      const id = key
        .replace(`${this.rootPath}/${project}/ids/`, "")
        .replace(".json", "");
      ids.push(id);
    }
    return ids;
  }

  public async listTags(project: string): Promise<string[]> {
    const listCommand = new ListObjectsV2Command({
      Bucket: this.config.bucketName,
      Prefix: `${this.rootPath}/${project}/tags/`,
    });
    const listResult = await this.client.send(listCommand);
    const contents = listResult.Contents;
    if (!contents) {
      return [];
    }
    const tags = [];
    for (const content of contents) {
      const key = content.Key;
      if (!key) continue;
      const tag = key
        .replace(`${this.rootPath}/${project}/tags/`, "")
        .replace(".json", "");
      tags.push(tag);
    }
    return tags;
  }

  public async hasArtifactByTag(
    project: string,
    tag: string,
  ): Promise<boolean> {
    const headCommand = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: `${this.rootPath}/${project}/tags/${tag}.json`,
    });
    const headResult = await this.client.send(headCommand).catch((err) => {
      if (err instanceof NoSuchKey) {
        return null;
      }
      throw err;
    });
    return Boolean(headResult);
  }

  public async hasArtifactById(project: string, id: string): Promise<boolean> {
    const headCommand = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: `${this.rootPath}/${project}/ids/${id}.json`,
    });
    const headResult = await this.client.send(headCommand).catch((err) => {
      if (err instanceof NoSuchKey) {
        return null;
      }
      throw err;
    });
    return Boolean(headResult);
  }

  public async uploadArtifact(
    project: string,
    id: string,
    tag: string | undefined,
    content: string,
  ): Promise<void> {
    const idKey = `${this.rootPath}/${project}/ids/${id}.json`;

    const putIdCommand = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: idKey,
      Body: content,
    });
    await this.client.send(putIdCommand);

    if (tag) {
      const copyCommand = new CopyObjectCommand({
        Bucket: this.config.bucketName,
        Key: `${this.rootPath}/${project}/tags/${tag}.json`,
        CopySource: `${this.config.bucketName}/${idKey}`,
      });
      await this.client.send(copyCommand);
    }
  }

  public async downloadArtifactById(
    project: string,
    id: string,
  ): Promise<Stream> {
    const getObjectCommand = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: `${this.rootPath}/${project}/ids/${id}.json`,
    });
    const getObjectResult = await this.client.send(getObjectCommand);
    if (!getObjectResult.Body) {
      throw new Error("Error fetching the artifact");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getObjectResult.Body.transformToWebStream() as any;
  }

  public async downloadArtifactByTag(
    project: string,
    tag: string,
  ): Promise<Stream> {
    const getObjectCommand = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: `${this.rootPath}/${project}/tags/${tag}.json`,
    });
    const getObjectResult = await this.client.send(getObjectCommand);
    if (!getObjectResult.Body) {
      throw new Error("Error fetching the artifact");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return getObjectResult.Body.transformToWebStream() as any;
  }
}
