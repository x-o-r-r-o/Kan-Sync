# Contributing

Thanks for helping improve Kan Sync. Please open an issue before large changes so we can align on scope.

## Development

This plugin ships as plain JavaScript — there is no build step.

```bash
git clone https://github.com/x-o-r-r-o/Kan-Sync.git
cd Kan-Sync
```

Copy (or symlink) `main.js`, `manifest.json`, and `styles.css` into:

```
<your-vault>/.obsidian/plugins/kan-sync/
```

Reload Obsidian (`Ctrl/Cmd + R`), or use the [Hot Reload](https://github.com/pjeby/hot-reload) plugin.

Syntax check:

```bash
node --check main.js
```

## Pull requests

- Keep changes focused; match existing style in `main.js` / `styles.css`
- Update `README.md` disclosures / changelog when behavior or network use changes
- Keep `SECURITY.md` frontmatter `version` in sync with `manifest.json` on releases
- Do not commit API keys or vault `data.json`

## Releases

Maintainers bump `manifest.json` + `versions.json`, tag a GitHub release with `main.js`, `manifest.json`, and `styles.css`, and rely on `.github/workflows/attest-release.yml` for artifact attestations.
