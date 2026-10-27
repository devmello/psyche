import { defineConfig } from "vitepress";

const repo = "https://github.com/devmello/psyche";

const page = (text: string, link: string) => ({ text, link });

export default defineConfig({
  title: "Psyche",
  description: "An open-source, self-hosted personal AI agent for your Mac and your own server.",
  lang: "en-US",
  // Published as a GitHub Pages project site: https://devmello.github.io/psyche/
  base: "/psyche/",
  cleanUrls: true,
  lastUpdated: false,
  // Dead links between site pages fail the build (`pnpm docs:check` adds the repository links).
  ignoreDeadLinks: false,
  srcExclude: ["**/node_modules/**", "scripts/**"],
  head: [["meta", { name: "color-scheme", content: "light dark" }]],
  markdown: {
    // Inline code is not compiled as a Vue template, so placeholders such as `{{cred:slug}}`
    // show as written (fenced blocks are already `v-pre`).
    config(md) {
      const render = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const html = render?.(tokens, idx, options, env, self) ?? "";
        return html.replace(/^<code/, "<code v-pre");
      };
      // Prose and tables are not Vue templates either: a literal `{{cred:slug}}` outside code
      // broke the site build twice (#745). Entity-escaped braces render the same.
      const text = md.renderer.rules.text;
      md.renderer.rules.text = (tokens, idx, options, env, self) =>
        (text?.(tokens, idx, options, env, self) ?? md.utils.escapeHtml(tokens[idx]?.content ?? ""))
          .replaceAll("{{", "&#123;&#123;")
          .replaceAll("}}", "&#125;&#125;");
    },
  },
  themeConfig: {
    nav: [
      page("Get started", "/get-started/"),
      page("Using Psyche", "/using/"),
      page("Security", "/security/"),
      page("Reference", "/reference/"),
      page("Guides", "/guides/"),
      page("Contributing", "/contributing/"),
      page("Release notes", "/release-notes/"),
    ],
    sidebar: [
      {
        text: "Get started",
        items: [
          page("Overview", "/get-started/"),
          page("The Mac app (DMG)", "/get-started/mac-app"),
          page("Docker and Compose", "/get-started/docker"),
          page("Server mode", "/get-started/server-mode"),
        ],
      },
      {
        text: "Using Psyche",
        collapsed: false,
        items: [
          page("Overview", "/using/"),
          page("Chat", "/using/chat"),
          page("Memory and persona", "/using/memory"),
          page("Tasks and automations", "/using/tasks-and-automations"),
          page("Feed, Ideas and Goals", "/using/feed-ideas-goals"),
          page("Documents and Files", "/using/documents-and-files"),
          page("The agent browser", "/using/browser"),
          page("Connectors", "/using/connectors"),
          page("Channels", "/using/channels"),
          page("Computer use", "/using/computer-use"),
          page("Dictation", "/using/dictation"),
          page("Skills", "/using/skills"),
          page("Credentials and payments", "/using/credentials-and-payments"),
          page("VM mode", "/using/vm-mode"),
          page("The coding helper", "/using/coding"),
        ],
      },
      {
        text: "Security for owners",
        collapsed: false,
        items: [
          page("Overview", "/security/"),
          page("The permission model", "/security/permissions"),
          page("Approvals and app tiers", "/security/approvals-and-tiers"),
          page("Untrusted content and taint", "/security/taint"),
          page("What stays on your device", "/security/on-device"),
          page("The audit log", "/security/audit-log"),
          page("Backups", "/security/backups"),
          page("Key storage", "/security/key-storage"),
        ],
      },
      {
        text: "Reference",
        collapsed: true,
        items: [
          page("Overview", "/reference/"),
          page("CLI commands", "/reference/cli"),
          page("Settings keys", "/reference/settings"),
          page("Protocol", "/reference/protocol"),
        ],
      },
      {
        text: "Guides",
        collapsed: true,
        items: [
          page("All guides", "/guides/"),
          page("Install", "/guides/install"),
          page("Getting started from source", "/guides/getting-started"),
          page("Approvals", "/guides/approvals"),
          page("Memory and persona", "/guides/memory-and-persona"),
          page("Connectors", "/guides/connectors"),
          page("Server mode", "/guides/server-mode"),
          page("Backup and restore", "/guides/backup-restore"),
          page("Migrate", "/guides/migrate"),
          page("Upgrade", "/guides/upgrade"),
        ],
      },
      {
        text: "Contributing",
        collapsed: true,
        items: [
          page("How to contribute", "/contributing/"),
          page("Architecture", "/contributing/architecture"),
          page("Pull requests and merging", "/contributing/pull-requests"),
        ],
      },
      {
        text: "Release notes",
        collapsed: true,
        items: [
          page("All releases", "/release-notes/"),
          page("0.3 (alpha)", "/release-notes/0.3"),
          page("0.2 (alpha)", "/release-notes/0.2"),
          page("0.1 (alpha)", "/release-notes/0.1"),
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/apps/site/:path`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: `Apache-2.0. Report vulnerabilities privately: <a href="${repo}/blob/main/SECURITY.md">security policy</a>.`,
    },
    outline: [2, 3],
  },
});
