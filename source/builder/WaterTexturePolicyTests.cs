using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;

namespace TerrainStudio
{
    public static class WaterTexturePolicyTests
    {
        static int checks;
        static void Check(bool value, string why) { checks++; if (!value) throw new Exception("FAILED: " + why); }
        static void Reject(Action action, string why)
        {
            try { action(); } catch (InvalidDataException e) { Check(e.Message.Contains("genuine Wet water surface") && e.Message.Contains("No output files"), why); return; }
            throw new Exception("FAILED: expected water rejection: " + why);
        }
        static Catalog FixtureCatalog(string root)
        {
            string path = Path.Combine(root, "catalog"); Directory.CreateDirectory(Path.Combine(path, "System")); Directory.CreateDirectory(Path.Combine(path, "Transitions"));
            File.WriteAllText(Path.Combine(path, "System", "Terrain.xml"), "<Terrains>" +
                "<Terrain ID='5' Name='Deep Water' TileID='168' R='0' G='0' B='130'/>" +
                "<Terrain ID='6' Name='Shallow Water' TileID='102' R='0' G='0' B='170'/>" +
                "<Terrain ID='9' Name='Water' TileID='168' R='0' G='110' B='255'/>" +
                "<Terrain ID='1' Name='Sand' TileID='102' R='255' G='255' B='0'/></Terrains>");
            return Catalog.Load(path);
        }
        static string Client(string root, int flagsBytes, bool first, bool second, bool wet, string waterName, int textureLength, string redirect)
        {
            string path = Path.Combine(root, "client-" + Guid.NewGuid().ToString("N").Substring(0, 8)); Directory.CreateDirectory(path);
            using (var w = new BinaryWriter(File.Create(Path.Combine(path, "tiledata.mul"))))
            {
                for (int group = 0; group < 512; group++)
                {
                    w.Write(0);
                    for (int n = 0; n < 32; n++)
                    {
                        int id = group * 32 + n; bool water = id == 310 || id == 311 || id == 10049;
                        ulong flags = water && wet ? 0xC0UL : 0x40UL;
                        if (flagsBytes == 8) w.Write(flags | 0x100000000UL); else w.Write((uint)flags);
                        w.Write((ushort)(id == 102 ? 76 : water ? id : 0));
                        byte[] name = new byte[20]; Encoding.ASCII.GetBytes(water ? waterName : "NoName").CopyTo(name, 0); w.Write(name);
                    }
                }
                w.Write(0); for (int n = 0; n < 32; n++) w.Write(new byte[flagsBytes + 33]);
            }
            using (var tex = new BinaryWriter(File.Create(Path.Combine(path, "texmaps.mul"))))
            using (var index = new BinaryWriter(File.Create(Path.Combine(path, "texidx.mul"))))
            {
                for (int id = 0; id <= 10049; id++)
                {
                    bool exists = id == 76 || id == 310 && first || id == 311 && second || id == 10049;
                    int length = id == 76 || id == 10049 ? 8192 : textureLength;
                    index.Write(exists ? (int)tex.BaseStream.Position : -1); index.Write(exists ? length : -1); index.Write(0);
                    if (exists) for (int i = 0; i < length / 2; i++) tex.Write((ushort)(id == 76 ? 0x28A0 : 0x011F));
                }
            }
            if (redirect != null) File.WriteAllText(Path.Combine(path, "TexTerr.def"), redirect);
            return path;
        }
        static void Images(string root, out string terrain, out string altitude)
        {
            terrain = Path.Combine(root, "Terrain.png"); altitude = Path.Combine(root, "Heightmap.png");
            using (var t = new Bitmap(16, 16)) using (var h = new Bitmap(16, 16))
            {
                for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++)
                {
                    t.SetPixel(x, y, x < 4 ? Color.FromArgb(0, 0, 130) : x < 8 ? Color.FromArgb(0, 0, 170) : x < 12 ? Color.FromArgb(0, 110, 255) : Color.Yellow);
                    int shade = y * 16 + x; h.SetPixel(x, y, Color.FromArgb(shade, shade, shade));
                }
                t.Save(terrain, ImageFormat.Png); h.Save(altitude, ImageFormat.Png);
            }
        }
        static ushort Tile(byte[] map, int x, int y) { return BitConverter.ToUInt16(map, ((x / 8) * 2 + y / 8) * 196 + 4 + ((y % 8) * 8 + x % 8) * 3); }
        static MapBuildOptions Options(string terrain, string altitude, string root, string client) { return new MapBuildOptions { TerrainPath = terrain, AltitudePath = altitude, OutputDirectory = Path.Combine(root, "output-" + Guid.NewGuid().ToString("N").Substring(0, 8)), ClientPath = client }; }
        [STAThread]
        public static int Main(string[] args)
        {
            try
            {
                string root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "water-fixtures-" + Guid.NewGuid().ToString("N").Substring(0, 8)); Directory.CreateDirectory(root);
                Catalog catalog = FixtureCatalog(root); string terrain, altitude; Images(root, out terrain, out altitude);
                byte[] terrainBefore = File.ReadAllBytes(terrain), altitudeBefore = File.ReadAllBytes(altitude);
                string client = Client(root, 8, true, true, true, "water", 8192, null);
                byte[] metadataBefore = File.ReadAllBytes(Path.Combine(client, "tiledata.mul"));
                var options = Options(terrain, altitude, root, client); var built = MapBuildJob.Run(catalog, options);
                byte[] bytes = File.ReadAllBytes(Path.Combine(built.OutputDirectory, "map0.mul")); var variants = new HashSet<int>();
                for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++)
                {
                    ushort id = Tile(bytes, x, y); if (x < 12) { Check(id == 310 || id == 311, "Each of all three water materials emits canonical water, even untextured deep-water base."); variants.Add(id); }
                    else Check(id == 102, "Nonwater material using identical dry base is preserved.");
                    int off = ((x / 8) * 2 + y / 8) * 196 + 4 + ((y % 8) * 8 + x % 8) * 3;
                    Check(unchecked((sbyte)bytes[off + 2]) == y * 16 + x - 128, "All 256 input heights, including both signed extremes, preserved exactly.");
                }
                Check(variants.Count == 2 && built.TextureWaterCells == 192 && built.TextureWaterCorrections == 192, "Water report counts and deterministic texture variation.");
                Check(built.Missing == 256 && built.Matched == 0 && built.GeneratedStatics == 0, "Repair does not fabricate legacy transition resolution or statics.");
                Check(built.Report.Contains("shoreline texture blending is not supplied") && built.Report.Contains("static texture variants"), "Report explains limits honestly.");
                Check(new FileInfo(Path.Combine(built.OutputDirectory, "statics0.mul")).Length == 0, "No static water file payload.");
                byte[] index = File.ReadAllBytes(Path.Combine(built.OutputDirectory, "staidx0.mul"));
                for (int i = 0; i < index.Length; i += 12) Check(BitConverter.ToInt32(index, i) == -1 && BitConverter.ToInt32(index, i + 4) == 0 && BitConverter.ToInt32(index, i + 8) == 0, "Every statics block empty.");
                var again = MapBuildJob.Run(catalog, options); Check(bytes.SequenceEqual(File.ReadAllBytes(Path.Combine(again.OutputDirectory, "map0.mul"))), "Repeated builds deterministic.");
                Check(terrainBefore.SequenceEqual(File.ReadAllBytes(terrain)) && altitudeBefore.SequenceEqual(File.ReadAllBytes(altitude)) && metadataBefore.SequenceEqual(File.ReadAllBytes(Path.Combine(client, "tiledata.mul"))), "Source PNGs and client tiledata never modified.");
                using (ClientAssets assets = ClientAssets.Open(client))
                {
                    Check(assets.LandFlags(310) == 0x1000000C0UL, "64-bit flags retained without truncation.");
                    var policy = WaterTexturePolicy.Inspect(assets); var source = new MapDocument(8, 8); var compiled = source.Clone();
                    source.Materials[0] = 6; source.Materials[1] = 5; source.Materials[2] = 9; source.Materials[3] = -1; source.Materials[4] = 1;
                    compiled.Land[0] = 310; compiled.Land[1] = 311; compiled.Land[2] = 556; compiled.Land[3] = 102; compiled.Land[4] = 102;
                    for (int i = 0; i < 64; i++) { source.Elevation[i] = (sbyte)(i - 32); compiled.Elevation[i] = source.Elevation[i]; }
                    var original = source.Clone(); var result = policy.Apply(catalog, source, compiled);
                    Check(result.WaterCells == 3 && result.CorrectedCells == 1 && compiled.Land[0] == 310 && compiled.Land[1] == 311, "Keep already valid water and replace legacy rock only on water source.");
                    Check(compiled.Land[3] == 102 && compiled.Land[4] == 102 && compiled.Elevation.SequenceEqual(source.Elevation), "Manual placements, nonwater and signed heights remain unchanged.");
                    Check(source.Land.SequenceEqual(original.Land) && source.Materials.SequenceEqual(original.Materials), "Pure source remains unchanged.");
                    catalog.Terrains.Single(t => t.Id == 6).Name = "Custom rock";
                    source.Materials[0] = 6; compiled.Land[0] = 102; policy.Apply(catalog, source, compiled); Check(compiled.Land[0] == 102, "ID alone does not reinterpret a custom material as water.");
                    catalog.Terrains.Single(t => t.Id == 6).Name = "Shallow Water";
                }
                string single = Client(root, 4, false, true, true, "water", 8192, null);
                using (ClientAssets assets = ClientAssets.Open(single)) Check(assets.LandFlags(311) == 0xC0UL, "32-bit flags retained.");
                var one = MapBuildJob.Run(catalog, Options(terrain, altitude, root, single)); byte[] oneBytes = File.ReadAllBytes(Path.Combine(one.OutputDirectory, "map0.mul"));
                Check(Enumerable.Range(0, 256).All(i => Tile(oneBytes, i % 16, i / 16) == (i % 16 < 12 ? 311 : 102)), "One verified water texture suffices; missing first candidate never leaks.");
                string aliased = Client(root, 4, false, true, true, "water", 8192, "310 {311}\n");
                var alias = MapBuildJob.Run(catalog, Options(terrain, altitude, root, aliased)); Check(alias.TextureWaterCorrections == 192, "Canonical-water TexTerr alias remains valid.");
                foreach (string invalid in new[] {
                    Client(root, 4, false, false, true, "water", 8192, null),
                    Client(root, 4, true, true, false, "water", 8192, null),
                    Client(root, 4, true, true, true, "acid", 8192, null),
                    Client(root, 4, true, true, true, "TerrainFallback", 8192, null),
                    Client(root, 4, true, true, true, "water", 42, null),
                    Client(root, 4, true, true, true, "water", 8192, "310 {76}\n311 {76}\n") })
                {
                    var bad = Options(terrain, altitude, root, invalid); Reject(() => MapBuildJob.Run(catalog, bad), "Unavailable, dry, acid, fallback, malformed or redirected seabed rejected."); Check(!Directory.Exists(bad.OutputDirectory), "Invalid water leaves no output or staging folder.");
                }
                options.RequireTerrainTextures = false; var legacy = MapBuildJob.Run(catalog, options); byte[] old = File.ReadAllBytes(Path.Combine(legacy.OutputDirectory, "map0.mul"));
                Check(Tile(old, 0, 0) == 168 && Tile(old, 4, 0) == 102 && Tile(old, 8, 0) == 168 && legacy.TextureWaterCorrections == 0, "Explicit legacy mode unaffected by texture-only policy.");
                Console.WriteLine("Water texture policy: " + checks + " checks passed. Fixtures: " + root); return 0;
            }
            catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        }
    }
}
