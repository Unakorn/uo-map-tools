using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using TerrainStudio;

// Standalone installed-client check; excluded from the production application build.
// Usage: RunImageBuildProbe.exe <Data folder> <read-only client folder> <new output folder>
public static class RunImageBuildProbe
{
    static int checks;
    static void Check(bool ok, string message) { checks++; if (!ok) throw new InvalidDataException(message); }
    static string Hash(string path) { using (var sha = SHA256.Create()) using (var stream = File.OpenRead(path)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", ""); }
    static void MakeImage(string path, Func<int, int, Color> pixel)
    {
        using (var image = new Bitmap(32, 32, PixelFormat.Format32bppArgb))
        {
            for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) image.SetPixel(x, y, pixel(x, y));
            image.Save(path, ImageFormat.Png);
        }
    }
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3) throw new ArgumentException("Usage: RunImageBuildProbe.exe <Data folder> <read-only client folder> <new output folder>");
            string data = Path.GetFullPath(args[0]), client = Path.GetFullPath(args[1]), root = Path.GetFullPath(args[2]);
            if (Directory.Exists(root) || File.Exists(root)) throw new IOException("Choose a new probe output folder; existing examples will not be overwritten.");
            var catalog = Catalog.Load(data);
            var grass = catalog.Terrains.Single(t => t.Id == 1); var sand = catalog.Terrains.Single(t => t.Id == 4); var blue = catalog.Terrains.Single(t => t.Id == 17);
            var clientHashes = new Dictionary<string, string>();
            foreach (string name in new[] { "tiledata.mul", "texidx.mul", "texmaps.mul" }) clientHashes.Add(name, Hash(Path.Combine(client, name)));
            Directory.CreateDirectory(root);
            string terrainPath = Path.Combine(root, "grass-sand-terrain.png"), altitudePath = Path.Combine(root, "all-heights-altitude.png"), rejectedPath = Path.Combine(root, "blue-tile-terrain-rejected.png");
            MakeImage(terrainPath, (x, y) => x < 16 ? grass.Color : sand.Color);
            MakeImage(altitudePath, (x, y) => { int shade = (y * 32 + x) & 255; return Color.FromArgb(shade, shade, shade); });
            MakeImage(rejectedPath, (x, y) => x == 15 && y == 15 ? blue.Color : grass.Color);
            string terrainHash = Hash(terrainPath), altitudeHash = Hash(altitudePath), rejectedHash = Hash(rejectedPath);
            var result = MapBuildJob.Run(catalog, new MapBuildOptions {
                TerrainPath = terrainPath, AltitudePath = altitudePath, ClientPath = client,
                OutputDirectory = Path.Combine(root, "completed-builds")
            });
            Check(result.Width == 32 && result.Height == 32, "Build dimensions were changed.");
            Check(result.GeneratedStatics == 0, "Strict build generated static artwork.");
            var usedLand = new SortedSet<int>();
            using (var assets = ClientAssets.Open(client))
            using (var map = new BinaryReader(File.OpenRead(Path.Combine(result.OutputDirectory, "map0.mul"))))
            using (var index = new BinaryReader(File.OpenRead(Path.Combine(result.OutputDirectory, "staidx0.mul"))))
            {
                Check(map.BaseStream.Length == 16 * 196, "Map byte length does not match 32 x 32.");
                Check(index.BaseStream.Length == 16 * 12, "Index byte length does not match 32 x 32.");
                Check(new FileInfo(Path.Combine(result.OutputDirectory, "statics0.mul")).Length == 0, "Static file is not empty.");
                for (int bx = 0; bx < 4; bx++) for (int by = 0; by < 4; by++)
                {
                    Check(map.ReadUInt32() == 0, "Map block header was not zero.");
                    Check(index.ReadInt32() == -1 && index.ReadInt32() == 0 && index.ReadInt32() == 0, "Static block is not empty.");
                    for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++)
                    {
                        int mapX = bx * 8 + x, mapY = by * 8 + y;
                        int id = map.ReadUInt16(), texture = assets.LandTextureId(id); usedLand.Add(id);
                        Check(texture != 0 && assets.HasTexture(texture), "Serialized land ID has no associated indexed texture at " + mapX + "," + mapY + ": " + id);
                        Check(map.ReadSByte() == (sbyte)(((mapY * 32 + mapX) & 255) - 128), "Serialized signed height changed at " + mapX + "," + mapY);
                    }
                }
                Check(map.BaseStream.Position == map.BaseStream.Length, "Extra map bytes remained.");
                int blueTexture = assets.LandTextureId(blue.TileId);
                Check(blueTexture == 0 || !assets.HasTexture(blueTexture), "This client now has a usable Blue Tile base texture; update the expected-rejection fixture.");
            }
            string rejectedOutput = Path.Combine(root, "must-not-exist-rejected-build"); string rejectedMessage = null;
            try { MapBuildJob.Run(catalog, new MapBuildOptions { TerrainPath = rejectedPath, AltitudePath = altitudePath, ClientPath = client, OutputDirectory = rejectedOutput }); }
            catch (InvalidDataException ex) { rejectedMessage = ex.Message; }
            Check(rejectedMessage != null && rejectedMessage.Contains("Texture-backed output rejected") && rejectedMessage.Contains("528") && rejectedMessage.Contains("(15, 15)"), "Blue Tile did not produce the expected precise texture rejection.");
            Check(!Directory.Exists(rejectedOutput), "Rejected build created an output folder.");
            Check(terrainHash == Hash(terrainPath) && altitudeHash == Hash(altitudePath) && rejectedHash == Hash(rejectedPath), "Input PNG bytes changed.");
            foreach (var item in clientHashes) Check(item.Value == Hash(Path.Combine(client, item.Key)), "Client texture metadata/data changed: " + item.Key);
            var report = new StringBuilder();
            report.AppendLine("TWO-IMAGE BUILD: INSTALLED-CLIENT PROBE");
            report.AppendLine("Client: " + client); report.AppendLine("Catalog: " + data);
            report.AppendLine("Use grass-sand-terrain.png and all-heights-altitude.png as the two build inputs.");
            report.AppendLine("Both images are exactly 32 x 32. The height image repeats all 256 grayscale shades four times. It tests signed-height encoding, not a natural smooth landscape.");
            report.AppendLine("Completed build: " + Path.GetFileName(result.OutputDirectory));
            report.AppendLine("Matched: " + result.Matched + "; unresolved: " + result.Missing + "; explicitly labeled autocorrect skipped: " + result.AutocorrectSkipped + "; generated statics: " + result.GeneratedStatics + ".");
            report.AppendLine("Every serialized map cell was read independently: exact signed Z preserved, each terrain ID has a nonzero associated indexed texture, all static-index blocks are empty.");
            report.AppendLine("Serialized terrain IDs: " + String.Join(", ", usedLand));
            report.AppendLine("Texture-backed terrain IDs verified; this does not force the client renderer to use textures on flat ground.");
            report.AppendLine("Blue Tile negative case: " + rejectedMessage);
            report.AppendLine("The rejected build created no output folder. All three input PNG hashes remained unchanged; tiledata.mul, texidx.mul and texmaps.mul SHA-256 hashes remained unchanged.");
            report.AppendLine("Checks passed: " + checks + ". No game client was launched; in-game bank, seam and slope rendering remains unverified.");
            File.WriteAllText(Path.Combine(root, "README.txt"), report.ToString(), new UTF8Encoding(false));
            Console.WriteLine(report.ToString()); return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
