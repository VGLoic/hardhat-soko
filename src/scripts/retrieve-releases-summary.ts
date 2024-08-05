import fs from "fs/promises";
import { toAsyncResult, ScriptError } from "../utils";
import { z } from "zod";

export async function retrieveReleasesSummary(
  sokoDirectory: string,
  opts: { debug?: boolean } = {},
) {
  const releasesExist = await fs.stat(sokoDirectory).catch(() => false);
  if (!releasesExist) {
    throw new ScriptError(
      "Releases not found locally. Please run the `pull` command first.",
    );
  }
  const generatedReleasesSummaryExist = await fs
    .stat(`${sokoDirectory}/generated/summary.json`)
    .catch(() => false);
  if (!generatedReleasesSummaryExist) {
    throw new ScriptError(
      "Releases summary not found. Please run the `pull` command first.",
    );
  }

  const releasesSummaryResult = await toAsyncResult(
    fs
      .readFile(`${sokoDirectory}/generated/summary.json`, "utf-8")
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
      "An error occurred while reading the releases summary",
    );
  }

  return releasesSummaryResult.value;
}
