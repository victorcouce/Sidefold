# Sidefold Cloud Sync — Backend Setup Guide

This guide covers the manual setup steps needed to enable cloud synchronization in Sidefold using Supabase and Google OAuth. The extension code is already prepared; you just need to create the cloud resources and fill in a few configuration values.

## Overview

Sidefold 1.2.0+ supports optional cloud sync:
- Your categories and channel assignments sync automatically across devices
- Login with your Google account (same one as your YouTube channel)
- Offline-first: the extension works without internet; sync happens in the background when available
- No data collection: only your email and categories are stored; sync is optional

---

## Phase 1: Create a Supabase Project

1. Go to **https://supabase.com** and sign up or log in.
2. Click **New Project**.
3. Fill in:
   - **Name**: e.g., "Sidefold"
   - **Database password**: Save this securely (you won't need it after setup)
   - **Region**: Choose one close to you (e.g., `eu-west` for Europe)
4. Click **Create new project** and wait 1–2 minutes for provisioning.

### Get Your API Keys

1. In the Supabase dashboard, go to **Project Settings → API** (left sidebar).
2. Copy and save:
   - **Project URL** (e.g., `https://xyz123abc.supabase.co`)
   - **anon public key** (starts with `eyJ...`)
3. These are safe to expose (the security is in RLS policies).

### Create the Database Schema

1. Go to **SQL Editor** (left sidebar).
2. Click **New Query**.
3. Copy the entire contents of `supabase/schema.sql` from the Sidefold repository.
4. Paste into the SQL editor and click **Run**.
5. You should see "success" messages for the table and policies.

---

## Phase 2: Set Up Google OAuth

### 2.1 Create a Google Cloud Project

1. Go to **https://console.cloud.google.com**.
2. Click the project dropdown at the top and click **New Project**.
3. Name it (e.g., "Sidefold") and click **Create**.
4. Wait for the project to be created (2–3 seconds).

### 2.2 Configure OAuth Consent Screen

1. In the left sidebar, go to **APIs & Services → OAuth consent screen**.
2. Choose **External** user type and click **Create**.
3. Fill in the OAuth consent form:
   - **App name**: "Sidefold"
   - **User support email**: your email (e.g., `victor.couce@gmail.com`)
   - **Developer contact**: your email
4. Click **Save and Continue**.
5. On the **Scopes** screen, click **Add or Remove Scopes** and search for:
   - `openid`
   - `email`
   - `profile`
   - Add these three and click **Update**.
6. Click **Save and Continue** twice more (no test users needed).
7. Click **Back to Dashboard**.

### 2.3 Create OAuth Client Credentials

1. In the left sidebar, go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth Client ID**.
3. Choose **Web application** (or **Chrome extension** if available).
4. Name it "Sidefold Extension".
5. Under **Authorized redirect URIs**, click **Add URI** and paste:
   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```
   - You'll get the `<YOUR_EXTENSION_ID>` later; for now, use a placeholder like `abcdef1234567890abcdef1234567890`.
6. Click **Create**.
7. A popup shows your **Client ID** and **Client Secret**. Copy both.

### 2.4 Add OAuth to Supabase

1. Go back to **Supabase** → **Project Settings → Authentication → Providers**.
2. Find **Google** and click to expand.
3. Enable it and paste:
   - **Client ID** (from Google Cloud)
   - **Client Secret** (from Google Cloud)
4. Click **Save**.

### 2.5 Add Redirect URL to Supabase

1. In Supabase, go to **Authentication → URL Configuration**.
2. Under **Redirect URLs**, click **Add URL** and paste:
   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```
   - Same ID as above; you'll update this once you have the real ID.
3. Click **Add URL**.

---

## Phase 3: Get Your Extension ID and Update Configuration

### 3.1 Load the Extension in Chrome (Temporary)

1. Open **chrome://extensions** in Chrome.
2. Enable **Developer mode** (toggle at top right).
3. Click **Load unpacked** and select the `YTCategoryManager` folder.
4. The extension appears with a unique ID (e.g., `abcdef1234567890abcdef1234567890`).

### 3.2 Update Google OAuth Redirect URI

1. Go to **Google Cloud Console → APIs & Services → Credentials**.
2. Click the OAuth client you created (Web application).
3. Update **Authorized redirect URIs** with your real extension ID:
   ```
   https://<YOUR_EXTENSION_ID>.chromiumapp.org/
   ```
4. Click **Save**.

### 3.3 Update Supabase Redirect URL

1. Go to **Supabase → Authentication → URL Configuration**.
2. Replace the placeholder Redirect URL with your real extension ID (same format as above).
3. Click **Update**.

### 3.4 Fill in config.js

1. In the `YTCategoryManager` folder, open `src/shared/config.js`.
2. Replace the placeholders:
   ```javascript
   const SUPABASE_URL = 'https://your-project.supabase.co';  // ← Your Supabase URL
   const SUPABASE_ANON_KEY = 'eyJ...';  // ← Your anon key
   const GOOGLE_CLIENT_ID = 'xxx...apps.googleusercontent.com';  // ← Your Google Client ID
   ```
3. Save the file.

### 3.5 Reload the Extension

1. Go back to **chrome://extensions**.
2. Find Sidefold and click the refresh icon.
3. Go to any YouTube page and refresh (`Cmd+Shift+R` or `Ctrl+Shift+R`).

---

## Testing

### Test Sign In
1. Open the Sidefold popup (click the extension icon in the toolbar).
2. Click **Sign in with Google**.
3. A browser window opens for consent. Approve it.
4. The popup should show your email address.

### Test Sync
1. Create a category in Sidefold's Organize panel.
2. Click **Sync now** in the popup.
3. Go to **Supabase → SQL Editor** and run:
   ```sql
   select * from public.user_data;
   ```
4. You should see a row with your `user_id` and category data.

### Test Sync to Another Device
1. Install the extension on a second browser/device with the same setup.
2. Sign in with the same Google account.
3. Navigate to YouTube.
4. The categories should appear automatically (pulled from Supabase).

---

## Troubleshooting

### "Extension context invalidated" errors
This is normal in MV3 when the service worker wakes up. The extension handles it gracefully and retries.

### Sign in fails with "No access_token"
- Check that Google OAuth is enabled in Supabase (Authentication → Providers → Google).
- Verify the redirect URL matches your extension ID exactly.
- Clear browser cookies and try again.

### Categories don't sync
- Verify that `config.js` has the correct Supabase URL and keys.
- Check the browser console (DevTools → Console) for sync errors.
- Ensure you're signed in (check the popup account section).

### "Sync error: http_error 401"
- Your session may have expired. Sign out and sign in again.
- Check that RLS policies are enabled in Supabase (should be by default after running schema.sql).

---

## Next Steps

- **Privacy Policy**: Update `docs/privacy.html` to reflect that email and categories are now stored in Supabase.
- **Chrome Web Store Listing**: Fill in the "Data Usage" form to declare PII (email) and user-generated content (categories).
- **Optional Self-Hosting**: If you want to host Sidefold privately, you can modify `config.js` to point to your own Supabase project.

---

For questions or issues, contact **victor.couce@gmail.com** or check the repository at **https://github.com/victorcouce/Sidefold**.
