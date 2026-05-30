# Changelog

All notable changes to this project will be documented in this file.

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
