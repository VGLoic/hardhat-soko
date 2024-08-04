import "hardhat/types/config";
import { extendConfig } from "hardhat/config";
import { HardhatConfig, HardhatUserConfig } from "hardhat/types/config";
import { z } from "zod";

export function add(a: number) {
  return a + 1;
}

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
    };
  }
}

extendConfig(
  (config: HardhatConfig, userConfig: Readonly<HardhatUserConfig>) => {
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
      })
      .safeParse(userConfig.soko);

    if (!sokoParsingResult.success) {
      console.warn(
        `Configuration for Soko has been found but seems invalid. Please consult the below errors: \n${sokoParsingResult.error.errors}`,
      );
      return;
    }

    config.soko = sokoParsingResult.data;
  },
);
