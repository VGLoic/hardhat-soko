import { LocalStorageProvider } from "../local-storage-provider";
import { ScriptError, toAsyncResult } from "../utils";

type ArtifactMetadata = {
  Project: string;
  ID: string;
  Tag: string;
  "Pull date": string;
};

export async function generateStructuredDataForArtifacts(
  localProvider: LocalStorageProvider,
  opts: { debug?: boolean } = {},
): Promise<ArtifactMetadata[]> {
  const projectsResult = await toAsyncResult(localProvider.listProjects(), {
    debug: opts.debug,
  });
  if (!projectsResult.success) {
    throw new ScriptError("Error listing the projects");
  }

  const metadatas: ArtifactMetadata[] = [];
  const idsAlreadyVisited = new Set<string>();
  const projects = projectsResult.value;
  for (const project of projects) {
    const tagsResult = await toAsyncResult(localProvider.listTags(project), {
      debug: opts.debug,
    });
    if (!tagsResult.success) {
      throw new ScriptError(`Error listing the tags for project "${project}"`);
    }

    const artifactIdsPromises = tagsResult.value.map((metadata) =>
      localProvider.retrieveArtifactId(project, metadata.tag),
    );
    const idsResults = await toAsyncResult(Promise.all(artifactIdsPromises), {
      debug: opts.debug,
    });
    if (!idsResults.success) {
      throw new ScriptError(
        `Error retrieving the content for project "${project}"`,
      );
    }

    for (let i = 0; i < tagsResult.value.length; i++) {
      const { tag, lastModifiedAt } = tagsResult.value[i];
      const artifactId = idsResults.value[i];
      metadatas.push({
        Project: project,
        ID: artifactId,
        Tag: tag,
        "Pull date": deriveTimeAgo(lastModifiedAt),
      });
      idsAlreadyVisited.add(artifactId);
    }

    const idsResult = await toAsyncResult(localProvider.listIds(project), {
      debug: opts.debug,
    });
    if (!idsResult.success) {
      throw new ScriptError(`Error listing the IDs for project "${project}"`);
    }
    for (const metadata of idsResult.value) {
      if (idsAlreadyVisited.has(metadata.id)) {
        continue;
      }
      metadatas.push({
        Project: project,
        ID: metadata.id,
        Tag: "",
        "Pull date": deriveTimeAgo(metadata.lastModifiedAt),
      });
      idsAlreadyVisited.add(metadata.id);
    }
  }

  return metadatas;
}

function deriveTimeAgo(time: string): string {
  const now = new Date();
  const then = new Date(time);
  const diff = now.getTime() - then.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return `Less than a minute ago`;
}
