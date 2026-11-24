using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace TerrainStudio
{
    /// <summary>
    /// Read-only UOP/MUL artwork adapter. Previews returned to callers are owned copies;
    /// callers must Dispose them. An internal 128-entry FIFO cache owns its own originals.
    /// Dispose releases the cache; no client files remain open between calls. Not thread-safe.
    /// Supports raw/zlib UOP, art.def missing-only geometry aliases and TexTerr.def texture aliases.
    /// Hues, animation, verdata and art.def tiledata metadata fallback are not interpreted.
    /// Format references: ClassicUO.Assets/{ArtLoader,TileDataLoader,TexmapsLoader}.cs.
    /// </summary>
    public sealed class ClientAssets : IDisposable
    {
        public readonly List<string> Warnings = new List<string>();
        public int StaticCount { get; private set; }
        public int TextureCount { get { return texIndex == null ? 0 : texIndex.Length; } }
        public string Folder { get; private set; }
        public string Summary
        {
            get
            {
                return String.Format(CultureInfo.InvariantCulture,
                    "{0}; {1}; {2}; {3} warning(s). Previews are unhued; verdata patches are not applied.",
                    tiledataFormat, uop != null ? "UOP art: " + uop.MappedCount + " indexed records" : artPath == null ? "no artwork archive" : "MUL art available",
                    texPath == null ? "no terrain textures" : "terrain textures available", Warnings.Count);
            }
        }

        private string tiledataFormat = "no tile names";
        private readonly string[] landNames = new string[0x4000];
        private readonly ushort[] landTextures = new ushort[0x4000];
        private readonly ulong[] landFlags = new ulong[0x4000];
        private string[] staticNames = new string[0];
        private byte[] staticHeights = new byte[0];
        public int StaticHeight(int id) { if(id<0||id>=staticHeights.Length)throw new InvalidDataException("Missing static height metadata");return staticHeights[id]; }
        private string artPath, texPath;
        private Entry[] artIndex, texIndex;
        private Entry[] directTexIndex;
        private long artFileLength, texFileLength;
        private UopArchive uop;
        private readonly int[] artSources = new int[UopArchive.ArtSlots];
        private int[] textureSources;
        private bool disposed;
        private readonly Dictionary<int, Bitmap> cache = new Dictionary<int, Bitmap>();
        private readonly Queue<int> cacheOrder = new Queue<int>();
        private readonly HashSet<string> warningSet = new HashSet<string>();
        private struct Entry { public int Offset, Length; }

        private ClientAssets() { for (int i = 0; i < artSources.Length; i++) artSources[i] = i; }

        public static ClientAssets Open(string folder)
        {
            if (!Directory.Exists(folder)) throw new DirectoryNotFoundException("The UO client folder does not exist.");
            ClientAssets result = new ClientAssets();
            result.Folder = Path.GetFullPath(folder);
            string tiledata = Path.Combine(folder, "tiledata.mul");
            if (File.Exists(tiledata))
            {
                try { result.ReadTileData(tiledata); }
                catch (Exception e)
                {
                    if (!IsDataError(e)) throw;
                    result.Warn("tiledata.mul: " + e.Message);
                }
            }
            else result.Warn("tiledata.mul is missing; numerical tile IDs still work, but names and texture associations are unavailable.");
            string uopPath = Path.Combine(folder, "artLegacyMUL.uop");
            if (File.Exists(uopPath))
            {
                try { result.uop = new UopArchive(uopPath); foreach (string warning in result.uop.Warnings) result.Warn(warning); }
                catch (Exception e) { if (!IsDataError(e)) throw; result.Warn("artLegacyMUL.uop: " + e.Message); }
            }
            if (result.uop == null || (File.Exists(Path.Combine(folder, "art.mul")) && File.Exists(Path.Combine(folder, "artidx.mul"))))
                result.artIndex = result.ReadIndexPair(folder, "artidx.mul", "art.mul", out result.artPath);
            result.texIndex = result.ReadIndexPair(folder, "texidx.mul", "texmaps.mul", out result.texPath);
            result.artFileLength = result.artPath == null ? 0 : new FileInfo(result.artPath).Length;
            result.texFileLength = result.texPath == null ? 0 : new FileInfo(result.texPath).Length;
            result.StaticCount = Math.Max(result.staticNames.Length, result.artIndex == null ? 0 : Math.Max(0, result.artIndex.Length - 0x4000));
            if (result.uop != null) result.StaticCount = Math.Max(result.StaticCount, result.uop.HighestIndex - 0x4000 + 1);
            result.StaticCount = Math.Min(result.StaticCount, 65536);
            if (result.texIndex != null)
            {
                result.directTexIndex = (Entry[])result.texIndex.Clone(); result.textureSources = new int[result.texIndex.Length];
                for (int i = 0; i < result.textureSources.Length; i++) result.textureSources[i] = i;
            }
            if (File.Exists(Path.Combine(folder, "TexTerr.def")) && result.texIndex != null)
                result.ApplyTextureRemaps(Path.Combine(folder, "TexTerr.def"));
            if (File.Exists(Path.Combine(folder, "art.def"))) result.ApplyArtRemaps(Path.Combine(folder, "art.def"));
            if (File.Exists(Path.Combine(folder, "verdata.mul"))) result.Warn("Client verdata overrides are not applied by this preview.");
            return result;
        }

        public int LandTextureId(int id) { CheckId(id, 0x3FFF); EnsureAlive(); return landTextures[id]; }
        public ulong LandFlags(int id) { CheckId(id, 0x3FFF); EnsureAlive(); return landFlags[id]; }
        public bool HasLandArt(int id) { CheckId(id, 0x3FFF); EnsureAlive(); return HasArtDirect(artSources[id]); }
        public bool HasStaticArt(int id) { CheckId(id, 65535); EnsureAlive(); return HasArtDirect(artSources[id + 0x4000]); }
        public bool HasDirectLandArt(int id) { CheckId(id, 0x3FFF); EnsureAlive(); return HasArtDirect(id); }
        public bool HasDirectStaticArt(int id) { CheckId(id, 65535); EnsureAlive(); return HasArtDirect(id + 0x4000); }
        public int LandArtSourceId(int id) { return HasLandArt(id) ? artSources[id] : -1; }
        public int StaticArtSourceId(int id) { return HasStaticArt(id) ? artSources[id + 0x4000] - 0x4000 : -1; }
        public bool HasTexture(int id) { CheckId(id, 65535); EnsureAlive(); return HasMulEntry(texIndex, id, texFileLength); }
        public bool HasDirectTexture(int id) { CheckId(id, 65535); EnsureAlive(); return HasMulEntry(directTexIndex, id, texFileLength); }
        public int TextureSourceId(int id) { return HasTexture(id) ? textureSources[id] : -1; }

        /// <summary>Flat land diamond, without substituting its terrain texture. Caller owns the bitmap.</summary>
        public Bitmap LandArtPreview(int id)
        {
            CheckId(id, 0x3FFF); EnsureAlive();
            return GetPreview(0x20000 + id, delegate { return DecodeSafely("Land art " + id, delegate { return DecodeLand(ReadArt(id)); }); });
        }

        /// <summary>Texture by its own ID, including TexTerr.def remaps. Caller owns the bitmap.</summary>
        public Bitmap TexturePreview(int id)
        {
            CheckId(id, 65535); EnsureAlive();
            return GetPreview(0x30000 + id, delegate { return DecodeSafely("Texture " + id, delegate { return DecodeTexture(ReadEntry(texPath, texIndex, id)); }); });
        }

        public string LandName(int id)
        {
            CheckId(id, 0x3FFF); EnsureAlive();
            return String.IsNullOrWhiteSpace(landNames[id]) ? "Land 0x" + id.ToString("X4") : landNames[id];
        }

        public string StaticName(int id)
        {
            CheckId(id, 65535); EnsureAlive();
            return id >= staticNames.Length || String.IsNullOrWhiteSpace(staticNames[id]) ? "Static 0x" + id.ToString("X4") : staticNames[id];
        }

        /// <summary>Terrain texture where associated and available, otherwise a flat land diamond. Caller owns returned bitmap.</summary>
        public Bitmap LandPreview(int id)
        {
            CheckId(id, 0x3FFF); EnsureAlive();
            return GetPreview(id, delegate
            {
                Bitmap texture = null;
                if (landTextures[id] != 0)
                    texture = DecodeSafely("Texture " + landTextures[id], delegate { return DecodeTexture(ReadEntry(texPath, texIndex, landTextures[id])); });
                return texture ?? DecodeSafely("Land " + id, delegate { return DecodeLand(ReadArt(id)); });
            });
        }

        /// <summary>Unhued static artwork. Caller owns returned bitmap.</summary>
        public Bitmap StaticPreview(int id)
        {
            CheckId(id, 65535); EnsureAlive();
            return GetPreview(id + 0x4000, delegate
            {
                return DecodeSafely("Static " + id, delegate { return DecodeStatic(ReadArt(id + 0x4000)); });
            });
        }

        private bool HasArtDirect(int combined)
        { return (uop != null && uop.HasEntry(combined)) || HasMulEntry(artIndex, combined, artFileLength); }

        private static bool HasMulEntry(Entry[] index, int id, long dataLength)
        {
            if (index == null || id < 0 || id >= index.Length) return false;
            Entry entry = index[id];
            return entry.Offset >= 0 && entry.Length > 0 && entry.Length <= 16 * 1024 * 1024 && (long)entry.Offset + entry.Length <= dataLength;
        }

        private byte[] ReadArt(int combined)
        {
            int source = artSources[combined];
            if (uop != null && uop.HasEntry(source)) return uop.Read(source);
            return ReadEntry(artPath, artIndex, source);
        }

        private Bitmap GetPreview(int key, Func<Bitmap> load)
        {
            Bitmap original;
            if (!cache.TryGetValue(key, out original))
            {
                original = load();
                if (cache.Count >= 128)
                {
                    int oldKey = cacheOrder.Dequeue();
                    Bitmap old = cache[oldKey];
                    if (old != null) old.Dispose();
                    cache.Remove(oldKey);
                }
                cache[key] = original; cacheOrder.Enqueue(key);
            }
            return original == null ? null : (Bitmap)original.Clone();
        }

        private Bitmap DecodeSafely(string label, Func<Bitmap> decode)
        {
            try { return decode(); }
            catch (Exception e)
            {
                if (!IsDataError(e)) throw;
                Warn(label + ": " + e.Message); return null;
            }
        }

        private void ReadTileData(string file)
        {
            long size = new FileInfo(file).Length;
            bool oldValid = FitsTileData(size, 4), newValid = FitsTileData(size, 8);
            if (oldValid == newValid)
                throw new InvalidDataException(oldValid ? "Old/new layouts are ambiguous; names were not guessed." : "Length does not match a complete old or new tiledata layout.");
            int flags = newValid ? 8 : 4;
            int landLength = 512 * (4 + 32 * (flags + 22));
            int count = (int)((size - landLength) / (4 + 32 * (flags + 33))) * 32;
            using (FileStream stream = OpenShared(file))
            using (BinaryReader reader = new BinaryReader(stream, Encoding.UTF8))
            {
                for (int group = 0; group < 512; group++)
                {
                    reader.ReadUInt32();
                    for (int n = 0; n < 32; n++)
                    {
                        int i = group * 32 + n;
                        landFlags[i] = newValid ? reader.ReadUInt64() : reader.ReadUInt32();
                        landTextures[i] = reader.ReadUInt16();
                        landNames[i] = ReadName(reader);
                    }
                }
                staticNames = new string[count]; staticHeights = new byte[count];
                for (int i = 0; i < count; i++)
                {
                    if ((i & 31) == 0) reader.ReadUInt32();
                    stream.Position += flags + 12; staticHeights[i] = reader.ReadByte();
                    staticNames[i] = ReadName(reader);
                }
            }
            tiledataFormat = (newValid ? "64-bit flags" : "32-bit flags") + ", 16,384 land names and " + count + " static names";
        }

        private static bool FitsTileData(long size, int flags)
        {
            long landSize = 512L * (4 + 32 * (flags + 22));
            long groupSize = 4 + 32 * (flags + 33);
            long remainder = size - landSize;
            return remainder >= 0 && remainder % groupSize == 0 && remainder / groupSize <= 2048;
        }

        private static string ReadName(BinaryReader reader)
        {
            byte[] raw = reader.ReadBytes(20);
            if (raw.Length != 20) throw new EndOfStreamException();
            int end = Array.IndexOf(raw, (byte)0); if (end < 0) end = raw.Length;
            return Encoding.UTF8.GetString(raw, 0, end).Trim();
        }

        private Entry[] ReadIndexPair(string folder, string indexName, string dataName, out string dataFile)
        {
            dataFile = null;
            string indexFile = Path.Combine(folder, indexName), path = Path.Combine(folder, dataName);
            if (!File.Exists(indexFile) || !File.Exists(path))
            {
                Warn(indexName + " / " + dataName + " pair is missing."); return null;
            }
            try
            {
                long length = new FileInfo(indexFile).Length;
                if (length % 12 != 0 || length / 12 > 0x20000)
                    throw new InvalidDataException("Index length is not a supported array of 12-byte records.");
                Entry[] entries = new Entry[(int)(length / 12)];
                using (FileStream stream = OpenShared(indexFile))
                using (BinaryReader reader = new BinaryReader(stream))
                    for (int i = 0; i < entries.Length; i++)
                    {
                        entries[i].Offset = reader.ReadInt32(); entries[i].Length = reader.ReadInt32(); reader.ReadInt32();
                    }
                dataFile = path; return entries;
            }
            catch (Exception e)
            {
                if (!IsDataError(e)) throw;
                Warn(indexName + ": " + e.Message); return null;
            }
        }

        private void ApplyTextureRemaps(string file)
        {
            int outsideIndex = 0;
            try
            {
                foreach (string raw in File.ReadLines(file))
                {
                    string line = raw.Split('#')[0].Trim(); if (line.Length == 0) continue;
                    Match match = Regex.Match(line, @"^\s*(\d+)\s*\{([^}]+)\}");
                    int index;
                    if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out index))
                    { Warn("An invalid TexTerr.def line was ignored."); continue; }
                    if (index < 0 || index >= texIndex.Length) { outsideIndex++; continue; }
                    foreach (Match token in Regex.Matches(match.Groups[2].Value, @"-?\d+"))
                    {
                        int replacement;
                        if (Int32.TryParse(token.Value, out replacement) && replacement >= 0 && replacement < texIndex.Length)
                        { texIndex[index] = texIndex[replacement]; textureSources[index] = textureSources[replacement]; }
                    }
                }
            }
            catch (Exception e) { if (!IsDataError(e)) throw; Warn("TexTerr.def: " + e.Message); }
            if (outsideIndex > 0) Warn("TexTerr.def: " + outsideIndex + " redirects address IDs outside this texture index and were ignored.");
        }

        // ClassicUO UOFileManager.ReadArtDefFile fills missing combined art entries only.
        // It never replaces existing artwork with the often much older compatibility fallback.
        private void ApplyArtRemaps(string file)
        {
            int aliases = 0;
            try
            {
                foreach (string raw in File.ReadLines(file))
                {
                    string line = raw.Split('#')[0].Trim(); if (line.Length == 0) continue;
                    Match match = Regex.Match(line, @"^\s*(\d+)\s*\{([^}]+)\}");
                    int index;
                    if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out index) || index < 0 || index >= 0x4000 + StaticCount)
                    { Warn("An invalid art.def line was ignored."); continue; }
                    if (HasArtDirect(artSources[index])) continue;
                    foreach (Match token in Regex.Matches(match.Groups[2].Value, @"-?\d+"))
                    {
                        int replacement;
                        if (!Int32.TryParse(token.Value, out replacement) || replacement < 0 || replacement >= 0x4000 + StaticCount) continue;
                        if ((replacement < 0x4000) != (index < 0x4000))
                        { Warn("A cross-kind land/static art.def redirect was ignored because the payload formats differ."); continue; }
                        if (HasArtDirect(artSources[replacement])) { artSources[index] = artSources[replacement]; aliases++; break; }
                    }
                }
            }
            catch (Exception e) { if (!IsDataError(e)) throw; Warn("art.def: " + e.Message); }
            if (aliases > 0) Warn("art.def filled " + aliases + " missing artwork entries. Previews are unhued; original tiledata metadata is retained.");
        }

        private static byte[] ReadEntry(string file, Entry[] index, int id)
        {
            if (file == null || index == null || id < 0 || id >= index.Length) return null;
            Entry entry = index[id];
            if (entry.Offset < 0 || entry.Length <= 0) return null;
            if (entry.Length > 16 * 1024 * 1024) throw new InvalidDataException("Artwork entry exceeds the supported 16 MB limit.");
            using (FileStream stream = OpenShared(file))
            {
                if ((long)entry.Offset + entry.Length > stream.Length) throw new InvalidDataException("Artwork entry points outside the data file.");
                stream.Position = entry.Offset;
                byte[] bytes = new byte[entry.Length]; int got = 0;
                while (got < bytes.Length)
                { int n = stream.Read(bytes, got, bytes.Length - got); if (n == 0) throw new EndOfStreamException(); got += n; }
                return bytes;
            }
        }

        private static Bitmap DecodeTexture(byte[] raw)
        {
            if (raw == null) return null;
            int side = raw.Length == 8192 ? 64 : raw.Length == 32768 ? 128 : 0;
            if (side == 0) throw new InvalidDataException("Terrain texture must contain 64x64 or 128x128 16-bit pixels.");
            int[] pixels = new int[side * side];
            for (int i = 0; i < pixels.Length; i++) pixels[i] = Pixel(U16(raw, i * 2));
            return MakeBitmap(side, side, pixels);
        }

        private static Bitmap DecodeLand(byte[] raw)
        {
            if (raw == null) return null;
            if (raw.Length < 2024) throw new InvalidDataException("Land diamond is shorter than 2,024 bytes.");
            int[] pixels = new int[44 * 44]; int at = 0;
            for (int y = 0; y < 44; y++)
            {
                int left = y < 22 ? 21 - y : y - 22;
                int width = 44 - 2 * left;
                for (int x = left; x < left + width; x++, at += 2) pixels[y * 44 + x] = Pixel(U16(raw, at));
            }
            return MakeBitmap(44, 44, pixels);
        }

        private static Bitmap DecodeStatic(byte[] raw)
        {
            if (raw == null) return null;
            if (raw.Length < 8) throw new InvalidDataException("Static header is truncated.");
            int width = U16(raw, 4), height = U16(raw, 6);
            if (width < 1 || height < 1 || width > 1024 || height > 1024 || raw.Length < 8 + 2 * height)
                throw new InvalidDataException("Static dimensions or row table are invalid.");
            int[] pixels = new int[width * height]; int start = 8 + 2 * height;
            for (int y = 0; y < height; y++)
            {
                int position = start + 2 * U16(raw, 8 + y * 2), x = 0;
                while (true)
                {
                    int gap = U16(raw, position), count = U16(raw, position + 2); position += 4;
                    if (gap == 0 && count == 0) break;
                    if (gap > width - x || count > width - x - gap || count * 2 > raw.Length - position)
                        throw new InvalidDataException("Static pixel run exceeds its row or data bounds.");
                    x += gap;
                    for (int n = 0; n < count; n++, x++, position += 2)
                    { ushort color = U16(raw, position); if (color != 0) pixels[y * width + x] = Pixel(color); }
                }
            }
            return MakeBitmap(width, height, pixels);
        }

        private static ushort U16(byte[] raw, int offset)
        {
            if (offset < 0 || offset > raw.Length - 2) throw new InvalidDataException("Artwork record is truncated.");
            return (ushort)(raw[offset] | (raw[offset + 1] << 8));
        }

        private static int Pixel(ushort rgb555)
        {
            int r = ((rgb555 >> 10) & 31) * 255 / 31;
            int g = ((rgb555 >> 5) & 31) * 255 / 31;
            int b = (rgb555 & 31) * 255 / 31;
            return unchecked((int)0xFF000000) | (r << 16) | (g << 8) | b;
        }

        private static Bitmap MakeBitmap(int width, int height, int[] pixels)
        {
            Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try { for (int y = 0; y < height; y++) Marshal.Copy(pixels, y * width, IntPtr.Add(data.Scan0, y * data.Stride), width); }
            finally { bitmap.UnlockBits(data); }
            return bitmap;
        }

        private static FileStream OpenShared(string file) { return new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); }
        private static void CheckId(int id, int max) { if (id < 0 || id > max) throw new ArgumentOutOfRangeException("id"); }
        private static bool IsDataError(Exception e) { return e is IOException || e is InvalidDataException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException || e is System.Security.SecurityException; }
        private void EnsureAlive() { if (disposed) throw new ObjectDisposedException("ClientAssets"); }
        private void Warn(string text) { if (warningSet.Add(text) && Warnings.Count < 500) Warnings.Add(text); }
        public void Dispose()
        {
            if (disposed) return;
            foreach (Bitmap bitmap in cache.Values) if (bitmap != null) bitmap.Dispose();
            cache.Clear(); cacheOrder.Clear(); disposed = true;
        }
    }
}
