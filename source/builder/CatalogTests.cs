using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using TerrainStudio;

public static class CatalogTests
{
    static int checks;
    static void Check(bool value, string message) { checks++; if (!value) throw new Exception("FAIL: " + message); }
    static string Fixture(string root, string name, string rules)
    {
        string path = Path.Combine(root, name);
        Directory.CreateDirectory(Path.Combine(path, "System"));
        Directory.CreateDirectory(Path.Combine(path, "Transitions"));
        var terrain = new StringBuilder("<Terrains>");
        for (int id = 1; id <= 9; id++) terrain.AppendFormat("<Terrain ID='{0}' Name='Material {0}' TileID='{1}' R='{0}' G='0' B='0' />", id, id + 2);
        terrain.Append("</Terrains>");
        File.WriteAllText(Path.Combine(path, "System", "Terrain.xml"), terrain.ToString());
        File.WriteAllText(Path.Combine(path, "System", "Altitude.xml"), "<Altitudes><Altitude Altitude='-100' R='0' G='81' B='0' /><Altitude Altitude='74' R='0' G='255' B='0' /></Altitudes>");
        File.WriteAllText(Path.Combine(path, "Transitions", "test.xml"), "<Trans>" + rules + "</Trans>");
        return path;
    }
    static string Rule(string key, string id, int offset, string statics)
    {
        return "<TransInfo HashKey='" + key + "'><MapTiles><MapTile TileID='" + id + "' AltIDMod='" + offset + "'/></MapTiles><StaticTiles>" + statics + "</StaticTiles></TransInfo>";
    }
    static MapDocument Fill(int width, int height, int material, ushort land, sbyte z)
    {
        var m = new MapDocument(width, height);
        for (int i = 0; i < m.Land.Length; i++) { m.Materials[i] = material; m.Land[i] = land; m.Elevation[i] = z; }
        return m;
    }
    public static int Main(string[] args)
    {
        try
        {
            string root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "catalog-test-fixtures", Guid.NewGuid().ToString("N"));
            string staticCandidates = "<StaticTile TileID='200' AltIDMod='-2'/><StaticTile TileID='201' AltIDMod='-2'/>";
            string asymmetric = Fixture(root, "asymmetric", Rule("010203040506070809", "100", 2, staticCandidates));
            var catalog = Catalog.Load(asymmetric);
            var map = new MapDocument(3, 3);
            for (int i = 0; i < 9; i++) { map.Materials[i] = i + 1; map.Land[i] = (ushort)(i + 3); map.Elevation[i] = 42; }
            var result = catalog.Compile(map);
            Check(result.Matched == 1 && result.Missing == 8, "row-major asymmetric neighborhood resolves exactly center");
            Check(result.Map.Land[4] == 100 && result.Map.Elevation[4] == 42, "center land and exact height");
            Check(result.Map.Statics.Count == 1 && result.Map.Statics[0].X == 1 && result.Map.Statics[0].Y == 1 && result.Map.Statics[0].Z == 42, "one deterministic static alternative at center");
            Check(map.Land[4] == 7 && map.Statics.Count == 0, "compiler does not mutate input");
            var legacy = catalog.Compile(map, true);
            Check(legacy.Map.Elevation[4] == 44 && legacy.Map.Statics[0].Z == 40, "explicit legacy offsets use original source Z independently");
            var again = catalog.Compile(map);
            Check(again.Map.Statics.Count == 1 && again.Map.Statics[0].Id == result.Map.Statics[0].Id, "repeat compile is deterministic without accumulated statics");
            map.Materials[4] = -1; map.Land[4] = 16383; map.Elevation[4] = 127;
            map.Statics.Add(new StaticPlacement { X = 1, Y = 1, Id = 65535, Hue = 123, Z = -128 });
            var manual = catalog.Compile(map, true);
            Check(manual.Map.Land[4] == 16383 && manual.Map.Elevation[4] == 127 && manual.Map.Statics.Count == 1 && manual.Map.Statics[0].Hue == 123, "manual land and statics retained across any neighbors");
            var full = Catalog.Load(Fixture(root, "full", Rule("010101010101010101", "30", 1, staticCandidates)));
            var heights = Fill(16, 16, 1, 3, 0);
            for (int i = 0; i < 256; i++) heights.Elevation[i] = (sbyte)(i - 128);
            var exact = full.Compile(heights);
            Check(exact.Matched == 256 && exact.Missing == 0, "clamped boundary neighborhoods match common terrain");
            Check(exact.Map.Elevation.SequenceEqual(heights.Elevation), "all 256 integer heights preserved exactly");
            Check(exact.Map.Statics.Count == 256 && exact.Map.Statics.All(s => s.Z == heights.Elevation[s.Y * 16 + s.X]), "all static heights preserve source in exact mode");
            bool overflow = false;
            try { full.Compile(heights, true); } catch (InvalidOperationException) { overflow = true; }
            Check(overflow && heights.Land.All(v => v == 3) && heights.Statics.Count == 0, "offset overflow rejects atomically without clamping or input mutation");
            string duplicate = Rule("010101010101010101", "20", 0, "");
            var conflict = Catalog.Load(Fixture(root, "conflict", duplicate + duplicate + Rule("010101010101010101", "21", 0, "")));
            Check(conflict.RuleCount == 0 && conflict.ConflictCount == 1, "different duplicate keys quarantined, identical definitions tolerated");
            var fallback = conflict.Compile(Fill(1, 1, 1, 777, 22));
            Check(fallback.Missing == 1 && fallback.Conflicts == 1 && fallback.Map.Land[0] == 3 && fallback.Map.Elevation[0] == 22, "conflicts retain known material base tile and original Z");
            string malformedRules = "<TransInfo HashKey='0101'><MapTiles /></TransInfo>" + "<TransInfo HashKey='020202020202020202'><MapTiles /><StaticTiles /></TransInfo>" + Rule("030303030303030303", "23E", 0, "");
            var malformed = Catalog.Load(Fixture(root, "malformed", malformedRules));
            Check(malformed.RuleCount == 1 && malformed.QuarantinedCount == 2 && malformed.Warnings.Any(w => w.Contains("hexadecimal")), "malformed/empty rules isolated; mixed hex tile IDs explicitly reported");
            Check(malformed.Compile(Fill(1, 1, 3, 5, 0)).Map.Land[0] == 574, "hex-looking tile ID decoded as 0x23E");
            Check(catalog.LegacyAltitudes[81 << 8] == -100 && catalog.LegacyAltitudes[255 << 8] == 74, "legacy palette values loaded exactly");
            string alternatives = "<TransInfo HashKey='010101010101010101'><MapTiles><MapTile TileID='504' AltIDMod='999'/><MapTile TileID='30' AltIDMod='1'/></MapTiles><StaticTiles>" + staticCandidates + "</StaticTiles></TransInfo>";
            var filterCatalog = Catalog.Load(Fixture(root, "client-filter", alternatives));
            var filterSource = Fill(1, 1, 1, 777, 22);
            filterSource.Statics.Add(new StaticPlacement { X = 0, Y = 0, Id = 65535, Hue = 123, Z = -128 });
            var noFilter = filterCatalog.Compile(filterSource, false, 19);
            var nullFilter = filterCatalog.Compile(filterSource, false, 19, null, null);
            Check(noFilter.Map.Land.SequenceEqual(nullFilter.Map.Land) && noFilter.Map.Statics.Select(s => s.Id).SequenceEqual(nullFilter.Map.Statics.Select(s => s.Id)) && noFilter.Matched == nullFilter.Matched && noFilter.Missing == nullFilter.Missing, "old overload equals explicit null filters");
            var singleAlternative = filterCatalog.Compile(filterSource, false, 19, new HashSet<int> { 30 }, new HashSet<int> { 201 });
            Check(singleAlternative.Matched == 1 && singleAlternative.Missing == 0 && singleAlternative.Map.Land[0] == 30 && singleAlternative.Map.Statics.Count == 2 && singleAlternative.Map.Statics[1].Id == 201, "unavailable alternatives excluded while one available alternative is selected");
            Check(singleAlternative.Map.Elevation[0] == 22 && singleAlternative.Notes.Any(n => n.Contains("Excluded automatic land IDs: 504")) && singleAlternative.Notes.Any(n => n.Contains("Excluded automatic static IDs: 200")), "excluded IDs reported and exact height retained");
            var filteredLegacy = filterCatalog.Compile(filterSource, true, 19, new HashSet<int> { 30 }, new HashSet<int> { 201 });
            Check(filteredLegacy.Map.Elevation[0] == 23 && filteredLegacy.Map.Statics[1].Z == 20, "only selected valid candidates apply legacy offsets; rejected overflowing alternative never used");
            var none = filterCatalog.Compile(filterSource, true, 19, new HashSet<int>(), new HashSet<int>());
            Check(none.Matched == 0 && none.Missing == 1 && none.Conflicts == 0 && none.Map.Land[0] == 3 && none.Map.Elevation[0] == 22, "all alternatives missing counts once and retains base tile/source Z instead of inserting zero");
            Check(none.Map.Statics.Count == 1 && none.Map.Statics[0].Id == 65535 && none.Map.Statics[0].Hue == 123 && none.Map.Statics[0].Z == -128, "unavailable generated statics omitted; unavailable manual statics preserved exactly");
            Check(none.Notes.Any(n => n.Contains("1 land cells, 1 static cells; 1 distinct cells")), "both exhausted candidate types reported without double-counting missing cells");
            var landOnlyMissing = filterCatalog.Compile(filterSource, false, 19, new HashSet<int>(), null);
            Check(landOnlyMissing.Matched == 0 && landOnlyMissing.Missing == 1 && landOnlyMissing.Map.Land[0] == 3 && landOnlyMissing.Map.Statics.Count == 2, "unavailable land leaves base and available static can compile as partial missing cell");
            var staticsOnlyMissing = filterCatalog.Compile(filterSource, false, 19, null, new HashSet<int>());
            Check(staticsOnlyMissing.Matched == 0 && staticsOnlyMissing.Missing == 1 && staticsOnlyMissing.Map.Land[0] == noFilter.Map.Land[0] && staticsOnlyMissing.Map.Statics.Count == 1, "unavailable required static is missing, while unchecked land candidate retains old behavior");
            var manualFilterSource = filterSource.Clone(); manualFilterSource.Materials[0] = -1; manualFilterSource.Land[0] = 16383;
            var manualFiltered = filterCatalog.Compile(manualFilterSource, true, 19, new HashSet<int>(), new HashSet<int>());
            Check(manualFiltered.Matched == 0 && manualFiltered.Missing == 0 && manualFiltered.Map.Land[0] == 16383 && manualFiltered.Map.Elevation[0] == 22 && manualFiltered.Map.Statics[0].Id == 65535, "manual tile cells bypass client filtering and retain manual statics");
            Check(filterSource.Land[0] == 777 && filterSource.Elevation[0] == 22 && filterSource.Statics.Count == 1 && filterSource.Materials[0] == 1, "all filtered compiles leave source untouched");
            var afterFilter = filterCatalog.Compile(filterSource, false, 19);
            Check(afterFilter.Map.Land.SequenceEqual(noFilter.Map.Land) && afterFilter.Map.Statics.Select(s => s.Id).SequenceEqual(noFilter.Map.Statics.Select(s => s.Id)), "filtering does not mutate catalog alternatives or future unfiltered results");
            var repeatFilter = filterCatalog.Compile(filterSource, false, 19, new HashSet<int> { 30 }, new HashSet<int> { 201 });
            Check(repeatFilter.Map.Land.SequenceEqual(singleAlternative.Map.Land) && repeatFilter.Map.Statics.Select(s => s.Id).SequenceEqual(singleAlternative.Map.Statics.Select(s => s.Id)), "filtered variants are deterministic");
            string staticOnlyRule = "<TransInfo HashKey='010101010101010101'><MapTiles/><StaticTiles><StaticTile TileID='201' AltIDMod='0'/></StaticTiles></TransInfo>";
            var staticOnly = Catalog.Load(Fixture(root, "static-only-filter", staticOnlyRule)).Compile(Fill(1, 1, 1, 777, 22), false, 0, new HashSet<int>(), new HashSet<int> { 201 });
            Check(staticOnly.Matched == 1 && staticOnly.Missing == 0 && staticOnly.Map.Land[0] == 3 && staticOnly.Map.Statics.Count == 1, "originally static-only rule needs no available land candidate");
            if (args.Length > 0)
            {
                var actual = Catalog.Load(args[0]);
                Console.WriteLine(actual.Summary);
                foreach (string warning in actual.Warnings) Console.WriteLine("WARNING " + warning);
                Check(actual.Terrains.Count == 93 && actual.LegacyAltitudes.Count == 176, "actual archive terrain/height coverage audited");
                Check(actual.RuleCount == 47775 && actual.QuarantinedCount == 8 && actual.ConflictCount == 0, "actual archive all valid transition rules imported and eight malformed/empty quarantined");
                var affected = actual.RuleInventory().Where(r => r.LandTileIds.Contains((ushort)504) || r.LandTileIds.Contains((ushort)1350)).ToList();
                Check(affected.Count == 6, "six actual rules reference the installed-client missing art IDs");
                var availableForRegression = new HashSet<int>(Enumerable.Range(0, 0x4000));
                availableForRegression.Remove(504); availableForRegression.Remove(1350);
                foreach (var affectedRule in affected)
                {
                    var source = Fill(3, 3, 1, 3, 22);
                    for (int i = 0; i < 9; i++) source.Materials[i] = affectedRule.Materials[i];
                    for (int seed = 0; seed < 32; seed++)
                    {
                        var safe = actual.Compile(source, false, seed, availableForRegression, null);
                        Check(safe.Map.Land[4] != 504 && safe.Map.Land[4] != 1350 && safe.Map.Elevation[4] == 22, "actual missing art alternatives are excluded across seeds without changing Z");
                    }
                }
                int pairs = 0;
                foreach (var a in actual.Terrains) foreach (var b in actual.Terrains)
                {
                    var pair = new MapDocument(2, 1);
                    pair.Materials[0] = a.Id; pair.Materials[1] = b.Id;
                    pair.Land[0] = a.TileId; pair.Land[1] = b.TileId;
                    pair.Elevation[0] = -128; pair.Elevation[1] = 127;
                    var compiled = actual.Compile(pair);
                    Check(compiled.Map.Elevation[0] == -128 && compiled.Map.Elevation[1] == 127, "ordered material pair supports full altitude extrema");
                    pairs++;
                }
                Console.WriteLine("Compiled " + pairs + " ordered material pairs without missing-rule crashes.");
            }
            Console.WriteLine("PASS " + checks + " catalog checks.");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
