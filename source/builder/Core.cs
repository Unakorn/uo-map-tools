using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace TerrainStudio
{
    public sealed class StaticPlacement
    {
        public int X, Y;
        public ushort Id, Hue;
        public sbyte Z;

        public StaticPlacement Clone()
        {
            return new StaticPlacement { X = X, Y = Y, Id = Id, Hue = Hue, Z = Z };
        }
    }

    public sealed class MapDocument
    {
        public const int MaximumDimension = 8192;
        public const int MaximumTiles = 33554432;
        public const int MaximumStatics = 10000000;
        public int Width, Height;
        public ushort[] Land;
        public sbyte[] Elevation;
        public int[] Materials;
        public List<StaticPlacement> Statics;

        public MapDocument(int width, int height)
        {
            int count = CheckedTileCount(width, height);
            Width = width;
            Height = height;
            Land = new ushort[count];
            Elevation = new sbyte[count];
            Materials = new int[count];
            Statics = new List<StaticPlacement>();
            for (int i = 0; i < count; i++) { Land[i] = 3; Materials[i] = -1; }
        }

        public static int CheckedTileCount(int width, int height)
        {
            if (width < 1 || height < 1 || width > MaximumDimension || height > MaximumDimension)
                throw new ArgumentOutOfRangeException("dimensions", "Map dimensions must each be from 1 to 8192 tiles.");
            long count = (long)width * height;
            if (count > MaximumTiles)
                throw new ArgumentOutOfRangeException("dimensions", "A map may contain at most 33,554,432 tiles.");
            return (int)count;
        }

        public void Validate()
        {
            int count = CheckedTileCount(Width, Height);
            if (Land == null || Elevation == null || Materials == null ||
                Land.Length != count || Elevation.Length != count || Materials.Length != count)
                throw new InvalidDataException("Land, elevation, and material layers must exactly match the map dimensions.");
            for (int i = 0; i < count; i++)
            {
                if (Land[i] > 0x3FFF)
                    throw new InvalidDataException(String.Format("Land ID 0x{0:X4} at ({1}, {2}) exceeds the UO land range 0x0000–0x3FFF.", Land[i], i % Width, i / Width));
                if (Materials[i] < -1)
                    throw new InvalidDataException(String.Format("Material ID at ({0}, {1}) must be -1 (manual tile) or a nonnegative material ID.", i % Width, i / Width));
            }
            if (Statics == null || Statics.Count > MaximumStatics)
                throw new InvalidDataException("Static placement list is missing or exceeds 10,000,000 entries.");
            for (int i = 0; i < Statics.Count; i++)
            {
                StaticPlacement p = Statics[i];
                if (p == null || p.X < 0 || p.Y < 0 || p.X >= Width || p.Y >= Height)
                    throw new InvalidDataException("Static placement " + i + " is outside the map bounds or is null.");
            }
        }

        public MapDocument Clone()
        {
            Validate();
            MapDocument result = new MapDocument(Width, Height);
            Array.Copy(Land, result.Land, Land.Length);
            Array.Copy(Elevation, result.Elevation, Elevation.Length);
            Array.Copy(Materials, result.Materials, Materials.Length);
            foreach (StaticPlacement p in Statics) result.Statics.Add(p.Clone());
            return result;
        }
    }

    public static class MapIO
    {
        private const uint ProjectMagic = 0x53544F55; // ASCII UOTS, little endian.
        private const int ProjectVersion = 1;

        // Blocks run X then Y; tiles inside a block run Y then X.
        // Refuses existing target files. Does not modify a client installation implicitly.
        public static void SaveMul(MapDocument document, string directory, int facet = 0)
        {
            if (document == null) throw new ArgumentNullException("document");
            document.Validate();
            if ((document.Width & 7) != 0 || (document.Height & 7) != 0)
                throw new InvalidDataException("UO MUL export requires width and height divisible by 8. No cropping or padding was performed.");
            if (facet < 0 || facet > 255) throw new ArgumentOutOfRangeException("facet", "Facet must be from 0 through 255.");
            string target = Path.GetFullPath(directory);
            string[] names = { "map" + facet + ".mul", "statics" + facet + ".mul", "staidx" + facet + ".mul" };
            foreach (string name in names)
                if (File.Exists(Path.Combine(target, name)) || Directory.Exists(Path.Combine(target, name)))
                    throw new IOException("Export refused to overwrite " + Path.Combine(target, name) + ". Choose an empty export folder.");
            Directory.CreateDirectory(target);
            string staging = Path.Combine(target, ".terrainstudio-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            List<string> moved = new List<string>();
            try
            {
                WriteMulFiles(document, staging, names);
                foreach (string name in names)
                {
                    string destination = Path.Combine(target, name);
                    File.Move(Path.Combine(staging, name), destination); // File.Move never overwrites.
                    moved.Add(destination);
                }
            }
            catch
            {
                // Roll back only files this export successfully moved into place.
                foreach (string path in moved) { try { File.Delete(path); } catch { } }
                throw;
            }
            finally
            {
                // This exact freshly generated staging directory contains only our three files.
                foreach (string name in names) { try { File.Delete(Path.Combine(staging, name)); } catch { } }
                try { Directory.Delete(staging); } catch { }
            }
        }

        private static void WriteMulFiles(MapDocument document, string directory, string[] names)
        {
            int blocksHigh = document.Height / 8;
            Dictionary<int, List<StaticPlacement>> byBlock = new Dictionary<int, List<StaticPlacement>>();
            foreach (StaticPlacement p in document.Statics)
            {
                int block = (p.X / 8) * blocksHigh + p.Y / 8;
                List<StaticPlacement> placements;
                if (!byBlock.TryGetValue(block, out placements))
                    byBlock.Add(block, placements = new List<StaticPlacement>());
                placements.Add(p);
            }
            using (BinaryWriter map = new BinaryWriter(new FileStream(Path.Combine(directory, names[0]), FileMode.CreateNew)))
            using (BinaryWriter statics = new BinaryWriter(new FileStream(Path.Combine(directory, names[1]), FileMode.CreateNew)))
            using (BinaryWriter index = new BinaryWriter(new FileStream(Path.Combine(directory, names[2]), FileMode.CreateNew)))
            {
                for (int bx = 0; bx < document.Width / 8; bx++)
                for (int by = 0; by < blocksHigh; by++)
                {
                    map.Write((uint)0);
                    for (int y = 0; y < 8; y++)
                    for (int x = 0; x < 8; x++)
                    {
                        int at = (by * 8 + y) * document.Width + bx * 8 + x;
                        map.Write(document.Land[at]);
                        map.Write(document.Elevation[at]);
                    }
                    List<StaticPlacement> placements;
                    if (!byBlock.TryGetValue(bx * blocksHigh + by, out placements))
                    {
                        index.Write(-1); index.Write(0); index.Write(0);
                    }
                    else
                    {
                        index.Write(checked((int)statics.BaseStream.Position));
                        index.Write(checked(placements.Count * 7));
                        index.Write(0);
                        foreach (StaticPlacement p in placements)
                        {
                            statics.Write(p.Id);
                            statics.Write((byte)(p.X & 7));
                            statics.Write((byte)(p.Y & 7));
                            statics.Write(p.Z);
                            statics.Write(p.Hue);
                        }
                    }
                }
            }
        }

        // Existing projects are atomically replaced. The UI must obtain overwrite consent.
        public static void SaveProject(MapDocument document, string path)
        {
            if (document == null) throw new ArgumentNullException("document");
            document.Validate();
            string destination = Path.GetFullPath(path);
            string directory = Path.GetDirectoryName(destination);
            Directory.CreateDirectory(directory);
            string staging = Path.Combine(directory, ".uots-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (BinaryWriter writer = new BinaryWriter(new FileStream(staging, FileMode.CreateNew)))
                {
                    writer.Write(ProjectMagic); writer.Write(ProjectVersion);
                    writer.Write(document.Width); writer.Write(document.Height);
                    writer.Write(document.Land.Length); writer.Write(document.Statics.Count);
                    for (int i = 0; i < document.Land.Length; i++)
                    {
                        writer.Write(document.Land[i]);
                        writer.Write(document.Elevation[i]);
                        writer.Write(document.Materials[i]);
                    }
                    foreach (StaticPlacement p in document.Statics)
                    {
                        writer.Write(p.X); writer.Write(p.Y); writer.Write(p.Id); writer.Write(p.Hue); writer.Write(p.Z);
                    }
                }
                if (File.Exists(destination)) File.Replace(staging, destination, null);
                else File.Move(staging, destination);
            }
            finally { if (File.Exists(staging)) File.Delete(staging); }
        }

        public static MapDocument LoadProject(string path)
        {
            using (BinaryReader reader = new BinaryReader(new FileStream(path, FileMode.Open, FileAccess.Read)))
            {
                if (reader.BaseStream.Length < 24) throw new InvalidDataException("Project header is truncated.");
                if (reader.ReadUInt32() != ProjectMagic) throw new InvalidDataException("This file is not a Terrain Studio project.");
                if (reader.ReadInt32() != ProjectVersion) throw new InvalidDataException("This project version is not supported.");
                int width = reader.ReadInt32(), height = reader.ReadInt32();
                int count = reader.ReadInt32(), staticCount = reader.ReadInt32();
                int expected = MapDocument.CheckedTileCount(width, height);
                if (count != expected || staticCount < 0 || staticCount > MapDocument.MaximumStatics)
                    throw new InvalidDataException("Project layer sizes or static count are invalid.");
                long expectedBytes = 24L + 7L * count + 13L * staticCount;
                if (reader.BaseStream.Length != expectedBytes)
                    throw new InvalidDataException("Project length does not match its dimensions and layers; it may be truncated or corrupt.");
                MapDocument result = new MapDocument(width, height);
                for (int i = 0; i < count; i++)
                {
                    result.Land[i] = reader.ReadUInt16();
                    result.Elevation[i] = reader.ReadSByte();
                    result.Materials[i] = reader.ReadInt32();
                }
                for (int i = 0; i < staticCount; i++)
                    result.Statics.Add(new StaticPlacement { X = reader.ReadInt32(), Y = reader.ReadInt32(), Id = reader.ReadUInt16(), Hue = reader.ReadUInt16(), Z = reader.ReadSByte() });
                result.Validate();
                return result;
            }
        }
    }

    public static class HeightImages
    {
        // Legacy dictionary keys are 24-bit RGB (0xRRGGBB), not signed ARGB.
        // No interpolation, luminance conversion, normalization, or gamma adjustment occurs.
        public static sbyte[] Import(Bitmap image, bool legacy, Dictionary<int, int> legacyRgbToZ)
        {
            if (image == null) throw new ArgumentNullException("image");
            int count = MapDocument.CheckedTileCount(image.Width, image.Height);
            if (legacy && legacyRgbToZ == null) throw new ArgumentNullException("legacyRgbToZ");
            sbyte[] heights = new sbyte[count];
            BitmapData data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                byte[] row = new byte[image.Width * 4];
                for (int y = 0; y < image.Height; y++)
                {
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                    for (int x = 0; x < image.Width; x++)
                    {
                        int offset = x * 4, b = row[offset], g = row[offset + 1], r = row[offset + 2];
                        if (row[offset + 3] != 255) throw PixelError(x, y, "is transparent or translucent; every height pixel must be fully opaque");
                        int z;
                        if (legacy)
                        {
                            if (!legacyRgbToZ.TryGetValue((r << 16) | (g << 8) | b, out z))
                                throw PixelError(x, y, String.Format("has RGB #{0:X2}{1:X2}{2:X2}, which is absent from the selected legacy altitude palette", r, g, b));
                            if (z < -128 || z > 127) throw PixelError(x, y, "maps outside the UO altitude range -128 through 127");
                        }
                        else
                        {
                            if (r != g || g != b) throw PixelError(x, y, String.Format("has RGB #{0:X2}{1:X2}{2:X2}; exact grayscale requires R = G = B", r, g, b));
                            z = r - 128;
                        }
                        heights[y * image.Width + x] = (sbyte)z;
                    }
                }
            }
            finally { image.UnlockBits(data); }
            return heights;
        }

        private static InvalidDataException PixelError(int x, int y, string reason)
        {
            return new InvalidDataException(String.Format("Height pixel ({0}, {1}) {2}. No pixels were imported.", x, y, reason));
        }

        public static Bitmap Export(MapDocument document)
        {
            if (document == null) throw new ArgumentNullException("document");
            document.Validate();
            Bitmap image = new Bitmap(document.Width, document.Height, PixelFormat.Format24bppRgb);
            try
            {
                BitmapData data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
                try
                {
                    byte[] row = new byte[document.Width * 3];
                    for (int y = 0; y < document.Height; y++)
                    {
                        for (int x = 0; x < document.Width; x++)
                        {
                            byte shade = (byte)(document.Elevation[y * document.Width + x] + 128);
                            row[x * 3] = shade; row[x * 3 + 1] = shade; row[x * 3 + 2] = shade;
                        }
                        Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), row.Length);
                    }
                }
                finally { image.UnlockBits(data); }
                return image;
            }
            catch { image.Dispose(); throw; }
        }
    }
}
