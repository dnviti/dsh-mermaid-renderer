# dsh-mermaid-renderer

Render ```mermaid fenced diagrams **inline in DeepSeek Harness chat** — as pure
vector SVG, with pan/zoom in the message card and a fullscreen viewer.

![version](https://img.shields.io/badge/version-0.1.0-blue)

## Features

- Detects ` ```mermaid ` / ` ```mmd ` fenced blocks in the closing assistant
  message of every completed turn and renders each as a diagram card under the
  message.
- **Vector-only viewport**: the raw Mermaid SVG is rendered directly; pan/zoom
  is a CSS transform, so diagrams stay crisp at any zoom level (no canvas, no
  rasterization).
- **Inline pan/zoom in the chat card**:
  - drag to pan
  - `ctrl`/`cmd` + scroll (or the `−`/`+` buttons, or double-click) to zoom
  - double-click again / `reset` to refit
  - plain scroll over a fitted diagram scrolls the chat normally
- **Fullscreen viewer** (native Fullscreen API with a fixed-overlay fallback):
  scroll to zoom, drag to pan, double-click to reset.
- **copy source** button on every card.
- Theme-aware: diagrams re-render when the DSH theme flips.
- Loads the mermaid library lazily from a CDN (jsdelivr → unpkg); on failure
  the diagram source is shown with the error.

## Install

Requires a DSH profile (this repo's examples use the `desktop` profile — use
whichever profile your app boots; `~/.dsh/profiles/<name>`).

```powershell
# 1. install the package into the profile's node_modules (forwards to pnpm)
dsh plugin --profile desktop -- add <path-or-git-url-to-this-repo>

# 2. register it as a loader entry — append to
#    %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
```

```yaml
- insert:
    - id: dsh-mermaid-renderer
      name: dsh-mermaid-renderer
```

```powershell
# 3. verify the entry composes, then restart the app
dsh --profile desktop --dump-config | Select-String mermaid
```

After restart the plugin appears on **Settings → Plugins**, and any
```mermaid block in chat renders with the interactive card.

> Plugin-set changes take effect on restart (package metadata is cached per
> name). The plugin is also usable as a *dynamic* session plugin via the
> cordis tooling — this package is the publishable static form.

## Usage

Ask an agent (or write yourself) a message containing a mermaid fence:

````markdown
```mermaid
flowchart LR
  A[Start] --> B{Choice}
  B -->|Yes| C[Done]
  B -->|No| D[Retry]
```
````

## Package layout

- `lib/index.js` — host half: empty apply so the package becomes a loader
  entry and its client bundle is served.
- `lib/client.js` — client half: registers via `window.__ModuleLoader__.load`
  and hooks the `conversation.chat.turnTail` slot chain.

## Development

No build step and no runtime npm dependencies: the bundle is hand-authored
plain JavaScript (React via `require("react")`, timers via the Cordis `timer`
service, styles via a managed `<style>` tag).

```powershell
node --check lib/client.js
node --check lib/index.js
```

## License

MIT — see [LICENSE](LICENSE).
