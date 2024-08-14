import fs from "fs/promises";
import { toAsyncResult, ScriptError } from "../utils";
import { z } from "zod";

export async function retrieveReleasesSummary(
  sokoTypingsDirectory: string,
  opts: { debug?: boolean } = {},
) {
  const typingsExist = await fs.stat(sokoTypingsDirectory).catch(() => false);
  if (!typingsExist) {
    throw new ScriptError(
      "Soko typings not found locally. Please run the `typings` command first.",
    );
  }
  const jsonSummaryExist = await fs
    .stat(`${sokoTypingsDirectory}/summary.json`)
    .catch(() => false);
  if (!jsonSummaryExist) {
    throw new ScriptError(
      "The `summary.json` is missing from the typings directory. Please run the `typings` command first.",
    );
  }

  const releasesSummaryResult = await toAsyncResult(
    fs
      .readFile(`${sokoTypingsDirectory}/summary.json`, "utf-8")
      .then(JSON.parse)
      .then((data) => {
        return z
          .object({
            contracts: z.record(z.array(z.string())),
            releases: z.record(z.array(z.string())),
          })
          .parse(data);
      }),
    { debug: opts.debug },
  );

  if (!releasesSummaryResult.success) {
    throw new ScriptError(
      "An error occurred while reading the generated JSON releases summary",
    );
  }

  return releasesSummaryResult.value;
}
