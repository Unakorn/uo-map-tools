using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace TerrainStudio
{
    public static class CoreTests
    {
        private static int assertions;
        private static string root;

        public static int Main()
        {
            root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "core-test-output-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                TestDimensionsAndValidation();
                TestAllHeights();
                TestHeightErrorsAndLegacy();
                TestMulOrdering();
                TestEveryLandId();
                TestProjects();
                Console.WriteLine("PASS: " + assertions + " assertions. Test fixtures: " + root);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("FAIL: " + ex);
                return 1;
            }
        }

        private static void Check(bool condition, string message)
        {
            assertions++;
            if (!condition) throw new Exception(message);
        }

        private static void Throws<T>(Action action, string message) where T : Exception
        {
            assertions++;
            try { action(); }
            catch (T) { return; }
            throw new Exception(message);
        }

        private static void TestDimensionsAndValidation()
        {
            Throws<ArgumentOutOfRangeException>(() => new MapDocument(0, 8), "Zero width must be rejected.");
            Throws<ArgumentOutOfRangeException>(() => new MapDocument(8, -1), "Negative height must be rejected.");
            Throws<ArgumentOutOfRangeException>(() => new MapDocument(8193, 8), "Oversized dimension must be rejected.");
            Throws<ArgumentOutOfRangeException>(() => new MapDocument(8192, 8192), "Oversized area must be rejected.");
            Check(MapDocument.CheckedTileCount(7168, 4096) == 29360128, "A full-size classic facet must fit.");
            MapDocument m = new MapDocument(8, 8);
            Check(m.Land[0] == 3 && m.Elevation[0] == 0 && m.Materials[0] == -1, "Blank defaults must be exact manual land at zero.");
            m.Land[17] = 0x4000;
            Throws<InvalidDataException>(() => m.Validate(), "Invalid land IDs must be rejected.");
            m.Land[17] = 0x3FFF;
            m.Validate();
            m.Materials[0] = -2;
            Throws<InvalidDataException>(() => m.Validate(), "Invalid material sentinel must be rejected.");
            m.Materials[0] = -1;
            m.Statics.Add(new StaticPlacement { X = 8, Y = 0 });
            Throws<InvalidDataException>(() => m.Validate(), "Out-of-bounds statics must be rejected.");
            m.Statics[0].X = -1;
            Throws<InvalidDataException>(() => m.Validate(), "Negative static coordinates must be rejected.");
            m.Statics.Clear();
            m.Elevation = new sbyte[1];
            Throws<InvalidDataException>(() => m.Validate(), "Layer sizes must match the map.");
            Throws<InvalidDataException>(() => MapIO.SaveMul(new MapDocument(9, 8), Path.Combine(root, "bad-size")), "Unaligned MUL dimensions must fail.");
            Check(!Directory.Exists(Path.Combine(root, "bad-size")), "Invalid MUL export must not create output.");
            Throws<ArgumentOutOfRangeException>(() => MapIO.SaveMul(new MapDocument(8, 8), Path.Combine(root, "bad-facet"), -1), "Negative facet must fail.");
        }

        private static void TestAllHeights()
        {
            MapDocument m = new MapDocument(16, 16);
            for (int i = 0; i < 256; i++) m.Elevation[i] = (sbyte)(i - 128);
            using (Bitmap image = HeightImages.Export(m))
            {
                sbyte[] actual = HeightImages.Import(image, false, null);
                for (int i = 0; i < 256; i++)
                {
                    Check(actual[i] == i - 128, "Every signed altitude must round-trip.");
                    Color pixel = image.GetPixel(i % 16, i / 16);
                    Check(pixel.R == i && pixel.G == i && pixel.B == i && pixel.A == 255, "Export shades must map exactly to Z+128.");
                }
                string png = Path.Combine(root, "all-heights.png");
                string bmp = Path.Combine(root, "all-heights.bmp");
                image.Save(png, ImageFormat.Png); image.Save(bmp, ImageFormat.Bmp);
                foreach (string path in new[] { png, bmp })
                    using (Bitmap reopened = new Bitmap(path))
                    {
                        sbyte[] values = HeightImages.Import(reopened, false, null);
                        for (int i = 0; i < 256; i++) Check(values[i] == i - 128, "PNG/BMP must preserve every height.");
                    }
            }
            // Indexed grayscale is accepted by decoded RGB, not palette-index guesswork.
            using (Bitmap indexed = new Bitmap(256, 1, PixelFormat.Format8bppIndexed))
            {
                ColorPalette palette = indexed.Palette;
                for (int i = 0; i < 256; i++) palette.Entries[i] = Color.FromArgb(255, 255 - i, 255 - i, 255 - i);
                indexed.Palette = palette;
                BitmapData bits = indexed.LockBits(new Rectangle(0, 0, 256, 1), ImageLockMode.WriteOnly, PixelFormat.Format8bppIndexed);
                byte[] pixels = new byte[256];
                for (int i = 0; i < 256; i++) pixels[i] = (byte)i;
                Marshal.Copy(pixels, 0, bits.Scan0, 256);
                indexed.UnlockBits(bits);
                sbyte[] actual = HeightImages.Import(indexed, false, null);
                for (int i = 0; i < 256; i++) Check(actual[i] == 127 - i, "Indexed image must honor palette RGB.");
            }
        }

        private static void TestHeightErrorsAndLegacy()
        {
            using (Bitmap image = new Bitmap(2, 1, PixelFormat.Format32bppArgb))
            {
                image.SetPixel(0, 0, Color.FromArgb(255, 128, 128, 128));
                image.SetPixel(1, 0, Color.FromArgb(255, 128, 129, 128));
                try
                {
                    HeightImages.Import(image, false, null);
                    throw new Exception("Colored height pixel must fail.");
                }
                catch (InvalidDataException ex) { Check(ex.Message.Contains("(1, 0)"), "Import error must identify exact pixel."); }
                image.SetPixel(1, 0, Color.FromArgb(127, 128, 128, 128));
                Throws<InvalidDataException>(() => HeightImages.Import(image, false, null), "Translucent height pixel must fail.");
                image.SetPixel(1, 0, Color.FromArgb(255, 1, 2, 3));
                Dictionary<int, int> palette = new Dictionary<int, int>();
                palette[0x808080] = -42; palette[0x010203] = 127;
                sbyte[] legacy = HeightImages.Import(image, true, palette);
                Check(legacy[0] == -42 && legacy[1] == 127, "Legacy exact palette must take precedence over gray decoding.");
                palette.Remove(0x010203);
                Throws<InvalidDataException>(() => HeightImages.Import(image, true, palette), "Missing legacy color must fail.");
                palette[0x010203] = 128;
                Throws<InvalidDataException>(() => HeightImages.Import(image, true, palette), "Out-of-range positive legacy Z must fail.");
                palette[0x010203] = -129;
                Throws<InvalidDataException>(() => HeightImages.Import(image, true, palette), "Out-of-range negative legacy Z must fail.");
            }
        }

        private static void TestMulOrdering()
        {
            MapDocument m = new MapDocument(16, 24);
            for (int y = 0; y < m.Height; y++)
            for (int x = 0; x < m.Width; x++)
            {
                m.Land[y * m.Width + x] = (ushort)(y * 16 + x);
                m.Elevation[y * m.Width + x] = (sbyte)((y * 16 + x) % 256 - 128);
            }
            m.Statics.Add(new StaticPlacement { X = 9, Y = 17, Id = 0xFFFF, Hue = 0xABCD, Z = -128 });
            m.Statics.Add(new StaticPlacement { X = 0, Y = 0, Id = 0x1234, Hue = 0, Z = 127 });
            m.Statics.Add(new StaticPlacement { X = 15, Y = 23, Id = 7, Hue = 1, Z = -1 });
            string folder = Path.Combine(root, "mul-order");
            MapIO.SaveMul(m, folder);
            byte[] map = File.ReadAllBytes(Path.Combine(folder, "map0.mul"));
            Check(map.Length == 6 * 196, "MUL size must be block count times 196.");
            // Fixed positions independently specify the six blocks: (0,0),(0,8),(0,16),(8,0),(8,8),(8,16).
            int[] firstIds = { 0, 128, 256, 8, 136, 264 };
            for (int block = 0; block < 6; block++)
            {
                int offset = block * 196;
                Check(BitConverter.ToUInt32(map, offset) == 0, "Header must be zero.");
                Check(BitConverter.ToUInt16(map, offset + 4) == firstIds[block], "Blocks must run x-major.");
                Check(BitConverter.ToUInt16(map, offset + 7) == firstIds[block] + 1, "Local X must advance first.");
                Check(BitConverter.ToUInt16(map, offset + 28) == firstIds[block] + 16, "Local Y must advance after eight X cells.");
                Check(BitConverter.ToUInt16(map, offset + 193) == firstIds[block] + 119, "Last tile must be (7,7).");
            }
            Check(map[6] == 128 && map[6 + 3 * 7] == 135, "Negative Z must use signed-byte bit representation.");
            byte[] idx = File.ReadAllBytes(Path.Combine(folder, "staidx0.mul"));
            byte[] sta = File.ReadAllBytes(Path.Combine(folder, "statics0.mul"));
            Check(idx.Length == 72 && sta.Length == 21, "Static index and data lengths must match records.");
            Check(BitConverter.ToInt32(idx, 0) == 0 && BitConverter.ToInt32(idx, 4) == 7, "First static block must point to one record.");
            Check(BitConverter.ToInt32(idx, 12) == -1 && BitConverter.ToInt32(idx, 16) == 0, "Empty static block must use -1 lookup and zero length.");
            Check(BitConverter.ToInt32(idx, 60) == 7 && BitConverter.ToInt32(idx, 64) == 14, "Last static block must point to its two records.");
            Check(BitConverter.ToUInt16(sta, 0) == 0x1234 && sta[4] == 127, "Statics must be serialized by block.");
            Check(BitConverter.ToUInt16(sta, 7) == 0xFFFF && sta[9] == 1 && sta[10] == 1 && sta[11] == 128 && BitConverter.ToUInt16(sta, 12) == 0xABCD, "All static fields and unsigned ID/hue limits must be exact.");
            Check(sta[16] == 7 && sta[17] == 7 && sta[18] == 255, "Last static local coordinates and Z must be exact.");
            byte[] before = File.ReadAllBytes(Path.Combine(folder, "map0.mul"));
            Throws<IOException>(() => MapIO.SaveMul(m, folder), "Existing export must not be overwritten.");
            byte[] after = File.ReadAllBytes(Path.Combine(folder, "map0.mul"));
            Check(before.Length == after.Length && before[6] == after[6], "Existing export must be preserved.");
            Check(Directory.GetDirectories(folder).Length == 0, "Completed export must remove its staging folder.");
        }

        private static void TestEveryLandId()
        {
            MapDocument m = new MapDocument(128, 128);
            for (int i = 0; i < m.Land.Length; i++) m.Land[i] = (ushort)i;
            string folder = Path.Combine(root, "all-land-ids");
            MapIO.SaveMul(m, folder, 5);
            byte[] bytes = File.ReadAllBytes(Path.Combine(folder, "map5.mul"));
            HashSet<ushort> ids = new HashSet<ushort>();
            for (int block = 0; block < 256; block++)
            for (int local = 0; local < 64; local++) ids.Add(BitConverter.ToUInt16(bytes, block * 196 + 4 + local * 3));
            Check(ids.Count == 16384 && ids.Contains(0) && ids.Contains(0x3FFF), "Export must preserve all 16,384 land IDs without category exclusions.");
        }

        private static void TestProjects()
        {
            MapDocument m = new MapDocument(9, 13);
            for (int i = 0; i < m.Land.Length; i++)
            {
                m.Land[i] = (ushort)(i + 100); m.Elevation[i] = (sbyte)(i - 64); m.Materials[i] = i % 3 == 0 ? -1 : i;
            }
            m.Statics.Add(new StaticPlacement { X = 8, Y = 12, Id = 65535, Hue = 65535, Z = -128 });
            MapDocument clone = m.Clone();
            clone.Land[0] = 2; clone.Elevation[0] = 2; clone.Materials[0] = 2; clone.Statics[0].Id = 2;
            Check(m.Land[0] == 100 && m.Elevation[0] == -64 && m.Materials[0] == -1 && m.Statics[0].Id == 65535, "Clone must deep-copy every layer and placement.");
            string path = Path.Combine(root, "roundtrip.uots");
            MapIO.SaveProject(m, path);
            MapDocument actual = MapIO.LoadProject(path);
            Check(actual.Width == 9 && actual.Height == 13, "Project dimensions need not be MUL-aligned.");
            for (int i = 0; i < m.Land.Length; i++)
                Check(m.Land[i] == actual.Land[i] && m.Elevation[i] == actual.Elevation[i] && m.Materials[i] == actual.Materials[i], "Project must preserve all map layers.");
            Check(actual.Statics.Count == 1 && actual.Statics[0].X == 8 && actual.Statics[0].Y == 12 && actual.Statics[0].Id == 65535 && actual.Statics[0].Hue == 65535 && actual.Statics[0].Z == -128, "Project must preserve every static field.");
            m.Elevation[0] = 127; MapIO.SaveProject(m, path);
            Check(MapIO.LoadProject(path).Elevation[0] == 127, "Confirmed project replacement must update atomically.");
            byte[] bytes = File.ReadAllBytes(path);
            string corrupt = Path.Combine(root, "corrupt.uots");
            byte[] shortFile = new byte[bytes.Length - 1]; Array.Copy(bytes, shortFile, shortFile.Length);
            File.WriteAllBytes(corrupt, shortFile);
            Throws<InvalidDataException>(() => MapIO.LoadProject(corrupt), "Truncated project must fail.");
            bytes[4] = 99; File.WriteAllBytes(corrupt, bytes);
            Throws<InvalidDataException>(() => MapIO.LoadProject(corrupt), "Unknown project version must fail.");
            bytes[4] = 1; bytes[24] = 0; bytes[25] = 0x40; File.WriteAllBytes(corrupt, bytes);
            Throws<InvalidDataException>(() => MapIO.LoadProject(corrupt), "Project containing invalid land ID must fail.");
        }
    }
}
