# UO Map Tools

A Windows desktop application for painting Ultima Online terrain, generating seeded heightmaps, preparing housing terraces, and building map MUL files with transitions and decorations.

## Download and run

Download the Windows x64 ZIP from Releases, **extract the entire folder**, and open **UO Map Paint.exe**. No Node installation, browser window, or separate Electron installation is required. Windows 10/11 x64 is the target. This initial release is unsigned; Windows may identify it as an unrecognized application.

The editor runs in its own desktop window with a bundled rendering engine. **File > Open map builder** opens the included builder. You can also open `Map builder/UO Map Builder.exe` directly. The builder uses Windows .NET Framework 4.x and needs your own installed Ultima Online client data. Game client archives, server accounts, passwords, and API keys are not included.

## Workflow

1. Create an image at a standard UO map size or a custom size.
2. Paint or generate Mountains/Hills; use Posterize and selection tools to assign terrain.
3. Prepare terraces/building sites, then generate decorations. The swamp/snow pass preserves housing flats from trees and rocks while allowing compatible plants.
4. **Save project** keeps editable layers, selections, and decorations. Export **Terrain.png**, **Heightmap.png**, and **Decorations.png** together using **Download PNGs**; extract the ZIP.
5. Open the builder, choose Terrain.png and Heightmap.png, your client data directory, output folder, and target facet. Decorations.png is read automatically when beside Terrain.png.
6. Client and server map dimensions must match the generated files. Back up existing map files before installing a build.

The image generator, editor, user-filter recorder, and map builder work offline. Optional AI needs your own API key and network access; no key is bundled. AI is a source-color assignment helper, not a replacement for reviewing the generated map.

## Included features

- Terrain, exact -128..127 altitude, and a separate 256-color decoration layer
- Standard map sizes, seeded landscapes, hills, ridges, ramps, roads, blur and boundary filters
- Wand, rectangle, ellipse, pixel and freehand selection, reusable selection snapshots
- Dense housing terraces, city sites, automatic walls/stone roofs and biome decoration passes
- Undo/Redo, editable projects, three-image exports, notes and portable recorded user filters
- Command-line and graphical MUL builder with legacy transition rules and shoreline passes

## Limits

Terrain transitions are not complete for every material pair. Builds retain fallback terrain where no compatible rule exists. House flats and plant flags do not guarantee every server's house-placement rules. Some operations on large maps briefly block the interface. Existing artwork thumbnails are omitted from the distributable; decoration entries retain names, art IDs, and exact palette colors. Roof generation can skip incompatible foundations.

Notes/settings/filter library are stored under the user's application profile. Keep downloaded project/filter/text files as durable backups. Existing browser-editor sessions are independent and are not migrated automatically.

## Build from source

Install Node.js and run `powershell -ExecutionPolicy Bypass -File Build-Desktop.ps1`. The script downloads a pinned, checksum-verified Electron runtime, generates the editor, compiles the builder, and creates `dist/UO-Map-Tools-1.0.0-win-x64.zip`. No npm modules are needed. Source is organized under `source/editor`, `source/desktop`, and `source/builder`; legacy XML catalogs are under `catalog`.

## Third-party material

See `THIRD-PARTY-NOTICES.md` and `catalog/LEGACY-NOTICE.txt`. This repository does not grant rights to Ultima Online artwork or override the original catalog's notices. No blanket open-source license is asserted for the combined legacy dataset. This is an independent fan tool, not an official Ultima Online product.
