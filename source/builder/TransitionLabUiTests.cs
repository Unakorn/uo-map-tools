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
    // Exercises only our own forms, offscreen, without opening file dialogs or changing a user's project.
    public static class TransitionLabUiTests
    {
        static int checks;
        static Exception uiException;
        static readonly List<string> layoutFailures = new List<string>();

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
                using (var parent = new StudioForm(catalog))
                using (var lab = new TransitionLabForm(catalog, null, null, null))
                {
                    Offscreen(parent); parent.Show(); Pump();
                    MapDocument parentSource = parent.Document, parentBefore = parentSource.Clone();
                    Offscreen(lab); lab.Show(parent); Pump();
                    Check(!lab.ApplyOffsets && !lab.AllowAutocorrect, "New lab starts with source-height and shape preservation enabled.");
                    Layout(lab, new Size(1000, 760)); Layout(lab, new Size(1200, 860));
                    ExerciseControls(lab, catalog);
                    Check(Object.ReferenceEquals(parentSource, parent.Document), "Lab controls do not replace the parent project.");
                    Same(parentSource, parentBefore, "Lab controls do not mutate the parent project.");
                    SaveImage(lab, "transition-lab-ui-qa.png");
                    lab.Close(); Pump();
                    Check(Object.ReferenceEquals(parentSource, parent.Document), "Closing the lab without Use test map leaves the parent source in place.");
                    Same(parentSource, parentBefore, "Closing the lab preserves all parent layers.");
                    Set(parent, "dirty", false); parent.Close(); Pump();
                }
                TestReportStates();
                if (args.Length > 1)
                {
                    using (ClientAssets assets = ClientAssets.Open(args[1]))
                    using (var lab = new TransitionLabForm(catalog, assets, null, null))
                    {
                        Offscreen(lab); lab.Show(); Pump();
                        Get<ComboBox>(lab, "background").SelectedItem = catalog.Terrains.First(t => t.Id == 1);
                        Get<ComboBox>(lab, "foreground").SelectedItem = catalog.Terrains.First(t => t.Id == 17);
                        Get<ComboBox>(lab, "shape").SelectedItem = "Vertical strip";
                        Get<NumericUpDown>(lab, "width").Value = 1; Pump();
                        SaveImage(lab, "transition-lab-client-qa.png");
                        Check(Get<Label>(lab, "summary").Text.Contains("in-game"), "Client preview identifies the need for in-game visual testing.");
                        lab.Close(); Pump();
                    }
                }
                Check(layoutFailures.Count == 0, String.Join("\r\n", layoutFailures));
                Console.WriteLine("Transition lab UI: " + checks + " checks passed."); return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }

        static void ExerciseControls(TransitionLabForm lab, Catalog catalog)
        {
            ComboBox background = Get<ComboBox>(lab, "background"), foreground = Get<ComboBox>(lab, "foreground"), shape = Get<ComboBox>(lab, "shape");
            NumericUpDown width = Get<NumericUpDown>(lab, "width"), backgroundZ = Get<NumericUpDown>(lab, "backgroundZ"), foregroundZ = Get<NumericUpDown>(lab, "foregroundZ");
            Check(width.Minimum == 1 && width.Increment == 1 && width.Maximum >= 4, "Widths one through four are available in single-tile increments.");
            Check(backgroundZ.Minimum == -128 && backgroundZ.Maximum == 127 && foregroundZ.Minimum == -128 && foregroundZ.Maximum == 127, "Both source heights expose the full signed-byte range.");
            background.SelectedItem = catalog.Terrains.First(t => t.Id == 1);
            foreground.SelectedItem = catalog.Terrains.First(t => t.Id == 17);
            backgroundZ.Value = -3; foregroundZ.Value = 7;
            foreach (string choice in TransitionLab.Shapes)
            {
                shape.SelectedItem = choice;
                for (int value = 1; value <= 4; value++)
                {
                    width.Value = value; Pump();
                    Check(lab.Result != null && lab.TestSource.Width == 32 && lab.TestSource.Height == 32, choice + " rebuilds successfully at width " + value);
                    Check(lab.Result.States.Length == 1024, "Every preview cell has a diagnostic state.");
                    Check(lab.Result.Matched + lab.Result.Missing == 1024, "Report totals account for every material cell.");
                    Check(lab.TestSource.Materials.Where((m, i) => m == 1).Any() && lab.TestSource.Materials.Any(m => m == 17), "Both selected materials reach the source.");
                    Check(lab.TestSource.Elevation.Where((z, i) => lab.TestSource.Materials[i] == 1).All(z => z == -3) && lab.TestSource.Elevation.Where((z, i) => lab.TestSource.Materials[i] == 17).All(z => z == 7), "Source heights follow their selected materials.");
                    Check(lab.Result.Map.Elevation.SequenceEqual(lab.TestSource.Elevation), "Offsets-off preview preserves exact source elevations.");
                    Check(lab.ReportText().Contains("width: " + value) && lab.ReportText().Contains(choice), "Report follows the active shape and width.");
                    Check(lab.ReportText().Contains("No minimum") && lab.ReportText().Contains("visual correctness"), "Report states the experiment's width policy and visual limitation.");
                }
            }
            shape.SelectedItem = "Isolated square"; width.Value = 1; Pump();
            int blue = Array.IndexOf(lab.TestSource.Materials, 17);
            Check(lab.Result.States[blue] == CellResolution.AutocorrectSkipped && lab.Result.Map.Land[blue] == 528, "Default preserves an isolated Blue Tile instead of applying the legacy Grass replacement.");
            MapDocument source = lab.TestSource, before = source.Clone();
            Get<CheckBox>(lab, "autocorrect").Checked = true; Pump();
            Check(lab.AllowAutocorrect && lab.Result.States[blue] == CellResolution.LegacyAutocorrect && lab.Result.Map.Land[blue] == 3, "Enabling autocorrect rebuilds to the explicitly labeled legacy replacement.");
            Same(source, before, "Rebuilding with autocorrect does not mutate the earlier source map.");
            Check(lab.ReportText().Contains("LegacyAutocorrect") && lab.ReportText().Contains("allow legacy autocorrect: True"), "Report names enabled autocorrect and affected cells.");
            Get<CheckBox>(lab, "autocorrect").Checked = false; Pump();
            Check(lab.Result.Map.Land[blue] == 528 && lab.ReportText().Contains("AutocorrectSkipped"), "Disabling autocorrect restores source terrain and reports the skipped rule.");
            foreach (string name in new[] { "issues", "grid" })
            {
                CompileResult result = lab.Result; MapDocument snapshot = lab.TestSource.Clone();
                CheckBox flag = Get<CheckBox>(lab, name); flag.Checked = !flag.Checked; Pump();
                Check(Object.ReferenceEquals(result, lab.Result), name + " display toggle does not regenerate map data.");
                Same(lab.TestSource, snapshot, name + " display toggle leaves source data intact.");
                flag.Checked = !flag.Checked;
            }
            Get<CheckBox>(lab, "offsets").Checked = true; Pump();
            Check(lab.ApplyOffsets && lab.ReportText().Contains("legacy offsets: True"), "Legacy offsets toggle rebuilds and reaches the report.");
            Get<CheckBox>(lab, "offsets").Checked = false;
            backgroundZ.Value = -128; foregroundZ.Value = 127; Pump();
            Check(lab.TestSource.Elevation.Min() == -128 && lab.TestSource.Elevation.Max() == 127 && lab.Result != null, "Extreme source elevations rebuild safely with offsets disabled.");
            Descendants(lab).OfType<Button>().Single(b => b.Text == "Swap").PerformClick(); Pump();
            Check(((TerrainDefinition)background.SelectedItem).Id == 17 && ((TerrainDefinition)foreground.SelectedItem).Id == 1 && backgroundZ.Value == 127 && foregroundZ.Value == -128, "Swap exchanges both terrain choices and their heights.");
            Check(lab.TestSource.Materials[0] == 17 && lab.TestSource.Elevation[0] == 127, "Swapped surroundings reach the new source.");
            foreground.SelectedItem = catalog.Terrains.First(t => t.Id == 4); Pump();
            Check(lab.TestSource.Materials.Contains(4) && !lab.TestSource.Materials.Contains(1), "Changing the terrain pair replaces the experiment's foreground.");
            Control canvas = Get<Control>(lab, "sourceView");
            Invoke(canvas, "OnMouseDown", new MouseEventArgs(MouseButtons.Left, 1, canvas.ClientSize.Width / 2, canvas.ClientSize.Height / 2, 0)); Pump();
            Check(Get<TextBox>(lab, "inspector").Text.Contains("Cell (16, 16)"), "Clicking the source preview selects the corresponding map cell.");
            canvas = Get<Control>(lab, "resultView");
            Invoke(canvas, "OnMouseDown", new MouseEventArgs(MouseButtons.Left, 1, canvas.ClientSize.Width / 2, canvas.ClientSize.Height / 2, 0)); Pump();
            Check(Get<TextBox>(lab, "inspector").Text.Contains(lab.Result.States[16 * 32 + 16].ToString()), "Resolved preview inspection displays the selected cell's diagnostic state.");
        }

        static void TestReportStates()
        {
            string folder = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "transition-lab-ui-fixture-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(folder, "System")); Directory.CreateDirectory(Path.Combine(folder, "Transitions"));
            File.WriteAllText(Path.Combine(folder, "System", "Terrain.xml"), "<Terrains><Terrain ID='1' Name='Grass' TileID='3' R='0' G='100' B='0'/><Terrain ID='4' Name='Sand' TileID='22' R='200' G='180' B='20'/></Terrains>");
            File.WriteAllText(Path.Combine(folder, "Transitions", "test.xml"), "<Trans><TransInfo Description='Uniform Grass' HashKey='010101010101010101'><MapTiles><MapTile TileID='100' AltIDMod='1'/></MapTiles><StaticTiles><StaticTile TileID='200' AltIDMod='-2'/></StaticTiles></TransInfo></Trans>");
            Catalog catalog = Catalog.Load(folder);
            using (var lab = new TransitionLabForm(catalog, null, new HashSet<int> { 3, 22 }, new HashSet<int>()))
            {
                Offscreen(lab); lab.Show(); Pump();
                Check(lab.Result.States.Contains(CellResolution.MissingRule) && lab.Result.States.Contains(CellResolution.UnavailableCandidate), "Preview distinguishes missing rules from unavailable client candidates.");
                string report = lab.ReportText();
                Check(report.Contains("MissingRule") && report.Contains("UnavailableCandidate"), "Saved-report text includes both unresolved causes.");
                Check(lab.Result.Map.Land.SequenceEqual(lab.TestSource.Land) && lab.Result.Map.Elevation.SequenceEqual(lab.TestSource.Elevation), "Unavailable and unmatched cells preserve their base terrain and exact height.");
                lab.Close(); Pump();
            }
            using (var lab = new TransitionLabForm(catalog, null, null, null))
            {
                Offscreen(lab); lab.Show(); Pump();
                Get<CheckBox>(lab, "offsets").Checked = true; Pump();
                Check(lab.Result.Map.Elevation[0] == 1 && lab.TestSource.Elevation[0] == 0, "Offsets checkbox changes resolved height while preserving source height.");
                Check(lab.Result.Map.Statics.Any(s => s.Z == -2), "Offsets checkbox applies the imported static altitude adjustment.");
                Get<NumericUpDown>(lab, "backgroundZ").Value = 127; Pump();
                Check(lab.Result == null && !Get<Button>(lab, "use").Enabled && Get<Label>(lab, "summary").Text.Contains("Cannot build"), "Overflowing offset is reported and cannot be adopted as a valid map.");
                Check(lab.ReportText().Contains("Cannot build"), "Failed preview can still produce a useful report.");
                Get<CheckBox>(lab, "offsets").Checked = false; Pump();
                Check(lab.Result != null && Get<Button>(lab, "use").Enabled && lab.Result.Map.Elevation[0] == 127, "Disabling offsets recovers from overflow without clipping the source height.");
                lab.Close(); Pump();
            }
        }

        static void Layout(TransitionLabForm lab, Size size)
        {
            lab.Size = size; Pump();
            foreach (Control control in Descendants(lab).Where(c => c is ComboBox || c is NumericUpDown || c is CheckBox || c is Button))
            {
                Check(control.Visible && control.Width > 0 && control.Height > 0, size + ": control is visible: " + control.Text);
                Rectangle rect = control.RectangleToScreen(control.ClientRectangle);
                for (Control ancestor = control.Parent; ancestor != null; ancestor = ancestor.Parent)
                {
                    Rectangle clip = ancestor.RectangleToScreen(ancestor.ClientRectangle);
                    checks++;
                    if (!clip.Contains(rect))
                    {
                        FieldInfo field = lab.GetType().GetFields(BindingFlags.Instance | BindingFlags.NonPublic).FirstOrDefault(f => Object.ReferenceEquals(f.GetValue(lab), control));
                        string issue = size + ": " + (field == null ? control.Text : field.Name) + " clipped by " + ancestor.GetType().Name + ": " + rect + " vs " + clip;
                        layoutFailures.Add(issue); Console.Error.WriteLine(issue);
                    }
                }
            }
            foreach (string name in new[] { "sourceView", "resultView" })
            {
                Control canvas = Get<Control>(lab, name);
                Check(canvas.ClientSize.Width >= 256 && canvas.ClientSize.Height >= 256, size + ": " + name + " provides a usable map viewport.");
            }
            SaveImage(lab, "transition-lab-layout-" + size.Width + "x" + size.Height + ".png");
        }
        static void SaveImage(Form form, string name)
        {
            string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name);
            using (var image = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(image, new Rectangle(Point.Empty, form.Size)); image.Save(path, ImageFormat.Png); }
            Console.WriteLine("UI diagnostic: " + path); Pump();
        }
        static IEnumerable<Control> Descendants(Control parent) { foreach (Control child in parent.Controls) { yield return child; foreach (Control nested in Descendants(child)) yield return nested; } }
        static void Offscreen(Form form) { form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-10000, -10000); form.ShowInTaskbar = false; }
        static void Pump() { Application.DoEvents(); if (uiException != null) throw new Exception("UI event failed", uiException); }
        static T Get<T>(object target, string name) { return (T)target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).GetValue(target); }
        static void Set(object target, string name, object value) { target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).SetValue(target, value); }
        static object Invoke(object target, string name, params object[] args) { try { return target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public).Invoke(target, args); } catch (TargetInvocationException ex) { throw ex.InnerException; } }
        static void Same(MapDocument a, MapDocument b, string message) { Check(a.Width == b.Width && a.Height == b.Height && a.Land.SequenceEqual(b.Land) && a.Materials.SequenceEqual(b.Materials) && a.Elevation.SequenceEqual(b.Elevation) && a.Statics.Count == b.Statics.Count && a.Statics.Zip(b.Statics, (x, y) => x.X == y.X && x.Y == y.Y && x.Id == y.Id && x.Z == y.Z && x.Hue == y.Hue).All(v => v), message); }
        static void Check(bool condition, string message) { checks++; if (!condition) throw new Exception("FAILED: " + message); }
    }
}
