import fs from "fs/promises";
import { ZBuildInfo, toAsyncResult, LOG_COLORS, ScriptError } from "../utils";
import { createHash } from "crypto";

/**
 * Based from the `releases` folder content, generate a `summary.ts`, a `summary.json` and a `typings.ts` files in `<Soko directory>/generated` folder.
 * This file contains two constants:
 * - `Contracts` of the form:
 * ```ts
 * export const SOKO_DIRECTORY = "<the configured Soko directory>"
 * export const CONTRACTS = {
 *    "src/Counter.sol/Counter": ["latest", "v1.3.1"],
 *    "src/IncrementOracle.sol/IncrementOracle": ["latest", "v1.3.1"],
 * } as const;
 * ```
 * - `Releases` of the form:
 * ```ts
 * export const RELEASES = {
 *  latest: [
 *    "src/Counter.sol/Counter",
 *    "src/IncrementOracle.sol/IncrementOracle",
 *  ],
 *  "v1.3.1": [
 *    "src/Counter.sol/Counter",
 *    "src/IncrementOracle.sol/IncrementOracle",
 *  ],
 * } as const;
 * ```
 */
export async function generateReleasesSummariesAndTypings(
  sokoDirectory: string,
  filterSimilarContracts: boolean,
  opts: { debug?: boolean } = {},
) {
  // Check if the `releases` folder exists
  const doesReleasesFolderExist = await fs
    .stat(sokoDirectory)
    .catch(() => false);
  if (!doesReleasesFolderExist) {
    console.log(
      LOG_COLORS.warn,
      "\nThe local Soko directory has not been found, initializing it.",
    );
    const dirCreationResult = await toAsyncResult(
      fs.mkdir(`${sokoDirectory}/generated`, { recursive: true }),
      { debug: opts.debug },
    );
    if (!dirCreationResult.success) {
      throw new ScriptError(
        `Error creating the local Soko directory ${sokoDirectory}`,
      );
    }
  }

  // Get the list of releases as directories in the sokoDirectory folder
  const releasesEntriesResult = await toAsyncResult(
    fs.readdir(sokoDirectory, { withFileTypes: true }),
    { debug: opts.debug },
  );
  if (!releasesEntriesResult.success) {
    throw new ScriptError("Error reading the Soko directory");
  }
  const releaseNames = releasesEntriesResult.value
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .filter((name) => name !== "generated");

  const releasesPerContracts: Record<
    string,
    { release: string; contractDigest: string }[]
  > = {};

  if (releaseNames.length === 0) {
    console.log(
      LOG_COLORS.warn,
      "\nNo local releases have been found. Generating an empty summary.",
    );
    await writeEmptySummaries(sokoDirectory, opts);
    return;
  }

  for await (const release of releaseArtifacts(
    sokoDirectory,
    releaseNames,
    opts,
  )) {
    for (const contractPath in release.buildInfo.output.contracts) {
      const contracts = release.buildInfo.output.contracts[contractPath];
      for (const contractName in contracts) {
        const contractHash = createHash("sha256");
        contractHash.update(
          JSON.stringify(
            release.buildInfo.output.contracts[contractPath][contractName].abi,
          ),
        );
        contractHash.update(
          JSON.stringify(
            release.buildInfo.output.contracts[contractPath][contractName].evm,
          ),
        );
        const contractDigest = contractHash.digest("hex");
        const contractKey = `${contractPath}:${contractName}`;
        if (!releasesPerContracts[contractKey]) {
          releasesPerContracts[contractKey] = [];
        }
        releasesPerContracts[contractKey].push({
          release: release.name,
          contractDigest,
        });
      }
    }
  }

  // Sort and optionally filter similar contracts
  const updatedReleasesPerContracts: Record<string, string[]> = {};
  for (const contractKey in releasesPerContracts) {
    // Order releases consistently
    releasesPerContracts[contractKey].sort((a, b) =>
      a.release.localeCompare(b.release),
    );
    const updatedReleases = [];
    if (filterSimilarContracts) {
      // Filter out similar contract
      let lastSemanticVersionContractHash = undefined;
      for (const contractRelease of releasesPerContracts[contractKey]) {
        if (!isSemanticVersion(contractRelease.release)) {
          updatedReleases.push(contractRelease.release);
        } else {
          if (
            lastSemanticVersionContractHash &&
            lastSemanticVersionContractHash === contractRelease.contractDigest
          ) {
            continue;
          }
          updatedReleases.push(contractRelease.release);
          lastSemanticVersionContractHash = contractRelease.contractDigest;
        }
      }
    } else {
      updatedReleases.push(
        ...releasesPerContracts[contractKey].map(
          (contractRelease) => contractRelease.release,
        ),
      );
    }
    updatedReleasesPerContracts[contractKey] = updatedReleases;
  }

  const contractsPerReleases = releaseNames.reduce(
    (acc, release) => {
      acc[release] = [];
      return acc;
    },
    {} as Record<string, string[]>,
  );
  for (const contractKey in updatedReleasesPerContracts) {
    const contractReleases = updatedReleasesPerContracts[contractKey];
    for (const release of contractReleases) {
      if (!contractsPerReleases[release]) {
        throw new ScriptError(
          `Release "${release}" not found in contractsPerReleases`,
        );
      }
      contractsPerReleases[release].push(contractKey);
    }
  }

  // Generate the `generate/summary.ts` content
  let releasesSummary = `// THIS IS AN AUTOGENERATED FILE. EDIT AT YOUR OWN RISKS.\n\n`;
  releasesSummary += `export const SOKO_DIRECTORY="${sokoDirectory}";\n\n`;
  releasesSummary += `export const CONTRACTS = {\n`;
  for (const contractKey in updatedReleasesPerContracts) {
    // 3. output
    releasesSummary += `  "${contractKey}": ${JSON.stringify(
      updatedReleasesPerContracts[contractKey],
    )},\n`;
  }
  releasesSummary += `} as const;\n\n`;

  releasesSummary += `export const RELEASES = {\n`;
  for (const release in contractsPerReleases) {
    releasesSummary += `  "${release}": ${JSON.stringify(
      contractsPerReleases[release],
    )},\n`;
  }
  releasesSummary += `} as const;\n`;

  await fs
    .mkdir(`${sokoDirectory}/generated`, { recursive: true })
    .catch(() => {});

  // Write the `summary.ts` file
  const writeTsResult = await toAsyncResult(
    fs.writeFile(`${sokoDirectory}/generated/summary.ts`, releasesSummary),
    { debug: opts.debug },
  );
  if (!writeTsResult.success) {
    throw new ScriptError(
      `Error writing the summary.ts file: ${writeTsResult.error}`,
    );
  }
  // Write the `summary.json` file
  const writeJsonResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/generated/summary.json`,
      JSON.stringify(
        {
          sokoDirectory: sokoDirectory,
          contracts: updatedReleasesPerContracts,
          releases: contractsPerReleases,
        },
        null,
        4,
      ),
    ),
    { debug: opts.debug },
  );
  if (!writeJsonResult.success) {
    throw new ScriptError(
      `Error writing the summary.json file: ${writeJsonResult.error}`,
    );
  }
}

async function* releaseArtifacts(
  sokoDirectory: string,
  releases: string[],
  opts: { debug?: boolean } = {},
) {
  for (const release of releases) {
    const releaseBuildInfo = await getReleaseBuildInfo(
      sokoDirectory,
      release,
      opts,
    );
    yield { buildInfo: releaseBuildInfo, name: release };
  }
}

async function getReleaseBuildInfo(
  sokoDirectory: string,
  release: string,
  opts: { debug?: boolean },
) {
  const buildInfoExists = await fs
    .stat(`${sokoDirectory}/${release}/build-info.json`)
    .catch(() => false);
  if (!buildInfoExists) {
    throw new ScriptError(
      `"build-info.json" not found for release "${release}". Skipping`,
    );
  }
  const buildInfoContentResult = await toAsyncResult(
    fs
      .readFile(`${sokoDirectory}/${release}/build-info.json`, "utf-8")
      .then(JSON.parse),
    { debug: opts.debug },
  );
  if (!buildInfoContentResult.success) {
    console.error(buildInfoContentResult.error);
    throw buildInfoContentResult.error;
  }
  const buildInfoResult = ZBuildInfo.passthrough().safeParse(
    buildInfoContentResult.value,
  );
  if (!buildInfoResult.success) {
    console.error(buildInfoResult.error);
    throw buildInfoResult.error;
  }
  return buildInfoResult.data;
}

function isSemanticVersion(s: string) {
  let consideredString = s;
  if (s.startsWith("v")) {
    consideredString = s.substring(1);
  }
  const parts = consideredString.split(".");
  if (parts.length === 0) return false;
  if (parts.length > 3) return false;
  if (
    parts.some((part) => {
      const partAsNumber = Number(part);
      if (isNaN(partAsNumber)) return true;
      if (Math.floor(partAsNumber) !== partAsNumber) return true;
    })
  )
    return false;
  return true;
}

function generateEmptyReleasesSummaryTsContent(sokoDirectory: string) {
  return `// THIS IS AN AUTOGENERATED FILE. EDIT AT YOUR OWN RISKS.
  export const SOKO_DIRECTORY="${sokoDirectory}";
  
  export const CONTRACTS = {} as const;
  
  export const RELEASES = {} as const;
  `;
}
function generateEmptyReleasesSummaryJsonContent(sokoDirectory: string) {
  return {
    sokoDirectory,
    contracts: {},
    releases: {},
  };
}

async function writeEmptySummaries(
  sokoDirectory: string,
  opts: { debug?: boolean } = {},
) {
  const writeEmptyTsSummaryResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/generated/summary.ts`,
      generateEmptyReleasesSummaryTsContent(sokoDirectory),
    ),
    { debug: opts.debug },
  );
  if (!writeEmptyTsSummaryResult.success) {
    throw new Error(
      `Error writing the summary.ts file: ${writeEmptyTsSummaryResult.error}`,
    );
  }
  const writeEmptyJsonResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/generated/summary.json`,
      JSON.stringify(
        generateEmptyReleasesSummaryJsonContent(sokoDirectory),
        null,
        4,
      ),
    ),
    { debug: opts.debug },
  );
  if (!writeEmptyJsonResult.success) {
    throw new Error(
      `Error writing the summary.json file: ${writeEmptyJsonResult.error}`,
    );
  }
  const writeEmptyTypingsResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/generated/typings.ts`,
      await fs.readFile(`${__dirname}/typings.txt`, "utf-8"),
    ),
    { debug: opts.debug },
  );
  if (!writeEmptyTypingsResult.success) {
    throw new Error(
      `Error writing the typings.ts file: ${writeEmptyTypingsResult.error}`,
    );
  }
}
