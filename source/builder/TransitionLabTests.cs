using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using TerrainStudio;

public static class TransitionLabTests
{
    static int checks;
    static void Check(bool condition, string message) { checks++; if (!condition) throw new Exception("FAIL: " + message); }
    static void Throws(Action action, string message)
    {
        bool threw = false; try { action(); } catch (ArgumentException) { threw = true; }
        Check(threw, message);
    }
    static TerrainDefinition Terrain(int id, ushort tile) { return new TerrainDefinition { Id = id, TileId = tile, Name = "Test " + id }; }
    static int Count(MapDocument map, int material) { return map.Materials.Count(v => v == material); }
    static string Key(MapDocument map, int x, int y)
    {
        var b = new StringBuilder();
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++)
            b.Append(map.Materials[Math.Max(0, Math.Min(map.Height - 1, y + dy)) * map.Width + Math.Max(0, Math.Min(map.Width - 1, x + dx))].ToString("X2"));
        return b.ToString();
    }
    static int Expected(string shape, int width)
    {
        if (shape == "Isolated square") return width * width;
        if (shape == "Horizontal strip" || shape == "Vertical strip") return 24 * width;
        if (shape == "Diagonal strip") { int n = 0; for (int d = -(width / 2); d < width - width / 2; d++) n += 24 - Math.Abs(d); return n; }
        if (shape == "L-bend") return 48 * width - width * width;
        if (shape == "Ring") return 576 - (24 - 2 * width) * (24 - 2 * width);
        if (shape == "Hole") return 576 - width * width;
        int even = 0; for (int i = 0; i < 24; i++) if ((i / width & 1) == 0) even++;
        return even * even + (24 - even) * (24 - even);
    }
    static void Same(MapDocument a, MapDocument b, string message)
    {
        Check(a.Width == b.Width && a.Height == b.Height && a.Land.SequenceEqual(b.Land) &&
            a.Materials.SequenceEqual(b.Materials) && a.Elevation.SequenceEqual(b.Elevation) &&
            a.Statics.Count == b.Statics.Count && a.Statics.Zip(b.Statics, (x, y) => x.X == y.X && x.Y == y.Y && x.Id == y.Id && x.Z == y.Z && x.Hue == y.Hue).All(v => v), message);
    }
    static Catalog Synthetic(string folder, IEnumerable<string> keys)
    {
        Directory.CreateDirectory(Path.Combine(folder, "System")); Directory.CreateDirectory(Path.Combine(folder, "Transitions"));
        File.WriteAllText(Path.Combine(folder, "System", "Terrain.xml"), "<Terrains><Terrain ID='1' Name='A' TileID='3' R='1' G='0' B='0'/><Terrain ID='4' Name='B' TileID='22' R='4' G='0' B='0'/><Terrain ID='6' Name='C' TileID='102' R='6' G='0' B='0'/></Terrains>");
        var xml = new StringBuilder("<Trans>");
        foreach (string key in keys.Distinct()) xml.Append("<TransInfo HashKey='" + key + "'><MapTiles><MapTile TileID='100' AltIDMod='1'/></MapTiles><StaticTiles><StaticTile TileID='200' AltIDMod='-2'/></StaticTiles></TransInfo>");
        xml.Append("</Trans>"); File.WriteAllText(Path.Combine(folder, "Transitions", "test.xml"), xml.ToString()); return Catalog.Load(folder);
    }
    public static int Main(string[] args)
    {
        try
        {
            var a = Terrain(1, 3); var b = Terrain(4, 22);
            Check(TransitionLab.Shapes.Length == 8 && TransitionLab.Shapes.Distinct().Count() == 8, "eight distinct shape choices");
            foreach (string shape in TransitionLab.Shapes) for (int width = 1; width <= 8; width++)
            {
                var map = TransitionLab.Create(a, b, shape, width, -128, 127);
                Check(map.Width == 32 && map.Height == 32 && map.Statics.Count == 0, shape + " dimensions and no guessed statics");
                Check(Count(map, 4) == Expected(shape, width), shape + " exact area at width " + width);
                for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++)
                {
                    int i = y * 32 + x; bool foreground = map.Materials[i] == 4;
                    Check(map.Land[i] == (foreground ? 22 : 3) && map.Elevation[i] == (foreground ? 127 : -128), "exact base tile and height per region");
                    if (x < 4 || y < 4 || x >= 28 || y >= 28) Check(!foreground, "four-cell fixture padding is background, not a terrain-thickness requirement");
                }
                map.Validate();
            }
            for (int width = 1; width <= 8; width++)
            {
                var h = TransitionLab.Create(a, b, "Horizontal strip", width, 0, 1);
                var v = TransitionLab.Create(a, b, "Vertical strip", width, 0, 1);
                bool transpose = true; for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) transpose &= h.Materials[y * 32 + x] == v.Materials[x * 32 + y];
                Check(transpose, "horizontal and vertical test strips transpose without changing thickness");
            }
            var same = TransitionLab.Create(a, a, "Isolated square", 1, -1, 1);
            Check(same.Materials.All(v => v == 1) && same.Land.All(v => v == 3) && same.Elevation.Count(z => z == 1) == 1, "same-material control supports distinct exact region heights");
            var independent = TransitionLab.Create(a, b, "Ring", 2, 0, 0); var another = TransitionLab.Create(a, b, "Ring", 2, 0, 0); independent.Materials[0] = -1;
            Check(another.Materials[0] == 1 && a.Id == 1 && b.Id == 4, "fixtures and supplied definitions are not shared mutable map storage");
            Throws(() => TransitionLab.Create(null, b, "Ring", 1, 0, 0), "null background rejected");
            Throws(() => TransitionLab.Create(a, null, "Ring", 1, 0, 0), "null foreground rejected");
            Throws(() => TransitionLab.Create(a, b, null, 1, 0, 0), "null shape rejected");
            Throws(() => TransitionLab.Create(a, b, "Unknown", 1, 0, 0), "unknown shape rejected");
            foreach (int width in new[] { -1, 0, 9 }) Throws(() => TransitionLab.Create(a, b, "Ring", width, 0, 0), "invalid width rejected");
            Throws(() => TransitionLab.Create(a, b, "Ring", 1, -129, 0), "low background height rejected");
            Throws(() => TransitionLab.Create(a, b, "Ring", 1, 0, 128), "high foreground height rejected");
            Throws(() => TransitionLab.Create(Terrain(256, 3), b, "Ring", 1, 0, 0), "unrepresentable catalog ID rejected");
            Throws(() => TransitionLab.Create(a, Terrain(4, 16384), "Ring", 1, 0, 0), "out-of-range land ID rejected");

            string folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "transition-lab-test-fixtures", Guid.NewGuid().ToString("N"));
            var isolated = TransitionLab.Create(a, b, "Isolated square", 1, -20, 40);
            var keys = new HashSet<string>(); for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) keys.Add(Key(isolated, x, y));
            Check(keys.Count == 10, "one-cell island exercises its center, all eight surrounding positions, and the uniform control");
            var complete = Synthetic(Path.Combine(folder, "complete-island"), keys); var before = isolated.Clone(); var compiled = complete.Compile(isolated);
            Check(compiled.Matched == 1024 && compiled.Missing == 0 && compiled.Map.Land.All(id => id == 100), "explicit one-cell rules resolve without requiring a wider patch");
            Check(compiled.Map.Elevation.SequenceEqual(isolated.Elevation) && compiled.Map.Statics.All(s => s.Z == isolated.Elevation[s.Y * 32 + s.X]), "resolved island retains every land and static height in exact mode"); Same(isolated, before, "source remains unchanged after resolving one-cell island");
            Check(compiled.States == null, "diagnostic arrays are not allocated unless requested");
            Same(compiled.Map, complete.Compile(isolated).Map, "repeat compile from source is stable and does not accumulate statics");
            var uniform = Synthetic(Path.Combine(folder, "uniform-only"), new[] { "010101010101010101" }); var missing = uniform.Compile(isolated);
            Check(missing.Missing == 9 && missing.Matched == 1015 && missing.Map.Land[15 * 32 + 15] == 22, "missing isolated-island rules expose exactly the nine-cell neighborhood and keep base land");
            var manual = TransitionLab.Create(a, a, "Isolated square", 1, 22, 22); manual.Materials[15 * 32 + 15] = -1; manual.Land[15 * 32 + 15] = 16383;
            manual.Statics.Add(new StaticPlacement { X = 15, Y = 15, Id = 65535, Hue = 123, Z = -128 }); before = manual.Clone(); var manualResult = uniform.Compile(manual, false, 0, null, null, true);
            Check(manualResult.Matched == 1015 && manualResult.Missing == 8 && manualResult.Map.Land[15 * 32 + 15] == 16383 && manualResult.Map.Statics.Any(s => s.Id == 65535 && s.Hue == 123 && s.Z == -128), "manual exact cell survives; adjacent material cells report their unsupported neighborhood"); Same(manual, before, "manual fixture source unchanged");
            Check(manualResult.States[15 * 32 + 15] == CellResolution.Manual && manualResult.States.Count(s => s == CellResolution.MissingRule) == 8 && manualResult.States.Count(s => s == CellResolution.Matched) == 1015, "diagnostics distinguish manual cell, its eight unresolved neighbors, and matched background");
            var junction = TransitionLab.Create(a, b, "Horizontal strip", 1, -2, 3); junction.Materials[16 * 32 + 15] = 6; junction.Land[16 * 32 + 15] = 102; junction.Elevation[16 * 32 + 15] = 4;
            string junctionKey = Key(junction, 15, 15); Check(junctionKey.Contains("01") && junctionKey.Contains("04") && junctionKey.Contains("06"), "junction includes three actual materials");
            var junctionCatalog = Synthetic(Path.Combine(folder, "junction"), new[] { junctionKey }); before = junction.Clone(); var joint = junctionCatalog.Compile(junction);
            Check(joint.Map.Land[15 * 32 + 15] == 100 && joint.Map.Elevation[15 * 32 + 15] == 3, "explicit multi-material neighborhood can resolve independently of thickness"); Same(junction, before, "junction source and heights unchanged");

            if (args.Length > 0)
            {
                var actual = Catalog.Load(args[0]); var byId = actual.Terrains.ToDictionary(t => t.Id); var inventory = actual.RuleInventory().ToDictionary(r => r.Key);
                int cases = 0; var resolvedCells = new int[2]; var missingCells = new int[2]; var skippedCells = new int[2];
                foreach (string shape in new[] { "Isolated square", "Horizontal strip", "Vertical strip" })
                {
                    var blue = TransitionLab.Create(byId[1], byId[17], shape, 1, -20, 40); before = blue.Clone();
                    var preserve = actual.Compile(blue, false, 0, null, null, true, false);
                    var legacy = actual.Compile(blue, false, 0, null, null, true, true);
                    int center = 15 * 32 + 15;
                    Check(blue.Materials[center] == 17 && preserve.Map.Land[center] == 528 && preserve.Map.Elevation[center] == 40, "disabled legacy autocorrect retains the actual one-cell Blue Tile feature: " + shape);
                    Check(preserve.States[center] == CellResolution.AutocorrectSkipped && preserve.AutocorrectSkipped > 0 && preserve.Missing >= preserve.AutocorrectSkipped && !preserve.Map.Statics.Any(s => s.X == 15 && s.Y == 15), "skipped autocorrect is unresolved with no generated center static: " + shape);
                    Check(legacy.Map.Land[center] == 3 && legacy.States[center] == CellResolution.LegacyAutocorrect, "enabled legacy autocorrect exposes the source of narrow-feature erasure: " + shape);
                    Check(preserve.Map.Elevation.SequenceEqual(blue.Elevation) && legacy.Map.Elevation.SequenceEqual(blue.Elevation) && preserve.Map.Materials.SequenceEqual(blue.Materials), "autocorrect toggle does not alter source materials or exact heights");
                    Same(blue, before, "both autocorrect modes keep the source immutable");
                    Same(legacy.Map, actual.Compile(blue).Map, "legacy default overload remains compatible");
                }
                foreach (int[] pair in new[] { new[] { 1, 4 }, new[] { 4, 6 }, new[] { 1, 6 }, new[] { 18, 4 } })
                    foreach (string shape in TransitionLab.Shapes) for (int width = 1; width <= 4; width++)
                    {
                        var map = TransitionLab.Create(byId[pair[0]], byId[pair[1]], shape, width, -3, 7); before = map.Clone();
                        int expectedMatches = 0; for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) if (inventory.ContainsKey(Key(map, x, y))) expectedMatches++;
                        var enabled = actual.Compile(map, false, 0, null, null, true, true);
                        Check(enabled.Matched == expectedMatches && enabled.Missing == 1024 - expectedMatches, "enabled legacy mode reports exact catalog-key coverage; a match is not claimed visually correct");
                        for (int mode = 0; mode < 2; mode++)
                        {
                            bool allowAutocorrect = mode == 1;
                            var result = actual.Compile(map, false, 0, null, null, true, allowAutocorrect);
                            Check(result.States.Length == map.Materials.Length && result.States.Count(s => s == CellResolution.Matched || s == CellResolution.LegacyAutocorrect) == result.Matched, "captured success states sum to matched cells in both modes");
                            Check(result.States.Count(s => s == CellResolution.MissingRule || s == CellResolution.Conflict || s == CellResolution.UnavailableCandidate || s == CellResolution.AutocorrectSkipped) == result.Missing && result.Matched + result.Missing == 1024, "all unresolved states sum to missing without double counting");
                            Check(result.States.Count(s => s == CellResolution.AutocorrectSkipped) == result.AutocorrectSkipped && result.States.Count(s => s == CellResolution.Conflict) == result.Conflicts, "diagnostic detail agrees with summary counters");
                            Check(result.Map.Elevation.SequenceEqual(map.Elevation) && result.Map.Materials.SequenceEqual(map.Materials), "compiled material mask and exact Z remain unchanged; selected art is separately diagnosed");
                            if (!allowAutocorrect)
                            {
                                int legacyCount = enabled.States.Count(s => s == CellResolution.LegacyAutocorrect);
                                Check(result.Matched == enabled.Matched - legacyCount && result.Missing == enabled.Missing + legacyCount && result.AutocorrectSkipped == legacyCount, "default-off mode transfers only explicitly labeled autocorrect successes to unresolved");
                                for (int i = 0; i < result.States.Length; i++) if (result.States[i] == CellResolution.AutocorrectSkipped)
                                    Check(result.Map.Land[i] == byId[map.Materials[i]].TileId && !result.Map.Statics.Any(s => s.X == i % 32 && s.Y == i / 32), "skipped cells keep base land and generate no transition statics");
                            }
                            else Check(result.AutocorrectSkipped == 0, "enabled mode has no skipped autocorrect states");
                            Same(map, before, "actual source unchanged in both modes");
                            var repeated = actual.Compile(map, false, 0, null, null, true, allowAutocorrect);
                            Same(result.Map, repeated.Map, "both modes produce deterministic map snapshots"); Check(result.States.SequenceEqual(repeated.States), "both modes produce deterministic cell diagnostics");
                            resolvedCells[mode] += result.Matched; missingCells[mode] += result.Missing; skippedCells[mode] += result.AutocorrectSkipped;
                        }
                        cases++;
                    }
                for (int mode = 0; mode < 2; mode++) Console.WriteLine("Actual catalog: " + cases + " shape/pair/width cases; autocorrect " + (mode == 0 ? "OFF (new UI default)" : "ON (legacy)") + "; " + resolvedCells[mode] + " matched; " + missingCells[mode] + " missing; " + skippedCells[mode] + " autocorrect skipped. Coverage is not proof of in-game appearance.");
            }
            Console.WriteLine("PASS " + checks + " transition-lab checks."); return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
