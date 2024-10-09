import "hardhat/types/config";
import { extendConfig, scope } from "hardhat/config";
import { HardhatConfig, HardhatUserConfig } from "hardhat/types/config";
import { z } from "zod";
import { LOG_COLORS, ScriptError, toAsyncResult } from "./utils";
import { S3BucketProvider } from "./s3-bucket-provider";
import { pull } from "./scripts/pull";
import { generateArtifactsSummariesAndTypings } from "./scripts/generate-typings";
import { pushArtifact } from "./scripts/push";
import { LocalStorageProvider } from "./local-storage-provider";
import { generateStructuredDataForArtifacts } from "./scripts/list";
import { generateDiffWithTargetRelease } from "./scripts/diff";

export type SokoHardhatUserConfig = {
  // Local directory in which artifacts will be pulled
  // Default to `.soko`
  pulledArtifactsPath?: string;
  // Local directory in which typings will be generated
  // Default to `.soko-typings`
  typingsPath?: string;
  // Configuration of the storage where the artifacts will be stored
  // Only AWS is supported for now
  storageConfiguration: {
    type: "aws";
    awsRegion: string;
    awsBucketName: string;
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
  };
  // If enabled, all tasks are running with activated debug mode
  // Default to `false`
  debug?: boolean;
};

const SokoHardhatConfig = z.object({
  pulledArtifactsPath: z.string().default(".soko"),
  typingsPath: z.string().default(".soko-typings"),
  storageConfiguration: z.object({
    type: z.literal("aws"),
    awsRegion: z.string().min(1),
    awsBucketName: z.string().min(1),
    awsAccessKeyId: z.string().min(1),
    awsSecretAccessKey: z.string().min(1),
  }),
  debug: z.boolean().default(false),
});

declare module "hardhat/types/config" {
  export interface HardhatUserConfig {
    soko?: SokoHardhatUserConfig;
  }

  export interface HardhatConfig {
    soko?: z.infer<typeof SokoHardhatConfig>;
  }
}

extendConfig(
  (config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
    if (userConfig.soko === undefined) {
      config.soko = undefined;
      return;
    }

    const sokoParsingResult = SokoHardhatConfig.safeParse(userConfig.soko);

    if (!sokoParsingResult.success) {
      console.error(
        LOG_COLORS.warn,
        `Configuration for Soko has been found but seems invalid. Please consult the below errors: \n${sokoParsingResult.error.errors.map(
          (error) => {
            return `  - ${error.path.join(".")}: ${error.message} (${error.code})`;
          },
        )}`,
      );
      return;
    }

    config.soko = sokoParsingResult.data;
  },
);

const sokoScope = scope("soko", "Soko Hardhat tasks");

const ZArtifactName = z
  .string()
  .min(1)
  .transform((value, ctx): { project: string; tagOrId: string | undefined } => {
    const elements = value.split(":");
    if (elements.length > 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "The artifact name should be formatted as `project` or `project:tag|ID`",
      });
      return z.NEVER;
    }
    if (elements.some((el) => el === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "The artifact name should be formatted as `project` or `project:tag|ID`",
      });
      return z.NEVER;
    }
    if (elements.length === 1) {
      return { project: elements[0], tagOrId: undefined };
    }
    return { project: elements[0], tagOrId: elements[1] };
  });

sokoScope
  .task("pull", "Pull one or many artifacts of a project")
  .setDescription(
    `Pull one or many artifacts of a project.

One artifact can be pulled by tag
  npx hardhat soko pull my-project:v1.2.3
or by ID
  soko pull my-project:dcauXtavGLxC

All artifacts for a project can be downloaded
  npx hardhat soko pull my-project

Already downloaded artifacts are not downloaded again by default, enable the force flag to force the download.
`,
  )
  .addParam(
    "artifact",
    "The artifact to pull, formatted as `project` or `project:tag|ID`",
  )
  .addFlag(
    "force",
    "Force the pull of the artifacts, replacing previously downloaded ones",
  )
  .addFlag("debug", "Enable debug mode")
  .setAction(async (opts, hre) => {
    const sokoConfig = hre.config.soko;
    if (!sokoConfig) {
      console.error(LOG_COLORS.error, "❌ Soko is not configured.");
      process.exitCode = 1;
      return;
    }

    const optsParsingResult = z
      .object({
        artifact: ZArtifactName,
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

    if (optsParsingResult.data.artifact.tagOrId) {
      console.error(
        LOG_COLORS.log,
        `\nPulling the artifact "${optsParsingResult.data.artifact.project}:${optsParsingResult.data.artifact.tagOrId}"`,
      );
    } else {
      console.error(
        LOG_COLORS.log,
        `\nPulling the missing artifacts of project "${optsParsingResult.data.artifact.project}"`,
      );
    }

    const storageProvider = new S3BucketProvider({
      bucketName: sokoConfig.storageConfiguration.awsBucketName,
      bucketRegion: sokoConfig.storageConfiguration.awsRegion,
      accessKeyId: sokoConfig.storageConfiguration.awsAccessKeyId,
      secretAccessKey: sokoConfig.storageConfiguration.awsSecretAccessKey,
    });

    const localProvider = new LocalStorageProvider(
      sokoConfig.pulledArtifactsPath,
    );

    const ensureResult = await toAsyncResult(
      localProvider.ensureProjectSetup(optsParsingResult.data.artifact.project),
      { debug: optsParsingResult.data.debug },
    );
    if (!ensureResult.success) {
      if (ensureResult.error instanceof ScriptError) {
        console.error(LOG_COLORS.error, "❌ ", ensureResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.error(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        ensureResult.error,
      );
      process.exitCode = 1;
      return;
    }

    const pullResult = await toAsyncResult(
      pull(
        optsParsingResult.data.artifact.project,
        optsParsingResult.data.artifact.tagOrId,
        {
          debug: optsParsingResult.data.debug,
          force: optsParsingResult.data.force,
        },
        localProvider,
        storageProvider,
      ),
      { debug: optsParsingResult.data.debug },
    );
    if (!pullResult.success) {
      if (pullResult.error instanceof ScriptError) {
        console.error(LOG_COLORS.error, "❌ ", pullResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.error(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        pullResult.error,
      );
      process.exitCode = 1;
      return;
    }

    if (
      pullResult.value.remoteTags.length === 0 &&
      pullResult.value.remoteIds.length === 0
    ) {
      console.error(LOG_COLORS.success, "\nNo artifacts to pull yet");
    } else if (
      pullResult.value.failedTags.length === 0 &&
      pullResult.value.failedIds.length === 0 &&
      pullResult.value.pulledTags.length === 0 &&
      pullResult.value.pulledIds.length === 0
    ) {
      console.error(
        LOG_COLORS.success,
        `\nYou're up to date with project "${optsParsingResult.data.artifact.project}"`,
      );
    } else {
      if (pullResult.value.pulledTags.length > 0) {
        console.error(
          LOG_COLORS.success,
          `\nPulled ${pullResult.value.pulledTags.length} tags from storage:`,
        );
        pullResult.value.pulledTags.forEach((tag) => {
          console.error(LOG_COLORS.success, ` - ${tag}`);
        });
      }
      if (pullResult.value.pulledIds.length > 0) {
        console.error(
          LOG_COLORS.success,
          `\nPulled ${pullResult.value.pulledIds.length} IDs from storage:`,
        );
        pullResult.value.pulledIds.forEach((id) => {
          console.error(LOG_COLORS.success, ` - ${id}`);
        });
      }
      if (pullResult.value.failedTags.length > 0) {
        console.error(
          LOG_COLORS.error,
          `\n❌ Failed to pull ${pullResult.value.failedTags.length} tags:`,
        );
        pullResult.value.failedTags.forEach((tag) => {
          console.error(LOG_COLORS.error, ` - ${tag}`);
        });
      }
      if (pullResult.value.failedIds.length > 0) {
        console.error(
          LOG_COLORS.error,
          `\n❌ Failed to pull ${pullResult.value.failedIds.length} IDs:`,
        );
        pullResult.value.failedIds.forEach((id) => {
          console.error(LOG_COLORS.error, ` - ${id}`);
        });
      }
    }
    console.error("\n");
  });

sokoScope
  .task("push", "Push a compilation artifact")
  .setDescription(
    `Push a compilation artifact.

The artifact will be stored in the input project (through the "-t" flag). An identifier is derived for the artifact.
  npx hardhat soko push ./path/to-my-artifact/artifact.json -t my-project

If a tag is provided, the artifact will also be identified by it:
  npx hardhat soko push ./path/to-my-artifact/artifact.json -t my-project:v1.2.3

If the provided tag already exists in the storage, the push will be aborted unless the force flag is enabled.`,
  )
  .addParam("artifactPath", "The compilation artifact path to push")
  .addParam(
    "tag",
    'Project name and optionally tag of the artifact (format "name:tag")',
  )
  .addFlag(
    "force",
    "Force the push of the artifact even if it already exists in the storage",
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
        artifactPath: z.string().min(1),
        tag: ZArtifactName,
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

    const storageProvider = new S3BucketProvider({
      bucketName: sokoConfig.storageConfiguration.awsBucketName,
      bucketRegion: sokoConfig.storageConfiguration.awsRegion,
      accessKeyId: sokoConfig.storageConfiguration.awsAccessKeyId,
      secretAccessKey: sokoConfig.storageConfiguration.awsSecretAccessKey,
    });

    const localProvider = new LocalStorageProvider(
      sokoConfig.pulledArtifactsPath,
    );

    const ensureResult = await toAsyncResult(
      localProvider.ensureProjectSetup(optsParsingResult.data.tag.project),
      { debug: optsParsingResult.data.debug },
    );
    if (!ensureResult.success) {
      if (ensureResult.error instanceof ScriptError) {
        console.error(LOG_COLORS.error, "❌ ", ensureResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.error(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        ensureResult.error,
      );
      process.exitCode = 1;
      return;
    }

    const pushResult = await toAsyncResult(
      pushArtifact(
        optsParsingResult.data.artifactPath,
        optsParsingResult.data.tag.project,
        // @dev `tagOrId` must be understood as a tag only here as the ID is derived from the artifact content
        optsParsingResult.data.tag.tagOrId,
        {
          debug: optsParsingResult.data.debug,
          force: optsParsingResult.data.force,
        },
        storageProvider,
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
      `\nArtifact "${optsParsingResult.data.tag.project}:${optsParsingResult.data.tag.tagOrId || pushResult.value}" pushed successfully`,
    );
  });

sokoScope
  .task("typings", "Generate typings based on the existing artifacts")
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

    console.log(LOG_COLORS.log, "\nStarting typings generation\n");

    const localProvider = new LocalStorageProvider(
      sokoConfig.pulledArtifactsPath,
    );
    const ensureResult = await toAsyncResult(localProvider.ensureSetup(), {
      debug: parsingResult.data.debug,
    });
    if (!ensureResult.success) {
      if (ensureResult.error instanceof ScriptError) {
        console.log(LOG_COLORS.error, "❌ ", ensureResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        ensureResult.error,
      );
      process.exitCode = 1;
      return;
    }

    await generateArtifactsSummariesAndTypings(
      sokoConfig.typingsPath,
      false,
      {
        debug: parsingResult.data.debug,
      },
      localProvider,
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
  .task("list", "List all the artifacts")
  .setDescription(
    "List the artifacts that have been pulled with their associated projects.",
  )
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

    const localProvider = new LocalStorageProvider(
      sokoConfig.pulledArtifactsPath,
    );

    const setupResult = await toAsyncResult(localProvider.ensureSetup(), {
      debug: parsingResult.data.debug,
    });
    if (!setupResult.success) {
      if (setupResult.error instanceof ScriptError) {
        console.log(LOG_COLORS.error, "❌ ", setupResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        setupResult.error,
      );
      process.exitCode = 1;
      return;
    }

    const structuredDataResult = await toAsyncResult(
      generateStructuredDataForArtifacts(localProvider, {
        debug: parsingResult.data.debug,
      }),
      { debug: parsingResult.data.debug },
    );
    if (!structuredDataResult.success) {
      if (structuredDataResult.error instanceof ScriptError) {
        console.log(
          LOG_COLORS.error,
          "❌ ",
          structuredDataResult.error.message,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        structuredDataResult.error,
      );
      process.exitCode = 1;
      return;
    }

    if (structuredDataResult.value.length === 0) {
      console.error(LOG_COLORS.warn, "\nNo artifacts found");
      return;
    }

    console.table(structuredDataResult.value, [
      "Project",
      "Tag",
      "ID",
      "Pull date",
    ]);
  });

sokoScope
  .task(
    "diff",
    "Compare a local compilation artifacts with an existing release",
  )
  .addParam("artifactPath", "The compilation artifact path to compare")
  .addParam(
    "tag",
    "The artifact to compare with, formatted as `project:tag|ID`",
  )
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
        artifactPath: z.string().min(1),
        tag: ZArtifactName,
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

    const tagOrId = paramParsingResult.data.tag.tagOrId;
    if (!tagOrId) {
      console.error(
        LOG_COLORS.error,
        "❌ The artifact must be identified by a tag or an ID",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      LOG_COLORS.log,
      `\nComparing the current compilation with the "${paramParsingResult.data.tag.project}:${tagOrId}" artifact`,
    );

    const localProvider = new LocalStorageProvider(
      sokoConfig.pulledArtifactsPath,
    );

    const ensureResult = await toAsyncResult(
      localProvider.ensureProjectSetup(paramParsingResult.data.tag.project),
      { debug: paramParsingResult.data.debug },
    );
    if (!ensureResult.success) {
      if (ensureResult.error instanceof ScriptError) {
        console.log(LOG_COLORS.error, "❌ ", ensureResult.error.message);
        process.exitCode = 1;
        return;
      }
      console.log(
        LOG_COLORS.error,
        "❌ An unexpected error occurred: ",
        ensureResult.error,
      );
      process.exitCode = 1;
      return;
    }

    const differencesResult = await toAsyncResult(
      generateDiffWithTargetRelease(
        paramParsingResult.data.artifactPath,
        { project: paramParsingResult.data.tag.project, tagOrId },
        {
          debug: paramParsingResult.data.debug,
        },
        localProvider,
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

sokoScope
  .task("help", "Use `npx hardhat help soko` instead")
  .setAction(async () => {
    console.log(
      LOG_COLORS.log,
      "This help format is not supported by Hardhat.\nPlease use `npx hardhat help soko` instead (change `npx` with what you use).\nHelp on a specific task can be obtained by using `npx hardhat help soko <command>`.",
    );
  });
