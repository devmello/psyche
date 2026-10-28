/**
 * Ready-made MCP servers: the Add connector gallery (`packages/ui`, its words are
 * `gallery.preset.<id>.*` in the UI catalogue) and the Gateway's capability catalogue both read
 * this list. Real servers only: the vendor's own remote URL, or an official or widely used
 * package. Adding a preset is one entry here plus its gallery strings.
 */

export type PresetCategory =
  | "files"
  | "dev"
  | "productivity"
  | "comms"
  | "web"
  | "everyday"
  | "finance";

/** A value the owner gives: a key (kept in the vault), or plain text such as a folder. */
export interface PresetField {
  id: string;
  kind: "secret" | "text";
  /** stdio: set as this environment variable (a secret goes in as a vault placeholder). */
  env?: string;
  /** Replaces `{id}` in the command's arguments, or in the server's address. */
  arg?: true;
  /** Host names the owner lists (comma-separated): the sandbox may reach them. */
  domains?: true;
  /** A key must start with this (Stripe's `rk_`: a restricted key, so the server stays read only). */
  prefix?: string;
  /** Where to get the key; shown as a link. */
  helpUrl?: string;
  placeholder?: string;
  optional?: true;
}

export type PresetIcon =
  | "folder"
  | "database"
  | "brain"
  | "git"
  | "bug"
  | "tasks"
  | "doc"
  | "cloud"
  | "globe"
  | "search"
  | "browser"
  | "weather"
  | "clock"
  | "map"
  | "music"
  | "home"
  | "card"
  | "chat"
  | "table";

export type PresetTransport =
  | { kind: "stdio"; command: readonly string[]; domains?: readonly string[] }
  | { kind: "http"; url: string; auth: "oauth" | "bearer" | "none" };

export interface McpPreset {
  /** The server id: tools register as `mcp__<id>__<tool>`. */
  id: string;
  label: string;
  /** One English line for the agent's capability catalogue (the gallery shows its own words). */
  summary: string;
  /** Extra words the catalogue search matches. */
  keywords: string;
  category: PresetCategory;
  icon: PresetIcon;
  /** The vendor's own server (shown as Official), or a community one. */
  official: boolean;
  popular?: true;
  transport: PresetTransport;
  fields: readonly PresetField[];
  docsUrl: string;
}

const NPM = ["registry.npmjs.org"] as const;
const PYPI = ["pypi.org", "files.pythonhosted.org"] as const;

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "filesystem",
    summary: "Read and search the files in one folder.",
    keywords: "files folder documents disk local",
    label: "Files on this Mac",
    category: "files",
    icon: "folder",
    official: true,
    popular: true,
    transport: {
      kind: "stdio",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "{folder}"],
      domains: [...NPM],
    },
    fields: [{ id: "folder", kind: "text", arg: true, placeholder: "/Users/you/Documents" }],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "github",
    summary: "Browse GitHub repositories, issues and pull requests.",
    keywords: "code git repo pr review",
    label: "GitHub",
    category: "dev",
    icon: "git",
    official: true,
    popular: true,
    transport: { kind: "http", url: "https://api.githubcopilot.com/mcp/", auth: "bearer" },
    fields: [
      {
        id: "token",
        kind: "secret",
        helpUrl: "https://github.com/settings/personal-access-tokens/new",
      },
    ],
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "gitlab",
    summary: "Projects, merge requests and issues on GitLab.com.",
    keywords: "code git repo mr review",
    label: "GitLab",
    category: "dev",
    icon: "git",
    official: true,
    transport: { kind: "http", url: "https://gitlab.com/api/v4/mcp", auth: "oauth" },
    fields: [],
    docsUrl: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
  },
  {
    id: "git",
    summary: "Read the history, branches and diffs of one local git repository.",
    keywords: "code commits log diff",
    label: "Git (local repository)",
    category: "dev",
    icon: "git",
    official: true,
    transport: {
      kind: "stdio",
      command: ["uvx", "mcp-server-git", "--repository", "{repo}"],
      domains: [...PYPI],
    },
    fields: [{ id: "repo", kind: "text", arg: true, placeholder: "/Users/you/Projects/app" }],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "sentry",
    summary: "Look into errors and issues in Sentry projects.",
    keywords: "crash bugs monitoring exceptions",
    label: "Sentry",
    category: "dev",
    icon: "bug",
    official: true,
    transport: { kind: "http", url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
    fields: [],
    docsUrl: "https://github.com/getsentry/sentry-mcp",
  },
  {
    id: "linear",
    summary: "Find and update Linear issues and projects.",
    keywords: "tickets tasks bugs project management",
    label: "Linear",
    category: "dev",
    icon: "tasks",
    official: true,
    popular: true,
    transport: { kind: "http", url: "https://mcp.linear.app/mcp", auth: "oauth" },
    fields: [],
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "jira",
    summary: "Search Jira issues and Confluence pages.",
    keywords: "atlassian tickets wiki docs",
    label: "Jira and Confluence",
    category: "dev",
    icon: "tasks",
    official: true,
    transport: { kind: "http", url: "https://mcp.atlassian.com/v2/mcp", auth: "oauth" },
    fields: [],
    docsUrl:
      "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/",
  },
  {
    id: "notion",
    summary: "Search, read and edit pages in a Notion workspace.",
    keywords: "notes docs wiki pages database",
    label: "Notion",
    category: "productivity",
    icon: "doc",
    official: true,
    popular: true,
    transport: { kind: "http", url: "https://mcp.notion.com/mcp", auth: "oauth" },
    fields: [],
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    id: "todoist",
    summary: "See and manage Todoist tasks and projects.",
    keywords: "todo tasks reminders lists",
    label: "Todoist",
    category: "productivity",
    icon: "tasks",
    official: true,
    transport: { kind: "http", url: "https://ai.todoist.net/mcp", auth: "oauth" },
    fields: [],
    docsUrl: "https://developer.todoist.com/",
  },
  {
    id: "airtable",
    summary: "Read and update records in Airtable bases.",
    keywords: "database spreadsheet table records",
    label: "Airtable",
    category: "productivity",
    icon: "table",
    official: false,
    transport: {
      kind: "stdio",
      command: ["npx", "-y", "airtable-mcp-server"],
      domains: [...NPM, "api.airtable.com"],
    },
    fields: [
      {
        id: "key",
        kind: "secret",
        env: "AIRTABLE_API_KEY",
        helpUrl: "https://airtable.com/create/tokens/new",
      },
    ],
    docsUrl: "https://github.com/domdomegg/airtable-mcp-server",
  },
  {
    id: "fetch",
    summary: "Fetch a web page and read it as plain text.",
    keywords: "web url http download page",
    label: "Web pages",
    category: "web",
    icon: "globe",
    official: true,
    popular: true,
    transport: { kind: "stdio", command: ["uvx", "mcp-server-fetch"], domains: [...PYPI] },
    fields: [
      {
        id: "sites",
        kind: "text",
        domains: true,
        optional: true,
        placeholder: "en.wikipedia.org, news.ycombinator.com",
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "brave-search",
    summary: "Search the web, news and images with Brave.",
    keywords: "web search news images",
    label: "Brave Search",
    category: "web",
    icon: "search",
    official: true,
    popular: true,
    transport: {
      kind: "stdio",
      command: ["npx", "-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
      domains: [...NPM, "api.search.brave.com"],
    },
    fields: [
      {
        id: "key",
        kind: "secret",
        env: "BRAVE_API_KEY",
        helpUrl: "https://api-dashboard.search.brave.com/app/keys",
      },
    ],
    docsUrl: "https://github.com/brave/brave-search-mcp-server",
  },
  {
    id: "playwright",
    summary: "Drive a separate browser to read pages and fill forms.",
    keywords: "browser web automation forms scrape",
    label: "Playwright browser",
    category: "web",
    icon: "browser",
    official: true,
    transport: { kind: "stdio", command: ["npx", "@playwright/mcp@latest"], domains: [...NPM] },
    fields: [
      { id: "sites", kind: "text", domains: true, optional: true, placeholder: "example.com" },
    ],
    docsUrl: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "firecrawl",
    summary: "Scrape and crawl websites into clean text.",
    keywords: "web scrape crawl extract",
    label: "Firecrawl",
    category: "web",
    icon: "globe",
    official: true,
    transport: { kind: "http", url: "https://mcp.firecrawl.dev/v2/mcp", auth: "bearer" },
    fields: [{ id: "key", kind: "secret", helpUrl: "https://www.firecrawl.dev/app/api-keys" }],
    docsUrl: "https://github.com/firecrawl/firecrawl-mcp-server",
  },
  {
    id: "time",
    summary: "Get the current time and convert between time zones.",
    keywords: "clock timezone date",
    label: "Time and time zones",
    category: "everyday",
    icon: "clock",
    official: true,
    transport: { kind: "stdio", command: ["uvx", "mcp-server-time"], domains: [...PYPI] },
    fields: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "home-assistant",
    summary: "See and control devices exposed in Home Assistant.",
    keywords: "smart home lights thermostat iot",
    label: "Home Assistant",
    category: "everyday",
    icon: "home",
    official: true,
    transport: { kind: "http", url: "{url}", auth: "oauth" },
    fields: [
      { id: "url", kind: "text", arg: true, placeholder: "https://home.example.com/api/mcp" },
    ],
    docsUrl: "https://www.home-assistant.io/integrations/mcp_server",
  },
  {
    id: "stripe",
    summary: "Look up Stripe customers, payments and balances (read only).",
    keywords: "payments billing invoices finance",
    label: "Stripe (read only)",
    category: "finance",
    icon: "card",
    official: true,
    transport: {
      kind: "stdio",
      command: ["npx", "-y", "@stripe/mcp"],
      domains: [...NPM, "api.stripe.com"],
    },
    fields: [
      {
        id: "key",
        kind: "secret",
        env: "STRIPE_SECRET_KEY",
        prefix: "rk_",
        helpUrl: "https://docs.stripe.com/keys/restricted-api-keys",
      },
    ],
    docsUrl: "https://github.com/stripe/ai/tree/main/tools/modelcontextprotocol",
  },
];
