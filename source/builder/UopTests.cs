using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;

namespace TerrainStudio
{
    public static class UopTests
    {
        private static int checks;
        private sealed class FixtureRecord { public int Id; public byte[] Stored; public int Decoded; public ushort Codec; }
        public static int Main()
        {
            try { Run(); return 0; } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        }
        public static void Run()
        {
            // Fixed golden hashes were independently computed from ClassicUO's register-form
            // algorithm, rather than from this implementation's lookup3 mix/final functions.
            Check(UopArchive.FilenameHash("build/artlegacymul/00000000.tga") == 0x99361F7D3A53AEA8UL, "hash land zero");
            Check(UopArchive.FilenameHash("build/artlegacymul/00016384.tga") == 0x2B323AA4D0FCED19UL, "hash first static");
            Check(UopArchive.FilenameHash("build/artlegacymul/00081919.tga") == 0x22CD1BB00B38FD9FUL, "hash final static");
            Throws<ArgumentException>(delegate { UopArchive.FilenameHash("not-ascii-\u00E9"); }, "non-ASCII asset path rejected");
            byte[] red = new byte[2024]; red[1] = 0x7C;
            byte[] blue = new byte[2024]; blue[0] = 0x1F;
            // RFC1950 vector independently generated using Node zlib.deflateSync(blue).
            byte[] compressedBlue = Convert.FromBase64String("eJyTZxgFo2AUjIJRMApGwXAFAP0AACA=");
            byte[] decoded = UopArchive.InflateZlib(compressedBlue, 2024);
            Check(Equal(decoded, blue), "independent zlib fixture exact bytes");
            byte[] badChecksum = (byte[])compressedBlue.Clone(); badChecksum[badChecksum.Length - 1] ^= 1;
            Throws<InvalidDataException>(delegate { UopArchive.InflateZlib(badChecksum, 2024); }, "zlib checksum rejected");
            Throws<InvalidDataException>(delegate { UopArchive.InflateZlib(compressedBlue, 2023); }, "zlib excess output rejected");
            Throws<EndOfStreamException>(delegate { UopArchive.InflateZlib(compressedBlue, 2025); }, "zlib short output rejected");
            byte[] badHeader = (byte[])compressedBlue.Clone(); badHeader[0] = 0;
            Throws<InvalidDataException>(delegate { UopArchive.InflateZlib(badHeader, 2024); }, "zlib header rejected");
            Throws<InvalidDataException>(delegate { UopArchive.InflateZlib(compressedBlue, 16 * 1024 * 1024 + 1); }, "zlib allocation bound");

            string folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "uop-fixtures", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            string file = Path.Combine(folder, "artLegacyMUL.uop");
            var records = new List<FixtureRecord> {
                new FixtureRecord { Id = 1, Stored = red, Decoded = red.Length, Codec = 0 },
                new FixtureRecord { Id = 2, Stored = compressedBlue, Decoded = 2024, Codec = 1 },
                new FixtureRecord { Id = 4, Stored = compressedBlue, Decoded = 2024, Codec = 3 },
                new FixtureRecord { Id = 0x4000, Stored = StaticArt(), Decoded = 34, Codec = 0 }
            };
            WriteArchive(file, records);
            UopArchive archive = new UopArchive(file);
            Check(archive.Version == 5 && archive.RecordCount == 4 && archive.MappedCount == 4, "UOP indexed records");
            Check(archive.HighestIndex == 0x4000, "UOP highest mapped index");
            Check(archive.HasEntry(1) && archive.HasEntry(2), "raw and zlib metadata present");
            Check(!archive.HasEntry(4) && archive.UnsupportedCount == 1, "BWT explicitly unsupported");
            Check(archive.Read(4) == null, "BWT data not misread as raw art");
            Check(Equal(archive.Read(1), red), "raw entry reads after per-record header");
            Check(Equal(archive.Read(2), blue), "zlib entry reads after per-record header");
            Check(!archive.HasEntry(-1) && !archive.HasEntry(81920) && archive.Read(0) == null, "missing and outside index safe");
            File.WriteAllText(Path.Combine(folder, "art.def"), "1 {2} 0\r\n3 {1 2} 0\r\n4 {2} 0\r\n");
            using (ClientAssets assets = ClientAssets.Open(folder))
            {
                Check(assets.HasDirectLandArt(1) && assets.HasLandArt(3) && !assets.HasDirectLandArt(3), "art.def fills only missing metadata");
                Check(assets.LandArtSourceId(1) == 1 && assets.LandArtSourceId(3) == 1, "first valid art.def candidate and current art retained");
                Check(assets.HasLandArt(4) && assets.LandArtSourceId(4) == 2, "unsupported compression may use explicit def fallback");
                Check(assets.HasStaticArt(0) && assets.StaticCount == 1, "UOP static namespace metadata");
                using (Bitmap art = assets.LandArtPreview(1)) Check(art.GetPixel(21, 0).ToArgb() == Color.Red.ToArgb(), "raw diamond remains original despite def");
                using (Bitmap art = assets.LandArtPreview(2)) Check(art.GetPixel(21, 0).ToArgb() == Color.Blue.ToArgb(), "zlib diamond decoded");
                using (Bitmap art = assets.LandArtPreview(3)) Check(art.GetPixel(21, 0).ToArgb() == Color.Red.ToArgb(), "missing art resolves explicit alias");
                using (Bitmap art = assets.StaticPreview(0)) Check(art.Width == 3 && art.Height == 2 && art.GetPixel(1, 0).R == 255, "UOP static RLE decoded");
                Check(assets.Summary.Contains("UOP art"), "UOP availability stated");
            }
            using (FileStream stream = File.Open(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) Check(stream.Length > 0, "UOP file not left locked");

            string bad = Path.Combine(folder, "bad.uop");
            File.Copy(file, bad); PatchLong(bad, 68, 64);
            Throws<InvalidDataException>(delegate { new UopArchive(bad); }, "cyclic directory rejected");
            File.Copy(file, bad, true); PatchLong(bad, 76, Int64.MaxValue - 1);
            Throws<InvalidDataException>(delegate { new UopArchive(bad); }, "overflow payload pointer rejected");
            File.Copy(file, bad, true); PatchInt(bad, 92, 16 * 1024 * 1024 + 1);
            Throws<InvalidDataException>(delegate { new UopArchive(bad); }, "oversized record rejected");
            File.Copy(file, bad, true); PatchInt(bad, 4, 999);
            Throws<InvalidDataException>(delegate { new UopArchive(bad); }, "unknown UOP version rejected");
            File.Copy(file, bad, true); PatchInt(bad, 64, Int32.MaxValue);
            Throws<InvalidDataException>(delegate { new UopArchive(bad); }, "oversized directory rejected");
            WriteArchive(bad, new List<FixtureRecord> { records[0], records[0] });
            Throws<InvalidDataException>(delegate { new UopArchive(bad); }, "duplicate hash rejected");
            File.Copy(file, bad, true); using (FileStream stream = File.OpenWrite(bad)) stream.SetLength(14);
            Throws<InvalidDataException>(delegate { new UopArchive(bad); }, "truncated archive header rejected");
            Console.WriteLine("UOP reader: " + checks + " assertions passed; fixtures at " + folder);
        }
        private static byte[] StaticArt()
        {
            using (var memory = new MemoryStream())
            using (var writer = new BinaryWriter(memory))
            {
                writer.Write(0); writer.Write((ushort)3); writer.Write((ushort)2); writer.Write((ushort)0); writer.Write((ushort)6);
                writer.Write((ushort)1); writer.Write((ushort)2); writer.Write((ushort)0x7C00); writer.Write((ushort)0x03E0); writer.Write(0);
                writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)0x001F); writer.Write(0);
                return memory.ToArray();
            }
        }
        private static void WriteArchive(string file, List<FixtureRecord> records)
        {
            using (var writer = new BinaryWriter(File.Create(file)))
            {
                writer.Write(0x0050594Du); writer.Write(5u); writer.Write(0u); writer.Write(64L); writer.Write((uint)records.Count); writer.Write((uint)records.Count);
                writer.Write(new byte[64 - 28]); writer.Write(records.Count); writer.Write(0L);
                long offset = 64 + 12 + records.Count * 34;
                foreach (var record in records)
                {
                    writer.Write(offset); writer.Write(4); writer.Write(record.Stored.Length); writer.Write(record.Decoded);
                    writer.Write(UopArchive.FilenameHash("build/artlegacymul/" + record.Id.ToString("D8") + ".tga"));
                    writer.Write(0u); writer.Write(record.Codec); offset += 4 + record.Stored.Length;
                }
                foreach (var record in records) { writer.Write(0x12345678u); writer.Write(record.Stored); }
            }
        }
        private static void PatchLong(string file, long offset, long value)
        { using (var stream = File.OpenWrite(file)) using (var writer = new BinaryWriter(stream)) { stream.Position = offset; writer.Write(value); } }
        private static void PatchInt(string file, long offset, int value)
        { using (var stream = File.OpenWrite(file)) using (var writer = new BinaryWriter(stream)) { stream.Position = offset; writer.Write(value); } }
        private static bool Equal(byte[] a, byte[] b)
        { if (a == null || b == null || a.Length != b.Length) return false; for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false; return true; }
        private static void Check(bool value, string message) { checks++; if (!value) throw new Exception("FAILED: " + message); }
        private static void Throws<T>(Action action, string message) where T : Exception
        { try { action(); } catch (T) { checks++; return; } throw new Exception("FAILED: " + message); }
    }
}
