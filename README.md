# Sidefold

Organize Subscriptions for YouTube™.

Sidefold is a Chrome extension (Manifest V3) that organizes your YouTube subscriptions into custom folders, directly in the sidebar.

## ✨ Features

- **Category sidebar** — folder-based sidebar injected into YouTube, grouping your subscribed channels by category
- **Bulk organizer panel** — floating modal with all your subscribed channels for quick assignment to folders
- **Category filter** — click a folder to see only the channels in that category, on `/feed/subscriptions`
- **Live search** — filter channels by name in real time, combinable with the category filter
- **Sort** — by most recent activity or alphabetically A→Z
- **Create & delete folders** — directly from the panel or popup, with a custom name and color
- **Bulk assign** — multi-select mode to assign multiple channels to a category at once
- **Open channel** — click a channel card to open it in a new tab
- **Dark mode** — fully compatible with YouTube's dark theme
- **Backup & restore** — export your folders and assignments to a JSON file, import on another device or browser profile
- **☁️ Cloud sync** (v1.2.0+) — optional: sign in with Google to sync your categories across devices automatically (offline-first)

## 🚀 Installation (developer mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Navigate to [youtube.com](https://www.youtube.com) — the sidebar and organizer button will appear automatically

## 🗂 Project structure

```
├── manifest.json
├── assets/
│   ├── icons/              # Extension icons (16, 32, 48, 128 px)
│   └── fonts/              # Roboto font (self-hosted)
├── _locales/               # i18n message files (en, es, ar, hi, id, pt_BR, zh_CN)
├── docs/
│   ├── privacy.html        # Privacy policy (served via GitHub Pages)
│   ├── BACKEND_SETUP.md    # Manual setup for cloud sync (Supabase + Google OAuth)
│   └── STORE_LISTING.md    # Chrome Web Store description
├── supabase/
│   └── schema.sql          # Database schema for cloud sync
└── src/
    ├── background/
    │   └── background.js   # Service worker — message relay
    ├── content/
    │   ├── content.js      # Orchestrator: SPA navigation, MutationObserver, injection
    │   ├── sidebar.js      # Category accordion sidebar injected into YouTube
    │   ├── sidebar.css
    │   ├── subscriptions-filter.js  # Category navbar on /feed/subscriptions
    │   └── video-label.js  # Categorize button on watch/channel pages
    ├── panel/
    │   ├── panel.js        # Content script bridge: fetches subscriptions, mounts iframe
    │   ├── panel-ui.js     # Panel UI rendered inside the iframe
    │   ├── panel.html
    │   └── panel.css
    ├── popup/
    │   ├── popup.html
    │   ├── popup.js
    │   └── popup.css
    └── shared/
        ├── account.js      # YouTube account detection (scoped storage)
        ├── config.js       # Supabase & Google OAuth configuration (fill after setup)
        ├── auth.js         # Google sign-in via Supabase Auth
        ├── sync.js         # Offline-first cloud sync with Supabase
        ├── i18n.js         # chrome.i18n wrapper + data-i18n attribute resolver
        ├── storage.js      # chrome.storage abstraction with in-memory cache
        └── utils.js        # Shared utilities (including debounce)
```

## 🔧 Permissions

| Permission | Reason |
|---|---|
| `storage` | Save folders, channel assignments and settings to local storage |
| `unlimitedStorage` | Support users with 200+ channels (removes 100KB sync limit) |
| `identity` | (v1.2.0+) Sign in with Google for cloud sync (optional) |
| `host_permissions: youtube.com` | Inject the sidebar and panel into YouTube pages |
| `host_permissions: supabase.co` | (v1.2.0+) Connect to Supabase for cloud sync (optional) |

No history, cookies, or YouTube viewing data is requested. Cloud sync features are completely optional.

## 💾 Backups

You can export all your folders and assignments to a JSON file, then import them on another device or browser profile:

1. Open the **Organize Subscriptions** panel (click the Sidefold icon)
2. Click **Export backup** → a JSON file downloads to your computer
3. On another device: open the panel and click **Import backup** → select the JSON file
4. Choose "Replace all" or "Merge" to combine with existing data

The backup is compatible across devices and can be kept as a safety copy.

## 🛠 Development

Files are loaded directly as content scripts — no bundler required. After any JS/CSS change, reload the extension card at `chrome://extensions`, then hard-reload the YouTube tab (`Cmd+Shift+R`).

**Validate JS syntax:**

```bash
node --check src/content/content.js
node --check src/content/sidebar.js
node --check src/panel/panel.js
node --check src/shared/storage.js
node --check src/shared/i18n.js
```

## 📝 Technical notes

- **Subscription fetching** — subscriptions are retrieved via `fetch('/feed/channels')`, parsing the `ytInitialData` JSON embedded in the page HTML. This avoids fragile DOM scraping and returns the full list reliably. Falls back to DOM scraping and a local cache if the fetch fails.
- **YouTube SPA navigation** — YouTube never does full page loads. `content.js` listens to `yt-navigate-finish` to reset injection state and re-inject after each navigation.
- **MutationObserver fallback** — if YouTube re-renders its sidebar and removes `#ycsm-sidebar`, the observer triggers re-injection automatically.
- **In-memory cache** — `storage.js` keeps a module-level `_memCache` to avoid repeated reads to `chrome.storage` on every sidebar render.
- **Account-scoped storage** — `account.js` detects the active YouTube channel ID and `storage.js` scopes all keys by channel (format: `account:<channelId>:<key>`). This allows multi-channel users to have separate categories per channel.
- **Canonical channel IDs** — legacy IDs like `/@handle` are automatically migrated to canonical `UCxxxxx` IDs when the panel opens.
- **Local storage with unlimited quota** — categories and assignments are stored in `chrome.storage.local` with `unlimitedStorage` permission, supporting users with 200+ channels. The subscription list cache also uses `chrome.storage.local`.
- **Offline-first sync** — `sync.js` implements pull/push/sync with last-write-wins conflict resolution using `updated_at` timestamps. All changes are made locally first; sync happens in the background via a debounced push (2s delay) when the user makes changes and a session is active.
- **MV3 context guards** — all `chrome.storage` and `chrome.identity` calls are wrapped with `isContextValid()` checks to avoid "Extension context invalidated" errors when the service worker wakes up.

## 🔒 Privacy

**By default:** This extension collects no personal data. All information (folders and assignments) is stored locally on your device via `chrome.storage.local`. To move data between devices, use the Export/Import backup feature.

**With cloud sync (optional, v1.2.0+):** You can optionally sign in with Google to sync your categories and assignments across devices. When enabled, only your Google email and category data are sent to Supabase (our cloud backend). No viewing history, no analytics, no tracking. You can disable sync anytime.

Full privacy policy: **[Privacy policy](https://victorcouce.github.io/Sidefold/privacy)**

## ☁️ Cloud Sync Setup (Optional)

To enable cloud synchronization, follow the backend setup guide:

**[Cloud Sync Setup Guide](./docs/BACKEND_SETUP.md)**

This involves creating a Supabase project and Google OAuth credentials (manual steps). The extension code is pre-configured; you just need to fill in a few configuration values in `src/shared/config.js` after setup.

## 📄 License

MIT
