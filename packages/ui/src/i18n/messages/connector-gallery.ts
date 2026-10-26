/**
 * The Add connector gallery (Settings → Connectors): categories, built-in descriptions and the
 * ready-made MCP servers' words. Preset ids match `screens/settings/mcp-presets.ts`;
 * `test/connector-gallery.test.ts` checks every preset has its strings.
 */
export const connectorGallery = {
  "gallery.intro":
    "Pick something to try. Every connector asks before it does anything, and you can remove it any time.",
  "gallery.search": "Search connectors",
  "gallery.noMatch": "Nothing matches. Try another word, or add your own MCP server.",
  "gallery.back": "All connectors",
  "gallery.getKey": "Where to get it.",
  "gallery.keyStaysInVault": "It is kept in your vault, never in the server's settings.",
  "gallery.tryAsking": "Once it is added, try asking:",
  "gallery.custom.desc": "Any MCP server: a command that runs in the sandbox, or a web address.",
  "gallery.badge.builtIn": "Built in",
  "gallery.badge.official": "Official",
  "gallery.badge.community": "Community",
  "gallery.category.popular": "Popular",
  "gallery.category.files": "Files and knowledge",
  "gallery.category.dev": "Dev",
  "gallery.category.productivity": "Productivity",
  "gallery.category.comms": "Messages and email",
  "gallery.category.web": "Web",
  "gallery.category.everyday": "Everyday",
  "gallery.category.finance": "Finance",
  "gallery.category.custom": "Your own",
  "gallery.builtin.google": "Gmail, Google Calendar and Drive.",
  "gallery.builtin.microsoft": "Outlook mail and calendar.",
  "gallery.builtin.imap": "Any mail account that supports IMAP.",
  "gallery.builtin.appleNotes": "Read and add to your notes in Apple Notes.",
  "gallery.builtin.appleReminders": "See and create reminders.",
  "gallery.builtin.appleCalendar": "See your calendar and add events.",
  "gallery.builtin.appleMail": "Read and draft mail in Apple Mail.",
  "gallery.builtin.appleShortcuts": "Run the Shortcuts you choose.",
  "gallery.builtin.obsidian": "Search and read your Obsidian vault.",
  "gallery.builtin.slack": "Chat with Psyche from Slack. Set up in Channels.",
  "gallery.preset.filesystem.desc": "Read and search the files in one folder you choose.",
  "gallery.preset.filesystem.example":
    "Find the PDF about my lease in this folder and summarize it.",
  "gallery.preset.filesystem.field.folder.label": "Folder",
  "gallery.preset.filesystem.field.folder.help":
    "The one folder Psyche may read. It runs in the sandbox, so it can read here but not change anything.",
  "gallery.preset.github.desc": "Browse repositories, issues and pull requests.",
  "gallery.preset.github.example": "What pull requests are waiting for my review?",
  "gallery.preset.github.field.token.label": "Personal access token",
  "gallery.preset.github.field.token.help":
    "A fine-grained token limited to the repositories you want Psyche to see.",
  "gallery.preset.gitlab.desc":
    "Projects, merge requests and issues on GitLab.com. You sign in when it connects.",
  "gallery.preset.gitlab.example": "Summarize the open merge requests in my main project.",
  "gallery.preset.git.desc": "Read the history, branches and diffs of one local repository.",
  "gallery.preset.git.example": "What changed in this repository over the last week?",
  "gallery.preset.git.field.repo.label": "Repository folder",
  "gallery.preset.git.field.repo.help":
    "The folder of a Git repository on this Mac. Psyche can read its history and diffs.",
  "gallery.preset.sentry.desc":
    "Look into errors and issues in your Sentry projects. You sign in when it connects.",
  "gallery.preset.sentry.example": "What are the most frequent unresolved errors this week?",
  "gallery.preset.linear.desc":
    "Find and update issues and projects. You sign in when it connects.",
  "gallery.preset.linear.example": "Which issues are assigned to me and due this week?",
  "gallery.preset.jira.desc":
    "Search Jira issues and Confluence pages. You sign in when it connects.",
  "gallery.preset.jira.example": "Show the Jira tickets I updated yesterday.",
  "gallery.preset.notion.desc":
    "Search, read and edit pages in your Notion workspace. You sign in when it connects.",
  "gallery.preset.notion.example": "Find my meeting notes from last Tuesday in Notion.",
  "gallery.preset.todoist.desc":
    "See and manage your Todoist tasks and projects. You sign in when it connects.",
  "gallery.preset.todoist.example": "What is due today in Todoist?",
  "gallery.preset.airtable.desc": "Read and update the records in your Airtable bases.",
  "gallery.preset.airtable.example":
    "List the records in my Projects base that are marked blocked.",
  "gallery.preset.airtable.field.key.label": "Personal access token",
  "gallery.preset.airtable.field.key.help":
    "Create a token that can read the bases you want to use.",
  "gallery.preset.fetch.desc": "Fetch a web page and read it as plain text.",
  "gallery.preset.fetch.example": "Read this page and give me the three key points.",
  "gallery.preset.fetch.field.sites.label": "Websites it may reach",
  "gallery.preset.fetch.field.sites.help":
    "Comma-separated host names, such as en.wikipedia.org. Leave empty and it can only reach the package registry.",
  "gallery.preset.braveSearch.desc": "Search the web, news and images with Brave.",
  "gallery.preset.braveSearch.example": "Search for this week's news about open-source AI models.",
  "gallery.preset.braveSearch.field.key.label": "API key",
  "gallery.preset.braveSearch.field.key.help": "The free plan is enough to try it.",
  "gallery.preset.playwright.desc": "Drive a separate browser to read pages and fill forms.",
  "gallery.preset.playwright.example": "Open example.com and tell me what the page says.",
  "gallery.preset.playwright.field.sites.label": "Websites it may reach",
  "gallery.preset.playwright.field.sites.help":
    "Comma-separated host names it may open. Leave empty to keep it offline.",
  "gallery.preset.firecrawl.desc": "Scrape and crawl websites into clean text.",
  "gallery.preset.firecrawl.example":
    "Crawl the docs site at example.com and summarize the main sections.",
  "gallery.preset.firecrawl.field.key.label": "API key",
  "gallery.preset.firecrawl.field.key.help": "Used to scrape and crawl sites for you.",
  "gallery.preset.time.desc": "Get the current time and convert between time zones.",
  "gallery.preset.time.example": "What time is it in Tokyo when it is 9am in San Francisco?",
  "gallery.preset.homeAssistant.desc": "See and control the devices you expose in Home Assistant.",
  "gallery.preset.homeAssistant.example": "Which lights are on right now?",
  "gallery.preset.homeAssistant.field.url.label": "Server address",
  "gallery.preset.homeAssistant.field.url.help":
    "Turn on the Model Context Protocol Server integration, then copy its address from Settings, System, AI. It must start with https://.",
  "gallery.preset.stripe.desc":
    "Look up customers, payments and balances. Read only, set by your restricted key.",
  "gallery.preset.stripe.example": "How much did I charge in the last 30 days?",
  "gallery.preset.stripe.field.key.label": "Restricted key",
  "gallery.preset.stripe.field.key.help":
    "Create a restricted key (it starts with rk_) with Read permission only. Other keys are refused here.",
};
