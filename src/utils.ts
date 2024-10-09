import { Dirent } from "fs";
import fs from "fs/promises";
import { z } from "zod";

export function toAsyncResult<T, TError = Error>(
  promise: Promise<T>,
  opts: {
    debug?: boolean;
  } = {},
): Promise<{ success: true; value: T } | { success: false; error: TError }> {
  return promise
    .then((value) => ({ success: true as const, value }))
    .catch((error) => {
      if (opts.debug) {
        console.error(error);
      }
      return { success: false as const, error };
    });
}

export function completeMessage(message: string, opts: { debug: boolean }) {
  return `Soko: ${message}${opts.debug ? "" : "\nFor more information, please run the same command with the `debug` flag or set `debug: true` option in Soko configuration of the `hardhat.config` file"}`;
}

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const LOG_COLORS = {
  log: "\x1b[0m%s\x1b[0m",
  success: "\x1b[32m%s\x1b[0m",
  error: "\x1b[31m%s\x1b[0m",
  warn: "\x1b[33m%s\x1b[0m",
};

const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Literal = z.infer<typeof literalSchema>;
type Json = Literal | { [key: string]: Json } | Json[];
const ZJson: z.ZodType<Json> = z.lazy(() =>
  z.union([literalSchema, z.array(ZJson), z.record(ZJson)]),
);

export const ZContractInfo = z.object({
  abi: z.array(
    z.object({
      inputs: z.array(ZJson),
      name: z.string(),
      outputs: z.array(ZJson),
      stateMutability: z.string(),
      type: z.string(),
    }),
  ),
  devdoc: ZJson,
  evm: z.object({
    bytecode: z.object({
      functionDebugData: ZJson,
      generatedSources: z.array(ZJson),
      linkReferences: ZJson,
      object: z.string(),
      opcodes: z.string(),
      sourceMap: z.string(),
    }),
    deployedBytecode: z.object({
      functionDebugData: ZJson,
      generatedSources: z.array(ZJson),
      linkReferences: ZJson,
      object: z.string(),
      opcodes: z.string(),
      sourceMap: z.string(),
    }),
    gasEstimates: ZJson,
    methodIdentifiers: ZJson,
  }),
  metadata: z.string(),
  storageLayout: ZJson,
  userdoc: ZJson,
});
export const ZBuildInfo = z.object({
  id: z.string(),
  _format: z.string(),
  solcVersion: z.string(),
  solcLongVersion: z.string(),
  input: z.object({
    language: z.string(),
    sources: z.record(z.string(), z.object({ content: z.string() })),
    settings: z.object({
      viaIR: z.boolean().optional(),
      optimizer: z.object({
        runs: z.number().optional(),
        enabled: z.boolean().optional(),
        details: z
          .object({
            yulDetails: z.object({
              optimizerSteps: z.string(),
            }),
          })
          .optional(),
      }),
      metadata: z.object({ useLiteralContent: z.boolean() }).optional(),
      outputSelection: z.record(
        z.string(),
        z.record(z.string(), z.array(z.string())),
      ),
      evmVersion: z.string().optional(),
      libraries: z
        .record(z.string(), z.record(z.string(), z.string()))
        .optional(),
      remappings: z.array(z.string()).optional(),
    }),
  }),
  output: z.object({
    contracts: z.record(z.string(), z.record(z.string(), ZContractInfo)),
  }),
});

export async function retrieveFreshCompilationArtifact(
  inputPath: string,
): Promise<
  | {
      status: "success";
      path: string;
      content: string;
    }
  | {
      status: "error";
      reason: string;
    }
> {
  const stat = await fs.stat(inputPath).catch(() => undefined);
  if (!stat) {
    return {
      status: "error",
      reason: `Input path "${inputPath}" not found`,
    };
  }

  let compilationArtifactPath: string | undefined = undefined;

  if (stat.isFile()) {
    if (!inputPath.endsWith(".json")) {
      return {
        status: "error",
        reason: `The file at path "${inputPath}" is not a json file. Compilation artifact must be a json file.`,
      };
    }
    compilationArtifactPath = inputPath;
  } else if (stat.isDirectory()) {
    const entries = await fs.readdir(inputPath, { withFileTypes: true });

    let finalCompilationArtifactsDirectoryEntries: Dirent[] | undefined =
      undefined;
    let finalBasePath: string = inputPath;

    // If we found only json files, we assume that we are in the final folder, we then expect only one file
    if (
      entries.every((entry) => entry.isFile() && entry.name.endsWith(".json"))
    ) {
      console.error(
        LOG_COLORS.log,
        `Found potential compilation artifacts in path "${inputPath}"`,
      );
      finalCompilationArtifactsDirectoryEntries = entries;
    }

    // If we found a build-info folder, we can dig into it
    const buildInfoFolderEntry = entries.find(
      (entry) => entry.isDirectory() && entry.name === "build-info",
    );
    if (buildInfoFolderEntry) {
      finalBasePath = `${inputPath}/${buildInfoFolderEntry.name}`;
      finalCompilationArtifactsDirectoryEntries = await fs.readdir(
        `${inputPath}/${buildInfoFolderEntry.name}`,
        { withFileTypes: true },
      );
    }

    if (!finalCompilationArtifactsDirectoryEntries) {
      return {
        status: "error",
        reason: `Failed to find compilation artifacts in path "${inputPath}". Please provide a more precise path.`,
      };
    }

    const checkResult = checkCompilationArtifactsFolder(
      finalCompilationArtifactsDirectoryEntries,
    );
    if (checkResult.status === "error") {
      return checkResult;
    }

    compilationArtifactPath = `${finalBasePath}/${checkResult.name}`;
    console.error(
      LOG_COLORS.log,
      `Found a potential compilation artifact in path "${compilationArtifactPath}"`,
    );
  } else {
    return {
      status: "error",
      reason: `Thing at path "${inputPath}" is neither identified as a file nor as a directory. This thing is not yet supported`,
    };
  }

  if (!compilationArtifactPath) {
    throw new Error("No compilation artifact found");
  }

  const contentResult = await toAsyncResult(
    fs.readFile(compilationArtifactPath, "utf-8").then((data) => {
      const firstParsing = JSON.parse(data);
      ZBuildInfo.parse(firstParsing);
      return data;
    }),
  );

  if (!contentResult.success) {
    throw new Error(`Error reading build info file: ${contentResult.error}`);
  }

  return {
    status: "success",
    path: compilationArtifactPath,
    content: contentResult.value,
  };
}

function checkCompilationArtifactsFolder(entries: Dirent[]):
  | {
      status: "success";
      name: string;
    }
  | { status: "error"; reason: string } {
  if (entries.length > 1) {
    return {
      status: "error",
      reason: `Found multiple potential compilation artifacts in the Hardhat build info folders. Please provide a more precise path.`,
    };
  } else {
    return {
      status: "success",
      name: entries[0].name,
    };
  }
}
