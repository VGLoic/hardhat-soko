import "hardhat/types/config";
import { extendConfig, scope } from "hardhat/config";
import { HardhatConfig, HardhatUserConfig } from "hardhat/types/config";
import { z } from "zod";
import fs from "fs/promises";
import {
  completeMessage,
  LOG_COLORS,
  ScriptError,
  toAsyncResult,
} from "./utils";
import { retrieveReleasesSummary } from "./scripts/retrieve-releases-summary";
import { S3BucketProvider } from "./s3-bucket-provider";
import { pull } from "./scripts/pull";

export async function addFile() {
  await fs.mkdir("./.soko", { recursive: true });
  const key = `./.soko/local-file-test-${Date.now()}.txt`;
  await fs.writeFile(key, "Hello World!");
}

export async function listFiles() {
  const files = await fs.readdir("./.soko");
  console.log(files);
}

export async function clearFiles() {
  await fs.rm(".soko", { recursive: true });
}

declare module "hardhat/types/config" {
  export interface HardhatUserConfig {
    soko?: {
      debug?: boolean;
      storageConfiguration: {
        type: "aws";
        awsRegion: string;
        awsBucketName: string;
        awsAccessKeyId: string;
        awsSecretAccessKey: string;
      };
    };
  }

  export interface HardhatConfig {
    soko?: {
      debug: boolean;
      storageConfiguration: {
        type: "aws";
        awsRegion: string;
        awsBucketName: string;
        awsAccessKeyId: string;
        awsSecretAccessKey: string;
      };
    };
  }
}

const SOKO_DIRECTORY = ".soko";

extendConfig(
  async (config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    if (userConfig.soko === undefined) {
      config.soko = undefined;
      return;
    }

    const sokoParsingResult = z
      .object({
        debug: z.boolean().default(false),
        storageConfiguration: z.object({
          type: z.literal("aws"),
          awsRegion: z.string().min(1),
          awsBucketName: z.string().min(1),
          awsAccessKeyId: z.string().min(1),
          awsSecretAccessKey: z.string().min(1),
        }),
      })
      .safeParse(userConfig.soko);

    if (!sokoParsingResult.success) {
      console.warn(
        `Configuration for Soko has been found but seems invalid. Please consult the below errors: \n${sokoParsingResult.error.errors.map(
          (error) => {
            return `  - ${error.path.join(".")}: ${error.message} (${error.code})`;
          },
        )}`,
      );
      return;
    }

    const sokoDirectoryStat = await fs.stat(SOKO_DIRECTORY).catch(() => null);
    if (sokoDirectoryStat === null) {
      const generatedFolderInitResult = await toAsyncResult(
        initiateGeneratedFolder(SOKO_DIRECTORY, { debug: false }),
        { debug: sokoParsingResult.data.debug },
      );
      if (!generatedFolderInitResult.success) {
        console.error(
          completeMessage(
            "Unable to create the Soko directory. This issue is blocking to continue with Soko.",
            { debug: sokoParsingResult.data.debug },
          ),
        );
        return;
      }
    } else {
      if (!sokoDirectoryStat.isDirectory()) {
        console.warn(
          `A file named "${SOKO_DIRECTORY}" exists in the root directory. Please remove it before continuing with Soko.`,
        );
        return;
      }

      // Check if there are the generated typings and summary files
      const generatedTypingStats = await fs
        .stat(`${SOKO_DIRECTORY}/generated/typings.ts`)
        .catch(() => null);
      const generatedTsSummaryStats = await fs
        .stat(`${SOKO_DIRECTORY}/generated/summary.ts`)
        .catch(() => null);
      const generatedJsonSummaryStats = await fs
        .stat(`${SOKO_DIRECTORY}/generated/summary.json`)
        .catch(() => null);

      if (
        !generatedTypingStats ||
        !generatedTsSummaryStats ||
        !generatedJsonSummaryStats
      ) {
        console.warn(
          `The Soko directory exists but some of the generated files are missing. They will be regenerated using default values.`,
        );
        const generatedFolderInitResult = await toAsyncResult(
          initiateGeneratedFolder(SOKO_DIRECTORY, {
            debug: sokoParsingResult.data.debug,
          }),
          {
            debug: sokoParsingResult.data.debug,
          },
        );
        if (!generatedFolderInitResult.success) {
          console.error(
            completeMessage(
              "Unable to create the Soko directory. This issue is blocking to continue with Soko.",
              { debug: sokoParsingResult.data.debug },
            ),
          );
          return;
        }
      }
    }

    config.soko = sokoParsingResult.data;
  },
);

const sokoScope = scope("soko", "Soko Hardhat tasks");

sokoScope
  .task(
    "pull",
    "Pull the missing releases from the release storage and generate associated typings",
  )
  .addOptionalParam(
    "release",
    "A specific release to pull from the release storage. If not provided, all missing releases will be pulled",
  )
  .addFlag("force", "Force the pull of the releases, replacing local ones")
  .addFlag(
    "noTypingGeneration",
    "Do not generate typings for the pulled releases",
  )
  .addFlag(
    "noFilter",
    "Do not filter similar contract in subsequent releases when generating typings",
  )
  .setAction(async (opts, hre) => {
    const sokoConfig = hre.config.soko;
    if (!sokoConfig) {
      console.error("❌ Soko is not configured.");
      return;
    }

    const releaseStorageProvider = new S3BucketProvider({
      bucketName: sokoConfig.storageConfiguration.awsBucketName,
      bucketRegion: sokoConfig.storageConfiguration.awsRegion,
      accessKeyId: sokoConfig.storageConfiguration.awsAccessKeyId,
      secretAccessKey: sokoConfig.storageConfiguration.awsSecretAccessKey,
    });

    const optsParsingResult = z
      .object({
        release: z.string().optional(),
        force: z.boolean().default(false),
        typingGeneration: z.boolean().default(true),
        filter: z.boolean().default(true),
        debug: z.boolean().default(false),
      })
      .safeParse(opts);
    if (!optsParsingResult.success) {
      console.log(LOG_COLORS.error, "❌ Invalid arguments");
      return;
    }

    if (optsParsingResult.data.release) {
      console.log(
        LOG_COLORS.log,
        `\nPulling the release "${optsParsingResult.data.release}" from the release storage`,
      );
    } else {
      console.log(
        LOG_COLORS.log,
        "\nPulling the missing releases from the release storage",
      );
    }

    const pullResult = await toAsyncResult(
      pull(SOKO_DIRECTORY, optsParsingResult.data, releaseStorageProvider),
      { debug: optsParsingResult.data.debug },
    );
    if (!pullResult.success) {
      if (pullResult.error instanceof ScriptError) {
        console.log(LOG_COLORS.error, "❌ ", pullResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        pullResult.error,
      );
      process.exitCode = 1;
      return;
    }

    if (pullResult.value.remoteReleases.length === 0) {
      console.log(LOG_COLORS.success, "\nNo releases to pull yet");
    } else if (
      pullResult.value.failedReleases.length === 0 &&
      pullResult.value.pulledReleases.length === 0
    ) {
      console.log(
        LOG_COLORS.success,
        `\nYou're up to date with ${pullResult.value.remoteReleases.length} releases:`,
      );
      pullResult.value.remoteReleases.forEach((release) => {
        console.log(LOG_COLORS.success, ` - ${release}`);
      });
    } else {
      if (pullResult.value.pulledReleases.length > 0) {
        console.log(
          LOG_COLORS.success,
          `\nPulled ${pullResult.value.pulledReleases.length} releases from storage:`,
        );
        pullResult.value.pulledReleases.forEach((release) => {
          console.log(LOG_COLORS.success, ` - ${release}`);
        });
      }

      if (pullResult.value.failedReleases.length > 0) {
        console.log(
          LOG_COLORS.error,
          `\n❌ Failed to pull ${pullResult.value.failedReleases.length} releases:`,
        );
        pullResult.value.failedReleases.forEach((release) => {
          console.log(LOG_COLORS.error, ` - ${release}`);
        });
        console.log("\n");
      }
    }

    // if (optsParsingResult.data.typingGeneration) {
    //   await generateReleasesSummary(optsParsingResult.data.filter, {
    //     debug: optsParsingResult.data.debug,
    //   }).catch((err) => {
    //     if (err instanceof ScriptError) {
    //       console.log(LOG_COLORS.error, "❌ ", err.message);
    //       process.exitCode = 1;
    //       return;
    //     }
    //     console.log(LOG_COLORS.error, "❌ An unexpected error occurred: ", err);
    //     process.exitCode = 1;
    //   });

    //   console.log(LOG_COLORS.success, "\nTypings generated successfully\n");
    // }
  });

sokoScope
  .task("describe", "Describe releases and their contents")
  .setAction(async (_, hre) => {
    if (!hre.config.soko) {
      console.error("❌ Soko is not configured.");
      return;
    }

    const releasesSummaryResult = await toAsyncResult(
      retrieveReleasesSummary(SOKO_DIRECTORY, { debug: hre.config.soko.debug }),
      { debug: hre.config.soko.debug },
    );
    if (!releasesSummaryResult.success) {
      if (releasesSummaryResult.error instanceof ScriptError) {
        console.log(
          LOG_COLORS.error,
          "❌ ",
          releasesSummaryResult.error.message,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ ",
        "An unexpected error occurred: ",
        releasesSummaryResult.error,
      );
      process.exitCode = 1;
      return;
    }

    if (Object.keys(releasesSummaryResult.value.releases).length === 0) {
      console.log(
        LOG_COLORS.warn,
        "No releases found locally. Have you forgotten to pull?",
      );
      return;
    }

    console.log(LOG_COLORS.log, "Available releases:");
    for (const release of Object.keys(releasesSummaryResult.value.releases)) {
      const contracts = releasesSummaryResult.value.releases[release];
      console.log(LOG_COLORS.log, ` - ${release}`);
      if (contracts.length === 0) {
        console.log(
          LOG_COLORS.warn,
          `   No new or updated contracts found for release ${release}.`,
        );
        continue;
      }
      for (const contract of contracts) {
        const [contractPath, contractName] = contract.split(":");
        console.log(LOG_COLORS.log, `   - ${contractName} (${contractPath})`);
      }
    }
  });

async function initiateGeneratedFolder(
  sokoDirectory: string,
  opts: { debug: boolean },
) {
  // Remove the generated folder if it exists
  await fs
    .rm(`${sokoDirectory}/generated`, { recursive: true })
    .catch(() => {});

  // Create the generated folder
  const creationDirResult = await toAsyncResult(
    fs.mkdir(`${sokoDirectory}/generated`),
    opts,
  );
  if (!creationDirResult.success) {
    throw new Error(
      "Unable to create the generated folder in the Soko directory.",
    );
  }

  const SUMMARY_TS_CONTENT = `// THIS IS AN AUTOGENERATED FILE. EDIT AT YOUR OWN RISKS.

export const CONTRACTS = {} as const;

export const RELEASES = {} as const;`;

  const TYPINGS_TS_CONTENT = `// THIS IS AN AUTOGENERATED FILE. EDIT AT YOUR OWN RISKS.

import { CONTRACTS, RELEASES } from "./summary";

export type Contract = keyof typeof CONTRACTS;
export type Release = keyof typeof RELEASES;

export type AvailableReleaseForContract<TContract extends Contract> =
  (typeof CONTRACTS)[TContract][number];

export type AvailableContractForRelease<TRelease extends Release> =
  (typeof RELEASES)[TRelease][number];`;

  const tsSummaryResult = await toAsyncResult(
    fs.writeFile(`${sokoDirectory}/generated/summary.ts`, SUMMARY_TS_CONTENT),
    opts,
  );
  if (!tsSummaryResult.success) {
    throw new Error(
      "Unable to create the summary.ts file in the generated folder.",
    );
  }
  const typingResult = await toAsyncResult(
    fs.writeFile(`${sokoDirectory}/generated/typings.ts`, TYPINGS_TS_CONTENT),
    opts,
  );
  if (!typingResult.success) {
    throw new Error(
      "Unable to create the typings.ts file in the generated folder.",
    );
  }
  const jsonSummaryResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/generated/summary.json`,
      JSON.stringify({ contracts: {}, releases: {} }),
    ),
    opts,
  );
  if (!jsonSummaryResult.success) {
    throw new Error(
      "Unable to create the summary.json file in the generated folder.",
    );
  }
}
