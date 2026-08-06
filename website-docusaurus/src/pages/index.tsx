import { useState } from "react";
import clsx from "clsx";
import Heading from "@theme/Heading";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useColorMode } from "@docusaurus/theme-common";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { Highlight, Prism, themes } from "prism-react-renderer";
import type { Language } from "prism-react-renderer";
import styles from "./index.module.css";

declare const require: (path: string) => unknown;

(globalThis as typeof globalThis & { Prism?: typeof Prism }).Prism = Prism;
require("prismjs/components/prism-bash");

const examples = [
  {
    id: "github-action",
    label: "GitHub Action",
    description: "Release workflow with deploy inputs and runtime files.",
    languageLabel: "yaml",
    highlightLanguage: "yaml",
    code: [
      "uses: BootstrapLaboratory/rush-delivery@v0.9.0",
      "with:",
      '  dry-run: "false"',
      "  toolchain-image-provider: github",
      "  rush-cache-provider: github",
      "  release-targets-json: '[\"npm\"]'",
      "  runtime-file-map: |",
      "    ${{ steps.auth.outputs.credentials_file_path }}=>gcp-credentials.json",
      "  deploy-env: |",
      "    GCP_PROJECT_ID=${{ vars.GCP_PROJECT_ID }}",
      "  release-env: |",
      "    NPM_TOKEN=${{ secrets.NPM_TOKEN }}",
    ].join("\n"),
  },
  {
    id: "dagger-cli",
    label: "Dagger CLI",
    description: "The same module call from a shell or another CI provider.",
    languageLabel: "sh",
    highlightLanguage: "bash",
    code: [
      "dagger -m github.com/BootstrapLaboratory/rush-delivery@v0.9.0 call workflow \\",
      '  --git-sha="${GITHUB_SHA}" \\',
      '  --event-name="${GITHUB_EVENT_NAME}" \\',
      "  --release-targets-json='[\"npm\"]' \\",
      '  --workflow-env-file="${WORKFLOW_ENV_FILE}" \\',
      '  --release-env-file="${RELEASE_ENV_FILE}" \\',
      "  --source-mode=git \\",
      '  --source-repository-url="${SOURCE_REPOSITORY_URL}" \\',
      '  --source-ref="${SOURCE_REF}" \\',
      "  --source-auth-token-env=GITHUB_TOKEN",
    ].join("\n"),
  },
  {
    id: "pr-validation",
    label: "PR Validation",
    description: "Read-only validation that reuses published CI artifacts.",
    languageLabel: "yaml",
    highlightLanguage: "yaml",
    code: [
      "uses: BootstrapLaboratory/rush-delivery@v0.9.0",
      "with:",
      "  entrypoint: validate",
      "  toolchain-image-provider: github",
      "  toolchain-image-policy: pull-or-build",
      "  rush-cache-provider: github",
      "  rush-cache-policy: pull-or-build",
    ].join("\n"),
  },
  {
    id: "project-metadata",
    label: "Project Metadata",
    description:
      "Schema-backed YAML keeps deploy order, runtime inputs, and artifacts with the repo.",
    languageLabel: "yaml",
    highlightLanguage: "yaml",
    code: [
      "# schemas: https://bootstraplaboratory.github.io/rush-delivery/schemas/v0.9.0/",
      "",
      "# .dagger/deploy/services-mesh.yaml",
      "services:",
      "  server: { deploy_after: [] }",
      "  webapp: { deploy_after: [server] }",
      "",
      "# .dagger/deploy/targets/webapp.yaml",
      "name: webapp",
      "deploy_script: deploy/cloudflare-pages/scripts/deploy-webapp.sh",
      "runtime:",
      "  image: node:24-bookworm-slim",
      "  workspace:",
      "    dirs: [apps/webapp/dist, deploy/cloudflare-pages/scripts]",
      "  pass_env:",
      "    - CLOUDFLARE_ACCOUNT_ID",
      "    - CLOUDFLARE_API_TOKEN",
      "    - WEBAPP_URL",
      "  dry_run_defaults:",
      "    WEBAPP_URL: https://webapp.pages.dev",
      "",
      "# .dagger/package/targets/webapp.yaml",
      "name: webapp",
      "artifact: { kind: directory, path: apps/webapp/dist }",
      "build:",
      "  map_env:",
      "    VITE_GRAPHQL_HTTP: WEBAPP_VITE_GRAPHQL_HTTP",
      "    VITE_GRAPHQL_WS: WEBAPP_VITE_GRAPHQL_WS",
      "",
      "# Illustrative OCI alternative: build once, deploy by digest",
      "# artifact:",
      "#   kind: oci_image",
      "#   context: .",
      "#   dockerfile: deploy/images/webapp.Dockerfile",
      "#   image: webapp",
      "#   platform: linux/amd64",
      "#   scan: { fail_on: [high, critical] }",
      "",
      "# .dagger/release/npm.yaml",
      "kind: npm",
      "versioning: { strategy: rush-change-files, target_branch: main }",
      "auth: { kind: token, token_env: NPM_TOKEN }",
      "publish: { registry: https://registry.npmjs.org/, tag: latest }",
    ].join("\n"),
  },
];

const capabilities = [
  {
    title: "Isolated",
    description:
      "Run every stage in an isolated Dagger environment, even locally, with each stage receiving only the secrets it is allowed to use.",
  },
  {
    title: "Portable",
    description:
      "Call the same workflow from local development, other CI providers, or deeper stage-level debugging.",
  },
  {
    title: "Complete",
    description:
      "Manage the full CI cycle from changed-target detection through validation, build, package, release, and deployment.",
  },
];

function HeroDiagram() {
  const diagramSrc = useBaseUrl("/img/rush-delivery-orbital-pipeline.svg");

  return (
    <img
      className={styles.heroDiagram}
      src={diagramSrc}
      alt="Rush plus project metadata flows into Rush Delivery, which connects to planned deploys, PR checks, releases, and versioning."
      decoding="async"
    />
  );
}

function ExampleSwitcher() {
  const [activeId, setActiveId] = useState(examples[0].id);
  const { colorMode } = useColorMode();
  const activeExample =
    examples.find((example) => example.id === activeId) ?? examples[0];
  const highlightTheme = colorMode === "dark" ? themes.oneDark : themes.github;

  function activateExample(index: number) {
    const nextExample = examples[index];
    setActiveId(nextExample.id);
    requestAnimationFrame(() => {
      document.getElementById(`example-tab-${nextExample.id}`)?.focus();
    });
  }

  return (
    <section
      className={styles.exampleSwitcher}
      aria-label="Workflow and metadata examples"
    >
      <div
        className={styles.exampleTabs}
        role="tablist"
        aria-orientation="vertical"
      >
        {examples.map((example, index) => {
          const isActive = example.id === activeExample.id;

          return (
            <button
              key={example.id}
              type="button"
              id={`example-tab-${example.id}`}
              className={clsx(
                styles.exampleTab,
                isActive && styles.exampleTabActive,
              )}
              role="tab"
              aria-selected={isActive}
              aria-controls={`example-panel-${example.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveId(example.id)}
              onKeyDown={(event) => {
                const isForward =
                  event.key === "ArrowDown" || event.key === "ArrowRight";
                const isBackward =
                  event.key === "ArrowUp" || event.key === "ArrowLeft";

                if (!isForward && !isBackward) return;

                event.preventDefault();
                const offset = isForward ? 1 : -1;
                activateExample(
                  (index + offset + examples.length) % examples.length,
                );
              }}
            >
              {example.label}
              <span>{example.description}</span>
            </button>
          );
        })}
      </div>
      <div
        id={`example-panel-${activeExample.id}`}
        className={styles.examplePanel}
        role="tabpanel"
        aria-labelledby={`example-tab-${activeExample.id}`}
      >
        <div className={styles.examplePanelBar}>
          <span />
          <span />
          <span />
          <strong>{activeExample.languageLabel}</strong>
        </div>
        <Highlight
          code={activeExample.code}
          language={activeExample.highlightLanguage as Language}
          theme={highlightTheme}
        >
          {({ className, getLineProps, getTokenProps, style, tokens }) => (
            <pre
              className={clsx(className, styles.exampleCode)}
              style={{ ...style, background: "transparent" }}
            >
              <code>
                {tokens.map((line, lineIndex) => (
                  <span
                    key={lineIndex}
                    {...getLineProps({
                      className: styles.exampleCodeLine,
                      line,
                    })}
                  >
                    {line.map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ))}
                  </span>
                ))}
              </code>
            </pre>
          )}
        </Highlight>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      title="Rush Delivery"
      description="Dagger-powered CI delivery framework for Rush monorepos."
    >
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Dagger module for Rush monorepos</p>
            <Heading as="h1" className={styles.heroTitle}>
              DETECT/
              <wbr />
              BUILD/
              <wbr />
              PACKAGE/
              <wbr />
              DEPLOY/
              <wbr />
              VALIDATE
            </Heading>
            <p className={styles.heroText}>
              A focused CI delivery layer for Rush monorepos. Detect affected
              targets, build, package, and deploy with Dagger while project
              behavior stays in metadata.
            </p>
            <div className={styles.actions}>
              <Link
                className={clsx(styles.button, styles.primary)}
                to="/docs/quick-start/github-actions"
              >
                Quick Start
              </Link>
              <Link
                className={clsx(styles.button, styles.secondary)}
                to="/docs/tutorial"
              >
                Tutorial
              </Link>
            </div>
          </div>
          <HeroDiagram />
        </section>

        <ExampleSwitcher />

        <section className={styles.capabilities}>
          {capabilities.map((capability) => (
            <article key={capability.title}>
              <Heading as="h2">{capability.title}</Heading>
              <p>{capability.description}</p>
            </article>
          ))}
        </section>

        <section
          className={styles.capabilities}
          aria-label="OCI application image resources"
        >
          <article>
            <Heading as="h2">OCI tutorial</Heading>
            <p>
              <Link to="/docs/tutorial/oci-application-images">
                Run the provider-off, publication, inspection, and digest deploy
                path.
              </Link>
            </p>
          </article>
          <article>
            <Heading as="h2">Production guide</Heading>
            <p>
              <Link to="/docs/oci-application-images">
                Review trust boundaries, evidence, failure semantics, and
                rollout.
              </Link>
            </p>
          </article>
          <article>
            <Heading as="h2">Registry recipes</Heading>
            <p>
              <Link to="/docs/oci-registry-recipes">
                Configure permissions, retention, and cleanup for your registry.
              </Link>
            </p>
          </article>
          <article>
            <Heading as="h2">Troubleshooting</Heading>
            <p>
              <Link to="/docs/oci-application-image-troubleshooting">
                Diagnose failures by phase without leaking credentials.
              </Link>
            </p>
          </article>
        </section>
      </main>
    </Layout>
  );
}
