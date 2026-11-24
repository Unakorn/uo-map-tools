using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

namespace TerrainStudio
{
    // Runs only this application's own form, offscreen. No user dialogs or external UI are controlled.
    public static class UiTests
    {
        private static int assertions;
        private static Exception uiException;

        [STAThread]
        public static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e) { uiException = e.Exception; };
            try
            {
                string data = args.Length > 0 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Data");
                Catalog catalog = Catalog.Load(data);
                using (StudioForm form = new StudioForm(catalog))
                {
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new Point(-10000, -10000);
                    form.ShowInTaskbar = false;
                    form.Show(); Pump();
                    TestScalarBrushes(form, catalog);
                    TestSourcePreservation(form, catalog);
                    TestScrolling(form);
                    TestAssetOwnership(form);
                    form.MakeExample(); Pump();
                    form.Width = 1380; form.Height = 900; Pump();
                    string image = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "ui-qa.png"));
                    using (Bitmap screenshot = new Bitmap(form.Width, form.Height))
                    {
                        form.DrawToBitmap(screenshot, new Rectangle(Point.Empty, form.Size));
                        screenshot.Save(image, ImageFormat.Png);
                    }
                    Check(Get<ScrollableControl>(form, "canvas").ClientSize.Width > 200, "Canvas has a useful viewport after layout.");
                    Set(form, "dirty", false);
                    form.Close(); Pump();
                    Console.WriteLine("UI tests: " + assertions + " assertions passed. Screenshot: " + image);
                }
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }

        private static void TestScalarBrushes(StudioForm form, Catalog catalog)
        {
            Invoke(form, "ResetDocument", new MapDocument(16, 16), false);
            ComboBox mode = Get<ComboBox>(form, "paintMode");
            NumericUpDown land = Get<NumericUpDown>(form, "landId");
            NumericUpDown elevation = Get<NumericUpDown>(form, "altitude");
            Check(land.Minimum == 0 && land.Maximum == 16383, "Every legal land ID is selectable.");
            Check(elevation.Minimum == -128 && elevation.Maximum == 127 && elevation.Increment == 1, "Height control supports every signed altitude in steps of one.");
            mode.SelectedIndex = 1;
            land.Value = 0; Stroke(form, 2, 3);
            Check(form.Document.Land[50] == 0 && form.Document.Materials[50] == -1, "Land zero remains an exact manual tile.");
            land.Value = 16383; Stroke(form, 2, 3);
            Check(form.Document.Land[50] == 0x3FFF && form.Document.Elevation[50] == 0, "Maximum land ID is painted without changing height.");
            mode.SelectedIndex = 2;
            elevation.Value = -128; Stroke(form, 2, 3);
            Check(form.Document.Elevation[50] == -128 && form.Document.Land[50] == 0x3FFF && form.Document.Materials[50] == -1, "Minimum height preserves exact land and manual provenance.");
            elevation.Value = 127; Stroke(form, 2, 3);
            Check(form.Document.Elevation[50] == 127, "Maximum height is painted exactly.");
            ListBox terrains = Get<ListBox>(form, "terrains");
            terrains.SelectedItem = catalog.Terrains.First(t => terrains.Items.Contains(t));
            mode.SelectedIndex = 0;
            TerrainDefinition selected = (TerrainDefinition)terrains.SelectedItem;
            Stroke(form, 2, 3);
            Check(form.Document.Land[50] == selected.TileId && form.Document.Materials[50] == selected.Id && form.Document.Elevation[50] == 127, "Material paint preserves existing altitude.");

            mode.SelectedIndex = 3;
            Get<NumericUpDown>(form, "staticId").Value = 65535;
            Get<NumericUpDown>(form, "hue").Value = 65535;
            elevation.Value = -128;
            MapDocument beforeStatic = form.Document.Clone();
            Stroke(form, 5, 6);
            Check(form.Document.Statics.Count == 1, "Static brush adds a placement.");
            StaticPlacement placement = form.Document.Statics[0];
            Check(placement.X == 5 && placement.Y == 6 && placement.Id == 65535 && placement.Hue == 65535 && placement.Z == -128, "Static brush preserves full scalar ranges.");
            Check(form.Document.Land.SequenceEqual(beforeStatic.Land) && form.Document.Elevation.SequenceEqual(beforeStatic.Elevation), "Static placement does not alter ground layers.");
            Stroke(form, 5, 6);
            Check(form.Document.Statics.Count == 1, "Repeated static stroke does not duplicate an identical placement.");
            mode.SelectedIndex = 4; Stroke(form, 5, 6);
            Check(form.Document.Statics.Count == 0, "Erase static removes the placement.");
            Invoke(form, "Undo");
            Check(form.Document.Statics.Count == 1 && form.Document.Statics[0].Id == 65535, "Undo restores static placement.");
            Invoke(form, "Redo");
            Check(form.Document.Statics.Count == 0, "Redo reapplies static removal.");
            Invoke(form, "Undo");

            mode.SelectedIndex = 1; land.Value = 16383;
            form.PointerDown(0, 10, MouseButtons.Left); form.PointerMove(7, 10); form.PointerUp();
            for (int x = 0; x <= 7; x++) Check(form.Document.Land[160 + x] == 16383 && form.Document.Materials[160 + x] == -1, "Drag interpolation leaves no unpainted cells.");
            MapDocument beforeInvalid = form.Document.Clone();
            form.PointerDown(-1, 3, MouseButtons.Left); form.PointerDown(16, 2, MouseButtons.Left); form.PointerUp();
            Check(form.Document.Land.SequenceEqual(beforeInvalid.Land), "Out-of-map pointer positions are ignored.");
            Pump();
        }

        private static void TestSourcePreservation(StudioForm form, Catalog catalog)
        {
            form.MakeExample();
            ComboBox mode = Get<ComboBox>(form, "paintMode");
            mode.SelectedIndex = 1; Get<NumericUpDown>(form, "landId").Value = 16383; Stroke(form, 64, 64);
            mode.SelectedIndex = 2; Get<NumericUpDown>(form, "altitude").Value = -127; Stroke(form, 64, 64);
            MapDocument source = form.Document;
            MapDocument snapshot = source.Clone();
            CompileResult result = catalog.Compile(source, false, 0);
            Invoke(form, "ShowBuild", result);
            Check(Object.ReferenceEquals(form.Document, source) && !Object.ReferenceEquals(form.DisplayMap, source), "Transition preview is distinct from editable source.");
            Check(source.Land.SequenceEqual(snapshot.Land) && source.Elevation.SequenceEqual(snapshot.Elevation) && source.Materials.SequenceEqual(snapshot.Materials), "Transition compilation never mutates source layers.");
            Check(form.DisplayMap.Land[64 * 128 + 64] == 16383 && form.DisplayMap.Elevation[64 * 128 + 64] == -127, "Transition preview preserves exact manual tile and altitude.");
            Get<NumericUpDown>(form, "altitude").Value = 126; Stroke(form, 64, 64);
            Check(Object.ReferenceEquals(form.DisplayMap, form.Document), "Editing invalidates stale compiled preview.");
            Invoke(form, "Undo");
            Check(form.Document.Elevation[64 * 128 + 64] == -127, "Undo restores exact pre-edit source altitude.");
            Get<CheckBox>(form, "legacyOffsets").Checked = true;
            Invoke(form, "ResetDocument", new MapDocument(8, 8), false);
            Check(!Get<CheckBox>(form, "legacyOffsets").Checked, "New/open documents reset legacy altitude offsets off.");
            Pump();
        }

        private static void TestScrolling(StudioForm form)
        {
            Invoke(form, "ResetDocument", new MapDocument(8192, 128), false);
            Get<NumericUpDown>(form, "zoom").Value = 40;
            ScrollableControl canvas = Get<ScrollableControl>(form, "canvas");
            Pump();
            Check(canvas.AutoScrollMinSize.Width == 327680, "Virtual extent supports maximum map width at maximum zoom.");
            Check(canvas.Width <= form.ClientSize.Width && canvas.Height <= form.ClientSize.Height, "Native buffered canvas remains viewport sized.");
            canvas.AutoScrollPosition = new Point(327680, 5120); Pump();
            Check(canvas.AutoScrollPosition.X < -300000, "Viewport can reach far-right map columns beyond native control size limits.");
            ComboBox mode = Get<ComboBox>(form, "paintMode"); mode.SelectedIndex = 1;
            Get<NumericUpDown>(form, "landId").Value = 16383;
            int px = canvas.ClientSize.Width / 2, py = canvas.ClientSize.Height / 2;
            int expectedX = (px - canvas.AutoScrollPosition.X) / form.Zoom;
            int expectedY = (py - canvas.AutoScrollPosition.Y) / form.Zoom;
            Invoke(canvas, "OnMouseDown", new MouseEventArgs(MouseButtons.Left, 1, px, py, 0));
            Invoke(canvas, "OnMouseUp", new MouseEventArgs(MouseButtons.Left, 1, px, py, 0));
            Check(expectedX < 8192 && expectedY < 128 && form.Document.Land[expectedY * 8192 + expectedX] == 16383 && form.Document.Materials[expectedY * 8192 + expectedX] == -1, "Scrolled pointer translates to correct world cell.");
            using (Bitmap viewport = new Bitmap(canvas.Width, canvas.Height)) canvas.DrawToBitmap(viewport, new Rectangle(Point.Empty, canvas.Size));
            Check(uiException == null, "Far-edge viewport renders without exceptions.");
            Invoke(form, "ResetDocument", new MapDocument(128, 8192), false);
            Pump();
            canvas.AutoScrollPosition = new Point(5120, 327680); Pump();
            Check(canvas.AutoScrollMinSize.Height == 327680 && canvas.AutoScrollPosition.Y < -300000, "Viewport supports maximum vertical extent and scrolling.");
            px = canvas.ClientSize.Width / 2; py = canvas.ClientSize.Height / 2;
            expectedX = (px - canvas.AutoScrollPosition.X) / form.Zoom;
            expectedY = (py - canvas.AutoScrollPosition.Y) / form.Zoom;
            Invoke(canvas, "OnMouseDown", new MouseEventArgs(MouseButtons.Left, 1, px, py, 0));
            Invoke(canvas, "OnMouseUp", new MouseEventArgs(MouseButtons.Left, 1, px, py, 0));
            Check(expectedX < 128 && expectedY < 8192 && form.Document.Land[expectedY * 128 + expectedX] == 16383, "Vertically scrolled pointer maps to correct world cell.");
            Get<NumericUpDown>(form, "zoom").Value = 5;
            Pump();
        }

        private static void TestAssetOwnership(StudioForm form)
        {
            string folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui-art-fixture");
            Directory.CreateDirectory(folder);
            using (BinaryWriter art = new BinaryWriter(File.Create(Path.Combine(folder, "art.mul"))))
            using (BinaryWriter index = new BinaryWriter(File.Create(Path.Combine(folder, "artidx.mul"))))
            {
                for (int id = 0; id < 4; id++)
                {
                    index.Write((int)art.BaseStream.Position); index.Write(2024); index.Write(0);
                    for (int i = 0; i < 1012; i++) art.Write((ushort)(id % 2 == 0 ? 0x7C00 : 0x03E0));
                }
            }
            form.Assets = ClientAssets.Open(folder);
            Invoke(form, "ResetDocument", new MapDocument(16, 16), false);
            Get<ComboBox>(form, "paintMode").SelectedIndex = 1;
            Get<NumericUpDown>(form, "landId").Value = 0;
            Invoke(form, "UpdateSelection");
            Bitmap previous = (Bitmap)Get<PictureBox>(form, "art").Image;
            Check(previous != null && previous.Width == 44, "Client land preview reaches PictureBox.");
            Get<NumericUpDown>(form, "landId").Value = 1;
            bool disposed = false;
            try { previous.GetPixel(21, 0); }
            catch (ArgumentException) { disposed = true; }
            Check(disposed, "Replacing selected art disposes the prior owned bitmap.");
            ScrollableControl canvas = Get<ScrollableControl>(form, "canvas");
            using (Bitmap viewport = new Bitmap(canvas.Width, canvas.Height))
                for (int frame = 0; frame < 20; frame++) canvas.DrawToBitmap(viewport, new Rectangle(Point.Empty, canvas.Size));
            Pump();
            Check(uiException == null, "Repeated artwork canvas renders do not use disposed previews.");
            Invoke(form, "ClearPreview");
            form.Assets.Dispose(); form.Assets = null;
            Invoke(form, "UpdateSelection");
        }

        private static void Stroke(StudioForm form, int x, int y)
        {
            form.PointerDown(x, y, MouseButtons.Left); form.PointerUp();
        }
        private static void Pump()
        {
            Application.DoEvents();
            if (uiException != null) throw new Exception("UI event failed", uiException);
        }
        private static T Get<T>(object target, string name)
        {
            return (T)target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).GetValue(target);
        }
        private static void Set(object target, string name, object value)
        {
            target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).SetValue(target, value);
        }
        private static object Invoke(object target, string name, params object[] args)
        {
            try { return target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).Invoke(target, args); }
            catch (TargetInvocationException ex) { throw ex.InnerException; }
        }
        private static void Check(bool condition, string message)
        {
            assertions++;
            if (!condition) throw new Exception("FAILED: " + message);
        }
    }
}
