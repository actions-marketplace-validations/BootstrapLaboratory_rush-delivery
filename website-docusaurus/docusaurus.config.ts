import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes as prismThemes } from "prism-react-renderer";

const repository =
  process.env.GITHUB_REPOSITORY ?? "BootstrapLaboratory/rush-delivery";
const repositoryName = repository.split("/").at(-1) ?? "rush-delivery";
const isProjectPages = repositoryName !== "bootstraplaboratory.github.io";
const baseUrl =
  process.env.PAGES_BASE_PATH ?? (isProjectPages ? `/${repositoryName}/` : "/");
const url =
  process.env.PAGES_SITE_URL ?? "https://bootstraplaboratory.github.io";
const currentDocsVersion = "v0.9.0";
const archivedDocsVersions = [
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

const config: Config = {
  title: "Rush Delivery",
  tagline: "Dagger-powered CI delivery for Rush monorepos.",
  favicon: "img/favicon.svg",

  url,
  baseUrl,
  organizationName: "BootstrapLaboratory",
  projectName: "rush-delivery",
  trailingSlash: true,

  future: {
    v4: true,
    faster: true,
  },

  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          path: "docs",
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
          lastVersion: "current",
          versions: {
            current: {
              label: currentDocsVersion,
              path: "",
              banner: "none",
              badge: false,
            },
            ...Object.fromEntries(
              archivedDocsVersions.map((version) => [
                version,
                {
                  label: version,
                  banner: "unmaintained",
                },
              ]),
            ),
          },
          editUrl:
            "https://github.com/BootstrapLaboratory/rush-delivery/edit/main/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/rush-delivery-card.svg",
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: "Rush Delivery",
      logo: {
        alt: "Rush Delivery",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docsSidebar",
          position: "left",
          label: "Docs",
        },
        {
          type: "docSidebar",
          sidebarId: "quickStartSidebar",
          label: "Quick Start",
          position: "left",
        },
        {
          type: "docSidebar",
          sidebarId: "tutorialSidebar",
          label: "Tutorial",
          position: "left",
        },
        {
          type: "docsVersionDropdown",
          label: currentDocsVersion,
          position: "right",
        },
        {
          href: "https://github.com/BootstrapLaboratory/rush-delivery",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Quick Start",
              to: "/docs/quick-start/github-actions",
            },
            {
              label: "Tutorial",
              to: "/docs/tutorial",
            },
            {
              label: "Metadata",
              to: "/docs/metadata",
            },
          ],
        },
        {
          title: "Project",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/BootstrapLaboratory/rush-delivery",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Bootstrap Laboratory.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
