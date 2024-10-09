import { StorageProvider } from "../s3-bucket-provider";
import { toAsyncResult } from "../utils";
import {
  LOG_COLORS,
  retrieveFreshCompilationArtifact,
  ScriptError,
} from "../utils";
import crypto from "crypto";

export async function pushArtifact(
  artifactPath: string,
  project: string,
  tag: string | undefined,
  opts: {
    force: boolean;
    debug: boolean;
  },
  storageProvider: StorageProvider,
) {
  const freshBuildInfoResult = await toAsyncResult(
    retrieveFreshCompilationArtifact(artifactPath),
    {
      debug: opts.debug,
    },
  );
  if (!freshBuildInfoResult.success) {
    throw new ScriptError(`❌ Error retrieving the compilation artifact`);
  }

  if (freshBuildInfoResult.value.status === "error") {
    throw new ScriptError(
      `❌ Error retrieving the compilation artifact. ${freshBuildInfoResult.value.reason}`,
    );
  }

  if (tag) {
    const hasTagResult = await toAsyncResult(
      storageProvider.hasArtifactByTag(project, tag),
      { debug: opts.debug },
    );
    if (!hasTagResult.success) {
      throw new ScriptError(
        `Error checking if the tag "${tag}" exists on the storage`,
      );
    }
    if (hasTagResult.value) {
      if (!opts.force) {
        throw new ScriptError(
          `The tag "${tag}" already exists on the storage. Please, make sure to use a different tag name.`,
        );
      } else {
        console.error(
          LOG_COLORS.warn,
          `The tag "${tag}" already exists on the storage. Forcing the push of the tag.`,
        );
      }
    }
  }

  const hash = crypto.createHash("sha256");
  hash.update(freshBuildInfoResult.value.content);
  const checksum = hash.digest("hex");
  const artifactId = checksum.substring(0, 12);

  const pushResult = await toAsyncResult(
    storageProvider.uploadArtifact(
      project,
      artifactId,
      tag,
      freshBuildInfoResult.value.content,
    ),
    { debug: opts.debug },
  );

  if (!pushResult.success) {
    throw new ScriptError(
      `Error pushing the artifact "${project}:${tag || artifactId}" to the storage`,
    );
  }

  return artifactId;
}
