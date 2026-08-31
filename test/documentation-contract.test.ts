import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, parseDocument as parseYamlDocument } from "yaml";

import {
  buildCosignPreflightCommandPlan,
  buildCosignPublicationCommandPlan,
} from "../src/application-images/cosign-plan.ts";
import {
  APPLICATION_IMAGE_CREDENTIAL_FIELDS,
  CURRENT_FRAMEWORK_DEPLOY_ENVIRONMENT_NAMES,
} from "../src/application-images/environment-boundary.ts";
import { rejectedVulnerabilities } from "../src/application-images/scan-policy.ts";
import { parseEnvFileContents } from "../src/env/env-file.ts";
import type { PackageManifestArtifact } from "../src/model/package-manifest.ts";
import { normalizeCredentialFreeRepositoryLocator } from "../src/source/repository-locator.ts";
import { buildSuccessfulDeployTargetResult } from "../src/stages/deploy/artifact-handoff.ts";
import { getRequiredRepoRelativeHostPathSource } from "../src/stages/deploy/runtime-env.ts";
import { parsePackageManifest } from "../src/stages/package-stage/package-manifest.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "..");
const currentRelease = "v0.9.1";
const previousRelease = "v0.9.0";
const daggerVersion = "v0.20.7";

type MarkdownFence = {
  body: string;
  language: string;
  line: number;
};

type DocsTreeItem = {
  children?: DocsTreeItem[];
  description?: string;
  id?: string;
  slug?: string;
  source?: string;
  title?: string;
};

type DocsTree = {
  items: DocsTreeItem[];
  quickStartItems?: DocsTreeItem[];
  tutorialItems?: DocsTreeItem[];
};

type NormalizedDocsPage = {
  description: string;
  route: string;
  source: string;
  title: string;
};

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function listFiles(
  relativeDirectory: string,
  predicate: (relativePath: string) => boolean = () => true,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(repoRoot, relativeDirectory), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFiles(relativePath, predicate)));
    } else if (predicate(relativePath)) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

function extractMarkdownFences(source: string): MarkdownFence[] {
  const fences: MarkdownFence[] = [];
  const pattern = /^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gm;

  for (const match of source.matchAll(pattern)) {
    fences.push({
      body: match[2],
      language: match[1].trim().split(/\s+/u)[0].toLowerCase(),
      line: source.slice(0, match.index).split(/\r?\n/u).length,
    });
  }

  return fences;
}

function sourceWithoutFences(source: string): string {
  return source.replace(/^```[^\r\n]*\r?\n[\s\S]*?^```[ \t]*$/gm, (fence) =>
    fence.replace(/[^\n]/gu, " "),
  );
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const location = error.instancePath || "/";
      return `${location} ${error.message ?? "failed validation"}`;
    })
    .join("\n");
}

function extractExportedStringConstant(source: string, name: string): string {
  const match = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*["']([^"']+)["']\\s*;`,
    "u",
  ).exec(source);

  assert.ok(match, `Expected exported string constant ${name}.`);
  return match[1];
}

function extractStringArrayConstant(source: string, name: string): string[] {
  const match = new RegExp(
    `const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`,
    "u",
  ).exec(source);

  assert.ok(match, `Expected string-array constant ${name}.`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
}

function extractToolTableRow(
  guide: string,
  tool: string,
): { image: string; version: string } {
  const pattern =
    "^\\|\\s*" + tool + "\\s*\\|\\s*`([^`]+)`\\s*\\|\\s*`([^`]+)`\\s*\\|$";
  const match = new RegExp(pattern, "mu").exec(guide);

  assert.ok(match, `Expected ${tool} in the documented tool table.`);
  return { image: match[2], version: match[1] };
}

function sectionBetween(
  source: string,
  heading: string,
  nextHeading: string,
): string {
  const start = source.indexOf(heading);
  const end = source.indexOf(nextHeading, start + heading.length);

  assert.notEqual(start, -1, `Expected heading ${heading}.`);
  assert.notEqual(end, -1, `Expected heading ${nextHeading}.`);
  return source.slice(start, end);
}

function markdownTableVariables(section: string): string[] {
  return [...section.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gmu)].map(
    (match) => match[1],
  );
}

function collectObjectsWithActionUse(
  value: unknown,
  results: Array<Record<string, unknown>>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectsWithActionUse(entry, results);
    return;
  }

  if (typeof value !== "object" || value === null) return;

  const object = value as Record<string, unknown>;
  if (
    typeof object.uses === "string" &&
    object.uses.startsWith("BootstrapLaboratory/rush-delivery@")
  ) {
    results.push(object);
  }

  for (const child of Object.values(object)) {
    collectObjectsWithActionUse(child, results);
  }
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, "")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/gu, "-");
}

function markdownAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();

  for (const line of sourceWithoutFences(source).split(/\r?\n/u)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match === null) continue;

    const base = normalizeHeadingText(match[1]);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }

  return anchors;
}

function normalizeGeneratedMarkdown(source: string): string {
  return source
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/u, "")
    .replace(/\]\([^)]+\)/gu, "](<LINK>)")
    .trim();
}

function normalizeSourceMarkdown(source: string): string {
  return source
    .replace(/^# .+\r?\n+/u, "")
    .replace(/\]\([^)]+\)/gu, "](<LINK>)")
    .trim();
}

function flattenDocsTree(
  tree: DocsTree,
  treePath: string,
  routeField: "id" | "slug",
): NormalizedDocsPage[] {
  const roots = [
    ...tree.items,
    ...(tree.quickStartItems ?? []),
    ...(tree.tutorialItems ?? []),
  ];
  const pages: NormalizedDocsPage[] = [];

  function visit(items: DocsTreeItem[]): void {
    for (const item of items) {
      if (item.source !== undefined) {
        const route = item[routeField];
        const title = item.title;
        assert.ok(typeof title === "string", `${treePath} title`);
        assert.ok(typeof route === "string", `${treePath} ${routeField}`);
        const absoluteSource = path.resolve(
          path.dirname(path.join(repoRoot, treePath)),
          item.source,
        );
        const relativeSource = path
          .relative(repoRoot, absoluteSource)
          .replaceAll(path.sep, "/");
        assert.ok(
          relativeSource.length > 0 &&
            relativeSource !== ".." &&
            !relativeSource.startsWith("../"),
          `${treePath} source must stay in the repository: ${item.source}`,
        );

        pages.push({
          description: item.description ?? "",
          route,
          source: relativeSource,
          title,
        });
      }

      if (item.children !== undefined) visit(item.children);
    }
  }

  visit(roots);
  return pages;
}

function parseDocsTree(source: string, treePath: string): DocsTree {
  const value = parseYaml(source) as unknown;
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      Array.isArray((value as Partial<DocsTree>).items),
    `${treePath} must contain an items array.`,
  );
  return value as DocsTree;
}

test("current release, Dagger, schema, provenance, and tool pins agree", async () => {
  const docsFiles = await listFiles("docs", (file) => file.endsWith(".md"));
  const currentReferenceFiles = [
    "README.md",
    ...docsFiles,
    "website/src/pages/index.astro",
    "website-docusaurus/src/pages/index.tsx",
  ];
  const versionReferences: Array<{ file: string; version: string }> = [];

  for (const file of currentReferenceFiles) {
    const source = await readRepoFile(file);
    for (const match of source.matchAll(
      /(?:github\.com\/)?BootstrapLaboratory\/rush-delivery@(v\d+\.\d+\.\d+)/gu,
    )) {
      versionReferences.push({ file, version: match[1] });
    }
  }

  assert.ok(versionReferences.length > 20, "Expected current module examples.");
  for (const reference of versionReferences) {
    assert.equal(
      reference.version,
      currentRelease,
      `${reference.file} has a stale current module/Action reference.`,
    );
  }

  const editorHintFiles = [
    ...docsFiles,
    "examples/oci-application-image-rush-repo/.dagger/application-images/providers.yaml",
    "examples/oci-application-image-rush-repo/.dagger/deploy/services-mesh.yaml",
    "examples/oci-application-image-rush-repo/.dagger/deploy/targets/control-plane-api.yaml",
    "examples/oci-application-image-rush-repo/.dagger/package/targets/control-plane-api.yaml",
    "examples/oci-application-image-rush-repo/.dagger/rush-cache/providers.yaml",
    ...(await listFiles("test/fixtures", (file) =>
      /\.(?:json|ya?ml)$/u.test(file),
    )),
    "website/src/pages/index.astro",
    "website-docusaurus/src/pages/index.tsx",
  ];
  let editorHintCount = 0;

  for (const file of editorHintFiles) {
    const source = await readRepoFile(file);
    for (const line of source.split(/\r?\n/u)) {
      if (!line.includes("$schema=") && !line.includes("# schemas:")) {
        continue;
      }

      const versions = [
        ...line.matchAll(/\/schemas\/(v\d+\.\d+\.\d+)\//gu),
      ].map((match) => match[1]);
      assert.ok(versions.length > 0, `${file} has an unpinned schema hint.`);
      editorHintCount += versions.length;
      for (const version of versions) {
        assert.equal(
          version,
          currentRelease,
          `${file} has a stale schema hint.`,
        );
      }
    }
  }

  assert.ok(editorHintCount > 10, "Expected immutable schema editor hints.");

  const action = parseYaml(await readRepoFile("action.yml")) as {
    inputs: Record<string, { default?: string; description?: string }>;
    runs: { steps: Array<{ uses?: string }> };
  };
  const module = JSON.parse(await readRepoFile("dagger.json")) as {
    engineVersion: string;
  };
  const rootPackage = JSON.parse(await readRepoFile("package.json")) as Record<
    string,
    unknown
  >;
  const devcontainer = await readRepoFile(".devcontainer/Dockerfile");
  assert.equal(rootPackage.version, undefined);
  assert.equal(action.inputs["dagger-version"].default, daggerVersion);
  assert.equal(module.engineVersion, daggerVersion);
  assert.match(devcontainer, /^ARG DAGGER_VERSION=0\.20\.7$/mu);
  assert.ok(
    action.runs.steps.some(
      (step) =>
        step.uses ===
        "dagger/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77",
    ),
  );

  const acceptanceWorkflowSource = await readRepoFile(
    ".github/workflows/oci-acceptance.yml",
  );
  assert.match(
    acceptanceWorkflowSource,
    /dagger\/dagger-for-github@27b130bf0f79a7f6fbbbe0fbca6760dc9bb40a77 # v8\.4\.1/u,
  );
  assert.match(acceptanceWorkflowSource, /version: v0\.20\.7/u);

  const docusaurusConfig = await readRepoFile(
    "website-docusaurus/docusaurus.config.ts",
  );
  assert.match(
    docusaurusConfig,
    new RegExp(
      `const currentDocsVersion = "${currentRelease.replaceAll(".", "\\.")}";`,
      "u",
    ),
  );
  assert.match(
    docusaurusConfig,
    new RegExp(`^  "${previousRelease.replaceAll(".", "\\.")}",$`, "mu"),
  );
  const archivedVersions = JSON.parse(
    await readRepoFile("docs-versions/versions.json"),
  ) as string[];
  assert.equal(archivedVersions[0], previousRelease);
  assert.deepEqual(
    extractStringArrayConstant(docusaurusConfig, "archivedDocsVersions"),
    archivedVersions,
  );
  assert.deepEqual(
    extractStringArrayConstant(
      await readRepoFile("website-docusaurus/scripts/sync-versioned-docs.mjs"),
      "publishedVersions",
    ),
    archivedVersions,
  );

  for (const homepage of [
    "website/src/pages/index.astro",
    "website-docusaurus/src/pages/index.tsx",
  ]) {
    const source = await readRepoFile(homepage);
    assert.match(source, /BootstrapLaboratory\/rush-delivery@v0\.9\.1/u);
    assert.match(source, /\/schemas\/v0\.9\.1\//u);
  }

  const packageImageSource = await readRepoFile(
    "src/application-images/package-image.ts",
  );
  assert.match(
    packageImageSource,
    /https:\/\/bootstraplaboratory\.github\.io\/rush-delivery\/build-types\/oci-image\/v0\.9\.1/u,
  );
  assert.match(
    packageImageSource,
    /https:\/\/github\.com\/BootstrapLaboratory\/rush-delivery@v0\.9\.1/u,
  );

  const cosignSource = await readRepoFile("src/application-images/cosign.ts");
  const cosignPlanSource = await readRepoFile(
    "src/application-images/cosign-plan.ts",
  );
  const toolContract = {
    "BusyBox preflight helper": {
      image: extractExportedStringConstant(
        cosignPlanSource,
        "COSIGN_PREFLIGHT_BUSYBOX_IMAGE",
      ),
      version: extractExportedStringConstant(
        cosignPlanSource,
        "COSIGN_PREFLIGHT_BUSYBOX_VERSION",
      ),
    },
    Cosign: {
      image: extractExportedStringConstant(cosignSource, "COSIGN_IMAGE"),
      version: extractExportedStringConstant(cosignSource, "COSIGN_VERSION"),
    },
    Grype: {
      image: extractExportedStringConstant(packageImageSource, "GRYPE_IMAGE"),
      version: extractExportedStringConstant(
        packageImageSource,
        "GRYPE_VERSION",
      ),
    },
    Syft: {
      image: extractExportedStringConstant(packageImageSource, "SYFT_IMAGE"),
      version: extractExportedStringConstant(
        packageImageSource,
        "SYFT_VERSION",
      ),
    },
  };
  const guide = await readRepoFile("docs/oci-application-images.md");

  for (const [tool, contract] of Object.entries(toolContract)) {
    assert.match(contract.image, /@sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(extractToolTableRow(guide, tool), contract);
  }

  assert.match(
    await readRepoFile("test/scripts/run-oci-acceptance.sh"),
    new RegExp(
      toolContract.Cosign.image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "u",
    ),
  );
  assert.match(
    await readRepoFile(
      "docs/tutorial/oci-application-images/03-registry-and-cosign-bootstrap.md",
    ),
    new RegExp(
      toolContract.Cosign.image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "u",
    ),
  );
});

test("generic onboarding snippets remain OCI-credential-free and provider-off", async () => {
  const baselineFiles = [
    "README.md",
    "docs/api.md",
    "docs/entrypoints.md",
    "docs/workflows.md",
    "docs/github-actions.md",
    "docs/quick-start/github-actions.md",
    "docs/quick-start/ci-cli.md",
    "docs/quick-start/local-run.md",
    "docs/tutorial/09-github-actions.md",
  ];
  const homepageFiles = [
    "website/src/pages/index.astro",
    "website-docusaurus/src/pages/index.tsx",
  ];
  const forbiddenCredentialPattern =
    /\b(?:username_env|signing_key_env|signing_password_env|verification_key_env|(?:RD_)?OCI_[A-Z0-9_]+|COSIGN_[A-Z0-9_]+)\b/u;
  let providerOffExamples = 0;

  for (const file of baselineFiles) {
    const blocks = extractMarkdownFences(await readRepoFile(file));
    assert.ok(
      blocks.length > 0,
      `${file} must contain its onboarding examples.`,
    );

    for (const block of blocks) {
      assert.doesNotMatch(
        block.body,
        forbiddenCredentialPattern,
        `${file}:${block.line} generic snippet requires OCI credentials.`,
      );

      const providerLines = block.body
        .split(/\r?\n/u)
        .filter((line) => line.includes("application-image-provider"));
      providerOffExamples += providerLines.length;

      for (const line of providerLines) {
        assert.match(
          line,
          /(?:--application-image-provider=|application-image-provider\s*:\s*)["']?off["']?(?:\s*\\)?\s*$/u,
          `${file}:${block.line} generic provider selection must be literal off.`,
        );
      }
    }
  }

  assert.ok(
    providerOffExamples >= 5,
    "Expected explicit provider-off baselines.",
  );

  for (const file of homepageFiles) {
    const source = await readRepoFile(file);
    assert.doesNotMatch(source, forbiddenCredentialPattern);
    for (const line of source
      .split(/\r?\n/u)
      .filter((entry) => entry.includes("application-image-provider"))) {
      assert.match(
        line,
        /application-image-provider\s*:\s*off/u,
        `${file} homepage baseline must not select a named OCI provider.`,
      );
    }
  }
});

test("current production snippets pin third-party actions to reviewed commits", async () => {
  const productionFiles = [
    ".github/workflows/ci.yml",
    ".github/workflows/oci-acceptance.yml",
    ".github/workflows/pages.yml",
    ".github/workflows/release-smoke.yml",
    "README.md",
    "action.yml",
    ...(await listFiles("docs", (file) => file.endsWith(".md"))),
  ];
  const actionPattern =
    /^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+)(?:\s+#\s*(\S.*))?\s*$/gmu;

  for (const file of productionFiles) {
    const source = await readRepoFile(file);

    for (const match of source.matchAll(actionPattern)) {
      const action = match[1];
      const reference = match[2];
      const comment = match[3];

      if (action === "BootstrapLaboratory/rush-delivery") {
        continue;
      }

      const line = source.slice(0, match.index).split(/\r?\n/u).length;
      assert.match(
        reference,
        /^[a-f0-9]{40}$/u,
        `${file}:${line} must pin ${action} to a full commit SHA.`,
      );
      assert.match(
        comment ?? "",
        /^v\d/u,
        `${file}:${line} must retain a human-readable release comment.`,
      );
    }
  }
});

test("Action keeps its legacy Docker socket default while OCI-only examples disable it", async () => {
  const action = parseYaml(await readRepoFile("action.yml")) as {
    inputs: Record<string, { default?: string; description?: string }>;
  };
  const socketInput = action.inputs["docker-socket"];

  assert.equal(socketInput.default, "/var/run/docker.sock");
  assert.match(
    socketInput.description ?? "",
    /legacy deploy-script compatibility/iu,
  );
  assert.match(socketInput.description ?? "", /set empty for OCI-only jobs/iu);

  const markdownFiles = [
    "README.md",
    ...(await listFiles("docs", (file) => file.endsWith(".md"))),
  ];
  let namedProviderActionExamples = 0;

  for (const file of markdownFiles) {
    for (const block of extractMarkdownFences(await readRepoFile(file))) {
      if (block.language !== "yaml" && block.language !== "yml") continue;

      const document = parseYamlDocument(block.body, { uniqueKeys: true });
      if (document.errors.length > 0) continue;

      const actionUses: Array<Record<string, unknown>> = [];
      collectObjectsWithActionUse(document.toJS(), actionUses);

      for (const actionUse of actionUses) {
        const withInputs = actionUse.with;
        if (typeof withInputs !== "object" || withInputs === null) continue;
        const inputs = withInputs as Record<string, unknown>;
        const provider = inputs["application-image-provider"];

        if (typeof provider === "string" && provider !== "off") {
          namedProviderActionExamples += 1;
          assert.equal(
            inputs["docker-socket"],
            "",
            `${file}:${block.line} OCI-only Action example must disable the legacy socket.`,
          );
        }
      }
    }
  }

  assert.ok(
    namedProviderActionExamples >= 4,
    "Expected self-contained named-provider Action examples.",
  );
});

test("complete canonical tutorial file blocks remain byte-identical", async () => {
  const copies = [
    {
      doc: "docs/tutorial/oci-application-images/01-build-and-scan-target.md",
      link: "../../../examples/oci-application-image-rush-repo/apps/control-plane-api/scripts/build.mjs",
      source:
        "examples/oci-application-image-rush-repo/apps/control-plane-api/scripts/build.mjs",
    },
    {
      doc: "docs/tutorial/oci-application-images/01-build-and-scan-target.md",
      link: "../../../examples/oci-application-image-rush-repo/apps/control-plane-api/Dockerfile",
      source:
        "examples/oci-application-image-rush-repo/apps/control-plane-api/Dockerfile",
    },
    {
      doc: "docs/tutorial/oci-application-images/01-build-and-scan-target.md",
      link: "../../../examples/oci-application-image-rush-repo/.dagger/package/targets/control-plane-api.yaml",
      source:
        "examples/oci-application-image-rush-repo/.dagger/package/targets/control-plane-api.yaml",
    },
    {
      doc: "docs/tutorial/oci-application-images/01-build-and-scan-target.md",
      link: "../../../examples/oci-application-image-rush-repo/.dagger/application-images/grype.yaml",
      source:
        "examples/oci-application-image-rush-repo/.dagger/application-images/grype.yaml",
    },
    {
      doc: "docs/tutorial/oci-application-images/03-registry-and-cosign-bootstrap.md",
      link: "../../../examples/oci-application-image-rush-repo/.dagger/application-images/providers.yaml",
      source:
        "examples/oci-application-image-rush-repo/.dagger/application-images/providers.yaml",
    },
    {
      doc: "docs/tutorial/oci-application-images/05-deploy-the-digest.md",
      link: "../../../examples/oci-application-image-rush-repo/deploy/consume-image.sh",
      source:
        "examples/oci-application-image-rush-repo/deploy/consume-image.sh",
    },
  ];

  for (const copy of copies) {
    const documentation = await readRepoFile(copy.doc);
    const linkPosition = documentation.indexOf(`](${copy.link})`);
    assert.notEqual(
      linkPosition,
      -1,
      `${copy.doc} must link its canonical source ${copy.source}.`,
    );
    const firstFence = /^```[^\r\n]*\r?\n([\s\S]*?)^```[ \t]*$/mu.exec(
      documentation.slice(linkPosition),
    );
    assert.ok(firstFence, `${copy.doc} must include ${copy.source}.`);
    assert.equal(
      firstFence[1],
      await readRepoFile(copy.source),
      `${copy.doc} duplicated complete file drifted from ${copy.source}.`,
    );
  }
});

test("documented environment, scan, Cosign, and deploy-result contracts match code", async () => {
  const guide = await readRepoFile("docs/oci-application-images.md");
  const deployTutorial = await readRepoFile(
    "docs/tutorial/oci-application-images/05-deploy-the-digest.md",
  );
  const expectedEnvironmentNames = [
    ...CURRENT_FRAMEWORK_DEPLOY_ENVIRONMENT_NAMES,
  ].sort();
  const guideVariables = markdownTableVariables(
    sectionBetween(
      guide,
      "### Framework-owned Deploy variables",
      "### Workspace and evidence isolation",
    ),
  ).sort();
  const tutorialVariables = markdownTableVariables(
    sectionBetween(
      deployTutorial,
      "## Framework Runtime Variables",
      "## Complete Deploy Result Examples",
    ),
  ).sort();

  assert.deepEqual(guideVariables, expectedEnvironmentNames);
  assert.deepEqual(tutorialVariables, expectedEnvironmentNames);

  const providerSection = sectionBetween(
    guide,
    "### Application-image provider",
    "### Provider activation",
  );
  const documentedCredentialFields = [
    ...providerSection.matchAll(/^\|\s*`([a-z_]+_env)`\s*\|/gmu),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(
    documentedCredentialFields,
    [...APPLICATION_IMAGE_CREDENTIAL_FIELDS].sort(),
  );

  const criticalAndHighReport = {
    matches: [
      { vulnerability: { id: "CVE-CRITICAL", severity: "Critical" } },
      { vulnerability: { id: "CVE-HIGH", severity: "High" } },
    ],
  };
  assert.deepEqual(rejectedVulnerabilities(criticalAndHighReport, ["high"]), {
    count: 1,
    ids: ["CVE-HIGH"],
  });
  assert.match(
    guide,
    /`scan\.fail_on` is the exact set of rejected normalized severities\. It is not a\s+threshold/u,
  );

  const preflight = buildCosignPreflightCommandPlan();
  const publication = buildCosignPublicationCommandPlan(
    `registry.example/platform/api@sha256:${"a".repeat(64)}`,
  );
  const securityModeFlagPattern =
    /^--(?:insecure-ignore-tlog|new-bundle-format=false|tlog-upload=false|use-signing-config=false)$/u;
  const codeFlags = new Set(
    [...preflight, ...publication]
      .flatMap((step) => step.args)
      .filter((argument) => securityModeFlagPattern.test(argument)),
  );
  const documentedFlags = new Set(
    [...guide.matchAll(/`(--[^`]+)`/gu)]
      .map((match) => match[1])
      .filter((argument) => securityModeFlagPattern.test(argument)),
  );

  assert.deepEqual(
    [...documentedFlags].sort(),
    [...codeFlags].sort(),
    "The documented Cosign security mode flags must match the command plans.",
  );
  assert.match(
    guide,
    /`--new-bundle-format=false`[\s\S]+legacy `\.sig`[\s\S]+`\.att`[\s\S]+OCI 1\.1 Referrers API/u,
  );
  assert.match(
    await readRepoFile(
      "docs/tutorial/oci-application-images/04-publish-and-inspect.md",
    ),
    /`--new-bundle-format=false`[\s\S]+shared `\.att`[\s\S]+three real Cosign verification commands/u,
  );

  const manifestSources: string[] = [];
  for (const file of [
    "docs/oci-application-images.md",
    "docs/tutorial/oci-application-images/02-provider-off-dry-run.md",
    "docs/tutorial/oci-application-images/04-publish-and-inspect.md",
  ]) {
    for (const fence of extractMarkdownFences(await readRepoFile(file))) {
      if (fence.language !== "json") continue;
      const value = JSON.parse(fence.body) as unknown;
      if (typeof value === "object" && value !== null && "artifacts" in value) {
        manifestSources.push(fence.body);
      }
    }
  }

  const artifacts: PackageManifestArtifact[] = [];
  for (const source of manifestSources) {
    const manifest = parsePackageManifest(source);
    artifacts.push(...Object.values(manifest.artifacts));
  }
  const planned = artifacts.find(
    (artifact) =>
      artifact.kind === "oci_image" && artifact.status === "planned",
  );
  const published = artifacts.find(
    (artifact) =>
      artifact.kind === "oci_image" && artifact.status === "published",
  );
  assert.ok(planned, "Expected a documented planned OCI artifact.");
  assert.ok(published, "Expected a documented published OCI artifact.");

  const documentedResults = extractMarkdownFences(deployTutorial)
    .filter((fence) => fence.language === "json")
    .map((fence) => JSON.parse(fence.body) as Record<string, unknown>)
    .filter((value) => Array.isArray(value.results));
  const plannedResult = documentedResults.find(
    (value) => value.dryRun === true,
  );
  const publishedResult = documentedResults.find(
    (value) => value.dryRun === false,
  );
  assert.ok(plannedResult);
  assert.ok(publishedResult);

  const expectedPlannedKeys = Object.keys(
    buildSuccessfulDeployTargetResult(
      planned,
      undefined,
      "output",
      "control-plane-api",
      1,
    ),
  ).sort();
  const expectedPublishedKeys = Object.keys(
    buildSuccessfulDeployTargetResult(
      published,
      undefined,
      "output",
      "control-plane-api",
      1,
    ),
  ).sort();
  const plannedResults = plannedResult.results as Array<
    Record<string, unknown>
  >;
  const publishedResults = publishedResult.results as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(Object.keys(plannedResults[0]).sort(), expectedPlannedKeys);
  assert.deepEqual(
    Object.keys(publishedResults[0]).sort(),
    expectedPublishedKeys,
  );
});

test("documented locator, env-diagnostic, and host-path guarantees match code", async () => {
  const guide = await readRepoFile("docs/oci-application-images.md");
  const splitStageTutorial = await readRepoFile(
    "docs/tutorial/oci-application-images/07-split-stages-and-rollback.md",
  );
  const troubleshooting = await readRepoFile(
    "docs/oci-application-image-troubleshooting.md",
  );

  assert.match(
    guide,
    /source repository locator is public provenance and label data, not\s+an authentication channel/u,
  );
  assert.match(
    guide,
    /rejects URL\s+password\/userinfo \(except the literal SSH user `git`\), query strings, fragments,\s+whitespace, control characters, and arbitrary SCP-like strings without echoing\s+the rejected value/u,
  );

  for (const locator of [
    "git://github.com/example/project.git",
    "http://git.example.invalid/example/project.git",
    "https://github.com/example/project.git",
    "ssh://git@git.example.invalid/example/project.git",
    "git@git.example.invalid:example/project.git",
  ]) {
    assert.equal(
      normalizeCredentialFreeRepositoryLocator(locator, "test locator"),
      locator,
    );
  }

  const locatorSentinel = "SENTINEL_SOURCE_LOCATOR_793ab5";
  for (const locator of [
    `https://user:${locatorSentinel}@github.com/example/project.git`,
    `https://github.com/example/project.git?token=${locatorSentinel}`,
    `https://github.com/example/project.git#${locatorSentinel}`,
    `https://github.com/example/project.git ${locatorSentinel}`,
    `ssh://operator@host.invalid/example/${locatorSentinel}.git`,
    `operator@host.invalid:example/${locatorSentinel}.git`,
  ]) {
    let diagnostic = "";
    assert.throws(
      () => normalizeCredentialFreeRepositoryLocator(locator, "test locator"),
      (error) => {
        diagnostic = error instanceof Error ? error.message : String(error);
        return true;
      },
    );
    assert.equal(diagnostic.includes(locatorSentinel), false);
  }

  assert.match(
    guide,
    /malformed, its diagnostic contains only the line number\s+and a redaction marker; it never repeats the raw line, invalid name, or value/u,
  );
  assert.match(
    troubleshooting,
    /Malformed-record diagnostics identify the physical line number and redact its\s+contents/u,
  );

  const envSentinel = "SENTINEL_ENV_DIAGNOSTIC_b8e5d2";
  for (const contents of [
    `OCI_TOKEN=valid-record\n${envSentinel}`,
    `${envSentinel.toLowerCase()}=value`,
  ]) {
    let diagnostic = "";
    assert.throws(
      () => parseEnvFileContents(contents, "deploy env"),
      (error) => {
        diagnostic = error instanceof Error ? error.message : String(error);
        return true;
      },
    );
    assert.match(diagnostic, /Invalid deploy env line [12]\./u);
    assert.match(diagnostic, /line contents were redacted/u);
    assert.equal(diagnostic.includes(envSentinel), false);
    assert.equal(diagnostic.includes(envSentinel.toLowerCase()), false);
  }

  assert.match(
    guide,
    /Repository-backed host-path sources are normalized before use and cannot point\s+at `\.dagger\/runtime\/evidence` or any descendant/u,
  );
  assert.match(
    guide,
    /resolution also uses an\s+evidence-stripped repository view, so a safe-looking symlink cannot resolve\s+back into another target's evidence/u,
  );
  assert.match(
    guide,
    /The destination of either file\s+mount form is normalized independently and cannot equal, descend from, or be a\s+parent that could mask `\/workspace\/\.dagger\/runtime\/evidence`/u,
  );
  assert.match(
    guide,
    /The three framework paths `\.dagger`, `\.dagger\/runtime`, and\s+`\.dagger\/runtime\/evidence` must be real directories when present in a packaged\s+Deploy bundle, not symbolic links/u,
  );
  assert.match(
    guide,
    /Standalone Deploy does not repair a supplied bundle: its common preflight\s+rejects an alias before either a dry or live target runs/u,
  );
  assert.match(
    splitStageTutorial,
    /Run the `v0\.9\.0` Package producer again from the intended source and built\s+output, export the complete returned directory, and register a new archive/u,
  );
  for (const frameworkPath of [
    '".dagger"',
    '".dagger/runtime"',
    '".dagger/runtime/evidence"',
  ]) {
    assert.ok(
      splitStageTutorial.includes(frameworkPath),
      `Split-stage tutorial must check ${frameworkPath}.`,
    );
  }
  assert.match(
    troubleshooting,
    /No dry or live target starts\. Do not patch\/repack the bundle/u,
  );
  assert.equal(
    getRequiredRepoRelativeHostPathSource(
      { DEPLOY_FILE: "./secrets/deploy.json" },
      "DEPLOY_FILE",
      "control-plane-api",
    ),
    "secrets/deploy.json",
  );
  assert.equal(
    getRequiredRepoRelativeHostPathSource(
      { DEPLOY_FILE: "/runner/work/repo/secrets/deploy.json" },
      "DEPLOY_FILE",
      "control-plane-api",
      "/runner/work/repo",
    ),
    "secrets/deploy.json",
  );

  for (const sourcePath of [
    ".dagger/runtime/evidence",
    ".dagger/runtime/evidence/sibling/scan.json",
    "/runner/work/repo/.dagger/runtime/evidence/sibling/scan.json",
  ]) {
    assert.throws(
      () =>
        getRequiredRepoRelativeHostPathSource(
          { EVIDENCE_SOURCE: sourcePath },
          "EVIDENCE_SOURCE",
          "control-plane-api",
          "/runner/work/repo",
        ),
      /consume the current target's verified evidence through ARTIFACT_EVIDENCE_DIR/u,
    );
  }
});

test("complete documentation JSON, YAML, shell, and manifests parse", async () => {
  const markdownFiles = [
    "README.md",
    ...(await listFiles("docs", (file) => file.endsWith(".md"))),
  ];
  const rootManifestSchema = JSON.parse(
    await readRepoFile("schemas/package-manifest.schema.json"),
  ) as AnySchema;
  const versionedManifestSchema = JSON.parse(
    await readRepoFile("schemas/v0.8.1/package-manifest.schema.json"),
  ) as AnySchema;
  const manifestValidators = [rootManifestSchema, versionedManifestSchema].map(
    (schema) => new Ajv2020({ allErrors: true }).compile(schema),
  );
  const counts = { bash: 0, json: 0, manifest: 0, yaml: 0 };

  for (const file of markdownFiles) {
    for (const fence of extractMarkdownFences(await readRepoFile(file))) {
      const location = `${file}:${fence.line}`;

      if (fence.language === "json") {
        counts.json += 1;
        const value = JSON.parse(fence.body) as unknown;

        if (
          typeof value === "object" &&
          value !== null &&
          "artifacts" in value
        ) {
          counts.manifest += 1;
          parsePackageManifest(fence.body);
          if ("schema_version" in value) {
            for (const validate of manifestValidators) {
              assert.ok(
                validate(value),
                `${location} must satisfy the package-manifest schema.\n${formatSchemaErrors(validate.errors)}`,
              );
            }
          }
        }
      } else if (fence.language === "yaml" || fence.language === "yml") {
        counts.yaml += 1;
        const document = parseYamlDocument(fence.body, { uniqueKeys: true });
        assert.deepEqual(
          document.errors.map((error) => error.message),
          [],
          `${location} must be complete, parseable YAML.`,
        );
      } else if (
        fence.language === "bash" ||
        fence.language === "sh" ||
        fence.language === "shell"
      ) {
        counts.bash += 1;
        const result = spawnSync("bash", ["-n"], {
          encoding: "utf8",
          input: fence.body,
        });
        assert.equal(
          result.status,
          0,
          `${location} must pass bash -n.\n${result.stderr}`,
        );
      }
    }
  }

  assert.ok(counts.bash > 20, "Expected complete shell examples.");
  assert.ok(counts.json > 10, "Expected complete JSON examples.");
  assert.ok(counts.yaml > 20, "Expected complete YAML examples.");
  assert.ok(counts.manifest >= 8, "Expected all complete manifest examples.");
});

test("internal Markdown links, docs trees, and generated routes stay synchronized", async () => {
  const docsMarkdownFiles = await listFiles("docs", (file) =>
    file.endsWith(".md"),
  );
  const markdownFiles = [
    "README.md",
    ...docsMarkdownFiles,
    ".ai/architecture.md",
    ".ai/conventions.md",
  ];
  const anchorCache = new Map<string, Set<string>>();

  async function anchorsFor(relativePath: string): Promise<Set<string>> {
    const cached = anchorCache.get(relativePath);
    if (cached !== undefined) return cached;
    const anchors = markdownAnchors(await readRepoFile(relativePath));
    anchorCache.set(relativePath, anchors);
    return anchors;
  }

  for (const file of markdownFiles) {
    const source = sourceWithoutFences(await readRepoFile(file));
    const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/gu;

    for (const match of source.matchAll(linkPattern)) {
      let target = match[1].replace(/^<|>$/gu, "");
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) continue;

      const hashIndex = target.indexOf("#");
      const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const rawFragment = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
      const queryIndex = rawPath.indexOf("?");
      const pathWithoutQuery =
        queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
      const decodedPath = decodeURIComponent(pathWithoutQuery);
      const absoluteTarget =
        decodedPath.length === 0
          ? path.join(repoRoot, file)
          : path.resolve(path.dirname(path.join(repoRoot, file)), decodedPath);
      const relativeTarget = path
        .relative(repoRoot, absoluteTarget)
        .replaceAll(path.sep, "/");

      assert.ok(
        relativeTarget.length > 0 &&
          relativeTarget !== ".." &&
          !relativeTarget.startsWith("../"),
        `${file} link escapes the repository: ${target}`,
      );

      const targetStats = await stat(absoluteTarget).catch(() => undefined);
      assert.ok(targetStats, `${file} has a missing internal link: ${target}`);

      if (
        rawFragment.length > 0 &&
        targetStats.isFile() &&
        relativeTarget.endsWith(".md")
      ) {
        const fragment = decodeURIComponent(rawFragment);
        assert.ok(
          (await anchorsFor(relativeTarget)).has(fragment),
          `${file} has a missing Markdown anchor: ${target}`,
        );
      }
    }
  }

  const astroTreePath = "website/docs-tree.yaml";
  const docusaurusTreePath = "website-docusaurus/docs-tree.yaml";
  const astroPages = flattenDocsTree(
    parseDocsTree(await readRepoFile(astroTreePath), astroTreePath),
    astroTreePath,
    "slug",
  );
  const docusaurusPages = flattenDocsTree(
    parseDocsTree(await readRepoFile(docusaurusTreePath), docusaurusTreePath),
    docusaurusTreePath,
    "id",
  );

  assert.deepEqual(docusaurusPages, astroPages);
  assert.equal(
    new Set(astroPages.map((page) => page.route)).size,
    astroPages.length,
  );
  assert.equal(
    new Set(astroPages.map((page) => page.source)).size,
    astroPages.length,
  );
  assert.deepEqual(
    astroPages.map((page) => page.source).sort(),
    docsMarkdownFiles,
    "Every current docs source must have exactly one route in both sites.",
  );

  const expectedOciRoutes = [
    "oci-application-image-troubleshooting",
    "oci-application-images",
    "oci-registry-recipes",
    "tutorial/oci-application-images",
    "tutorial/oci-application-images/build-and-scan-target",
    "tutorial/oci-application-images/deploy-the-digest",
    "tutorial/oci-application-images/github-actions",
    "tutorial/oci-application-images/provider-off-dry-run",
    "tutorial/oci-application-images/publish-and-inspect",
    "tutorial/oci-application-images/registry-and-cosign-bootstrap",
    "tutorial/oci-application-images/split-stages-and-rollback",
  ];
  const routes = new Set(astroPages.map((page) => page.route));
  for (const route of expectedOciRoutes) {
    assert.ok(routes.has(route), `Missing OCI docs route ${route}.`);
  }

  for (const page of astroPages) {
    const source = await readRepoFile(page.source);
    for (const generatedPath of [
      `website/src/content/docs/docs/${page.route}.md`,
      `website-docusaurus/docs/${page.route}.md`,
    ]) {
      const generated = await readRepoFile(generatedPath);
      assert.equal(
        normalizeGeneratedMarkdown(generated),
        normalizeSourceMarkdown(source),
        `${generatedPath} must be regenerated from ${page.source}.`,
      );
    }
  }
});
