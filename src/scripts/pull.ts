import fs from "fs/promises";
import { toAsyncResult } from "../utils";
import { LOG_COLORS, ScriptError } from "../utils";
import { ReleaseStorageProvider } from "../s3-bucket-provider";

/**
 * Pulls releases from an S3 bucket
 * @param opts.force Whether to force the pull
 * @param opts.release A specific release to pull
 * @param opts.debug Whether to enable debug mode
 * @param releaseStorageProvider The release storage provider
 * @returns An object with the remote releases, pulled releases, and failed releases
 */
export async function pull(
  sokoDirectory: string,
  opts: { force: boolean; release?: string; debug: boolean },
  releaseStorageProvider: ReleaseStorageProvider,
) {
  const remoteReleasesResult = await toAsyncResult(
    releaseStorageProvider.listReleases(),
    { debug: opts.debug },
  );
  if (!remoteReleasesResult.success) {
    throw new ScriptError("Error listing the releases in the storage");
  }
  const remoteReleases = remoteReleasesResult.value;

  if (remoteReleases.length === 0) {
    return {
      remoteReleases: [],
      pulledReleases: [],
      failedReleases: [],
    };
  }

  if (opts.release && !remoteReleases.includes(opts.release)) {
    throw new ScriptError(
      `The release "${opts.release}" does not exist in the S3 bucket`,
    );
  }

  let localReleases: string[] = [];
  const doesReleasesFolderExist = await fs
    .stat(sokoDirectory)
    .catch(() => false);
  if (doesReleasesFolderExist) {
    // Get the list of releases as directories in the sokoDirectory folder
    const releasesEntriesResult = await toAsyncResult(
      fs.readdir(sokoDirectory, { withFileTypes: true }),
      { debug: opts.debug },
    );

    if (!releasesEntriesResult.success) {
      throw new ScriptError("Error reading the contents of the Soko directory");
    }

    localReleases = releasesEntriesResult.value
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .filter((name) => name !== "generated");
  }

  const localReleasesSet = new Set(localReleases);

  let releasesToPull: string[];
  if (!opts.force) {
    if (opts.release) {
      if (localReleasesSet.has(opts.release)) {
        return {
          remoteReleases,
          pulledReleases: [],
          failedReleases: [],
        };
      }
      releasesToPull = [opts.release];
    } else {
      const missingReleases = remoteReleases.filter(
        (release) => !localReleasesSet.has(release),
      );

      if (missingReleases.length === 0) {
        return {
          remoteReleases,
          pulledReleases: [],
          failedReleases: [],
        };
      }

      if (missingReleases.length > 0) {
        console.log(
          LOG_COLORS.log,
          `\nFound ${missingReleases.length} missing releases, starting to pull`,
        );
      }

      releasesToPull = missingReleases;
    }
  } else {
    if (opts.release) {
      console.log(
        LOG_COLORS.log,
        `\nForce flag enabled, starting to pull release "${opts.release}"`,
      );
      releasesToPull = [opts.release];
    } else {
      console.log(
        LOG_COLORS.log,
        "\nForce flag enabled, starting to pull all releases",
      );
      releasesToPull = remoteReleases;
    }
  }

  const pullResults = await Promise.allSettled(
    releasesToPull.map(async (releaseToPull) =>
      pullRelease(
        sokoDirectory,
        releaseToPull,
        releaseStorageProvider,
        opts.debug,
      )
        .then(() => {
          console.log(
            LOG_COLORS.success,
            `\nSuccessfully pulled release "${releaseToPull}"`,
          );
        })
        .catch((err) => {
          if (opts.debug) {
            console.error(
              LOG_COLORS.error,
              `\nError pulling release "${releaseToPull}": ${err.message}`,
            );
          } else {
            console.error(
              LOG_COLORS.error,
              `\nError pulling release "${releaseToPull}"`,
            );
          }
          throw err;
        }),
    ),
  );

  const pulledReleases = [];
  const failedReleases = [];
  for (let i = 0; i < pullResults.length; i++) {
    const releaseToPull = releasesToPull[i];
    if (pullResults[i].status === "fulfilled") {
      pulledReleases.push(releaseToPull);
    } else {
      failedReleases.push(releaseToPull);
    }
  }

  return {
    remoteReleases,
    pulledReleases,
    failedReleases,
  };
}

async function pullRelease(
  sokoDirectory: string,
  releaseToPull: string,
  releaseStorageProvider: ReleaseStorageProvider,
  debug: boolean,
) {
  const releaseContentResult = await toAsyncResult(
    releaseStorageProvider.pullRelease(releaseToPull),
    { debug },
  );
  if (!releaseContentResult.success) {
    throw new ScriptError(
      `Error pulling the release "${releaseToPull}" from the storage`,
    );
  }

  const releaseDirectoryCreationResult = await toAsyncResult(
    fs.mkdir(`${sokoDirectory}/${releaseToPull}`, { recursive: true }),
    { debug },
  );
  if (!releaseDirectoryCreationResult.success) {
    throw new ScriptError(
      `Error creating the release directory for "${releaseToPull}"`,
    );
  }

  const copyResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/${releaseToPull}/build-info.json`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      releaseContentResult.value as any,
    ),
    { debug },
  );
  if (!copyResult.success) {
    throw new ScriptError(
      `Error copying the "build-info.json" for release "${releaseToPull}"`,
    );
  }
}
