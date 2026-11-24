using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace TerrainStudio
{
    /// <summary>Synthetic integration tests; no user images or game installation required.</summary>
    public static class ImageInputsTests
    {
        private static int assertions;
        public static int Main(string[] args)
        {
            try { Run(); if (args.Length > 0) RunActualCatalog(args[0]); return 0; }
            catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        }

        public static void Run()
        {
            Catalog catalog = Palette();
            int[] expectedMaterials = { 7, 200, 7, 200, 7, 200 };
            ushort[] expectedLand = { 3, 0x3FFF, 3, 0x3FFF, 3, 0x3FFF };
            using (Bitmap source = new Bitmap(3, 2, PixelFormat.Format32bppArgb))
            {
                for (int y = 0; y < 2; y++) for (int x = 0; x < 3; x++)
                    source.SetPixel(x, y, catalog.Terrains[expectedMaterials[y * 3 + x] == 7 ? 0 : 1].Color);
                MapDocument map = TerrainImages.Import(source, catalog);
                Check(map.Width == 3 && map.Height == 2, "non-square dimensions preserved");
                for (int i = 0; i < 6; i++)
                {
                    Check(map.Materials[i] == expectedMaterials[i], "row-major material " + i);
                    Check(map.Land[i] == expectedLand[i], "exact base land " + i);
                    Check(map.Elevation[i] == 0, "terrain import does not invent heights " + i);
                }
                Check(map.Statics.Count == 0, "terrain import does not invent statics");
                using (Bitmap exported = TerrainImages.Export(map, catalog))
                {
                    for (int y = 0; y < 2; y++) for (int x = 0; x < 3; x++)
                        Check(source.GetPixel(x, y).ToArgb() == exported.GetPixel(x, y).ToArgb(), "exact RGB export " + x + "," + y);
                    using (MemoryStream encoded = new MemoryStream())
                    {
                        exported.Save(encoded, ImageFormat.Png); encoded.Position = 0;
                        using (Bitmap png = new Bitmap(encoded))
                        {
                            MapDocument roundtrip = TerrainImages.Import(png, catalog);
                            for (int i = 0; i < 6; i++)
                            {
                                Check(roundtrip.Materials[i] == map.Materials[i], "PNG material roundtrip " + i);
                                Check(roundtrip.Land[i] == map.Land[i], "PNG base tile roundtrip " + i);
                            }
                        }
                    }
                }
                source.SetPixel(1, 0, Color.FromArgb(0, 200, 1));
                ThrowsMessage<ArgumentException>(delegate { TerrainImages.Import(source, catalog); }, "(1, 0)", "one-channel mismatch rejected with coordinate");
                source.SetPixel(1, 0, Color.FromArgb(254, 0, 200, 0));
                ThrowsMessage<ArgumentException>(delegate { TerrainImages.Import(source, catalog); }, "(1, 0)", "partially transparent exact RGB rejected");
                source.SetPixel(1, 0, Color.FromArgb(0, 0, 200, 0));
                ThrowsMessage<ArgumentException>(delegate { TerrainImages.Import(source, catalog); }, "(1, 0)", "fully transparent exact RGB rejected");
                source.SetPixel(1, 0, catalog.Terrains[0].Color);
                catalog.Terrains.Add(new TerrainDefinition { Id = 8, Name = "Duplicate color", TileId = 100, Color = catalog.Terrains[0].Color });
                ThrowsMessage<Exception>(delegate { TerrainImages.Import(source, catalog); }, "ambiguous", "used ambiguous palette color rejected");
                using (Bitmap uniqueColor = new Bitmap(1, 1))
                {
                    uniqueColor.SetPixel(0, 0, catalog.Terrains[1].Color);
                    Check(TerrainImages.Import(uniqueColor, catalog).Materials[0] == 200, "unused duplicate colors do not block unique-color imports");
                }
                ThrowsMessage<InvalidOperationException>(delegate { using (Bitmap unused = TerrainImages.Export(map, catalog)) { } }, "ambiguous", "ambiguous material export cannot lose identity");
                catalog.Terrains.RemoveAt(2);

                map.Materials[2] = -1;
                ThrowsMessage<InvalidOperationException>(delegate { using (Bitmap unused = TerrainImages.Export(map, catalog)) { } }, "manually selected", "manual tile cannot silently lose exact ID");
                map.Materials[2] = 12345;
                ThrowsMessage<InvalidOperationException>(delegate { using (Bitmap unused = TerrainImages.Export(map, catalog)) { } }, "cannot preserve", "unknown material cannot silently become a color");
            }

            using (Bitmap indexed = new Bitmap(2, 1, PixelFormat.Format8bppIndexed))
            {
                ColorPalette colors = indexed.Palette;
                colors.Entries[0] = catalog.Terrains[0].Color; colors.Entries[1] = catalog.Terrains[1].Color;
                indexed.Palette = colors;
                BitmapData data = indexed.LockBits(new Rectangle(0, 0, 2, 1), ImageLockMode.WriteOnly, PixelFormat.Format8bppIndexed);
                try { Marshal.Copy(new byte[] { 1, 0 }, 0, data.Scan0, 2); }
                finally { indexed.UnlockBits(data); }
                MapDocument fromIndexed = TerrainImages.Import(indexed, catalog);
                Check(fromIndexed.Materials[0] == 200 && fromIndexed.Materials[1] == 7, "indexed palette values map by RGB, not index");
            }
            Console.WriteLine("Terrain image inputs: " + assertions + " assertions passed.");
        }

        public static void RunActualCatalog(string dataDirectory)
        {
            Catalog catalog = Catalog.Load(dataDirectory);
            TerrainDefinition grass = catalog.Terrains.Find(delegate(TerrainDefinition t) { return t.Name == "Grass"; });
            TerrainDefinition ambiguous = catalog.Terrains.Find(delegate(TerrainDefinition t) { return (t.Color.ToArgb() & 0xFFFFFF) == 0xC6F184; });
            Check(grass != null && ambiguous != null, "actual catalog includes grass and known duplicate color");
            using (Bitmap image = new Bitmap(2, 1))
            {
                image.SetPixel(0, 0, grass.Color); image.SetPixel(1, 0, grass.Color);
                MapDocument imported = TerrainImages.Import(image, catalog);
                Check(imported.Materials[0] == grass.Id && imported.Materials[1] == grass.Id, "actual grass import unaffected by duplicate elsewhere");
                using (Bitmap exported = TerrainImages.Export(imported, catalog))
                    Check(exported.GetPixel(0, 0).ToArgb() == grass.Color.ToArgb(), "actual grass exports exactly");
                image.SetPixel(1, 0, ambiguous.Color);
                ThrowsMessage<Exception>(delegate { TerrainImages.Import(image, catalog); }, "ambiguous", "actual duplicate RGB cannot guess a material");
                imported.Materials[1] = ambiguous.Id;
                ThrowsMessage<InvalidOperationException>(delegate { using (Bitmap unused = TerrainImages.Export(imported, catalog)) { } }, "ambiguous", "actual duplicate material cannot export lossily");
            }
            Console.WriteLine("Terrain images including actual catalog: " + assertions + " assertions passed.");
        }

        private static Catalog Palette()
        {
            Catalog catalog = new Catalog();
            catalog.Terrains.Add(new TerrainDefinition { Id = 7, Name = "Synthetic grass", TileId = 3, Color = Color.FromArgb(0, 200, 0) });
            catalog.Terrains.Add(new TerrainDefinition { Id = 200, Name = "Synthetic maximum land", TileId = 0x3FFF, Color = Color.FromArgb(255, 254, 253) });
            return catalog;
        }
        private static void Check(bool condition, string description)
        { assertions++; if (!condition) throw new Exception("FAILED: " + description); }
        private static void ThrowsMessage<T>(Action action, string fragment, string description) where T : Exception
        {
            try { action(); }
            catch (T e) { Check(e.Message.IndexOf(fragment, StringComparison.OrdinalIgnoreCase) >= 0, description + " diagnostic: " + e.Message); return; }
            throw new Exception("FAILED: " + description);
        }
    }
}
