using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace TerrainStudio
{
    /// <summary>Bounds-checked, read-only UOP v4/v5 art archive. No persistent file handle.</summary>
    public sealed class UopArchive
    {
        public const int ArtSlots = 0x14000;
        private const int MaximumRecordBytes = 16 * 1024 * 1024;
        private readonly Entry[] entries = new Entry[ArtSlots];
        private readonly string path;
        public uint Version { get; private set; }
        public int RecordCount { get; private set; }
        public int MappedCount { get; private set; }
        public int UnsupportedCount { get; private set; }
        public int HighestIndex { get; private set; }
        public readonly List<string> Warnings = new List<string>();
        private sealed class Entry { public long Offset; public int Packed, Raw; public ushort Compression; }

        public UopArchive(string file)
        {
            path = Path.GetFullPath(file); HighestIndex = -1;
            var hashes = new Dictionary<ulong, Entry>();
            using (FileStream stream = OpenRead())
            using (BinaryReader reader = new BinaryReader(stream))
            {
                if (stream.Length < 28 || reader.ReadUInt32() != 0x0050594D) throw new InvalidDataException("Not a UOP archive (MYP header missing).");
                Version = reader.ReadUInt32();
                if (Version != 4 && Version != 5) throw new InvalidDataException("Unsupported UOP version " + Version + "; supported versions are 4 and 5.");
                reader.ReadUInt32();
                long next = reader.ReadInt64();
                uint blockCapacity = reader.ReadUInt32(), declaredCount = reader.ReadUInt32();
                if (declaredCount > 1000000 || blockCapacity > 1000000) throw new InvalidDataException("UOP record count exceeds the supported limit.");
                var visited = new HashSet<long>();
                int totalSlots = 0;
                while (next != 0)
                {
                    if (next < 28 || next > stream.Length - 12 || !visited.Add(next)) throw new InvalidDataException("UOP directory pointer is outside the file or cyclic.");
                    stream.Position = next;
                    int count = reader.ReadInt32(); next = reader.ReadInt64();
                    if (count < 0 || count > 1000000 || count > (stream.Length - stream.Position) / 34 || totalSlots > 1000000 - count)
                        throw new InvalidDataException("UOP directory is truncated or too large.");
                    totalSlots += count;
                    for (int i = 0; i < count; i++)
                    {
                        long offset = reader.ReadInt64();
                        int header = reader.ReadInt32(), packed = reader.ReadInt32(), raw = reader.ReadInt32();
                        ulong hash = reader.ReadUInt64(); reader.ReadUInt32(); ushort compression = reader.ReadUInt16();
                        if (offset == 0) continue;
                        if (offset < 0 || header < 0 || packed < 0 || raw < 0 || raw > MaximumRecordBytes || packed > MaximumRecordBytes)
                            throw new InvalidDataException("UOP record has invalid offset or length.");
                        long payload = offset + (long)header;
                        int stored = compression == 0 ? raw : packed;
                        if (payload < offset || payload > stream.Length || stored > stream.Length - payload)
                            throw new InvalidDataException("UOP record points outside the archive.");
                        if (compression == 0 && packed != raw)
                            throw new InvalidDataException("Uncompressed UOP record has unequal stored and decoded lengths.");
                        if (hashes.ContainsKey(hash)) throw new InvalidDataException("Duplicate UOP filename hash; archive is ambiguous.");
                        var entry = new Entry { Offset = payload, Packed = packed, Raw = raw, Compression = compression };
                        hashes.Add(hash, entry); RecordCount++;
                        if (compression != 0 && compression != 1) UnsupportedCount++;
                    }
                }
                if (RecordCount != declaredCount) Warnings.Add("UOP declares " + declaredCount + " records but contains " + RecordCount + ".");
            }
            for (int i = 0; i < entries.Length; i++)
            {
                ulong hash = FilenameHash("build/artlegacymul/" + i.ToString("D8", CultureInfo.InvariantCulture) + ".tga");
                Entry entry;
                if (hashes.TryGetValue(hash, out entry)) { entries[i] = entry; MappedCount++; HighestIndex = i; }
            }
            if (MappedCount != RecordCount) Warnings.Add((RecordCount - MappedCount) + " UOP records do not map to classic land/static IDs.");
            if (UnsupportedCount > 0) Warnings.Add(UnsupportedCount + " UOP records use unsupported compression (including flag 3 ZlibBwt); these previews are unavailable.");
        }

        /// <summary>Metadata presence only; does not imply decodable, nonblank, or semantically useful art.</summary>
        public bool HasEntry(int index)
        { return index >= 0 && index < entries.Length && entries[index] != null && entries[index].Raw > 0 && entries[index].Compression <= 1; }

        public byte[] Read(int index)
        {
            if (!HasEntry(index)) return null;
            Entry entry = entries[index];
            using (FileStream stream = OpenRead())
            {
                int length = entry.Compression == 0 ? entry.Raw : entry.Packed;
                if (entry.Offset > stream.Length || length > stream.Length - entry.Offset) throw new InvalidDataException("UOP changed or record was truncated after indexing.");
                stream.Position = entry.Offset;
                byte[] stored = new byte[length]; ReadFully(stream, stored);
                return entry.Compression == 0 ? stored : InflateZlib(stored, entry.Raw);
            }
        }

        private FileStream OpenRead() { return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); }
        private static void ReadFully(Stream stream, byte[] bytes)
        {
            int position = 0;
            while (position < bytes.Length) { int n = stream.Read(bytes, position, bytes.Length - position); if (n == 0) throw new EndOfStreamException(); position += n; }
        }

        // Framework DeflateStream accepts raw DEFLATE. Validate and remove the RFC1950 wrapper,
        // then independently verify its Adler32 trailer and exact advertised output length.
        internal static byte[] InflateZlib(byte[] packed, int expected)
        {
            if (expected < 0 || expected > MaximumRecordBytes || packed.Length < 6 ||
                (packed[0] & 15) != 8 || (packed[0] >> 4) > 7 || ((packed[0] << 8) + packed[1]) % 31 != 0 || (packed[1] & 32) != 0)
                throw new InvalidDataException("Invalid or unsupported UOP zlib header.");
            byte[] raw = new byte[expected];
            using (var input = new MemoryStream(packed, 2, packed.Length - 6, false))
            using (var deflate = new DeflateStream(input, CompressionMode.Decompress))
            {
                ReadFully(deflate, raw);
                if (deflate.ReadByte() != -1) throw new InvalidDataException("UOP zlib output exceeds its advertised length.");
            }
            uint a = 1, b = 0;
            foreach (byte value in raw) { a = (a + value) % 65521; b = (b + a) % 65521; }
            int end = packed.Length;
            uint trailer = ((uint)packed[end - 4] << 24) | ((uint)packed[end - 3] << 16) | ((uint)packed[end - 2] << 8) | packed[end - 1];
            if (((b << 16) | a) != trailer) throw new InvalidDataException("UOP zlib Adler32 checksum failed.");
            return raw;
        }

        /// <summary>UOP's Jenkins lookup3 two-word hash, packed as (b &lt;&lt; 32) | c.</summary>
        public static ulong FilenameHash(string filename)
        {
            if (filename == null) throw new ArgumentNullException("filename");
            foreach (char ch in filename) if (ch > 127) throw new ArgumentException("UOP asset paths must be ASCII.");
            byte[] bytes = Encoding.ASCII.GetBytes(filename);
            unchecked
            {
                uint a = 0xDEADBEEF + (uint)bytes.Length, b = a, c = a;
                int offset = 0, left = bytes.Length;
                while (left > 12)
                {
                    a += Word(bytes, offset); b += Word(bytes, offset + 4); c += Word(bytes, offset + 8);
                    a -= c; a ^= Rotate(c, 4); c += b;
                    b -= a; b ^= Rotate(a, 6); a += c;
                    c -= b; c ^= Rotate(b, 8); b += a;
                    a -= c; a ^= Rotate(c, 16); c += b;
                    b -= a; b ^= Rotate(a, 19); a += c;
                    c -= b; c ^= Rotate(b, 4); b += a;
                    offset += 12; left -= 12;
                }
                if (left == 0) return (ulong)c << 32;
                for (int i = 0; i < left; i++)
                {
                    uint value = (uint)bytes[offset + i] << ((i % 4) * 8);
                    if (i < 4) a += value; else if (i < 8) b += value; else c += value;
                }
                c ^= b; c -= Rotate(b, 14);
                a ^= c; a -= Rotate(c, 11);
                b ^= a; b -= Rotate(a, 25);
                c ^= b; c -= Rotate(b, 16);
                a ^= c; a -= Rotate(c, 4);
                b ^= a; b -= Rotate(a, 14);
                c ^= b; c -= Rotate(b, 24);
                return ((ulong)b << 32) | c;
            }
        }
        private static uint Rotate(uint value, int count) { return (value << count) | (value >> (32 - count)); }
        private static uint Word(byte[] bytes, int offset)
        { return (uint)(bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)); }
    }
}
