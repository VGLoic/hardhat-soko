# Hardhat Soko

Hardhat plugin in order to manage your smart contract artifacts from a remote location.

## Motivation

When compiling the smart contracts, the developer will generate _compilation artifacts_ that contain all the needed informations for further tasks such as deployment, verification or simple contract interactions.

These compilation artifacts are however generally ignored and not stored. At best, compilation artifact for a contract is contained within its deployment summary. Not having a clear way of identifying or re-using an artifact is a painful experience for all developers working closely or remotely with the smart contracts:

- the smart contract developer is afraid of erasing artifacts that are still needed when developing new features,
- the "smart contract devops" has to execute the deployment or interaction scripts with artifact that are meant to be thrown away, it complexifies drastically the sharing of ABIs and deployments to the rest of the team,
- the developer using the deployed smart contracts often ends up copy pasting deployed addresses and ABIs without having a clear vision on it.

**The goal of this plugin is to encourage the developer to organize the compilation artifacts by releases, hence freezing them once created. These artifacts would be stored on a dedicated storage in order to enable an easy conservation and retrieval.**

Once the artifacts are kept safe on the storage, developers can easily leverage them in order to execute the same tasks as before but in a safer and clearer way:

- deployment scripts depend only on frozen artifacts,
- the artifact associated to a deployed contract can be easily found, hence allowing simple verification or interaction,
- pipelines can be built using the stored artifacts in order to expose safely to other developers the ABIs and the deployed contracts.

## Installation

Installation can be made using any package manager

```bash
npm install hardhat-soko
```

```bash
pnpm install hardhat-soko
```

```bash
yarn add hardhat-soko
```

## Configuration

In the `hardhat.config.ts/js` file, one should import the `hardhat-soko` plugin and fill the Soko configuration.

```ts
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
...
import "hardhat-soko";

export const config: HardhatUserConfig = {
  ... // Existing configuration
  // Example configuration for Soko with AWS S3 as storage for releases
  soko: {
    directory: ".soko",
    typingsDirectory: ".soko-typings",
    storageConfiguration: {
      type: "aws",
      awsRegion: AWS_REGION,
      awsBucketName: AWS_S3_BUCKET,
      awsAccessKeyId: AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  },
}
```

Here is the detailled TypeScript type of the configuration

```ts
type SokoHardhatUserConfig = {
  // Local directory in which releases will be pulled
  // Default to `.soko`
  directory?: string;
  // Local directory in which typings will be generated
  // Default to `.soko-typings`
  typingsDirectory?: string;
  // Configuration of the storage where the release will be stored
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
```

## Tasks

> ![INFO]
> The code snippets in this section uses `npx` but one can choose something else

An overview of the Soko tasks is exposed by running the `soko` task:

```bash
npx hardhat soko
```

Help about any task scopped under soko is available:

```bash
npx hardhat help soko pull
```

### Pull

Pull locally the missing releases from the configured releases storage and generate the associated typings.

```bash
npx hardhat soko pull
```

### Push

Push a local compilation artifact as a new release. This script assumes that there is an existing compilation artifact in the local Hardhat `artifacts` folder.

```bash
npx hardhat soko push --release v1.2.3
```

### Typings

Generate the TypeScript typings based on the pulled releases.

```bash
npx hardhat soko typings
```

> ![INFO]
> If no releases have been pulled, one can still generate the default typings using this command. It may be helpful for those who do not care about the scripts involving Soko but want to be unblocked in case of missing files.

By default, similar contracts in subsequent releases are filtered. Comparison is based on ABI and bytecode. This behaviour can be disabled using the `--no-filter` flag.

### Describe

Describe the pulled releases and their contents.

```bash
npx hardhat soko describe
```

### Diff

Compare a local compilation artifacts with an existing release and print the contracts for which differences have been found.

```bash
npx hardhat soko diff --release latest
```

## Using the typings

The typings are exposed in order to help the developer retrieve easily and safely a contract artifact (ABI, bytecode, etc...).

There are two available utils in order to retrieve a contract artifact, it would depend on the task at hand:

- start with a contract, select one of its available release

```ts
import { contract } from "../.soko-typings";

const artifact = await contract(
  "src/path/to/my/contract.sol:MyExampleContract",
).getArtifact("v1.2.3");
```

- start with a release, select a contract within it

```ts
import { release } from "../.soko-typings";

const artifact = await release("v1.2.3").getContractArtifact(
  "src/path/to/my/contract.sol:MyExampleContract",
);
```

If typings have been generated from existing releases, the inputs of the utils will be strongly typed and wrong release name or incorrect contract name will be detected.

In case there are no releases or the releases have not been pulled, the generated typings are made in such a way that strong typecheck disappears and any string can be used with the helper functions.

### Release complete artifact

A complete artifact, i.e. the whole `build info` of a release can be retrieved using the `getReleaseBuildInfo`.

### Example with hardhat-deploy

A simple example can be made with the [hardhat-deploy](https://github.com/wighawag/hardhat-deploy) plugin for deploying a released smart contract.

The advantage of this deployment is that it only works with frozen artifacts. New development will never have an impact on it.

```ts
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { contract } from "../.soko-typings";

const deployMyExample: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment,
) {
  const { deployer } = await hre.getNamedAccounts();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const myExampleArtifact: any = await contract(
    "src/Example.sol:MyExample",
  ).getArtifact("v1.2.3");

  await hre.deployments.deploy(`MyExample@v1.2.3`, {
    contract: {
      abi: myExampleArtifact.abi,
      bytecode: myExampleArtifact.evm.bytecode.object,
      metadata: myExampleArtifact.metadata,
    },
    from: deployer,
  });
};

export default deployMyExample;
```
