using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace TerrainStudio
{
    // Integration against installed data, read only. No game executable is launched.
    public static class ClientIntegrationTests
    {
        private static int assertions;
        private static Exception uiException;
        private static readonly StringBuilder report = new StringBuilder();

        [STAThread]
        public static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e) { uiException = e.Exception; };
            try
            {
                string folder = args.Length > 0 ? Path.GetFullPath(args[0]) : @"C:\Program Files (x86)\Electronic Arts\Ultima Online Classic";
                string data = args.Length > 1 ? Path.GetFullPath(args[1]) : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Data");
                Check(Directory.Exists(folder), "Installed client folder exists.");
                Dictionary<string, string> before = Fingerprints(folder);
                TestProjection();
                AuditUop(folder);
                using (ClientAssets assets = ClientAssets.Open(folder))
                {
                    report.AppendLine(assets.Summary);
                    TestAssets(assets);
                    TestBrowser(assets);
                }
                TestMissingAssets();
                TestStudio(folder, data);
                Dictionary<string, string> after = Fingerprints(folder);
                Check(before.Count == after.Count && before.All(pair => after.ContainsKey(pair.Key) && pair.Value == after[pair.Key]), "Client files are byte-for-byte unchanged after loading, decoding, and browsing.");
                report.AppendLine("PASS: " + assertions + " assertions. Input client files SHA-256 unchanged.");
                string reportPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client-integration-report.txt");
                File.WriteAllText(reportPath, report.ToString(), Encoding.UTF8);
                Console.WriteLine(report.ToString());
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(report.ToString());
                Console.Error.WriteLine(ex);
                return 1;
            }
        }

        private static Dictionary<string, string> Fingerprints(string folder)
        {
            var result = new Dictionary<string, string>();
            foreach (string name in new[] { "artLegacyMUL.uop", "tiledata.mul", "texidx.mul", "texmaps.mul", "art.def", "TexTerr.def" })
            {
                string path = Path.Combine(folder, name);
                if (!File.Exists(path)) continue;
                using (FileStream stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (SHA256 hash = SHA256.Create()) result[name] = BitConverter.ToString(hash.ComputeHash(stream));
            }
            return result;
        }

        private static void AuditUop(string folder)
        {
            string path = Path.Combine(folder, "artLegacyMUL.uop");
            if (!File.Exists(path)) { report.AppendLine("No UOP exists; classic MUL path only."); return; }
            using (BinaryReader reader = new BinaryReader(File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)))
            {
                Check(reader.ReadUInt32() == 0x50594D, "Independent UOP signature agrees.");
                uint version = reader.ReadUInt32(); reader.ReadUInt32();
                long next = reader.ReadInt64(); reader.ReadUInt32(); int declared = reader.ReadInt32();
                var visited = new HashSet<long>(); var flags = new Dictionary<ushort, int>();
                int live = 0, empty = 0;
                while (next != 0)
                {
                    Check(next >= 28 && next <= reader.BaseStream.Length - 12 && visited.Add(next), "UOP directory block is bounded and acyclic.");
                    reader.BaseStream.Position = next;
                    int count = reader.ReadInt32(); next = reader.ReadInt64();
                    Check(count >= 0 && reader.BaseStream.Position + (long)count * 34 <= reader.BaseStream.Length, "UOP directory entry count is bounded.");
                    for (int i = 0; i < count; i++)
                    {
                        long offset = reader.ReadInt64(); int header = reader.ReadInt32(), packed = reader.ReadInt32(), plain = reader.ReadInt32();
                        reader.ReadUInt64(); reader.ReadUInt32(); ushort flag = reader.ReadUInt16();
                        if (offset == 0) { empty++; continue; }
                        Check(offset > 0 && header >= 0 && packed >= 0 && plain >= 0 && offset + header + (long)packed <= reader.BaseStream.Length, "Live UOP payload is bounded.");
                        live++; flags[flag] = flags.ContainsKey(flag) ? flags[flag] + 1 : 1;
                    }
                }
                Check(live == declared, "Independent live UOP record count matches header.");
                report.AppendLine("UOP v" + version + ": " + live + " live entries, " + empty + " empty directory slots, " + visited.Count + " blocks; flags " + String.Join(", ", flags.Select(pair => pair.Key + "=" + pair.Value)) + ".");
            }
        }

        private static void TestProjection()
        {
            using (Bitmap diamond = new Bitmap(44, 44, PixelFormat.Format32bppArgb))
            {
                for (int y = 0; y < 44; y++)
                {
                    int inset = y < 22 ? 21 - y : y - 22;
                    for (int x = inset; x < 44 - inset; x++) diamond.SetPixel(x, y, Color.DarkGray);
                }
                diamond.SetPixel(21, 0, Color.Red); diamond.SetPixel(22, 0, Color.Red);
                diamond.SetPixel(43, 21, Color.Lime); diamond.SetPixel(43, 22, Color.Lime);
                diamond.SetPixel(0, 21, Color.Blue); diamond.SetPixel(0, 22, Color.Blue);
                diamond.SetPixel(21, 43, Color.Yellow); diamond.SetPixel(22, 43, Color.Yellow);
                using (Bitmap square = LandArtProjection.ToTopDown(diamond))
                {
                    Check(square.GetPixel(0, 0).ToArgb() == Color.Red.ToArgb(), "Diamond top maps to northwest map-cell corner.");
                    Check(square.GetPixel(43, 0).ToArgb() == Color.Lime.ToArgb(), "Diamond right maps to northeast map-cell corner (+X).");
                    Check(square.GetPixel(0, 43).ToArgb() == Color.Blue.ToArgb(), "Diamond left maps to southwest map-cell corner (+Y).");
                    Check(square.GetPixel(43, 43).ToArgb() == Color.Yellow.ToArgb(), "Diamond bottom maps to southeast map-cell corner (+X,+Y).");
                    bool opaque = true;
                    for (int y = 0; y < 44; y++) for (int x = 0; x < 44; x++) if (square.GetPixel(x, y).A != 255) opaque = false;
                    Check(opaque, "Diamond projection fills every top-down pixel without transparent seams.");
                }
                Check(diamond.GetPixel(0, 0).A == 0 && diamond.GetPixel(22, 0).ToArgb() == Color.Red.ToArgb(), "Projection preserves original raw diamond.");
            }
        }

        private static void TestAssets(ClientAssets assets)
        {
            int land = 0, statics = 0, textures = 0, directLand = 0, directStatics = 0, absentLand = -1, absentStatic = -1;
            var landSamples = new SortedSet<int>();
            var staticSamples = new SortedSet<int>();
            for (int id = 0; id < 16384; id++)
            {
                if (assets.HasLandArt(id))
                {
                    land++; if (landSamples.Count < 8 || id % 997 == 0) landSamples.Add(id);
                    if (assets.HasDirectLandArt(id)) directLand++;
                    else if (landSamples.Count < 32) landSamples.Add(id);
                    Check(assets.LandArtSourceId(id) >= 0 && assets.LandArtSourceId(id) < 16384, "Available land source remains in land namespace.");
                }
                else if (absentLand < 0) absentLand = id;
            }
            for (int id = 0; id < 65536; id++)
            {
                if (assets.HasStaticArt(id))
                {
                    statics++; if (staticSamples.Count < 8 || id % 1999 == 0) staticSamples.Add(id);
                    if (assets.HasDirectStaticArt(id)) directStatics++;
                    else if (staticSamples.Count < 32) staticSamples.Add(id);
                }
                else if (absentStatic < 0) absentStatic = id;
            }
            for (int id = 0; id < assets.TextureCount; id++) if (assets.HasTexture(id)) textures++;
            Check(land > 0 && statics > 0 && textures > 0, "Installed client supplies land, static, and terrain texture records.");
            Check(land <= 16384 && statics <= 65536 && assets.StaticCount <= 65536, "Available record counts respect independent namespaces.");
            report.AppendLine("Available indexed records (not a claim of unique artwork): land " + land + " (direct " + directLand + "), statics " + statics + " (direct " + directStatics + "), textures " + textures + ".");
            foreach (int id in landSamples)
            {
                using (Bitmap art = assets.LandArtPreview(id))
                {
                    Check(art != null && art.Width == 44 && art.Height == 44, "Sampled real land art decodes as 44x44 diamond: " + id);
                    Check(art.GetPixel(0, 0).A == 0 && art.GetPixel(43, 43).A == 0, "Raw land corners remain transparent: " + id);
                    Check(art.GetPixel(21, 0).A == 255 && art.GetPixel(22, 43).A == 255, "Stored diamond pixels remain opaque: " + id);
                }
            }
            int decodedStatics = 0;
            foreach (int id in staticSamples)
            {
                using (Bitmap art = assets.StaticPreview(id))
                {
                    if (art == null) { report.AppendLine("Indexed static " + id + " did not decode; warnings retain this limitation."); continue; }
                    Check(art.Width > 0 && art.Height > 0 && art.Width <= 1024 && art.Height <= 1024, "Sampled static dimensions are bounded: " + id);
                    decodedStatics++;
                }
            }
            Check(decodedStatics > 0, "Actual UOP static records decode.");
            foreach (int id in Enumerable.Range(0, assets.TextureCount).Where(assets.HasTexture).Take(8))
                using (Bitmap texture = assets.TexturePreview(id))
                    Check(texture != null && (texture.Width == 64 || texture.Width == 128) && texture.Height == texture.Width, "Sampled texture record has expected square dimensions.");
            if (absentLand >= 0) using (Bitmap missing = assets.LandArtPreview(absentLand)) Check(missing == null, "Absent land remains absent, without synthetic artwork.");
            if (absentStatic >= 0) using (Bitmap missing = assets.StaticPreview(absentStatic)) Check(missing == null, "Absent static remains absent, without synthetic artwork.");
            report.AppendLine("Decoded " + landSamples.Count + " raw-land samples and " + decodedStatics + " static samples; adapter warnings: " + assets.Warnings.Count + ".");
        }

        private static void TestBrowser(ClientAssets assets)
        {
            using (AssetBrowser browser = new AssetBrowser(assets))
            {
                ShowOffscreen(browser); Pump();
                browser.SetFilter(0, "", true); Pump();
                Check(browser.FilteredCount == 16384, "Browser's all-land mode exposes the complete numeric land namespace.");
                Check(browser.CurrentPageIds.All(id => id >= 0 && id <= 16383), "Land page contains only legal land IDs.");
                browser.SetFilter(0, "0x3FFF", true); Pump();
                Check(browser.FilteredCount == 1 && browser.CurrentPageIds.Contains(16383), "Hex lookup reaches maximum land ID even without artwork.");
                Check(browser.SelectById(16383), "Maximum land ID can be selected for inspection.");
                browser.SetFilter(1, "65535", true); Pump();
                Check(browser.FilteredCount == 1 && browser.CurrentPageIds.Contains(65535), "Decimal lookup reaches maximum static ID.");
                Check(browser.SelectById(65535), "Maximum static ID can be selected for inspection.");
                browser.SetFilter(0, "", false); Pump();
                int expectedLand = Enumerable.Range(0, 16384).Count(assets.HasLandArt);
                Check(browser.FilteredCount == expectedLand, "Available-land filter agrees with client record availability.");
                browser.SetFilter(0, "GRASS", false); Pump();
                Check(browser.FilteredCount == Enumerable.Range(0, 16384).Count(id => assets.HasLandArt(id) && assets.LandName(id).IndexOf("grass", StringComparison.OrdinalIgnoreCase) >= 0), "Name filtering is case-insensitive and based on client metadata.");
                browser.SetFilter(2, "", false); Pump();
                Check(browser.FilteredCount == Enumerable.Range(0, assets.TextureCount).Count(assets.HasTexture), "Texture browser uses its separate namespace.");
                browser.SetFilter(2, "0", true); browser.SelectById(0); Pump();
                Check(!Get<Button>(browser, "choose").Enabled, "Texture zero without a usable land association cannot be painted as an arbitrary land ID.");
                browser.SetFilter(0, "__no_such_tile_name_987654321__", true); Pump();
                Check(browser.FilteredCount == 0 && !browser.CurrentPageIds.Any(), "No-result filter shows zero records without fabricated fallback.");
                browser.SetFilter(0, "", false); Pump();
                SaveScreenshot(browser, "client-browser-qa.png");
                browser.Close(); Pump();
            }
            using (Bitmap art = assets.LandArtPreview(Enumerable.Range(0, 16384).First(assets.HasLandArt)))
                Check(art != null, "Closing browser does not dispose its caller-owned client adapter.");
            TestAcceptedSelection(assets, 0, 16383, false);
            TestAcceptedSelection(assets, 1, 65535, true);
            int linkedLand = Enumerable.Range(0, 16384).First(id => assets.LandTextureId(id) != 0 && assets.LandTextureId(id) != id && assets.HasTexture(assets.LandTextureId(id)));
            int textureId = assets.LandTextureId(linkedLand);
            using (AssetBrowser browser = new AssetBrowser(assets))
            {
                ShowOffscreen(browser); browser.SetFilter(2, textureId.ToString(), false); browser.SelectById(textureId); Pump();
                ComboBox linked = Get<ComboBox>(browser, "associatedLand");
                int choice = -1;
                for (int i = 0; i < linked.Items.Count; i++) if (Get<int>(linked.Items[i], "Id") == linkedLand) choice = i;
                Check(choice >= 0, "Texture inspector exposes actual associated land IDs.");
                linked.SelectedIndex = choice;
                Invoke(browser, "AcceptTile");
                Check(browser.DialogResult == DialogResult.OK && browser.SelectedTileId == linkedLand && browser.SelectedTileId != textureId && !browser.SelectedIsStatic, "Texture selection emits associated LAND ID, never the separate texture ID.");
            }
        }

        private static void TestAcceptedSelection(ClientAssets assets, int mode, int id, bool isStatic)
        {
            using (AssetBrowser browser = new AssetBrowser(assets))
            {
                ShowOffscreen(browser); browser.SetFilter(mode, id.ToString(), true); browser.SelectById(id); Pump();
                Invoke(browser, "AcceptTile");
                Check(browser.DialogResult == DialogResult.OK && browser.SelectedTileId == id && browser.SelectedIsStatic == isStatic, "Accepted selection emits exact " + (isStatic ? "static" : "land") + " ID without archive offset.");
            }
        }

        private static void TestMissingAssets()
        {
            string folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client-empty-fixture"); Directory.CreateDirectory(folder);
            using (ClientAssets assets = ClientAssets.Open(folder))
            {
                Check(!assets.HasLandArt(0) && !assets.HasStaticArt(0) && !assets.HasTexture(0), "Missing client files report absent artwork.");
                using (Bitmap land = assets.LandArtPreview(0)) Check(land == null, "Missing-client land preview is null.");
                using (Bitmap art = assets.StaticPreview(0)) Check(art == null, "Missing-client static preview is null.");
                Check(assets.Warnings.Count > 0, "Missing-client limitations are reported.");
                using (AssetBrowser browser = new AssetBrowser(assets))
                {
                    ShowOffscreen(browser); browser.SetFilter(0, "", false); Pump();
                    Check(browser.FilteredCount == 0, "Empty client produces no available-art browser claims.");
                    browser.SetFilter(0, "16383", true); Pump();
                    Check(browser.FilteredCount == 1, "Numeric editing remains available when art is missing.");
                    browser.Close();
                }
            }
        }

        private static void TestStudio(string folder, string data)
        {
            string settings = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client-path.txt");
            bool existed = File.Exists(settings); string oldSetting = existed ? File.ReadAllText(settings) : null;
            using (StudioForm form = new StudioForm(Catalog.Load(data)))
            {
                ShowOffscreen(form); form.ConnectClient(folder, false); Pump();
                Check(form.Assets != null && String.Equals(Path.GetFullPath(form.Assets.Folder).TrimEnd('\\'), folder.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase), "Studio connects to the explicitly supplied real client folder.");
                form.MakeExample(); Pump();
                SaveScreenshot(form, "client-map-qa.png");
                Set(form, "dirty", false); form.Close(); Pump();
            }
            Check(File.Exists(settings) == existed && (!existed || File.ReadAllText(settings) == oldSetting), "ConnectClient(persist:false) preserves saved client configuration.");
            Check(uiException == null, "Client-connected form closes without UI errors.");
        }

        private static void ShowOffscreen(Form form)
        {
            form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-10000, -10000); form.ShowInTaskbar = false; form.Show();
        }
        private static void SaveScreenshot(Form form, string name)
        {
            string path = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", name));
            using (Bitmap image = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(image, new Rectangle(Point.Empty, form.Size)); image.Save(path, ImageFormat.Png); }
            report.AppendLine("Screenshot: " + path);
        }
        private static void Set(object target, string name, object value)
        {
            target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).SetValue(target, value);
        }
        private static T Get<T>(object target, string name)
        {
            return (T)target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).GetValue(target);
        }
        private static object Invoke(object target, string name, params object[] args)
        {
            try { return target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).Invoke(target, args); }
            catch (TargetInvocationException ex) { throw ex.InnerException; }
        }
        private static void Pump()
        {
            Application.DoEvents(); if (uiException != null) throw new Exception("UI event failed", uiException);
        }
        private static void Check(bool condition, string message)
        {
            assertions++; if (!condition) throw new Exception("FAILED: " + message);
        }
    }
}
