import fs from "fs/promises";
import { Stream } from "stream";
import { ZBuildInfo } from "./utils";
import { z } from "zod";
import crypto from "crypto";

export class LocalStorageProvider {
  public readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  public async hasId(project: string, id: string): Promise<boolean> {
    return this.exists(`${this.rootPath}/${project}/ids/${id}.json`);
  }

  public async hasTag(project: string, tag: string): Promise<boolean> {
    return this.exists(`${this.rootPath}/${project}/tags/${tag}.json`);
  }

  public async listProjects(): Promise<string[]> {
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  public async listIds(project: string): Promise<
    {
      id: string;
      lastModifiedAt: string;
    }[]
  > {
    const entries = await fs.readdir(`${this.rootPath}/${project}/ids`, {
      withFileTypes: true,
    });
    const ids = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        ids.push(entry.name.replace(".json", ""));
      }
    }
    const statsPromises = ids.map((id) =>
      fs.stat(`${this.rootPath}/${project}/ids/${id}.json`),
    );
    const allStats = await Promise.all(statsPromises);

    return ids.map((id, i) => ({
      id,
      lastModifiedAt: allStats[i].mtime.toISOString(),
    }));
  }

  public async listTags(project: string): Promise<
    {
      tag: string;
      lastModifiedAt: string;
    }[]
  > {
    const entries = await fs.readdir(`${this.rootPath}/${project}/tags`, {
      withFileTypes: true,
    });
    const tags = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        tags.push(entry.name.replace(".json", ""));
      }
    }
    const statsPromises = tags.map((tag) =>
      fs.stat(`${this.rootPath}/${project}/tags/${tag}.json`),
    );
    const allStats = await Promise.all(statsPromises);
    return tags.map((tag, i) => ({
      tag,
      lastModifiedAt: allStats[i].mtime.toISOString(),
    }));
  }

  public async createArtifactById(
    project: string,
    id: string,
    artifact: Stream,
  ): Promise<void> {
    return fs.writeFile(`${this.rootPath}/${project}/ids/${id}.json`, artifact);
  }

  public async createArtifactByTag(
    project: string,
    tag: string,
    artifact: Stream,
  ): Promise<void> {
    return fs.writeFile(
      `${this.rootPath}/${project}/tags/${tag}.json`,
      artifact,
    );
  }

  public async ensureSetup(): Promise<void> {
    const doesRootPathExist = await this.exists(this.rootPath);
    if (!doesRootPathExist) {
      await fs.mkdir(this.rootPath, { recursive: true });
    }
  }

  public async ensureProjectSetup(project: string): Promise<void> {
    const pathsToEnsure = [
      this.rootPath,
      `${this.rootPath}/${project}`,
      `${this.rootPath}/${project}/ids`,
      `${this.rootPath}/${project}/tags`,
    ];
    for (const path of pathsToEnsure) {
      const doesPathExist = await this.exists(path);
      if (!doesPathExist) {
        await fs.mkdir(path, { recursive: true });
      }
    }
  }

  public async retrieveArtifactByTag(
    project: string,
    tag: string,
  ): Promise<z.infer<typeof ZBuildInfo>> {
    const artifactContent = await fs.readFile(
      `${this.rootPath}/${project}/tags/${tag}.json`,
      "utf-8",
    );
    const rawArtifact = JSON.parse(artifactContent);
    return ZBuildInfo.passthrough().parse(rawArtifact);
  }

  public async retrieveArtifactById(
    project: string,
    id: string,
  ): Promise<z.infer<typeof ZBuildInfo>> {
    const artifactContent = await fs.readFile(
      `${this.rootPath}/${project}/ids/${id}.json`,
      "utf-8",
    );
    const rawArtifact = JSON.parse(artifactContent);
    return ZBuildInfo.passthrough().parse(rawArtifact);
  }

  public async retrieveArtifactId(
    project: string,
    tag: string,
  ): Promise<string> {
    const artifactContent = await fs.readFile(
      `${this.rootPath}/${project}/tags/${tag}.json`,
      "utf-8",
    );
    const hash = crypto.createHash("sha256");
    hash.update(artifactContent);
    return hash.digest("base64").substring(0, 12);
  }

  private exists(path: string): Promise<boolean> {
    return fs
      .stat(path)
      .then(() => true)
      .catch(() => false);
  }
}
