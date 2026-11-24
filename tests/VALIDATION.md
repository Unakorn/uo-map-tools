# Release validation

Windows x64 portable desktop build tested with Electron 45.4.1.

- Isolated desktop executable launched without opening an external browser.
- Renderer has no Node require access; sandbox/context isolation enabled.
- Generated terraces and housing-compatible plants on a 128x128 fixture.
- Saved an editable project and exported a ZIP containing Terrain.png, Heightmap.png and Decorations.png.
- Unsaved work prevented closing the window.
- Included C# map builder compiled and built the exported fixture: 16,384 terrain cells, 4,908 decoration pieces, no unresolved transitions in this single-material fixture.
- Existing larger-map editor and server tests are historical evidence, not a complete desktop release test of every operation.

Run editor checks: node --test source/editor/terraces078.test.cjs source/editor/plants080.test.cjs

A bundled smoke run is available with UO Map Paint.exe --self-test=<absolute-empty-output-directory>. It runs invisibly in an isolated profile, writes a screenshot, sample project, image ZIP and JSON result, then exits.
