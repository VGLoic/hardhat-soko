import { toAsyncResult } from "../utils";
import { LOG_COLORS, ScriptError } from "../utils";
import { StorageProvider } from "../s3-bucket-provider";
import { LocalStorageProvider } from "./local-storage-provider";

/**
 * Pulls artifacts of a project from the storage provider
 * @param project The project name
 * @param tagOrId The tag or ID of the artifact to pull
 * @param opts.force Whether to force the pull
 * @param opts.release A specific release to pull
 * @param opts.debug Whether to enable debug mode
 * @param storageProvider The storage provider
 * @returns An object with the remote releases, pulled releases, and failed releases
 */
export async function pull(
  project: string,
  tagOrId: string | undefined,
  opts: { force: boolean; debug: boolean },
  localProvider: LocalStorageProvider,
  storageProvider: StorageProvider,
) {
  const remoteListingResult = await toAsyncResult(
    Promise.all([
      storageProvider.listTags(project),
      storageProvider.listIds(project),
    ]),
    { debug: opts.debug },
  );
  if (!remoteListingResult.success) {
    throw new ScriptError("Error listing the remote tags and IDs");
  }
  const [remoteTags, remoteIds] = remoteListingResult.value;

  const tagsToDownload: string[] = [];
  const idsToDownload: string[] = [];

  if (tagOrId) {
    if (remoteTags.includes(tagOrId)) {
      tagsToDownload.push(tagOrId);
    } else if (remoteIds.includes(tagOrId)) {
      idsToDownload.push(tagOrId);
    } else {
      throw new ScriptError(
        `The tag or ID "${tagOrId}" does not exist in the storage`,
      );
    }
  } else {
    tagsToDownload.push(...remoteTags);
    idsToDownload.push(...remoteIds);
  }

  let filteredTagsToDownload: string[] = [];
  let filteredIdsToDownload: string[] = [];
  if (opts.force) {
    filteredTagsToDownload = tagsToDownload;
    filteredIdsToDownload = idsToDownload;
  } else {
    const localListingResult = await toAsyncResult(
      Promise.all([
        localProvider.listTags(project).then((tagMetadatas) => {
          const tags = new Set<string>();
          for (const tagMetadata of tagMetadatas) {
            tags.add(tagMetadata.tag);
          }
          return tags;
        }),
        localProvider.listIds(project).then((idMetadatas) => {
          const ids = new Set<string>();
          for (const idMetadata of idMetadatas) {
            ids.add(idMetadata.id);
          }
          return ids;
        }),
      ]),
      { debug: opts.debug },
    );
    if (!localListingResult.success) {
      throw new ScriptError("Error listing the local tags and IDs");
    }

    const [localTags, localIds] = localListingResult.value;

    filteredTagsToDownload = tagsToDownload.filter(
      (tag) => !localTags.has(tag),
    );
    filteredIdsToDownload = idsToDownload.filter((id) => !localIds.has(id));
  }

  if (
    filteredTagsToDownload.length === 0 &&
    filteredIdsToDownload.length === 0
  ) {
    return {
      remoteTags,
      remoteIds,
      pulledTags: [],
      pulledIds: [],
      failedTags: [],
      failedIds: [],
    };
  }

  const missingArtifactCount =
    filteredTagsToDownload.length + filteredIdsToDownload.length;
  console.error(
    LOG_COLORS.log,
    `\nFound ${missingArtifactCount} missing artifacts, starting to pull`,
  );

  const tagsPromises: Promise<void>[] = filteredTagsToDownload.map(
    async (tag) => {
      const downloadResult = await toAsyncResult(
        storageProvider.downloadArtifactByTag(project, tag),
        { debug: opts.debug },
      );
      if (!downloadResult.success) {
        throw new ScriptError(`Error downloading the tag "${tag}"`);
      }

      const createResult = await toAsyncResult(
        localProvider.createArtifactByTag(project, tag, downloadResult.value),
        { debug: opts.debug },
      );
      if (!createResult.success) {
        throw new ScriptError(`Error creating the tag "${tag}"`);
      }

      console.error(
        LOG_COLORS.success,
        `\nSuccessfully pulled artifact "${tag}"`,
      );
    },
  );
  const idsPromises: Promise<void>[] = filteredIdsToDownload.map(async (id) => {
    const downloadResult = await toAsyncResult(
      storageProvider.downloadArtifactById(project, id),
      { debug: opts.debug },
    );
    if (!downloadResult.success) {
      throw new ScriptError(`Error downloading the ID "${id}"`);
    }

    const createResult = await toAsyncResult(
      localProvider.createArtifactById(project, id, downloadResult.value),
      { debug: opts.debug },
    );
    if (!createResult.success) {
      throw new ScriptError(`Error creating the ID "${id}"`);
    }

    console.error(LOG_COLORS.success, `\nSuccessfully pulled artifact "${id}"`);
  });

  const tagsSettlements = await Promise.allSettled(tagsPromises);
  const pulledTags = [];
  const failedTags = [];
  for (let i = 0; i < tagsSettlements.length; i++) {
    if (tagsSettlements[i].status === "fulfilled") {
      pulledTags.push(filteredTagsToDownload[i]);
    } else {
      failedTags.push(filteredTagsToDownload[i]);
    }
  }

  const idsSettlements = await Promise.allSettled(idsPromises);
  const pulledIds = [];
  const failedIds = [];
  for (let i = 0; i < idsSettlements.length; i++) {
    if (idsSettlements[i].status === "fulfilled") {
      pulledIds.push(filteredIdsToDownload[i]);
    } else {
      failedIds.push(filteredIdsToDownload[i]);
    }
  }

  return {
    remoteTags,
    remoteIds,
    pulledTags,
    pulledIds,
    failedTags,
    failedIds,
  };
}
