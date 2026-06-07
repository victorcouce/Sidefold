# Changelog

All notable changes to this project will be documented in this file.

## [1.2.2] - 2026-06-07

### Fixed
- **Account detection picking the wrong channel** — The DOM fallback in `account.js` could grab the channel of the page's *content* (e.g. a creator like LaVanguardia you were viewing) instead of your own logged-in channel. This scoped storage to a phantom account and showed empty categories. Detection now only accepts canonical `UC…` channel IDs and, when falling back to the DOM, reads exclusively the real account avatar in the masthead.
- **Stale cached account ID** — `loadAccountId()` (used by the panel and popup) now ignores previously cached non-canonical IDs.

### Technical
- Added `isCanonicalChannelId()` validation in `account.js`.
- Added `test-account.js` covering account detection (run with `node test-account.js`).

## [1.2.1] - 2026-06-06

### Fixed
- **Cloud sync data loss** — `pull()`/`push()` now bypass `storage.js` account scoping to prevent categories/assignments from being written under the wrong key during sync.

## [1.2.0] - 2026-06-06

### Added
- **☁️ Cloud sync (optional)** — Sign in with Google to sync your categories and assignments across devices automatically (offline-first, powered by Supabase).
- **Google OAuth authentication** via `chrome.identity.launchWebAuthFlow`.
- **Account section in popup** — Sign in/out button, sync status, and manual sync trigger.
- **Automatic sync on navigation** — Content script triggers sync when you navigate YouTube if a session is active.
- **Debounced sync push** — Changes are batched and sent to the server with a 2-second delay.
- **Last-write-wins conflict resolution** — Timestamps determine which version wins when editing on multiple devices.

### Changed
- **Storage enhanced** — All keys are now scoped by YouTube account ID for multi-channel support.
- **Manifest version bumped** to 1.2.0.
- **Permissions updated** — Added `identity` and `*.supabase.co` host permissions (cloud sync is optional, so these don't affect offline-only users).
- **Internationalization** — Added new UI strings in all 7 languages (en, es, ar, hi, id, pt_BR, zh_CN) for account section and sync features.

### Technical
- New modules: `config.js`, `auth.js`, `sync.js` for cloud integration.
- Storage now tracks `__local_updated_at__` per account for conflict resolution.
- Added `debounce()` utility in `utils.js`.
- Enhanced `content.js` to trigger sync on page load and navigation.

### Documentation
- **`docs/BACKEND_SETUP.md`** — Complete runbook for setting up Supabase and Google OAuth (manual steps for the user).
- **`docs/STORE_LISTING.md`** — Chrome Web Store description and data usage declaration.
- **Privacy policy updated** — Now documents cloud sync, data storage on Supabase, and optional sign-in.
- **README updated** — Explains cloud sync features and links to setup guide.
- **CLAUDE.md updated** — Documents new modules and offline-first sync architecture.

### Notes
- Cloud sync is 100% optional. The extension works offline without an account.
- Only email and category data are sent to the server; never watch history or viewing habits.
- Self-hosters can deploy their own Supabase project and modify `config.js` as needed.

## [1.1.0] - 2026-05-31

### Changed
- **Storage migrated** from `chrome.storage.sync` to `chrome.storage.local` with `unlimitedStorage` permission. Removes the 100KB / 512-item limit that affected users with 200+ channels.

### Added
- **Export backup** button in Organize Subscriptions panel — download all data as a JSON file.
- **Import backup** button in Organize Subscriptions panel — restore from exported JSON with "Replace all" or "Merge" modes.
- One-time automatic migration of existing data from sync storage; no user action required.
- Schema versioning (`__schema_version__`) for future migrations without data loss.

### Notes
- Cross-device sync via Chrome profile is paused; use Export/Import to move data between devices for now. Dedicated sync solution planned for Premium tier.
- `chrome.storage.sync` is not cleared automatically in this release as a safety measure; it can be cleaned in v1.2.0+ after confirming stability.

## [1.0.0] - 2026-05-23

### Initial Release
- Inject category sidebar into YouTube's subscriptions feed.
- Organize subscriptions into categories with colors.
- Drag-to-reorder categories.
- View subscriptions by category.
- Search and filter channels.
