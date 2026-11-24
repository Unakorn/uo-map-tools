using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using TerrainStudio;

// Standalone diagnostic executable, intentionally excluded from the production application build.
public static class TransitionLabProbe
{
    static void Require(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
    static string Csv(object value) { return "\"" + Convert.ToString(value, CultureInfo.InvariantCulture).Replace("\"", "\"\"") + "\""; }
    static void Row(TextWriter writer, params object[] values) { writer.WriteLine(String.Join(",", values.Select(Csv))); }
    static bool Boundary(MapDocument map, int x, int y)
    {
        int material = map.Materials[y * map.Width + x];
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++)
        {
            int nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < map.Width && ny < map.Height && map.Materials[ny * map.Width + nx] != material) return true;
        }
        return false;
    }
    static bool Matched(CellResolution state) { return state == CellResolution.Matched || state == CellResolution.LegacyAutocorrect; }
    static void Unchanged(MapDocument source, MapDocument snapshot)
    {
        Require(source.Land.SequenceEqual(snapshot.Land) && source.Materials.SequenceEqual(snapshot.Materials) &&
            source.Elevation.SequenceEqual(snapshot.Elevation) && source.Statics.Count == snapshot.Statics.Count, "Probe compilation modified its source fixture.");
    }
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3) throw new ArgumentException("Usage: TransitionLabProbe.exe <catalog Data folder> <read-only client folder> <new output folder>");
            string dataPath = Path.GetFullPath(args[0]), clientPath = Path.GetFullPath(args[1]), output = Path.GetFullPath(args[2]);
            string clientPrefix = clientPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            Require(!String.Equals(output, clientPath, StringComparison.OrdinalIgnoreCase) && !output.StartsWith(clientPrefix, StringComparison.OrdinalIgnoreCase), "Probe output must be outside the client installation.");
            Require(!Directory.Exists(output) && !File.Exists(output), "Probe output must be a fresh folder; existing artifacts are never overwritten.");
            var catalog = Catalog.Load(dataPath); var byId = catalog.Terrains.ToDictionary(t => t.Id);
            var land = new HashSet<int>(); var statics = new HashSet<int>();
            using (var assets = ClientAssets.Open(clientPath))
            {
                for (int id = 0; id < 16384; id++) { int texture = assets.LandTextureId(id); if (assets.HasLandArt(id) || (texture != 0 && assets.HasTexture(texture))) land.Add(id); }
                for (int id = 0; id < 65536; id++) if (assets.HasStaticArt(id)) statics.Add(id);
            }
            Require(land.Count > 0 && statics.Count > 0, "Expected installed-client land/static availability could not be established.");
            Directory.CreateDirectory(output);
            var totals = new long[2, 5]; int rows = 0;
            using (var csv = new StreamWriter(Path.Combine(output, "transition-cases.csv"), false, new UTF8Encoding(false)))
            {
                Row(csv, "background_id", "background_name", "foreground_id", "foreground_name", "shape", "width", "allow_legacy_autocorrect", "source_z", "seed", "matched", "missing", "conflicts", "unavailable_candidate", "autocorrect_skipped", "legacy_autocorrect_used", "generated_statics", "mixed_neighborhood_cells", "mixed_matched", "mixed_missing", "mixed_autocorrect_skipped", "foreground_cells", "foreground_land_changed", "foreground_resolved_to_background_base");
                foreach (int foregroundId in new[] { 4, 18, 6, 17 }) foreach (string shape in TransitionLab.Shapes) for (int width = 1; width <= 4; width++)
                {
                    var source = TransitionLab.Create(byId[1], byId[foregroundId], shape, width, 0, 0); var snapshot = source.Clone();
                    for (int mode = 0; mode < 2; mode++)
                    {
                        bool allowAutocorrect = mode == 1;
                        var result = catalog.Compile(source, false, 0, land, statics, true, allowAutocorrect);
                        Unchanged(source, snapshot);
                        Require(result.Map.Materials.SequenceEqual(source.Materials) && result.Map.Elevation.SequenceEqual(source.Elevation), "Compilation changed material identity or exact height.");
                        Require(result.States != null && result.States.Length == 1024 && result.States.Count(Matched) == result.Matched && result.Matched + result.Missing == 1024, "Diagnostic partition is inconsistent.");
                        int mixed = 0, mixedMatched = 0, mixedMissing = 0, mixedSkipped = 0, foregroundCount = 0, changed = 0, replaced = 0;
                        for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++)
                        {
                            int i = y * 32 + x;
                            if (Boundary(source, x, y)) { mixed++; if (Matched(result.States[i])) mixedMatched++; else mixedMissing++; if (result.States[i] == CellResolution.AutocorrectSkipped) mixedSkipped++; }
                            if (source.Materials[i] == foregroundId) { foregroundCount++; if (result.Map.Land[i] != source.Land[i]) changed++; if (result.Map.Land[i] == byId[1].TileId) replaced++; }
                        }
                        int unavailable = result.States.Count(s => s == CellResolution.UnavailableCandidate), used = result.States.Count(s => s == CellResolution.LegacyAutocorrect);
                        Row(csv, 1, byId[1].Name, foregroundId, byId[foregroundId].Name, shape, width, allowAutocorrect, 0, 0, result.Matched, result.Missing, result.Conflicts, unavailable, result.AutocorrectSkipped, used, result.Map.Statics.Count, mixed, mixedMatched, mixedMissing, mixedSkipped, foregroundCount, changed, replaced);
                        totals[mode, 0] += result.Matched; totals[mode, 1] += result.Missing; totals[mode, 2] += result.AutocorrectSkipped; totals[mode, 3] += unavailable; totals[mode, 4] += used; rows++;
                    }
                }
            }
            Require(rows == 256, "Expected 256 probe cases.");
            string fixtures = Path.Combine(output, "blue-tile-source-fixtures"); Directory.CreateDirectory(fixtures);
            for (int width = 1; width <= 4; width++)
            {
                var map = TransitionLab.Create(byId[1], byId[17], "Vertical strip", width, 0, 0);
                string stem = Path.Combine(fixtures, "grass-blue-tile-vertical-width-" + width);
                MapIO.SaveProject(map, stem + ".uostudio");
                using (var bitmap = TerrainImages.Export(map, catalog)) bitmap.Save(stem + "-terrain.png", ImageFormat.Png);
                using (var bitmap = HeightImages.Export(map)) bitmap.Save(stem + "-height.png", ImageFormat.Png);
                var loaded = MapIO.LoadProject(stem + ".uostudio"); Unchanged(map, loaded);
            }
            var sample = TransitionLab.Create(byId[1], byId[17], "Vertical strip", 1, 0, 0);
            var compiled = catalog.Compile(sample, false, 0, land, statics, true, false);
            string mul = Path.Combine(output, "mul-sample-32x32-autocorrect-off"); MapIO.SaveMul(compiled.Map, mul, 0);
            long mapLength = new FileInfo(Path.Combine(mul, "map0.mul")).Length, indexLength = new FileInfo(Path.Combine(mul, "staidx0.mul")).Length, staticsLength = new FileInfo(Path.Combine(mul, "statics0.mul")).Length;
            Require(mapLength == 16 * 196 && indexLength == 16 * 12 && staticsLength == compiled.Map.Statics.Count * 7L, "Export byte lengths disagree with 32x32 MUL records.");
            var summary = new StringBuilder();
            summary.AppendLine("TRANSITION LAB: ACTUAL CATALOG + READ-ONLY CLIENT AVAILABILITY");
            summary.AppendLine("Catalog: " + dataPath); summary.AppendLine("Client: " + clientPath);
            summary.AppendLine("Availability matches the native UI's indexed-art or associated-texture checks: " + land.Count + " land slots, " + statics.Count + " static slots. No client files were written; this is not a fresh artwork-decode or in-game visual audit.");
            summary.AppendLine("256 rows: Grass against Sand / Rock / Shallow Water / Blue Tile; eight shapes; widths 1-4; both autocorrect modes. Every fixture is 32x32, seed 0, exact flat Z0, legacy height offsets OFF.");
            for (int mode = 0; mode < 2; mode++) summary.AppendLine("Autocorrect " + (mode == 0 ? "OFF (new UI default)" : "ON (legacy)") + ": 128 cases; matched " + totals[mode, 0] + "; missing " + totals[mode, 1] + "; autocorrect skipped " + totals[mode, 2] + "; unavailable candidates " + totals[mode, 3] + "; explicitly labeled autocorrect used " + totals[mode, 4] + ".");
            summary.AppendLine("Mixed-neighborhood counts include any cell whose in-bounds 3x3 neighborhood contains a different material. They cover both sides of a border, including diagonals. They exclude uniform interior cells from this boundary summary.");
            summary.AppendLine("Foreground land changes include legitimate transition/variant IDs. Resolving to the background base is recorded as a concrete fact, not automatically classified as a visual defect. Matching a rule or possessing indexed artwork does not prove a seam is correct in-game.");
            summary.AppendLine("The four Blue Tile source projects retain materials and exact Z. Source terrain/height PNGs are exact 32x32 files; the height image is uniformly shade128 (Z0). Autocorrect is a build option and is not stored in the project.");
            summary.AppendLine("MUL sample: one Blue Tile cell-wide vertical strip with autocorrect OFF; map0.mul=" + mapLength + " bytes; staidx0.mul=" + indexLength + " bytes; statics0.mul=" + staticsLength + " bytes (" + compiled.Map.Statics.Count + " generated statics). These are sample files outside the client, requiring matching facet dimensions for any in-game use.");
            summary.AppendLine("Source immutability, material IDs, exact heights, diagnostic totals, project round trips, and export lengths were verified during this probe.");
            File.WriteAllText(Path.Combine(output, "README.txt"), summary.ToString(), new UTF8Encoding(false)); Console.WriteLine(summary.ToString()); return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
