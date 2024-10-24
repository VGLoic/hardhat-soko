# Hardhat Soko

Hardhat plugin in order to manage your smart contract compilation artifacts.

1. [Motivation](#motivation),
2. [Installation](#installation),
3. [Configuration](#configuration),
4. [Hardhat Tasks](#tasks),
5. [Using the typings](#using-the-typings).

## Motivation

When compiling the smart contracts, the developer will generate _compilation artifacts_. They will contain all the needed informations for further tasks such as deployment, verification or simple contract interactions.

These compilation artifacts are generally ignored and not commited nor stored. At best, compilation artifact for a contract is contained within its deployment summary. Not having a clear way of identifying or re-using an artifact is a painful experience for all developers working closely or remotely with the smart contracts:

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
  // Example configuration for Soko with AWS S3 as storage for compilation artifacts
  soko: {
    project: "awesome-stuff",
    pulledArtifactsPath: ".soko",
    typingsPath: ".soko-typings",
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
  // The name of the project
  project: string;
  // Local path in which artifacts will be pulled
  // Default to `.soko`
  pulledArtifactsPath?: string;
  // Local path in which typings will be generated
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
```

## Projects, tags and IDs

**An ID, e.g. `dcauXtavGLxC`, is derived for each compilation artifact**. The ID is based on the content of the artifact.

**A tag, e.g. `v1.2.3`, can be associated to a compilation artifact when pushed.**

**A project, e.g. `my-project`, will gather many compilation artifacts.**

A project is setup at the level of the Hardhat Config, it will be used when pushing new artifacts or as default for the other commands. It is however possible to pull any projects you control.

## Tasks

> [!NOTE]
> The code snippets in this section uses `npx` but one can choose something else

An overview of the Soko tasks is exposed by running the `soko` task:

```bash
npx hardhat soko
```

Help about any task scopped under soko is available:

```bash
npx hardhat help soko push
```

### Push

Push a local compilation artifact for the configured project to the storage, creating the remote artifact with its ID and optionally tagging it.

Only push the compilation artifact without an additional tag:

```bash
npx hardhat soko push --artifact-path ./path/to/my/artifact.json
```

Or use a tag to associate the compilation artifact with it

```bash
npx hardhat soko push --artifact-path ./path/to/my/artifact.json --tag v1.2.3
```

### Pull

Pull locally the missing artifacts from the configured storage.

One can pull all the artifacts from the configured project

```bash
npx hardhat soko pull
```

Or target a specific artifact using its tag or ID or another project:

```bash
npx hardhat soko pull --id 123456
npx hardhat soko pull --tag v1.2.3
npx hardhat soko pull --tag v4.5.6 --project another-project
```

### Typings

Once the artifacts have been pulled, one can generate the TypeScript typings based on the pulled projects.

```bash
npx hardhat soko typings
```

> [!NOTE]
> If no projects have been pulled, one can still generate the default typings using this command. It may be helpful for those who do not care about the scripts involving Soko but want to be unblocked in case of missing files.

### List

List the pulled projects and their compilation artifacts.

```bash
npx hardhat soko list
```

### Diff

Compare a local compilation artifacts with an existing compilation artifact and print the contracts for which differences have been found.

```bash
npx hardhat soko diff --artifact-path ./path/to/my/artifact.json --tag v1.2.3
npx hardhat soko diff --artifact-path ./path/to/my/artifact.json --id 123456
```

## Using the typings

The typings are exposed in order to help the developer retrieve easily and safely a contract artifact (ABI, bytecode, etc...).

There are two available utils in order to retrieve a contract artifact, it would depend on the task at hand:

- start with a contract, select one of its available tag

```ts
import { project } from "../.soko-typings";

const artifact = await project("my-project")
  .contract("src/path/to/my/contract.sol:MyExampleContract")
  .getArtifact("v1.2.3");
```

- start with a tag, select a contract within it

```ts
import { project } from "../.soko-typings";

const artifact = await project("my-project")
  .tag("v1.2.3")
  .getContractArtifact("src/path/to/my/contract.sol:MyExampleContract");
```

If typings have been generated from existing projects, the inputs of the utils will be strongly typed and wrong project, tags or contracts names will be detected.

In case there are no projects or the projects have not been pulled, the generated typings are made in such a way that strong typecheck disappears and any string can be used with the helper functions.

### Retrieve full compilation artifact

The full compilation artifact of a tag can be retrieved using the `project("my-project").tag("v1.2.3").getCompilationArtifact` method.

### Example with hardhat-deploy

A simple example can be made with the [hardhat-deploy](https://github.com/wighawag/hardhat-deploy) plugin for deploying a released smart contract.

The advantage of this deployment is that it only works with frozen artifacts. New development will never have an impact on it.

```ts
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { project } from "../.soko-typings";

const deployMyExample: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment,
) {
  const { deployer } = await hre.getNamedAccounts();

  const myExampleArtifact = await project("my-project")
    .contract("src/Example.sol:MyExample")
    .getArtifact("v1.2.3");

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

## Examples

Here are examples of integration with Hardhat Soko in order to handle the releases of smart contracts, deployments and publication of NPM packages containing ABI and deployment addresses:

- [everything with Hardhat](https://github.com/VGLoic/hardhat-soko-example),
- [compilation and testing with Foundry, deployments with Hardhat](https://github.com/VGLoic/foundry-hardhat-soko-example).
