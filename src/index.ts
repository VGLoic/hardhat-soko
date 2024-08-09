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
import {
  generateEmptyReleasesSummaryTsContent,
  generateEmptyReleasesSummaryJsonContent,
  generateReleasesSummary,
} from "./scripts/generate-releases-summary";
import { pushRelease } from "./scripts/push";
import { generateDiffWithTargetRelease } from "./scripts/diff";

declare module "hardhat/types/config" {
  export interface HardhatUserConfig {
    soko?: {
      storageConfiguration: {
        type: "aws";
        awsRegion: string;
        awsBucketName: string;
        awsAccessKeyId: string;
        awsSecretAccessKey: string;
      };
      debug?: boolean;
    };
  }

  export interface HardhatConfig {
    soko?: {
      storageConfiguration: {
        type: "aws";
        awsRegion: string;
        awsBucketName: string;
        awsAccessKeyId: string;
        awsSecretAccessKey: string;
      };
      debug: boolean;
    };
  }
}

const SOKO_DIRECTORY = "./.soko";

extendConfig(
  async (config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    if (userConfig.soko === undefined) {
      config.soko = undefined;
      return;
    }

    const sokoParsingResult = z
      .object({
        storageConfiguration: z.object({
          type: z.literal("aws"),
          awsRegion: z.string().min(1),
          awsBucketName: z.string().min(1),
          awsAccessKeyId: z.string().min(1),
          awsSecretAccessKey: z.string().min(1),
        }),
        debug: z.boolean().default(false),
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
        initiateGeneratedFolder(SOKO_DIRECTORY, {
          debug: sokoParsingResult.data.debug,
        }),
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
  .task("help", "Use `npx hardhat help soko` instead")
  .setAction(async () => {
    console.log(
      LOG_COLORS.log,
      "This help format is not supported by Hardhat.\nPlease use `npx hardhat help soko` instead (change `npx` with what you use).\nHelp on a specific task can be obtained by using `npx hardhat help soko <command>`.",
    );
  });

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
  .addFlag("debug", "Enable debug mode")
  .setAction(async (opts, hre) => {
    const sokoConfig = hre.config.soko;
    if (!sokoConfig) {
      console.error("❌ Soko is not configured.");
      process.exitCode = 1;
      return;
    }

    const optsParsingResult = z
      .object({
        release: z.string().optional(),
        force: z.boolean().default(false),
        noTypingGeneration: z.boolean().default(false),
        noFilter: z.boolean().default(false),
        debug: z.boolean().default(sokoConfig.debug),
      })
      .safeParse(opts);
    if (!optsParsingResult.success) {
      console.log(LOG_COLORS.error, "❌ Invalid arguments");
      if (sokoConfig.debug || opts.debug) {
        console.error(optsParsingResult.error);
      }
      process.exitCode = 1;
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

    const releaseStorageProvider = new S3BucketProvider({
      bucketName: sokoConfig.storageConfiguration.awsBucketName,
      bucketRegion: sokoConfig.storageConfiguration.awsRegion,
      accessKeyId: sokoConfig.storageConfiguration.awsAccessKeyId,
      secretAccessKey: sokoConfig.storageConfiguration.awsSecretAccessKey,
    });

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

    if (!optsParsingResult.data.noTypingGeneration) {
      await generateReleasesSummary(
        SOKO_DIRECTORY,
        !optsParsingResult.data.noFilter,
        {
          debug: optsParsingResult.data.debug,
        },
      )
        .then(() => {
          console.log(LOG_COLORS.success, "\nTypings generated successfully\n");
        })
        .catch((err) => {
          if (err instanceof ScriptError) {
            console.log(LOG_COLORS.error, "❌ ", err.message);
            process.exitCode = 1;
            return;
          }
          console.log(
            LOG_COLORS.error,
            "❌ An unexpected error occurred: ",
            err,
          );
          process.exitCode = 1;
        });
    }
  });

sokoScope
  .task("generate-typings", "Generate typings based on the existing releases")
  .addFlag("noFilter", "Do not filter similar contract in subsequent releases")
  .addFlag("debug", "Enable debug mode")
  .setAction(async (opts, hre) => {
    const sokoConfig = hre.config.soko;
    if (!sokoConfig) {
      console.error("❌ Soko is not configured.");
      process.exitCode = 1;
      return;
    }

    const parsingResult = z
      .object({
        noFilter: z.boolean().default(false),
        debug: z.boolean().default(sokoConfig.debug),
      })
      .safeParse(opts);

    if (!parsingResult.success) {
      console.error(LOG_COLORS.error, "❌ Invalid arguments");
      if (sokoConfig.debug || opts.debug) {
        console.error(parsingResult.error);
      }
      process.exitCode = 1;
      return;
    }

    console.log(
      LOG_COLORS.log,
      `\nStarting typings generation. ${
        !parsingResult.data.noFilter
          ? "Similar contracts in subsequent releases will be filtered."
          : "All contracts for all releases will be considered"
      }`,
    );

    console.log("\n");

    await generateReleasesSummary(
      SOKO_DIRECTORY,
      !parsingResult.data.noFilter,
      {
        debug: parsingResult.data.debug,
      },
    )
      .then(() => {
        console.log(LOG_COLORS.success, "\nTypings generated successfully\n");
      })
      .catch((err) => {
        if (err instanceof ScriptError) {
          console.log(LOG_COLORS.error, "❌ ", err.message);
          process.exitCode = 1;
          return;
        }
        console.log(LOG_COLORS.error, "❌ An unexpected error occurred: ", err);
        process.exitCode = 1;
      });
  });

sokoScope
  .task("describe", "Describe releases and their contents")
  .addFlag("debug", "Enable debug mode")
  .setAction(async (opts, hre) => {
    const sokoConfig = hre.config.soko;
    if (!sokoConfig) {
      console.error("❌ Soko is not configured.");
      process.exitCode = 1;
      return;
    }

    const parsingResult = z
      .object({
        debug: z.boolean().default(sokoConfig.debug),
      })
      .safeParse(opts);

    if (!parsingResult.success) {
      console.error(LOG_COLORS.error, "❌ Invalid arguments");
      if (sokoConfig.debug || opts.debug) {
        console.error(parsingResult.error);
      }
      process.exitCode = 1;
      return;
    }

    const releasesSummaryResult = await toAsyncResult(
      retrieveReleasesSummary(SOKO_DIRECTORY, {
        debug: parsingResult.data.debug,
      }),
      { debug: parsingResult.data.debug },
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

sokoScope
  .task("push", "Push a release to the release storage")
  .addParam("release", "The release to push to the release storage")
  .addFlag(
    "force",
    "Force the push of the release even if it already exists in the release storage",
  )
  .addFlag("debug", "Enable debug mode")
  .setAction(async (opts, hre) => {
    const sokoConfig = hre.config.soko;
    if (!sokoConfig) {
      console.error("❌ Soko is not configured.");
      process.exitCode = 1;
      return;
    }

    const optsParsingResult = z
      .object({
        release: z.string().min(1),
        force: z.boolean().default(false),
        debug: z.boolean().default(sokoConfig.debug),
      })
      .safeParse(opts);

    if (!optsParsingResult.success) {
      console.error(LOG_COLORS.error, "❌ Invalid arguments");
      if (sokoConfig.debug || opts.debug) {
        console.error(optsParsingResult.error);
      }
      process.exitCode = 1;
      return;
    }

    const releaseStorageProvider = new S3BucketProvider({
      bucketName: sokoConfig.storageConfiguration.awsBucketName,
      bucketRegion: sokoConfig.storageConfiguration.awsRegion,
      accessKeyId: sokoConfig.storageConfiguration.awsAccessKeyId,
      secretAccessKey: sokoConfig.storageConfiguration.awsSecretAccessKey,
    });

    console.log(
      LOG_COLORS.log,
      `\nPushing release "${optsParsingResult.data.release}" artifact to the release storage`,
    );

    const pushResult = await toAsyncResult(
      pushRelease(
        optsParsingResult.data.release,
        optsParsingResult.data,
        releaseStorageProvider,
      ),
      { debug: optsParsingResult.data.debug },
    );
    if (!pushResult.success) {
      if (pushResult.error instanceof ScriptError) {
        console.log(LOG_COLORS.error, "❌ ", pushResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        pushResult.error,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      LOG_COLORS.success,
      `\nRelease "${optsParsingResult.data.release}" pushed successfully`,
    );
  });

sokoScope
  .task(
    "diff",
    "Compare a local compilation artifacts with an existing release",
  )
  .addParam("release", "The release to compare with")
  .addFlag("debug", "Enable debug mode")
  .setAction(async (opts, hre) => {
    const sokoConfig = hre.config.soko;
    if (!sokoConfig) {
      console.error("❌ Soko is not configured.");
      process.exitCode = 1;
      return;
    }

    const paramParsingResult = z
      .object({
        release: z.string().min(1),
        debug: z.boolean().default(sokoConfig.debug),
      })
      .safeParse(opts);
    if (!paramParsingResult.success) {
      console.error(LOG_COLORS.error, "❌ Invalid arguments");
      if (sokoConfig.debug || opts.debug) {
        console.error(paramParsingResult.error);
      }
      process.exitCode = 1;
      return;
    }

    console.log(
      LOG_COLORS.log,
      `\nComparing the current compilation with the "${paramParsingResult.data.release}" release`,
    );

    const differencesResult = await toAsyncResult(
      generateDiffWithTargetRelease(
        SOKO_DIRECTORY,
        paramParsingResult.data.release,
        {
          debug: paramParsingResult.data.debug,
        },
      ),
    );
    if (!differencesResult.success) {
      if (differencesResult.error instanceof ScriptError) {
        console.log(LOG_COLORS.error, "❌ ", differencesResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        differencesResult.error,
      );
      process.exitCode = 1;
      return;
    }

    if (differencesResult.value.length === 0) {
      console.log(LOG_COLORS.success, "\nNo differences found");
      return;
    }

    console.log(LOG_COLORS.success, "\nDifferences found:");
    for (const difference of differencesResult.value) {
      console.log(
        LOG_COLORS.success,
        ` - ${difference.name} (${difference.path}): ${difference.status}`,
      );
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
    fs.mkdir(`${sokoDirectory}/generated`, { recursive: true }),
    opts,
  );
  if (!creationDirResult.success) {
    throw new Error(
      "Unable to create the generated folder in the Soko directory.",
    );
  }

  const tsSummaryResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/generated/summary.ts`,
      generateEmptyReleasesSummaryTsContent(sokoDirectory),
    ),
    opts,
  );
  if (!tsSummaryResult.success) {
    throw new Error(
      "Unable to create the summary.ts file in the generated folder.",
    );
  }
  const typingResult = await toAsyncResult(
    fs.writeFile(
      `${sokoDirectory}/generated/typings.ts`,
      await fs.readFile(`${__dirname}/typings.txt`, "utf-8"),
    ),
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
      JSON.stringify(
        generateEmptyReleasesSummaryJsonContent(sokoDirectory),
        null,
        2,
      ),
    ),
    opts,
  );
  if (!jsonSummaryResult.success) {
    throw new Error(
      "Unable to create the summary.json file in the generated folder.",
    );
  }
}
