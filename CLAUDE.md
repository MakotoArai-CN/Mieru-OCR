# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mieru-OCR is a browser-based offline CAPTCHA recognition tool using the DDDDOCR model via ONNX Runtime Web. It ships as three variants: a userscript (Tampermonkey/Violentmonkey), a Chrome/Edge extension (Manifest V3), and a Firefox extension (Manifest V2). All OCR inference runs client-side with no backend.

Primary language is Chinese (comments, UI strings, commit messages).

## Build Commands

```bash
bun install                  # Install dependencies (bun is the preferred package manager)
bun run dev                  # Watch mode for userscript development
bun run build                # Build userscript only -> dist/userscript/
bun run build:extension      # Build Chrome/Edge extension -> dist/extension/ + .zip
bun run build:firefox        # Build Firefox extension -> dist/firefox/ + .zip
bun run build:all            # Build all three variants sequentially
bun run type-check           # TypeScript type checking (tsc --noEmit)
```

There are no automated tests. The benchmark tool (`benchmark.ts`) evaluates model accuracy with `bun run benchmark.ts`.

## Architecture

### Three Build Targets, One Shared Core

```
src/core/          Shared OCR logic (framework-agnostic)
src/userscript/    Userscript variant (single .user.js output via vite-plugin-monkey)
src/extension/     Browser extension variant (multi-entry: background, content, popup, options, offscreen)
```

Each build target has its own Vite config:
- `vite.config.ts` - Userscript (uses `vite-plugin-monkey`)
- `vite.config.browser.ts` - Chrome/Edge MV3 extension (custom `copyPublicAssets` plugin)
- `vite.config.firefox.ts` - Firefox MV2 extension

Path aliases: `@core/*` -> `src/core/*`, `@userscript/*` -> `src/userscript/*`, `@extension/*` -> `src/extension/*`

### Core Modules (`src/core/`)

- **ocr-engine.ts** - ONNX Runtime session management, tensor creation, inference, charset lookup
- **captcha-detector.ts** - DOM scanning for CAPTCHA elements using keyword matching, size validation, and confidence scoring. Finds nearby input fields heuristically
- **auto-fill.ts** - Sets input values with framework compatibility (React value tracker, Vue v-model, Angular ng-model). Dispatches synthetic events
- **image-processor.ts** - Loads images from various sources, normalizes to 64px height grayscale
- **calculator.ts** - Solves math expression CAPTCHAs
- **types.ts** - All shared TypeScript interfaces including `OCRConfig`, `ExtensionSettings`, `SiteRule`, typed `EventEmitter<T>`
- **config.ts** - Constants (keywords, size limits, CDN mirrors), default settings, `Logger` class, theme colors

### Extension Architecture (MV3)

The extension uses Chrome's offscreen document pattern for ONNX inference since service workers can't run WASM directly:

1. **Content script** (`content/content.ts`) - Injected into pages, detects CAPTCHAs, sends recognition requests via `chrome.runtime.sendMessage`
2. **Service worker** (`background/service-worker.ts`) - Routes messages between content script and offscreen document, manages offscreen document lifecycle
3. **Offscreen document** (`offscreen/offscreen.ts` + `ort-bootstrap.ts`) - Loads ONNX Runtime and model, runs inference in a hidden DOM context
4. **Popup** (`popup/`) - Shows recognition results and site stats
5. **Options** (`options/`) - Full settings page

Firefox variants (`*-firefox.ts`) use MV2 background pages instead of service workers/offscreen documents.

### Versioning

The `version` file at repo root is the source of truth. CI reads it and syncs to `package.json`, `manifest.json`, and `manifest.firefox.json` during build. The release workflow triggers on pushes to this file.

### Model & Runtime Files

- ONNX model (`common.onnx`) and charset (`charsets.json`) live in `public/` and are bundled into extensions
- Quantized model variants are in `models/` (for benchmarking, not bundled by default)
- ONNX Runtime WASM files are copied from `node_modules/onnxruntime-web/dist/` during extension builds
- For the userscript, ONNX Runtime is loaded via CDN `@require`, and models are downloaded from GitHub mirrors and cached in IndexedDB
