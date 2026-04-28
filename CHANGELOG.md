# Changelog

## v0.2.6.3 (v0.2.6-3)

### Viewer Menu, Filters, And Detail UX

- Moved `Clipboard` and `Options` into a compact top-right `Menu`
- Added the current app version inside that menu
- Added avatar description toggles for `posted by` and `cameo` entries in the detail panel
- Added likes and recent-post ordering for copied poster usernames
- Added clipboard helpers for `post_id`, `gen_id`, and `task_id`
- Added `Remote files` and `No manifest` quick filters
- Added `Poster most posts first` and `ID core` sorting in advanced filters
- Added streaming manifest parsing so very large manifest JSON files can still be indexed
- Replaced the `Manifest supplement` excerpt with a full manifest-backed tree view that shows nested fields in collapsible sections

### Diagnostics And Indexing

- Added source diagnostics that show per-source directory paths, raw file counts, unique IDs from TXT, and matched/indexed totals
- Added rebuild progress reporting so startup and rescan work shows which phase is currently running
- Relaxed local-to-manifest matching so exact `gen_id` / `post_id` matches still attach even when source bucket names differ
- Added support for nested remix and creator layouts in `sora2_data`

### Cache Workflow And Security

- Kept cached-startup SQLite behavior and one-shot renew-on-start maintenance controls
- Patched the transitive `@xmldom/xmldom` dependency to `0.8.13` to clear the current npm security audit alert

## v0.2.6.1

### Viewer Menu And Detail UX

- Moved `Clipboard` and `Options` into a compact top-right `Menu`
- Added the current app version inside that menu
- Added avatar description toggles for `posted by` and `cameo` entries in the detail panel
- Added likes and recent-post ordering for copied poster usernames
- Added streaming manifest parsing so very large manifest JSON files can still be indexed

## v0.2.6

### Cache Workflow

- Changed startup to use the last completed SQLite cache immediately instead of always triggering an automatic full rescan
- Kept `Rescan` as the explicit rebuild action and continued rebuilding the SQLite cache by deleting and rewriting all cached rows
- Added a temporary startup notice that reminds users to click `Rescan` after updating files while the app was closed
- Added `SORA_SQLITE_RENEW_ON_START=1` to delete the cached SQLite database at startup and force a clean rebuild
- Added a one-shot `Renew next start` checkbox that schedules the next app launch to behave like `SORA_SQLITE_RENEW_ON_START=1`

## v0.2.5

### Source Handling And Indexing

- Added source filters for `sora_v2_cameos` and `sora_v2_cameo_drafts`
- Added grouped `Users` and `Chars` source menus and hid those menus when there are no matching sources
- Added support for merged manifest parts and merged source memberships across manifest and local matches
- Added support for symlinked and junction-backed source directories and manifest files inside `sora2_data/`
- Added persisted viewer state so query, filters, page size, selected item, and paging survive reloads

### UI And Detail View

- Refined the gallery and detail layout for denser desktop viewing
- Added a visible initial loading state so the first index load is not blank while manifests and local files are being scanned
- Added cameo and profile user IDs to the detail panel when available
- Added local avatar lookup for posters and cameo users, including improved fallback owner lookup for cameo avatars

### Documentation And Release Assets

- Refreshed the README screenshot for the `v0.2.5` release
- Added the data directory settings example image to the README
- Updated the README release links and data layout examples for `v0.2.5`

## v0.2.4

### Security And Dependencies

- Updated `electron` to `39.8.5` to address the current Dependabot security alerts affecting the desktop build

### Desktop Viewer

- Changed the detail view to prefer the actual loaded video resolution and aspect ratio from the local media file
- Added fallback metadata resolution and ratio rows when the manifest or TXT metadata differs from the real local media

### Documentation

- Added a README note that changing the data directory after first launch also requires resetting `app-data\`
- Updated the README release links for `v0.2.4`

## v0.2.3

### CI And Test Stability

- Stabilized the smoke test media fixture so the `/media` fetch check is less likely to fail on GitHub Actions and Linux runners

### Desktop App

- Added an Electron desktop entry point while keeping `npm start` available for the browser-based local server workflow
- Added Windows portable packaging with `npm run build:electron`
- Set the portable distribution filename to `Sora2_Vault_Viewer-portable.exe`

### Runtime Paths And Persistence

- Added explicit runtime path visibility in the UI for data, app-data, SQLite, TXT cache, and config file paths
- Added startup log visibility in the UI
- Added Electron-side settings persistence in `app.getPath("userData")\app-data\viewer-config.json`
- Added portable-aware data directory resolution using `PORTABLE_EXECUTABLE_DIR\sora2_data\`

### UI Adjustments

- Tuned the Electron startup window size for desktop use
- Adjusted gallery card sizing to use a fixed card width with a variable number of cards based on available window width
- Reduced card text, line spacing, badge size, and badge corner radius for denser gallery cards
- Styled the `Paths` and `Startup Log` cards with a light background for readability

### Packaging And Repo Hygiene

- Added Electron dependencies and packaging configuration to `package.json`
- Added generated portable executables to `.gitignore`
