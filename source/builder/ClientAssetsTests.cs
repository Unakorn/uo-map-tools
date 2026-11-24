using System;
using System.Drawing;
using System.IO;
using System.Text;

namespace TerrainStudio
{
    public static class ClientAssetsTests
    {
        private static int assertions;
        public static int Main()
        {
            try { Run(); return 0; }
            catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        }

        public static void Run()
        {
            string fixtures = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client-assets-fixtures", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(fixtures);
            string old = Path.Combine(fixtures, "old"); Directory.CreateDirectory(old);
            MakeTiledata(old, 4);
            MakeArt(old); MakeTextures(old);
            using (ClientAssets client = ClientAssets.Open(old))
            {
                Check(client.LandName(0) == "Grass", "old land name");
                Check(client.StaticName(0) == "Tree", "old static name");
                Check(client.StaticCount == 32, "static count from tiledata");
                using (Bitmap texture = client.LandPreview(0))
                {
                    Check(texture.Width == 64 && texture.Height == 64, "64 texture dimensions");
                    Check(texture.GetPixel(0, 0).ToArgb() == Color.Red.ToArgb(), "texture RGB555 red");
                    Check(texture.GetPixel(63, 63).ToArgb() == Color.Blue.ToArgb(), "texture final pixel");
                }
                using (Bitmap large = client.LandPreview(2))
                { Check(large.Width == 128, "128 texture dimensions"); Check(large.GetPixel(127, 127).ToArgb() == Color.Lime.ToArgb(), "128 texture pixel"); }
                using (Bitmap remapped = client.LandPreview(3))
                { Check(remapped.Width == 64 && remapped.GetPixel(0, 0).ToArgb() == Color.Red.ToArgb(), "TexTerr remap"); }
                using (Bitmap diamond = client.LandPreview(1))
                {
                    Check(diamond.Width == 44 && diamond.Height == 44, "land dimensions");
                    Check(diamond.GetPixel(0, 0).A == 0, "land outside transparency");
                    Check(diamond.GetPixel(21, 0).ToArgb() == Color.Red.ToArgb(), "land top pixel location");
                    Check(diamond.GetPixel(22, 0).ToArgb() == Color.Black.ToArgb(), "zero land pixel is opaque black");
                    int opaque = 0;
                    for (int y = 0; y < 44; y++) for (int x = 0; x < 44; x++) if (diamond.GetPixel(x, y).A == 255) opaque++;
                    Check(opaque == 1012, "diamond has 1012 opaque pixels");
                }
                using (Bitmap art = client.StaticPreview(0))
                {
                    Check(art.Width == 3 && art.Height == 2, "static dimensions");
                    Check(art.GetPixel(0, 0).A == 0, "static gap transparency");
                    Check(art.GetPixel(1, 0).ToArgb() == Color.Red.ToArgb(), "static red run");
                    Check(art.GetPixel(2, 0).ToArgb() == Color.Lime.ToArgb(), "static green run");
                    Check(art.GetPixel(0, 1).ToArgb() == Color.Blue.ToArgb(), "static row offset");
                }
                using (Bitmap clone = client.LandPreview(0)) Check(clone.Width == 64, "cached original survives caller disposal");
                Check(client.StaticPreview(65535) == null, "missing static safely null");
                Throws<ArgumentOutOfRangeException>(delegate { client.LandPreview(0x4000); }, "land ID limit");
                Throws<ArgumentOutOfRangeException>(delegate { client.StaticName(-1); }, "static ID lower limit");
                // An exclusive open establishes that the adapter retained no file handles.
                using (FileStream stream = File.Open(Path.Combine(old, "art.mul"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) Check(stream.Length > 0, "no retained art file lock");
            }

            string modern = Path.Combine(fixtures, "new"); Directory.CreateDirectory(modern); MakeTiledata(modern, 8);
            File.WriteAllBytes(Path.Combine(modern, "artLegacyMUL.uop"), new byte[0]);
            using (ClientAssets client = ClientAssets.Open(modern))
            {
                Check(client.LandName(0) == "Grass", "new land name");
                Check(client.StaticName(0) == "Tree", "new static name");
                Check(client.Summary.Contains("64-bit"), "new format detected");
                Check(client.Warnings.Exists(delegate(string s) { return s.Contains("UOP") || s.Contains("uop"); }), "UOP limitation explicit");
                Check(client.LandPreview(0) == null, "missing artwork safely null");
            }

            string broken = Path.Combine(fixtures, "broken"); Directory.CreateDirectory(broken);
            File.WriteAllBytes(Path.Combine(broken, "tiledata.mul"), new byte[11]);
            MakeArt(broken);
            using (FileStream stream = new FileStream(Path.Combine(broken, "art.mul"), FileMode.Open)) stream.SetLength(2);
            using (ClientAssets client = ClientAssets.Open(broken))
            {
                Check(client.LandName(1) == "Land 0x0001", "invalid tiledata uses numeric name");
                Check(client.LandPreview(1) == null, "out-of-bounds art safely null");
                Check(client.Warnings.Exists(delegate(string s) { return s.Contains("outside"); }), "bad art offset diagnosed");
            }

            string invalidRun = Path.Combine(fixtures, "bad-run"); Directory.CreateDirectory(invalidRun); MakeArt(invalidRun);
            using (FileStream stream = new FileStream(Path.Combine(invalidRun, "art.mul"), FileMode.Open))
            using (BinaryWriter writer = new BinaryWriter(stream)) { stream.Position = 2024 + 12 + 2; writer.Write((ushort)99); }
            using (ClientAssets client = ClientAssets.Open(invalidRun))
            {
                Check(client.StaticPreview(0) == null, "static run overflow safely null");
                Check(client.Warnings.Exists(delegate(string s) { return s.Contains("run exceeds"); }), "static run overflow diagnosed");
            }

            ClientAssets disposed = ClientAssets.Open(old); disposed.Dispose(); disposed.Dispose();
            Throws<ObjectDisposedException>(delegate { disposed.LandPreview(0); }, "dispose guarded");
            Console.WriteLine("Client assets: " + assertions + " assertions passed; fixtures at " + fixtures);
        }

        private static void MakeTiledata(string folder, int flags)
        {
            using (BinaryWriter writer = new BinaryWriter(File.Create(Path.Combine(folder, "tiledata.mul"))))
            {
                for (int group = 0; group < 512; group++)
                {
                    writer.Write(0);
                    for (int n = 0; n < 32; n++)
                    {
                        writer.Write(new byte[flags]); int id = group * 32 + n;
                        writer.Write((ushort)(id == 0 ? 1 : id == 2 ? 2 : id == 3 ? 3 : 0));
                        WriteName(writer, id == 0 ? "Grass" : "");
                    }
                }
                writer.Write(0);
                for (int i = 0; i < 32; i++) { writer.Write(new byte[flags + 13]); WriteName(writer, i == 0 ? "Tree" : ""); }
            }
        }
        private static void WriteName(BinaryWriter writer, string name)
        { byte[] data = new byte[20]; Encoding.ASCII.GetBytes(name).CopyTo(data, 0); writer.Write(data); }

        private static void MakeArt(string folder)
        {
            using (BinaryWriter writer = new BinaryWriter(File.Create(Path.Combine(folder, "art.mul"))))
            {
                for (int i = 0; i < 1012; i++) writer.Write((ushort)(i == 0 ? 0x7C00 : 0));
                writer.Write(0); writer.Write((ushort)3); writer.Write((ushort)2);
                writer.Write((ushort)0); writer.Write((ushort)6);
                writer.Write((ushort)1); writer.Write((ushort)2); writer.Write((ushort)0x7C00); writer.Write((ushort)0x03E0); writer.Write(0);
                writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)0x001F); writer.Write(0);
            }
            using (BinaryWriter writer = new BinaryWriter(File.Create(Path.Combine(folder, "artidx.mul"))))
                for (int i = 0; i <= 0x4000; i++)
                { writer.Write(i == 1 ? 0 : i == 0x4000 ? 2024 : -1); writer.Write(i == 1 ? 2024 : i == 0x4000 ? 34 : -1); writer.Write(0); }
        }
        private static void MakeTextures(string folder)
        {
            using (BinaryWriter writer = new BinaryWriter(File.Create(Path.Combine(folder, "texmaps.mul"))))
            {
                for (int i = 0; i < 4096; i++) writer.Write((ushort)(i == 4095 ? 0x001F : 0x7C00));
                for (int i = 0; i < 16384; i++) writer.Write((ushort)0x03E0);
            }
            using (BinaryWriter writer = new BinaryWriter(File.Create(Path.Combine(folder, "texidx.mul"))))
                for (int i = 0; i < 4; i++)
                { writer.Write(i == 1 ? 0 : i == 2 ? 8192 : -1); writer.Write(i == 1 ? 8192 : i == 2 ? 32768 : -1); writer.Write(0); }
            File.WriteAllText(Path.Combine(folder, "TexTerr.def"), "# synthetic remapping\r\n3 { 1 }\r\n");
        }
        private static void Check(bool condition, string message)
        { assertions++; if (!condition) throw new Exception("FAILED: " + message); }
        private static void Throws<T>(Action action, string message) where T : Exception
        { try { action(); } catch (T) { assertions++; return; } throw new Exception("FAILED: " + message); }
    }
}
