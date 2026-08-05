import { dag, Directory } from "@dagger.io/dagger";

import { logSection } from "../logging/sections.ts";

const WORKDIR = "/workspace";
const SELF_CHECK_IMAGE = "node:24-bookworm-slim";
const SELF_CHECK_INSTALL_COMMAND =
  "apt-get update && apt-get install -y ca-certificates git";

export async function selfCheck(moduleSource: Directory): Promise<string> {
  logSection("Rush delivery self-check");
  logSection("Dagger framework tests");

  const sourceWithGeneratedSdk = moduleSource.withDirectory(
    "sdk",
    dag.currentModule().generatedContextDirectory().directory("sdk"),
  );

  const container = dag
    .container()
    .from(SELF_CHECK_IMAGE)
    .withDirectory(WORKDIR, sourceWithGeneratedSdk)
    .withWorkdir(WORKDIR)
    .withExec(["bash", "-lc", SELF_CHECK_INSTALL_COMMAND])
    .withExec(["yarn", "install", "--frozen-lockfile"], { expand: false })
    .withExec(["yarn", "typecheck"], { expand: false })
    .withExec(["yarn", "test"], { expand: false });

  await container.sync();

  return "rush-delivery self-check passed";
}
