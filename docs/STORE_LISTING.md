# Chrome Web Store Listing — Sidefold 1.2.0+

This file contains the updated description and permission justifications for the Chrome Web Store listing.

---

## Store Description (Short)

**Sidefold** — Organize Subscriptions for YouTube™

---

## Store Description (Long)

Sidefold helps you organize your YouTube subscriptions into custom categories. Create folders like "Technology," "Gaming," "Music," and filter your feed to watch only what you care about right now.

### Features
- **Categories**: Create and name custom categories for your subscriptions.
- **Drag to organize**: Reorder categories on the sidebar.
- **Color-coded**: Each category gets a unique color for quick recognition.
- **Filter your feed**: Click a category in the sidebar to see only those subscriptions.
- **Multiple devices**: Categories and assignments sync across your devices using your Google account (optional, offline-first).
- **Export/Import**: Backup and restore your categories anytime.

### Privacy
Sidefold respects your privacy:
- **No tracking** — We don't track your viewing habits.
- **Local storage** — Your categories and assignments are stored locally on your device.
- **Optional cloud sync** (v1.2.0+) — Sign in with Google to sync across devices. Only your email and category data are sent to our server (Supabase); they're never sold or shared. You can disable sync anytime.
- **Read policy**: https://victorcouce.github.io/Sidefold/privacy

Made for the community. Open source: https://github.com/victorcouce/Sidefold

---

## Permissions Justification

When you install Sidefold, Chrome may ask for the following permissions:

### `storage` and `unlimitedStorage`
**Why**: To store your categories, channel assignments, and settings locally so they persist across sessions and devices. The data never leaves your device unless you enable cloud sync.

### `identity` (NEW in v1.2.0)
**Why**: To sign you in with your Google account for cloud synchronization. Sidefold uses `chrome.identity.launchWebAuthFlow` to authenticate you with Supabase Auth. Your Google email is used as your account ID; no other Google data is accessed.

### Access to `https://*.supabase.co/*` (NEW in v1.2.0)
**Why**: To sync your categories and assignments with our cloud backend (Supabase) when you're signed in. This is only active if you enable cloud sync. All data is encrypted in transit (HTTPS) and protected by row-level security policies — only you can access your own data.

### Access to `https://www.youtube.com/*`
**Why**: To inject the sidebar into YouTube pages, read your subscriptions, and detect which videos you're watching. This allows Sidefold to show categories in the sidebar, filter your feed, and label videos with their assigned categories.

---

## Data Usage Declaration (Chrome Web Store)

### Collected Data
- **Authentication info**: Google email and unique ID (only when cloud sync is enabled)
- **User-generated content**: Your custom categories and channel assignments (stored locally; sent to server only if cloud sync is enabled)

### Data Usage
- **Not sold**: Your data is never sold to third parties.
- **Not used for unrelated purposes**: Your data is used only to sync your preferences across devices (if enabled) and to improve Sidefold.
- **Retention**: Your categories are stored as long as you use Sidefold. You can delete your cloud data by signing out; local data remains until you uninstall the extension.
- **Optional feature**: Cloud sync is optional. You can use Sidefold entirely offline without creating an account.

---

## Category
- **Category**: Productivity

---

## Language
- **Primary language**: English
- **Additional languages**: Spanish, Arabic, Hindi, Indonesian, Portuguese (Brazil), Chinese (Simplified)

---

## Changelog Snippet for Store
**Version 1.2.0**
- Added optional cloud synchronization with Google Sign-In (Supabase backend)
- Categories and assignments now sync across devices and browsers
- Added account section to popup
- Updated privacy policy to reflect cloud sync option
- Performance improvements and bug fixes

---

## Notes
- The extension is open source: https://github.com/victorcouce/Sidefold
- Report issues: https://github.com/victorcouce/Sidefold/issues
- Privacy policy: https://victorcouce.github.io/Sidefold/privacy
- Contact: victor.couce@gmail.com
