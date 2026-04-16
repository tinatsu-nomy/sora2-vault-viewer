# Changelog

## v0.2.3

### CI And Test Stability

- Stabilized the smoke test media fixture so the `/media` fetch check is less likely to fail on GitHub Actions and Linux runners

### Desktop App

- Added an Electron desktop entry point while keeping `npm start` available for the browser-based local server workflow
- Added Windows portable packaging with `npm run build:electron`
- Set the portable distribution filename to `Sora2 Vault Viewer-portable.exe`

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
