import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { repoRoot, websiteRoot } from "../src/lib/docsTree.mjs";

const execFileAsync = promisify(execFile);
const docsVersionsRoot = path.join(repoRoot, "docs-versions");
const versionedDocsDir = path.join(docsVersionsRoot, "versioned_docs");
const versionedSidebarsDir = path.join(docsVersionsRoot, "versioned_sidebars");
const versionsJsonPath = path.join(docsVersionsRoot, "versions.json");
const githubBlobBase =
  "https://github.com/BootstrapLaboratory/rush-delivery/blob";

const publishedVersions = [
  "v0.8.1",
  "v0.8.0",
  "v0.7.1",
  "v0.6.7",
  "v0.6.6",
  "v0.6.5",
  "v0.6.4",
  "v0.6.3",
  "v0.6.2",
  "v0.6.1",
  "v0.6.0",
  "v0.5.0",
  "v0.4.1",
  "v0.4.0",
  "v0.3.4",
  "v0.3.3",
  "v0.3.2",
  "v0.3.1",
];

function stripLeadingHeading(markdown) {
  return markdown.replace(/^# .+\r?\n+/, "");
}

async function gitShow(ref, filePath) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${ref}:${filePath}`],
      {
        cwd: repoRoot,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return stdout;
  } catch (error) {
    throw new Error(`Unable to read ${filePath} from ${ref}.`, {
      cause: error,
    });
  }
}

function normalizeTagSource(source) {
  const normalized = path.posix.normalize(
    path.posix.join("website-docusaurus", source),
  );

  if (normalized.startsWith("../")) {
    throw new Error(`Docs tree source escapes repository root: ${source}`);
  }

  return normalized;
}

function flattenDocsTree(tree, items = allDocItems(tree)) {
  const pages = [];

  for (const item of items) {
    if (item.source !== undefined) {
      pages.push({
        description: item.description ?? "",
        id: item.id,
        source: normalizeTagSource(item.source),
        title: item.title,
      });
    }

    if (Array.isArray(item.children)) {
      pages.push(...flattenDocsTree(tree, item.children));
    }
  }

  return pages;
}

function allDocItems(tree) {
  return [
    ...tree.items,
    ...(tree.quickStartItems ?? []),
    ...(tree.tutorialItems ?? []),
  ];
}

function validateDocsTree(tree, version) {
  if (
    typeof tree !== "object" ||
    tree === null ||
    !Array.isArray(tree.items) ||
    (tree.quickStartItems !== undefined &&
      !Array.isArray(tree.quickStartItems)) ||
    (tree.tutorialItems !== undefined && !Array.isArray(tree.tutorialItems))
  ) {
    throw new Error(
      `${version}: website-docusaurus/docs-tree.yaml must define items and optional quickStartItems/tutorialItems arrays.`,
    );
  }
}

function frontmatterString(page) {
  const lines = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `sidebar_label: ${JSON.stringify(page.title)}`,
  ];

  if (!page.id.includes("/")) {
    lines.splice(1, 0, `id: ${JSON.stringify(page.id)}`);
  }

  if (page.description.length > 0) {
    lines.push(`description: ${JSON.stringify(page.description)}`);
  }

  lines.push("---", "", "");
  return lines.join("\n");
}

function routeForId(id) {
  return id === "index" ? "/docs/" : `/docs/${id}/`;
}

function relativeDocRoute(fromId, toId) {
  const relative = path.posix.relative(routeForId(fromId), routeForId(toId));

  return relative.length > 0 ? relative : ".";
}

function rewriteMarkdownLinks(markdown, page, sourceToId, version) {
  const sourceDir = path.posix.dirname(page.source);

  return markdown.replace(
    /\]\((?!https?:\/\/|mailto:|#|\/)([^)\s]+)(#[^)]+)?\)/g,
    (_match, rawLink, rawHash = "") => {
      const targetPath = path.posix
        .normalize(path.posix.join(sourceDir, rawLink))
        .replaceAll(path.sep, "/");
      const targetId = sourceToId.get(targetPath);

      if (targetId !== undefined) {
        return `](${relativeDocRoute(page.id, targetId)}${rawHash})`;
      }

      return `](${githubBlobBase}/${version}/${targetPath}${rawHash})`;
    },
  );
}

function treeItemToSidebar(item) {
  if (Array.isArray(item.children)) {
    return {
      type: "category",
      label: item.title,
      items: item.children.map(treeItemToSidebar),
    };
  }

  return {
    type: "doc",
    id: item.id,
    label: item.title,
  };
}

function buildSidebars(tree) {
  const tutorialItems =
    tree.tutorialItems === undefined || tree.tutorialItems.length === 0
      ? [
          {
            id: "tutorial",
            title: "Tutorial",
          },
        ]
      : tree.tutorialItems;

  return {
    docsSidebar: tree.items.map(treeItemToSidebar),
    quickStartSidebar: (tree.quickStartItems ?? []).map(treeItemToSidebar),
    tutorialSidebar: tutorialItems.map(treeItemToSidebar),
  };
}

async function loadTree(version) {
  const tree = parseYaml(
    await gitShow(version, "website-docusaurus/docs-tree.yaml"),
  );

  validateDocsTree(tree, version);
  return tree;
}

async function writeVersionDocs(version) {
  const tree = await loadTree(version);
  const outputDir = path.join(versionedDocsDir, `version-${version}`);
  const pages = flattenDocsTree(tree);
  const sourceToId = new Map(pages.map((page) => [page.source, page.id]));

  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  await writeFile(
    path.join(outputDir, "index.md"),
    [
      "---",
      'id: "index"',
      'title: "Docs"',
      'sidebar_label: "Docs"',
      `description: ${JSON.stringify(`Documentation for Rush Delivery ${version}.`)}`,
      "---",
      "",
      `You are viewing archived documentation for Rush Delivery ${version}.`,
      "",
      "Choose a page from the sidebar, or start with the [Quick Start](quick-start/github-actions).",
      "",
    ].join("\n"),
  );

  if (tree.tutorialItems === undefined || tree.tutorialItems.length === 0) {
    await writeFile(
      path.join(outputDir, "tutorial.md"),
      [
        "---",
        'id: "tutorial"',
        'title: "Tutorial"',
        'sidebar_label: "Tutorial"',
        `description: ${JSON.stringify(`Tutorial availability for Rush Delivery ${version}.`)}`,
        "---",
        "",
        `The tutorial was not published for Rush Delivery ${version}.`,
        "",
        "Use the archived docs sidebar for this version, or switch to the current docs version for the tutorial.",
        "",
      ].join("\n"),
    );
  }

  for (const page of pages) {
    const markdown = rewriteMarkdownLinks(
      stripLeadingHeading(await gitShow(version, page.source)),
      page,
      sourceToId,
      version,
    );
    const outputPath = path.join(outputDir, `${page.id}.md`);

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${frontmatterString(page)}${markdown.trim()}\n`,
    );
  }

  await mkdir(versionedSidebarsDir, { recursive: true });
  await writeFile(
    path.join(versionedSidebarsDir, `version-${version}-sidebars.json`),
    `${JSON.stringify(buildSidebars(tree), null, 2)}\n`,
  );
}

async function main() {
  await rm(versionedDocsDir, { force: true, recursive: true });
  await rm(versionedSidebarsDir, { force: true, recursive: true });
  await mkdir(versionedDocsDir, { recursive: true });
  await mkdir(versionedSidebarsDir, { recursive: true });

  for (const version of publishedVersions) {
    await writeVersionDocs(version);
  }

  await writeFile(
    versionsJsonPath,
    `${JSON.stringify(publishedVersions, null, 2)}\n`,
  );
}

await main();
