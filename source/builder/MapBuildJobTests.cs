using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace TerrainStudio
{
    public static class MapBuildJobTests
    {
        static int checks;
        static void Check(bool condition, string message) { checks++; if (!condition) throw new Exception("FAILED: " + message); }
        static void Fail(Action action, string contains, string message)
        {
            try { action(); } catch (Exception ex) { Check(ex.Message.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0, message + " (unexpected error: " + ex.Message + ")"); return; }
            throw new Exception("FAILED: " + message + " did not reject input.");
        }
        static void Image(string path, int width, int height, Func<int, int, Color> pixel)
        {
            using (var image = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) image.SetPixel(x, y, pixel(x, y));
                image.Save(path, ImageFormat.Png);
            }
        }
        static string CatalogFolder(string root, bool duplicate)
        {
            string folder = Path.Combine(root, duplicate ? "duplicate-catalog" : "catalog");
            Directory.CreateDirectory(Path.Combine(folder, "System")); Directory.CreateDirectory(Path.Combine(folder, "Transitions"));
            File.WriteAllText(Path.Combine(folder, "System", "Terrain.xml"), "<Terrains><Terrain ID='1' Name='Grass' TileID='3' R='0' G='100' B='0'/><Terrain ID='17' Name='Blue Tile' TileID='528' R='0' G='60' B='95'/>" + (duplicate ? "<Terrain ID='56' Name='Duplicate' TileID='100' R='0' G='100' B='0'/>" : "") + "</Terrains>");
            File.WriteAllText(Path.Combine(folder, "Transitions", "test.xml"), "<Trans>" +
                "<TransInfo Description='Uniform grass' HashKey='010101010101010101'><MapTiles><MapTile TileID='100' AltIDMod='2'/></MapTiles><StaticTiles><StaticTile TileID='200' AltIDMod='-3'/></StaticTiles></TransInfo>" +
                "<TransInfo Description='Blue Tile to Grass AC' HashKey='010101011101010101'><MapTiles><MapTile TileID='3' AltIDMod='0'/></MapTiles><StaticTiles/></TransInfo></Trans>");
            return folder;
        }
        static MapBuildOptions Options(string terrain, string altitude, string output)
        {
            return new MapBuildOptions { TerrainPath = terrain, AltitudePath = altitude, OutputDirectory = output, RequireTerrainTextures = false };
        }
        static string TextureClient(string root, params int[] texturedLand)
        {
            string folder = Path.Combine(root, "texture-client-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder);
            var ids = new HashSet<int>(texturedLand);
            using (var writer = new BinaryWriter(File.Create(Path.Combine(folder, "tiledata.mul"))))
            {
                for (int group = 0; group < 512; group++)
                {
                    writer.Write(0);
                    for (int n = 0; n < 32; n++) { writer.Write((uint)0); writer.Write((ushort)(ids.Contains(group * 32 + n) ? 1 : 0)); writer.Write(new byte[20]); }
                }
                writer.Write(0); for (int n = 0; n < 32; n++) writer.Write(new byte[37]);
            }
            using (var writer = new BinaryWriter(File.Create(Path.Combine(folder, "texmaps.mul"))))
                for (int i = 0; i < 4096; i++) writer.Write((ushort)0x03E0);
            using (var writer = new BinaryWriter(File.Create(Path.Combine(folder, "texidx.mul"))))
            { writer.Write(-1); writer.Write(-1); writer.Write(0); writer.Write(0); writer.Write(8192); writer.Write(0); }
            return folder;
        }
        static void CheckMap(string folder, int width, int height, Func<int, int, ushort> tile, Func<int, int, sbyte> z)
        {
            using (var reader = new BinaryReader(File.OpenRead(Path.Combine(folder, "map0.mul"))))
            {
                Check(reader.BaseStream.Length == (width / 8) * (height / 8) * 196L, "Map file byte length.");
                for (int bx = 0; bx < width / 8; bx++) for (int by = 0; by < height / 8; by++)
                {
                    Check(reader.ReadUInt32() == 0, "Map block header.");
                    for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++)
                    {
                        int mx = bx * 8 + x, my = by * 8 + y;
                        Check(reader.ReadUInt16() == tile(mx, my), "Map tile ID at expected X-major block / row-major cell offset.");
                        Check(reader.ReadSByte() == z(mx, my), "Map signed height at expected X-major block / row-major cell offset.");
                    }
                }
                Check(reader.BaseStream.Position == reader.BaseStream.Length, "No extra map bytes.");
            }
        }
        static void CheckStatics(string folder, int width, int height, Func<int, int, sbyte> z)
        {
            using (var index = new BinaryReader(File.OpenRead(Path.Combine(folder, "staidx0.mul"))))
            using (var statics = new BinaryReader(File.OpenRead(Path.Combine(folder, "statics0.mul"))))
            {
                Check(index.BaseStream.Length == (width / 8) * (height / 8) * 12L, "Static index length.");
                Check(statics.BaseStream.Length == width * height * 7L, "One generated static per exact matching cell.");
                for (int bx = 0; bx < width / 8; bx++) for (int by = 0; by < height / 8; by++)
                {
                    Check(index.ReadInt32() == statics.BaseStream.Position, "Index offset points into matching block.");
                    Check(index.ReadInt32() == 64 * 7 && index.ReadInt32() == 0, "Static block count and header.");
                    for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++)
                    {
                        Check(statics.ReadUInt16() == 200, "Exact static ID.");
                        Check(statics.ReadByte() == x && statics.ReadByte() == y, "Static local coordinates.");
                        Check(statics.ReadSByte() == z(bx * 8 + x, by * 8 + y), "Exact static signed Z.");
                        Check(statics.ReadUInt16() == 0, "Static hue preserved as zero.");
                    }
                }
            }
        }
        static T FormField<T>(MapBuildForm form, string name) { return (T)typeof(MapBuildForm).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form); }
        static void CheckFormFacet(Catalog catalog, string client, string terrain, string altitude, string output)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new MapBuildForm(catalog, client))
            {
                form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-32000, -32000); form.Show(); Application.DoEvents();
                SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
                var facet = FormField<ComboBox>(form, "facet");
                Check(facet.Items.Count == 6 && facet.SelectedIndex == 0, "The small builder defaults to map0 and offers six map file numbers.");
                FormField<TextBox>(form, "terrainPath").Text = terrain; FormField<TextBox>(form, "altitudePath").Text = altitude; FormField<TextBox>(form, "outputPath").Text = output;
                facet.SelectedIndex = 5; Check(form.LastResult == null, "Selecting a map file does not run an intermediate build.");
                var task = form.BuildAsync(); DateTime deadline = DateTime.UtcNow.AddSeconds(30);
                while (!task.IsCompleted && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(1); }
                Check(task.IsCompleted, "GUI-selected facet build finishes."); task.GetAwaiter().GetResult();
                Check(form.LastResult != null && form.LastResult.Facet == 5, "GUI map-file selection is passed into the build job. " + FormField<TextBox>(form, "report").Text);
                Check(File.Exists(Path.Combine(form.LastResult.OutputDirectory, "map5.mul")) && !File.Exists(Path.Combine(form.LastResult.OutputDirectory, "map0.mul")), "GUI-selected Ter Mur output is map5, even for a custom-sized test image.");
                form.Close(); Application.DoEvents();
            }
        }
        [STAThread]
        public static int Main(string[] args)
        {
            try
            {
                string fixtureParent = Path.GetTempPath();
                if (fixtureParent.Length > 100) fixtureParent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Codex");
                string root = Path.Combine(fixtureParent, "uo-mbjob-" + Guid.NewGuid().ToString("N").Substring(0, 8));
                Directory.CreateDirectory(root);
                Catalog catalog = Catalog.Load(CatalogFolder(root, false));
                string terrain = Path.Combine(root, "terrain.png"), altitude = Path.Combine(root, "altitude.png");
                Image(terrain, 16, 16, (x, y) => Color.FromArgb(0, 100, 0));
                Image(altitude, 16, 16, (x, y) => Color.FromArgb(y * 16 + x, y * 16 + x, y * 16 + x));
                byte[] terrainBefore = File.ReadAllBytes(terrain), altitudeBefore = File.ReadAllBytes(altitude);
                string output = Path.Combine(root, "built-maps"); var notifications = new List<string>();
                var first = MapBuildJob.Run(catalog, Options(terrain, altitude, output), value => { notifications.Add(value); Check(!Directory.Exists(output), "Validation and compilation finish before creating output."); });
                Check(notifications.Count == 3, "Progress reports one continuous build operation.");
                Check(first.Width == 16 && first.Height == 16 && first.Matched == 256 && first.Missing == 0 && first.GeneratedStatics == 256, "Result reports exact dimensions and catalog counts.");
                Check(File.ReadAllText(first.ReportPath) == first.Report && first.Report.Contains("Z = shade - 128"), "Report is published with completed output.");
                Check(Directory.GetDirectories(output).Length == 1 && Directory.GetFiles(first.OutputDirectory).Length == 4, "Only a completed result folder with three MUL files and report is published.");
                CheckMap(first.OutputDirectory, 16, 16, (x, y) => 100, (x, y) => (sbyte)(y * 16 + x - 128));
                CheckStatics(first.OutputDirectory, 16, 16, (x, y) => (sbyte)(y * 16 + x - 128));
                Check(terrainBefore.SequenceEqual(File.ReadAllBytes(terrain)) && altitudeBefore.SequenceEqual(File.ReadAllBytes(altitude)), "Both input images remain byte-identical.");
                string bitmapTerrain = Path.Combine(root, "terrain.bmp"), bitmapAltitude = Path.Combine(root, "altitude.bmp");
                using (var image = new Bitmap(terrain)) image.Save(bitmapTerrain, ImageFormat.Bmp);
                using (var image = new Bitmap(altitude)) image.Save(bitmapAltitude, ImageFormat.Bmp);
                var bitmapResult = MapBuildJob.Run(catalog, Options(bitmapTerrain, bitmapAltitude, Path.Combine(root, "bitmap-output")));
                Check(File.ReadAllBytes(Path.Combine(first.OutputDirectory, "map0.mul")).SequenceEqual(File.ReadAllBytes(Path.Combine(bitmapResult.OutputDirectory, "map0.mul"))), "Exact BMP inputs produce the same map bytes as PNG inputs.");
                byte[] completedBefore = File.ReadAllBytes(Path.Combine(first.OutputDirectory, "map0.mul"));
                File.WriteAllText(Path.Combine(output, "map0.mul"), "Existing map, do not overwrite");
                var second = MapBuildJob.Run(catalog, Options(terrain, altitude, output));
                Check(second.OutputDirectory != first.OutputDirectory && Directory.GetDirectories(output).Length == 2, "Repeated builds create distinct result folders.");
                Check(completedBefore.SequenceEqual(File.ReadAllBytes(Path.Combine(first.OutputDirectory, "map0.mul"))) && File.ReadAllText(Path.Combine(output, "map0.mul")) == "Existing map, do not overwrite", "Existing map files and prior completed build stay intact.");

                string invalidOutput = Path.Combine(root, "invalid-output");
                string wrongSize = Path.Combine(root, "wrong-size.png"); Image(wrongSize, 8, 16, (x, y) => Color.Gray);
                Fail(() => MapBuildJob.Run(catalog, Options(terrain, wrongSize, invalidOutput)), "same dimensions", "Mismatched dimensions rejected.");
                string narrowTerrain = Path.Combine(root, "seven-wide-terrain.png"), narrowHeight = Path.Combine(root, "seven-wide-altitude.png");
                Image(narrowTerrain, 7, 8, (x, y) => Color.FromArgb(0, 100, 0)); Image(narrowHeight, 7, 8, (x, y) => Color.Gray);
                Fail(() => MapBuildJob.Run(catalog, Options(narrowTerrain, narrowHeight, invalidOutput)), "divisible by 8", "Non-MUL dimensions rejected without padding.");
                string badTerrain = Path.Combine(root, "bad-terrain.png"); Image(badTerrain, 16, 16, (x, y) => Color.Red);
                Fail(() => MapBuildJob.Run(catalog, Options(badTerrain, altitude, invalidOutput)), "Unknown terrain color", "Off-palette terrain rejected.");
                Image(badTerrain, 16, 16, (x, y) => Color.FromArgb(128, 0, 100, 0));
                Fail(() => MapBuildJob.Run(catalog, Options(badTerrain, altitude, invalidOutput)), "Unknown terrain color", "Translucent terrain rejected.");
                string badHeight = Path.Combine(root, "bad-height.png"); Image(badHeight, 16, 16, (x, y) => Color.FromArgb(0, 80, 0));
                Fail(() => MapBuildJob.Run(catalog, Options(terrain, badHeight, invalidOutput)), "exact grayscale", "Legacy green height encoding is not silently inferred.");
                Image(badHeight, 16, 16, (x, y) => Color.FromArgb(128, 80, 80, 80));
                Fail(() => MapBuildJob.Run(catalog, Options(terrain, badHeight, invalidOutput)), "transparent", "Translucent altitude rejected.");
                var duplicate = Catalog.Load(CatalogFolder(root, true));
                Fail(() => MapBuildJob.Run(duplicate, Options(terrain, altitude, invalidOutput)), "Ambiguous", "Ambiguous RGB material identity rejected.");
                Fail(() => MapBuildJob.Run(catalog, Options(Path.Combine(root, "absent.png"), altitude, invalidOutput)), "does not exist", "Absent image rejected.");
                string lossy = Path.Combine(root, "terrain.jpg"); using (var image = new Bitmap(terrain)) image.Save(lossy, ImageFormat.Jpeg);
                Fail(() => MapBuildJob.Run(catalog, Options(lossy, altitude, invalidOutput)), "PNG or BMP", "Lossy image formats rejected explicitly.");
                string outputFile = Path.Combine(root, "output-is-file"); File.WriteAllText(outputFile, "unchanged");
                Fail(() => MapBuildJob.Run(catalog, Options(terrain, altitude, outputFile)), "existing file", "An output file cannot be used as a directory.");
                Check(File.ReadAllText(outputFile) == "unchanged", "Rejected output path does not alter its existing file.");
                Check(!Directory.Exists(invalidOutput), "Every invalid-image case leaves output absent.");

                var offsets = Options(terrain, altitude, invalidOutput); offsets.ApplyLegacyZOffsets = true;
                Fail(() => MapBuildJob.Run(catalog, offsets), "outside -128..127", "Invalid legacy height offsets rejected before publication.");
                Check(!Directory.Exists(invalidOutput), "Offset failure creates no output.");
                string flat = Path.Combine(root, "flat-altitude.png"); Image(flat, 16, 16, (x, y) => Color.FromArgb(128, 128, 128));
                offsets.AltitudePath = flat; offsets.OutputDirectory = output; var raised = MapBuildJob.Run(catalog, offsets);
                CheckMap(raised.OutputDirectory, 16, 16, (x, y) => 100, (x, y) => 2);
                CheckStatics(raised.OutputDirectory, 16, 16, (x, y) => -3);

                string client = Path.Combine(root, "client"); Directory.CreateDirectory(client); File.WriteAllText(Path.Combine(client, "marker.txt"), "unchanged");
                var clientOptions = Options(terrain, flat, Path.Combine(client, "nested", "output")); clientOptions.ClientPath = client;
                Fail(() => MapBuildJob.Run(catalog, clientOptions), "outside the UO client", "Client descendant output rejected.");
                clientOptions.OutputDirectory = client;
                Fail(() => MapBuildJob.Run(catalog, clientOptions), "outside the UO client", "Client-root output rejected.");
                Check(Directory.GetDirectories(client).Length == 0 && File.ReadAllText(Path.Combine(client, "marker.txt")) == "unchanged", "Client folder remains unchanged.");
                clientOptions.OutputDirectory = Path.Combine(root, "client-other");
                var sibling = MapBuildJob.Run(catalog, clientOptions);
                Check(File.Exists(sibling.ReportPath), "A similarly prefixed sibling is outside the client and allowed.");

                string island = Path.Combine(root, "blue-island.png"); Image(island, 16, 16, (x, y) => x == 7 && y == 7 ? Color.FromArgb(0, 60, 95) : Color.FromArgb(0, 100, 0));
                var keepOptions = Options(island, flat, output); var kept = MapBuildJob.Run(catalog, keepOptions);
                Check(kept.AutocorrectSkipped == 1 && kept.Missing == 9, "Default build skips explicit legacy autocorrect, reporting unresolved cells.");
                CheckMap(kept.OutputDirectory, 16, 16, (x, y) => x == 7 && y == 7 ? (ushort)528 : Math.Abs(x - 7) <= 1 && Math.Abs(y - 7) <= 1 ? (ushort)3 : (ushort)100, (x, y) => 0);
                keepOptions.AllowLegacyAutocorrect = true; var corrected = MapBuildJob.Run(catalog, keepOptions);
                Check(corrected.AutocorrectSkipped == 0 && corrected.Missing == 8, "Legacy autocorrect is explicit and separately counted.");
                CheckMap(corrected.OutputDirectory, 16, 16, (x, y) => Math.Abs(x - 7) <= 1 && Math.Abs(y - 7) <= 1 ? (ushort)3 : (ushort)100, (x, y) => 0);
                Check(!Directory.GetDirectories(output).Any(p => Path.GetFileName(p).StartsWith(".uo-map-build-", StringComparison.Ordinal)), "No staging folders remain after successful builds.");
                var strict = new MapBuildOptions { TerrainPath = terrain, AltitudePath = altitude, OutputDirectory = Path.Combine(root, "texture-output") };
                Check(strict.RequireTerrainTextures, "Texture-backed terrain is the default job policy.");
                Fail(() => MapBuildJob.Run(catalog, strict), "client folder", "Strict texture mode requires client data.");
                strict.ClientPath = TextureClient(root, 100);
                byte[] metadataBefore = File.ReadAllBytes(Path.Combine(strict.ClientPath, "tiledata.mul"));
                var textured = MapBuildJob.Run(catalog, strict);
                Check(textured.GeneratedStatics == 0 && textured.Matched == 0 && textured.Missing == 256, "Strict mode excludes all static-art transitions and reports their absence while retaining available terrain texture transitions.");
                CheckMap(textured.OutputDirectory, 16, 16, (x, y) => 100, (x, y) => (sbyte)(y * 16 + x - 128));
                Check(new FileInfo(Path.Combine(textured.OutputDirectory, "statics0.mul")).Length == 0, "Strict output has an empty static artwork file.");
                using (var index = new BinaryReader(File.OpenRead(Path.Combine(textured.OutputDirectory, "staidx0.mul"))))
                    for (int i = 0; i < 4; i++) Check(index.ReadInt32() == -1 && index.ReadInt32() == 0 && index.ReadInt32() == 0, "Strict static index marks every block empty.");
                Check(textured.Report.Contains("does not force the client renderer to use textures on flat ground"), "Strict report does not claim renderer behavior was forced.");
                Check(metadataBefore.SequenceEqual(File.ReadAllBytes(Path.Combine(strict.ClientPath, "tiledata.mul"))), "Texture metadata was read only.");
                strict.ClientPath = TextureClient(root, 3); // Rule land 100 is unavailable; valid base 3 remains.
                var fallback = MapBuildJob.Run(catalog, strict);
                CheckMap(fallback.OutputDirectory, 16, 16, (x, y) => 3, (x, y) => (sbyte)(y * 16 + x - 128));
                Check(fallback.Missing == 256 && fallback.GeneratedStatics == 0, "Unavailable transition artwork is not substituted, and textured base fallback is reported.");
                strict.ClientPath = TextureClient(root, 528); strict.OutputDirectory = Path.Combine(root, "missing-texture-output");
                Fail(() => MapBuildJob.Run(catalog, strict), "land ID 3", "An untextured fallback is rejected with its exact tile ID.");
                Check(!Directory.Exists(strict.OutputDirectory), "Missing base texture is rejected before creating output.");
                for (int facet = 0; facet <= 5; facet++)
                {
                    var facetOptions = Options(terrain, altitude, Path.Combine(root, "facet-output")); facetOptions.Facet = facet;
                    var selected = MapBuildJob.Run(catalog, facetOptions);
                    Check(selected.Facet == facet && selected.Report.Contains("Map file number: " + facet), "Selected map file number is recorded in result and report.");
                    var names = Directory.GetFiles(selected.OutputDirectory).Select(Path.GetFileName).OrderBy(n => n).ToArray();
                    Check(names.SequenceEqual(new[] { "build-report.txt", "map" + facet + ".mul", "staidx" + facet + ".mul", "statics" + facet + ".mul" }.OrderBy(n => n)), "Only the selected map/static/index filenames are published.");
                    foreach (string prefix in new[] { "map", "staidx", "statics" })
                        Check(File.ReadAllBytes(Path.Combine(first.OutputDirectory, prefix + "0.mul")).SequenceEqual(File.ReadAllBytes(Path.Combine(selected.OutputDirectory, prefix + facet + ".mul"))), "Facet changes filenames without altering exact map records or custom dimensions.");
                }
                foreach (int invalidFacet in new[] { -1, 6, Int32.MaxValue })
                {
                    var invalidFacetOptions = Options(terrain, altitude, Path.Combine(root, "invalid-facet-output")); invalidFacetOptions.Facet = invalidFacet;
                    Fail(() => MapBuildJob.Run(catalog, invalidFacetOptions), "0 through 5", "Unsupported map file number rejected.");
                    Check(!Directory.Exists(invalidFacetOptions.OutputDirectory), "Invalid facet creates no output.");
                }
                var savedError = Console.Error;
                try
                {
                    using (var errorText = new StringWriter())
                    {
                        Console.SetError(errorText);
                        Check(MapBuildCommand.Main(new[] { terrain, altitude, output, client, "6" }) == 2, "CLI rejects an out-of-range fifth argument as usage error.");
                        Check(MapBuildCommand.Main(new[] { terrain, altitude, output, client, "water" }) == 2, "CLI rejects nonnumeric map file arguments.");
                    }
                }
                finally { Console.SetError(savedError); }
                CheckFormFacet(catalog, TextureClient(root, 3, 100), terrain, altitude, Path.Combine(root, "gui-facet-output"));
                Console.WriteLine("Map build job: " + checks + " checks passed. Fixtures: " + root); return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }
    }
}
