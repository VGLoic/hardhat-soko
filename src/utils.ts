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
  return `Soko: ${message}${opts.debug ? "" : "\nFor more information, please run the same command with the `debug: true` option in Soko part of Hardhat configuration."}`;
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
