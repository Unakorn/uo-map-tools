using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace TerrainStudio
{
    // Exercises only this application's own small builder form, offscreen, with synthetic files.
    public static class MapBuildFormTests
    {
        static int checks;
        static Exception uiError;
        static string root;
        [STAThread]
        public static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e) { uiError = e.Exception; };
            Control.CheckForIllegalCrossThreadCalls = true;
            try
            {
                // Keep fixture paths short enough for .NET Framework's nested atomic-export staging.
                string fixtureParent = Path.GetTempPath();
                if (fixtureParent.Length > 100) fixtureParent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Codex");
                root = Path.Combine(fixtureParent, "uo-mbui-" + Guid.NewGuid().ToString("N").Substring(0, 8));
                Directory.CreateDirectory(root);
                Catalog catalog = MakeCatalog();
                string client = MakeClient("textured-client", true), noTextures = MakeClient("missing-textures", false);
                string terrain = Path.Combine(root, "terrain image.png"), altitude = Path.Combine(root, "altitude image.png");
                WriteImages(terrain, altitude);
                byte[] terrainBefore = File.ReadAllBytes(terrain), altitudeBefore = File.ReadAllBytes(altitude);
                byte[] clientBefore = File.ReadAllBytes(Path.Combine(client, "tiledata.mul"));
                using (var form = new MapBuildForm(catalog, client))
                {
                    form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-32000, -32000); form.Show(); Pump();
                    var build = Get<Button>(form, "buildButton");
                    var open = Get<Button>(form, "openOutput");
                    Get<TextBox>(form, "terrainPath").Text = terrain;
                    Get<TextBox>(form, "altitudePath").Text = altitude;
                    string output = Path.Combine(root, "completed maps"); Get<TextBox>(form, "outputPath").Text = output;
                    Check(!form.IsBuilding && form.LastResult == null && build.Enabled && !open.Enabled, "Initial state is ready for one build with no stale result.");
                    Check(Get<TextBox>(form, "clientPath").Text == client, "Supplied client location is displayed.");
                    Check(!All(form).Any(c => c.GetType().Name == "MapCanvas" || c.GetType().Name == "LabCanvas" || c is PictureBox), "Builder contains no terrain editing or live transition canvas.");
                    Check(All(form).OfType<Button>().Count(b => b.Text == "Build map") == 1, "There is one build action.");
                    Check(!All(form).OfType<Button>().Any(b => b.Text.Contains("Resolve") || b.Text.Contains("Paint") || b.Text.Contains("Transition lab")), "No interactive transition/editor stages are exposed.");
                    string allLabels = String.Join(" ", All(form).OfType<Label>().Select(l => l.Text));
                    Check(allLabels.Contains("texture rendering still depends on the client"), "UI does not promise forced texture rendering.");
                    Layout(form, new Size(680, 550), "minimum"); Layout(form, new Size(800, 600), "normal");

                    build.PerformClick();
                    Check(form.IsBuilding && !build.Enabled && !Get<TableLayoutPanel>(form, "inputs").Enabled && !open.Enabled, "One button starts the asynchronous job and disables reentry/input mutation.");
                    var duplicate = form.BuildAsync();
                    Check(duplicate.IsCompleted && form.LastResult == null, "Reentrant BuildAsync returns immediately without starting another job.");
                    WaitForBuild(form);
                    Check(form.LastResult != null && build.Enabled && open.Enabled && Get<TableLayoutPanel>(form, "inputs").Enabled, "Successful build restores controls and enables its output folder. Status: " + Get<Label>(form, "resultStatus").Text + " Report: " + Get<TextBox>(form, "report").Text);
                    Check(Directory.GetDirectories(output).Length == 1, "One click plus rejected reentry publishes exactly one completed folder.");
                    string completed = form.LastResult.OutputDirectory;
                    Check(File.Exists(form.LastResult.ReportPath), "Report is published in the completed output folder.");
                    Check(Get<TextBox>(form, "report").Text == form.LastResult.Report && Get<Label>(form, "resultStatus").Text.Contains("Built 16"), "Completed report and dimensions are displayed directly.");
                    Check(form.LastResult.GeneratedStatics == 0, "Texture-backed GUI output contains no generated static artwork.");
                    VerifyMap(completed);
                    Layout(form, new Size(680, 550), "minimum-completed"); Layout(form, new Size(800, 600), "normal-completed");

                    string failureOutput = Path.Combine(root, "rejected missing texture");
                    Get<TextBox>(form, "clientPath").Text = noTextures; Get<TextBox>(form, "outputPath").Text = failureOutput;
                    build.PerformClick(); WaitForBuild(form);
                    Check(form.LastResult == null && !open.Enabled && build.Enabled && !form.IsBuilding, "Failed build clears stale success and restores controls.");
                    string failure = Get<TextBox>(form, "report").Text;
                    Check(failure.Contains("Texture-backed output rejected") && failure.Contains("(0, 0)") && failure.Contains("no indexed associated terrain texture"), "Missing texture diagnostic identifies cause and coordinates.");
                    Check(!Directory.Exists(failureOutput), "Texture validation failure creates no output directory.");
                    Check(Get<Label>(form, "resultStatus").Text.StartsWith("Build failed"), "Failure status is visible without an intermediate dialog.");

                    Get<TextBox>(form, "clientPath").Text = client;
                    Get<TextBox>(form, "altitudePath").Text = Path.Combine(root, "does-not-exist.png");
                    var failedTask = form.BuildAsync(); WaitForBuild(form); failedTask.GetAwaiter().GetResult();
                    Check(form.LastResult == null && build.Enabled && Get<TextBox>(form, "report").Text.Contains("altitude image"), "Missing-image task completes with an actionable failure and usable controls.");
                    Check(!Directory.Exists(failureOutput), "Missing input does not publish a build.");

                    Get<TextBox>(form, "altitudePath").Text = altitude; Get<TextBox>(form, "outputPath").Text = output;
                    var recovered = form.BuildAsync(); WaitForBuild(form); recovered.GetAwaiter().GetResult();
                    Check(form.LastResult != null && Directory.GetDirectories(output).Length == 2, "Correcting inputs succeeds without replacing the earlier build.");
                    VerifyMap(completed); VerifyMap(form.LastResult.OutputDirectory);
                    Check(terrainBefore.SequenceEqual(File.ReadAllBytes(terrain)) && altitudeBefore.SequenceEqual(File.ReadAllBytes(altitude)), "Successful, failed and repeated GUI jobs leave both image files unchanged.");
                    Check(clientBefore.SequenceEqual(File.ReadAllBytes(Path.Combine(client, "tiledata.mul"))), "Client metadata remains unchanged.");
                    Check(Directory.GetFiles(client).Length == 3 && Directory.GetDirectories(client).Length == 0, "No output was written into the client directory.");
                    form.Close(); Pump();
                }
                Console.WriteLine("Map builder UI: " + checks + " checks passed. Fixtures: " + root);
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }

        static Catalog MakeCatalog()
        {
            string data = Path.Combine(root, "Data"); Directory.CreateDirectory(Path.Combine(data, "System")); Directory.CreateDirectory(Path.Combine(data, "Transitions"));
            File.WriteAllText(Path.Combine(data, "System", "Terrain.xml"), "<Terrains><Terrain ID='1' Name='Grass' TileID='3' R='0' G='100' B='0'/><Terrain ID='4' Name='Sand' TileID='22' R='227' G='191' B='51'/></Terrains>");
            File.WriteAllText(Path.Combine(data, "Transitions", "common.xml"), "<Trans><TransInfo Description='Grass' HashKey='010101010101010101'><MapTiles><MapTile TileID='3' AltIDMod='0'/></MapTiles><StaticTiles/></TransInfo><TransInfo Description='Sand' HashKey='040404040404040404'><MapTiles><MapTile TileID='22' AltIDMod='0'/></MapTiles><StaticTiles/></TransInfo></Trans>");
            return Catalog.Load(data);
        }
        static string MakeClient(string name, bool textures)
        {
            string folder = Path.Combine(root, name); Directory.CreateDirectory(folder);
            using (var writer = new BinaryWriter(File.Create(Path.Combine(folder, "tiledata.mul"))))
            {
                for (int group = 0; group < 512; group++)
                {
                    writer.Write(0);
                    for (int n = 0; n < 32; n++) { int id = group * 32 + n; writer.Write((uint)0); writer.Write((ushort)(textures && (id == 3 || id == 22) ? 1 : 0)); writer.Write(new byte[20]); }
                }
                writer.Write(0); for (int n = 0; n < 32; n++) writer.Write(new byte[37]);
            }
            using (var writer = new BinaryWriter(File.Create(Path.Combine(folder, "texmaps.mul")))) for (int i = 0; i < 4096; i++) writer.Write((ushort)0x03E0);
            using (var writer = new BinaryWriter(File.Create(Path.Combine(folder, "texidx.mul")))) { writer.Write(-1); writer.Write(-1); writer.Write(0); writer.Write(0); writer.Write(8192); writer.Write(0); }
            return folder;
        }
        static void WriteImages(string terrain, string altitude)
        {
            using (var a = new Bitmap(16, 16, PixelFormat.Format32bppArgb)) using (var b = new Bitmap(16, 16, PixelFormat.Format32bppArgb))
            {
                for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) { int shade = y * 16 + x; a.SetPixel(x, y, x < 8 ? Color.FromArgb(0, 100, 0) : Color.FromArgb(227, 191, 51)); b.SetPixel(x, y, Color.FromArgb(shade, shade, shade)); }
                a.Save(terrain, ImageFormat.Png); b.Save(altitude, ImageFormat.Png);
            }
        }
        static void VerifyMap(string folder)
        {
            using (var reader = new BinaryReader(File.OpenRead(Path.Combine(folder, "map0.mul"))))
            {
                Check(reader.BaseStream.Length == 4 * 196, "16x16 map has four 196-byte blocks.");
                for (int bx = 0; bx < 2; bx++) for (int by = 0; by < 2; by++)
                {
                    Check(reader.ReadUInt32() == 0, "Map block header is zero.");
                    for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++)
                    {
                        int worldX = bx * 8 + x, worldY = by * 8 + y;
                        Check(reader.ReadUInt16() == (worldX < 8 ? 3 : 22), "Exact material land ID in X-major block order.");
                        Check(reader.ReadSByte() == worldY * 16 + worldX - 128, "Every grayscale shade is an exact signed height.");
                    }
                }
            }
            Check(new FileInfo(Path.Combine(folder, "statics0.mul")).Length == 0, "No static art output.");
            using (var reader = new BinaryReader(File.OpenRead(Path.Combine(folder, "staidx0.mul"))))
            { Check(reader.BaseStream.Length == 48, "Static index length is exact."); for (int i = 0; i < 4; i++) Check(reader.ReadInt32() == -1 && reader.ReadInt32() == 0 && reader.ReadInt32() == 0, "Empty static index record is exact."); }
        }
        static void Layout(Form form, Size size, string label)
        {
            form.Size = size; form.PerformLayout(); Pump();
            foreach (Control control in All(form).Where(c => c.Visible))
            {
                Rectangle bounds = control.RectangleToScreen(control.ClientRectangle);
                for (Control parent = control.Parent; parent != null; parent = parent.Parent)
                {
                    Rectangle clip = parent.RectangleToScreen(parent.ClientRectangle);
                    Check(bounds.Left >= clip.Left - 1 && bounds.Right <= clip.Right + 1 && bounds.Top >= clip.Top - 1 && bounds.Bottom <= clip.Bottom + 1, label + ": control is visible within ancestor bounds: " + control.GetType().Name + " " + control.Text);
                }
            }
            string image = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "map-builder-" + label + ".png");
            using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size)); bitmap.Save(image, ImageFormat.Png); }
            Console.WriteLine("UI diagnostic: " + image);
        }
        static void WaitForBuild(MapBuildForm form)
        {
            var timer = Stopwatch.StartNew();
            while (form.IsBuilding) { Pump(); if (timer.ElapsedMilliseconds > 30000) throw new TimeoutException("Builder did not complete in 30 seconds."); Thread.Sleep(5); }
            Pump();
        }
        static void Pump()
        {
            Application.DoEvents();
            // This offscreen harness has no outer Application.Run loop. Reinstall the UI
            // synchronization context that the normal application message loop supplies.
            if (!(SynchronizationContext.Current is WindowsFormsSynchronizationContext))
                SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
            if (uiError != null) throw new Exception("UI event failed.", uiError);
            if (Application.OpenForms.Count > 1) throw new Exception("Build requires no intermediate window or dialog.");
        }
        static IEnumerable<Control> All(Control parent) { foreach (Control child in parent.Controls) { yield return child; foreach (Control nested in All(child)) yield return nested; } }
        static T Get<T>(object instance, string name) { return (T)instance.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(instance); }
        static void Check(bool condition, string message) { checks++; if (!condition) throw new Exception("FAILED: " + message); }
    }
}
