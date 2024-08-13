import fs from "fs/promises";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  ZBuildInfo,
  type ZContractInfo,
  toAsyncResult,
  LOG_COLORS,
  retrieveFreshBuildInfo,
  ScriptError,
} from "../utils";

/**
 * This script generates the differences between the artifacts generated by a fresh compilation and the ones of a release.
 *
 * The fresh artifacts are represented by the file at `artifacts/build-info/<build info hash>.json`.
 * The `latest` artifacts are represented by the file at `<Soko directory>/<release>/build-info.json`.
 *
 * For each build info file, the script will parse the `output.contracts` object.
 * This object contains as keys the path of a contract file and as values the contracts within it, i.e.
 * ```
 * {
 *  "output": {
 *   "contracts": {
 *      "path/to/foo.sol": {
 *         "Foo": {
 *             "abi": [...],
 *             "devdoc": {...},
 *             "evm": {
 *                "bytecode": {...},
 *                "deployedBytecode": {...},
 *                ...
 *             },
 *             "metadata": "...",
 *             "storageLayout": {...},
 *             "userdoc": {...}
 *         }
 *      },
 *      "path/to/bar.sol": {
 *         "Bar1": {
 *             "abi": [...],
 *             "devdoc": {...},
 *             "evm": {
 *                "bytecode": {...},
 *                "deployedBytecode": {...},
 *                ...
 *             },
 *             "metadata": "...",
 *             "storageLayout": {...},
 *             "userdoc": {...}
 *         },
 *         "Bar2": {
 *             "abi": [...],
 *             "devdoc": {...},
 *             "evm": {
 *                "bytecode": {...},
 *                "deployedBytecode": {...},
 *                ...
 *             },
 *             "metadata": "...",
 *             "storageLayout": {...},
 *             "userdoc": {...}
 *         },
 *      },
 *   }
 * }
 * ```
 *
 * For each contract, a hash is computed based on
 * - stringified abi,
 * - bytecode object,
 * - metadata
 * This hash is stored in a map with the `<file path>-<contract name>` as key.
 *
 * Comparing the two maps, the script will output the differences between the two sets of contracts.
 */
type Difference = {
  path: string;
  name: string;
  status: "added" | "removed" | "changed";
};
export async function generateDiffWithTargetRelease(
  sokoDirectory: string,
  release: string,
  opts: { debug?: boolean } = {},
): Promise<Difference[]> {
  const freshBuildInfoResult = await toAsyncResult(retrieveFreshBuildInfo());
  if (!freshBuildInfoResult.success) {
    throw new ScriptError(
      `Error retrieving the build info for the compilation. Please, make sure to have a unique build info file in the "artifacts/build-info" folder.`,
    );
  }

  const virtualReleaseContractHashesResult = await toAsyncResult(
    generateContractHashes(freshBuildInfoResult.value.content),
    opts,
  );

  if (!virtualReleaseContractHashesResult.success) {
    throw new Error(
      `Error generating virtual release contract hashes: ${virtualReleaseContractHashesResult.error}`,
    );
  }

  const TARGET_RELEASE_PATH = `${sokoDirectory}/${release}/build-info.json`;
  const hasTargetRelease = await fs
    .stat(TARGET_RELEASE_PATH)
    .catch(() => false);
  if (!hasTargetRelease) {
    console.log(
      LOG_COLORS.warn,
      `The "${release}" release has not been found locally. If this is not expected, please run the \`pull\` command first.`,
    );
    const differences: Difference[] = [];
    for (const contractKey of virtualReleaseContractHashesResult.value.keys()) {
      const { contractPath, contractName } = parseKey(contractKey);
      differences.push({
        path: contractPath,
        name: contractName,
        status: "added",
      });
    }
    return differences;
  }

  const targetReleaseBuildInfoContentResult = await toAsyncResult(
    fs.readFile(TARGET_RELEASE_PATH, "utf-8"),
    opts,
  );
  if (!targetReleaseBuildInfoContentResult.success) {
    throw new Error(
      `Error reading target release build info: ${targetReleaseBuildInfoContentResult.error}`,
    );
  }

  const targetReleaseContractHashesResult = await toAsyncResult(
    generateContractHashes(targetReleaseBuildInfoContentResult.value),
    opts,
  );
  if (!targetReleaseContractHashesResult.success) {
    throw new Error(
      `Error generating target release contract hashes: ${targetReleaseContractHashesResult.error}`,
    );
  }

  const differences: Difference[] = [];
  for (const [
    contractKey,
    contractHash,
  ] of virtualReleaseContractHashesResult.value.entries()) {
    const { contractPath, contractName } = parseKey(contractKey);
    const targetReleaseHash =
      targetReleaseContractHashesResult.value.get(contractKey);
    if (!targetReleaseHash) {
      differences.push({
        path: contractPath,
        name: contractName,
        status: "added",
      });
    } else if (targetReleaseHash !== contractHash) {
      differences.push({
        path: contractPath,
        name: contractName,
        status: "changed",
      });
    }
  }

  for (const contractKey of targetReleaseContractHashesResult.value.keys()) {
    if (!virtualReleaseContractHashesResult.value.has(contractKey)) {
      const { contractPath, contractName } = parseKey(contractKey);
      differences.push({
        path: contractPath,
        name: contractName,
        status: "removed",
      });
    }
  }

  return differences;
}

async function generateContractHashes(
  buildInfoContent: string,
): Promise<Map<string, string>> {
  const buildInfoResult = ZBuildInfo.safeParse(JSON.parse(buildInfoContent));
  if (!buildInfoResult.success) {
    throw new Error(`Invalid build info file: ${buildInfoResult.error}`);
  }

  const contractHashes = new Map<string, string>();
  for (const contractPath in buildInfoResult.data.output.contracts) {
    const contracts = buildInfoResult.data.output.contracts[contractPath];
    for (const contractName in contracts) {
      const contract = contracts[contractName];
      const hash = hashContract(contract);
      contractHashes.set(formKey(contractPath, contractName), hash);
    }
  }

  return contractHashes;
}

function hashContract(contract: z.infer<typeof ZContractInfo>): string {
  const hash = createHash("sha256");

  contract.abi.sort((a, b) => a.name.localeCompare(b.name));
  for (const abiItem of contract.abi) {
    hash.update(JSON.stringify(abiItem));
  }

  hash.update(contract.evm.bytecode.object);
  hash.update(contract.metadata);

  return hash.digest("hex");
}

const SEPARATOR = "@@@@";
function formKey(contractPath: string, contractName: string): string {
  return `${contractPath}${SEPARATOR}${contractName}`;
}
function parseKey(key: string): { contractPath: string; contractName: string } {
  const [contractPath, contractName] = key.split(SEPARATOR);
  if (!contractPath || !contractName) {
    throw new Error(`Invalid key: ${key}`);
  }
  return { contractPath, contractName };
}