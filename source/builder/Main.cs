using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TerrainStudio
{
    internal static class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                string data = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Data");
                var catalog = Catalog.Load(data);
                using (var form = new MapBuildForm(catalog))
                {
                    if (args.Length == 2 && args[0] == "--screenshot")
                    {
                        form.Show(); form.Refresh(); Application.DoEvents();
                        using (var bmp = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bmp, new Rectangle(Point.Empty, form.Size)); bmp.Save(args[1], ImageFormat.Png); }
                    }
                    else Application.Run(form);
                }
            }
            catch (Exception ex) { MessageBox.Show(ex.Message, "UO Map Builder", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
    }

    public sealed class StudioForm : Form
    {
        internal MapDocument Document;
        internal MapDocument DisplayMap { get { return compiled == null ? Document : compiled.Map; } }
        internal Catalog Catalog;
        internal ClientAssets Assets;
        private HashSet<int> clientLand, clientStatics;
        internal bool HeightView, ShowGrid = true, ShowTextures = true, LandArtView = true;
        internal int Zoom = 4;
        private CompileResult compiled;
        private MapCanvas canvas;
        private Panel scroll;
        private ListBox terrains;
        private TextBox search;
        private ComboBox paintMode;
        private NumericUpDown landId, staticId, hue, altitude, brushSize, zoom;
        private Label selectionInfo, headerInfo, status;
        private PictureBox art;
        private TextBox report;
        private CheckBox legacyOffsets;
        private CheckBox legacyAutocorrect;
        private readonly LinkedList<MapDocument> undo = new LinkedList<MapDocument>();
        private readonly LinkedList<MapDocument> redo = new LinkedList<MapDocument>();
        private bool dirty, stroking, busy;
        private long undoBytes;
        private int lastX = -1, lastY = -1;
        private string projectPath;
        internal readonly Dictionary<int, TerrainDefinition> TerrainById;
        private static readonly Color Surface = Color.FromArgb(26, 31, 38);
        private static readonly Color Muted = Color.FromArgb(166, 183, 196);

        public StudioForm(Catalog catalog)
        {
            Catalog = catalog;
            TerrainById = catalog.Terrains.ToDictionary(t => t.Id);
            Text = "Terrain Studio 0.4 — map builder";
            Width = 1380; Height = 900; MinimumSize = new Size(1080, 720);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(15, 19, 24); ForeColor = Color.WhiteSmoke;
            Font = new Font("Segoe UI", 9F);
            KeyPreview = true;
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
            Controls.Add(root);

            var header = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(34, 42, 52) };
            header.Controls.Add(new Label { Text = "UO  /  TERRAIN STUDIO", Font = new Font("Segoe UI Semibold", 17), AutoSize = true, Location = new Point(18, 8) });
            headerInfo = new Label { Text = "Exact tiles. Exact heights. Auditable transitions.", AutoSize = true, ForeColor = Muted, Location = new Point(20, 42) };
            header.Controls.Add(headerInfo); root.Controls.Add(header, 0, 0);
            var toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(10, 6, 0, 0), WrapContents = false, AutoScroll = true };
            toolbar.Controls.Add(Button("New", NewMap)); toolbar.Controls.Add(Button("Map images", OpenMapImages)); toolbar.Controls.Add(Button("Open project", OpenProject)); toolbar.Controls.Add(Button("Save project", SaveProject));
            toolbar.Controls.Add(Button("Import image", ImportImage)); toolbar.Controls.Add(Button("Export image", ExportImage));
            toolbar.Controls.Add(Button("Transition lab", OpenTransitionLab)); toolbar.Controls.Add(Button("Resolve transitions", ResolveTransitions)); toolbar.Controls.Add(Button("Export UO", ExportUo));
            toolbar.Controls.Add(Button("Client files…", LoadClient)); toolbar.Controls.Add(Button("Tiles…", BrowseTiles)); toolbar.Controls.Add(Button("Audit…", AuditClient)); toolbar.Controls.Add(Button("Example", delegate { if (ConfirmDiscard()) MakeExample(); }));
            root.Controls.Add(toolbar, 0, 1);

            var body = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, Padding = new Padding(10, 0, 10, 0) };
            body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250)); body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 290));
            root.Controls.Add(body, 0, 2);
            var left = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, BackColor = Surface, Padding = new Padding(10) };
            left.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); left.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); left.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            left.Controls.Add(new Label { Text = "TERRAIN MATERIALS", ForeColor = Muted, AutoSize = true, Padding = new Padding(0, 7, 0, 0) });
            search = new TextBox { Dock = DockStyle.Top, BackColor = Color.FromArgb(12, 17, 22), ForeColor = Color.WhiteSmoke, BorderStyle = BorderStyle.FixedSingle };
            search.TextChanged += delegate { FilterTerrains(); }; left.Controls.Add(search);
            terrains = new ListBox { Dock = DockStyle.Fill, BackColor = Surface, ForeColor = Color.WhiteSmoke, BorderStyle = BorderStyle.None, DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = 27, IntegralHeight = false };
            terrains.DrawItem += DrawTerrain;
            terrains.SelectedIndexChanged += delegate { if (terrains.SelectedItem != null) { paintMode.SelectedIndex = 0; UpdateSelection(); } };
            left.Controls.Add(terrains); body.Controls.Add(left, 0, 0);

            var center = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(8, 0, 8, 0) };
            center.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); center.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var viewTools = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 4, 0, 0) };
            viewTools.Controls.Add(Button("Undo", Undo)); viewTools.Controls.Add(Button("Redo", Redo));
            var heights = new CheckBox { Text = "Heights", AutoSize = true, Padding = new Padding(3, 7, 0, 0) }; heights.CheckedChanged += delegate { HeightView = heights.Checked; canvas.Invalidate(); }; viewTools.Controls.Add(heights);
            var grid = new CheckBox { Text = "Grid", Checked = true, AutoSize = true, Padding = new Padding(3, 7, 0, 0) }; grid.CheckedChanged += delegate { ShowGrid = grid.Checked; canvas.Invalidate(); }; viewTools.Controls.Add(grid);
            zoom = Number(1, 40, Zoom, 58); zoom.ValueChanged += delegate { Zoom = (int)zoom.Value; ResizeCanvas(); };
            viewTools.Controls.Add(new Label { Text = "Zoom", AutoSize = true, Padding = new Padding(3, 8, 0, 0) }); viewTools.Controls.Add(zoom);
            center.Controls.Add(viewTools);
            scroll = new Panel { Dock = DockStyle.Fill, BackColor = Color.Black, BorderStyle = BorderStyle.FixedSingle };
            canvas = new MapCanvas(this) { Dock = DockStyle.Fill }; scroll.Controls.Add(canvas); center.Controls.Add(scroll); body.Controls.Add(center, 1, 0);

            var right = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = Surface, Padding = new Padding(12, 8, 10, 8) };
            right.Controls.Add(Label("BRUSH", Muted));
            paintMode = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 235, BackColor = Color.FromArgb(12, 17, 22), ForeColor = Color.WhiteSmoke, DrawMode = DrawMode.OwnerDrawFixed };
            paintMode.DrawItem += delegate(object sender, DrawItemEventArgs e) { e.DrawBackground(); int selected = e.Index < 0 ? paintMode.SelectedIndex : e.Index; if (selected >= 0) TextRenderer.DrawText(e.Graphics, paintMode.Items[selected].ToString(), Font, e.Bounds, Color.WhiteSmoke, TextFormatFlags.Left | TextFormatFlags.VerticalCenter); };
            paintMode.Items.AddRange(new object[] { "Terrain material", "Exact land tile", "Height only", "Place static", "Erase statics" }); paintMode.SelectedIndex = 0; paintMode.SelectedIndexChanged += delegate { UpdateSelection(); }; right.Controls.Add(paintMode);
            landId = Number(0, 16383, 3, 130); right.Controls.Add(Row("Land tile ID", landId)); landId.ValueChanged += delegate { UpdateSelection(); };
            staticId = Number(0, 65535, 0, 130); right.Controls.Add(Row("Static ID", staticId)); staticId.ValueChanged += delegate { UpdateSelection(); };
            hue = Number(0, 65535, 0, 130); right.Controls.Add(Row("Static hue", hue));
            altitude = Number(-128, 127, 0, 130); right.Controls.Add(Row("Height (Z)", altitude));
            brushSize = Number(1, 32, 1, 130); right.Controls.Add(Row("Brush tiles", brushSize));
            right.Controls.Add(new Label { Text = "Height painting changes Z only.\nTerrain painting preserves height.\nRight-click samples a cell.", ForeColor = Muted, Width = 235, Height = 58 });
            selectionInfo = new Label { Width = 235, Height = 62, ForeColor = Color.FromArgb(133, 214, 224) }; right.Controls.Add(selectionInfo);
            art = new PictureBox { Size = new Size(235, 95), BackColor = Color.FromArgb(12, 16, 20), SizeMode = PictureBoxSizeMode.Zoom }; right.Controls.Add(art);
            var mapView = new ComboBox { Width = 235, DropDownStyle = ComboBoxStyle.DropDownList, BackColor = Color.FromArgb(12, 17, 22), ForeColor = Color.WhiteSmoke, DrawMode = DrawMode.OwnerDrawFixed };
            mapView.DrawItem += delegate(object sender, DrawItemEventArgs e) { e.DrawBackground(); int selected = e.Index < 0 ? mapView.SelectedIndex : e.Index; if (selected >= 0) TextRenderer.DrawText(e.Graphics, mapView.Items[selected].ToString(), Font, e.Bounds, Color.WhiteSmoke, TextFormatFlags.Left | TextFormatFlags.VerticalCenter); };
            mapView.Items.AddRange(new[] { "Land art (top-down)", "Terrain textures", "Material colors" }); mapView.SelectedIndex = 0;
            mapView.SelectedIndexChanged += delegate { LandArtView = mapView.SelectedIndex == 0; ShowTextures = mapView.SelectedIndex != 2; UpdateSelection(); canvas.Invalidate(); }; right.Controls.Add(mapView);
            right.Controls.Add(new Label { Text = "Flat diagnostic views; height is stored exactly.\nTile browser shows original artwork.", Width = 235, Height = 36, ForeColor = Muted });
            legacyOffsets = new CheckBox { Text = "Apply legacy transition Z offsets", AutoSize = false, Width = 235, Height = 38 }; legacyOffsets.CheckedChanged += delegate { compiled = null; canvas.Invalidate(); }; right.Controls.Add(legacyOffsets);
            right.Controls.Add(new Label { Text = "OFF keeps each imported height exact.\nON lets transition rules adjust Z.", Width = 235, Height = 42, ForeColor = Muted });
            legacyAutocorrect = new CheckBox { Text = "Allow legacy autocorrect", Width = 235, Height = 28 };
            legacyAutocorrect.CheckedChanged += delegate { compiled = null; canvas.Invalidate(); }; right.Controls.Add(legacyAutocorrect);
            right.Controls.Add(new Label { Text = "OFF skips labeled AC rules that can erase\nthin shapes. Missing art keeps base terrain.", Width = 235, Height = 38, ForeColor = Muted });
            right.Controls.Add(Label("COVERAGE / BUILD REPORT", Muted));
            report = new TextBox { Width = 235, Height = 195, ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(12, 16, 20), ForeColor = Muted, BorderStyle = BorderStyle.None, Font = new Font("Segoe UI", 8.5F), Text = catalog.Summary };
            right.Controls.Add(report); right.Controls.Add(Button("Save audit report", SaveReport)); body.Controls.Add(right, 2, 0);
            status = new Label { Dock = DockStyle.Fill, ForeColor = Muted, Padding = new Padding(15, 7, 0, 0) }; root.Controls.Add(status, 0, 3);
            Document = new MapDocument(128, 128); FillMaterial(Document, catalog.Terrains.FirstOrDefault(t => t.Name == "Grass") ?? catalog.Terrains[0]);
            FilterTerrains(); terrains.SelectedItem = catalog.Terrains.FirstOrDefault(t => t.Name == "Grass") ?? catalog.Terrains[0]; ResizeCanvas(); UpdateSelection(); SetStatus("Ready. No client artwork loaded; canvas shows terrain colors. Exact tile colors are ID markers, not artwork.");
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) { e.Cancel = true; return; } if (!ConfirmDiscard()) e.Cancel = true; };
            KeyDown += delegate(object sender, KeyEventArgs e) { if (e.Control && e.KeyCode == Keys.Z) { Undo(); e.SuppressKeyPress = true; } if (e.Control && e.KeyCode == Keys.Y) { Redo(); e.SuppressKeyPress = true; } if (e.Control && e.KeyCode == Keys.S) { SaveProject(); e.SuppressKeyPress = true; } };
        }

        private static Label Label(string text, Color color) { return new Label { Text = text, AutoSize = true, ForeColor = color, Margin = new Padding(0, 7, 0, 7) }; }
        private static NumericUpDown Number(int min, int max, int value, int width) { return new NumericUpDown { Minimum = min, Maximum = max, Value = value, Width = width, BackColor = Color.FromArgb(12, 17, 22), ForeColor = Color.WhiteSmoke, BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(2, 4, 2, 2) }; }
        private static Control Row(string name, Control control) { var p = new Panel { Width = 235, Height = 32, Margin = Padding.Empty }; p.Controls.Add(new Label { Text = name, Location = new Point(0, 8), AutoSize = true }); control.Location = new Point(105, 3); p.Controls.Add(control); return p; }
        private static Button Button(string text, Action action) { var b = new Button { Text = text, AutoSize = true, Height = 30, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(49, 61, 73), ForeColor = Color.WhiteSmoke, Margin = new Padding(3, 0, 3, 0), Padding = new Padding(5, 0, 5, 0) }; b.FlatAppearance.BorderColor = Color.FromArgb(79, 94, 108); b.Click += delegate { try { action(); } catch (Exception ex) { MessageBox.Show(ex.Message, "UO Terrain Studio", MessageBoxButtons.OK, MessageBoxIcon.Warning); } }; return b; }
        private void SetStatus(string text) { status.Text = text; }
        private void OpenMapImages()
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string packaged = Path.GetFullPath(Path.Combine(folder, "..", "map-paint.html"));
            string adjacent = Path.Combine(folder, "map-paint.html");
            string editor = File.Exists(packaged) ? packaged : adjacent;
            if (!File.Exists(editor))
                throw new FileNotFoundException("The map image editor is missing. Keep the 'Map builder' folder inside the UO Map Tools package beside map-paint.html, or place map-paint.html next to this program.");
            Process.Start(new ProcessStartInfo(new Uri(editor).AbsoluteUri) { UseShellExecute = true });
            SetStatus("Opened Map Paint. Use Save for Terrain Studio there, then Open project here when ready.");
        }
        private bool ConfirmDiscard() { return !dirty || MessageBox.Show("Discard unsaved map changes?", "Unsaved map", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes; }
        private void FilterTerrains() { var old = terrains.SelectedItem as TerrainDefinition; terrains.BeginUpdate(); terrains.Items.Clear(); foreach (var t in Catalog.Terrains.OrderBy(t => t.Name)) if (t.Name.IndexOf(search.Text, StringComparison.OrdinalIgnoreCase) >= 0 || t.Id.ToString() == search.Text) terrains.Items.Add(t); if (old != null && terrains.Items.Contains(old)) terrains.SelectedItem = old; else if (terrains.Items.Count > 0) terrains.SelectedIndex = 0; terrains.EndUpdate(); }
        private void DrawTerrain(object sender, DrawItemEventArgs e) { if (e.Index < 0) return; var t = (TerrainDefinition)terrains.Items[e.Index]; e.DrawBackground(); using (var b = new SolidBrush(t.Color)) e.Graphics.FillRectangle(b, e.Bounds.X + 4, e.Bounds.Y + 5, 16, 16); TextRenderer.DrawText(e.Graphics, t.Name, Font, new Rectangle(e.Bounds.X + 28, e.Bounds.Y + 4, e.Bounds.Width - 29, 22), e.ForeColor, TextFormatFlags.EndEllipsis); }
        private void UpdateSelection()
        {
            if (selectionInfo == null || paintMode == null || landId == null || staticId == null) return;
            bool isStatic = paintMode.SelectedIndex == 3; int id = isStatic ? (int)staticId.Value : (int)landId.Value;
            var t = terrains.SelectedItem as TerrainDefinition;
            if (paintMode.SelectedIndex == 0 && t != null) id = t.TileId;
            string name = Assets == null ? "Client artwork not loaded" : (isStatic ? Assets.StaticName(id) : Assets.LandName(id));
            selectionInfo.Text = String.Format("{0} {1}  /  0x{1:X4}\n{2}", isStatic ? "Static" : "Land", id, name);
            ClearPreview();
            if (Assets != null) { try { art.Image = isStatic ? Assets.StaticPreview(id) : (LandArtView ? Assets.LandArtPreview(id) : Assets.LandPreview(id)); if (art.Image == null) selectionInfo.Text += "\nArtwork unavailable"; } catch (Exception ex) { selectionInfo.Text += "\n" + ex.Message; } }
        }
        private static void FillMaterial(MapDocument doc, TerrainDefinition terrain) { for (int i = 0; i < doc.Land.Length; i++) { doc.Materials[i] = terrain.Id; doc.Land[i] = terrain.TileId; } }
        private void ClearPreview() { if (art == null) return; var previous = art.Image; art.Image = null; if (previous != null) previous.Dispose(); }
        private void ResizeCanvas() { if (Document == null || canvas == null) return; canvas.AutoScrollMinSize = new Size(Document.Width * Zoom, Document.Height * Zoom); canvas.Invalidate(); }
        private void ResetDocument(MapDocument doc, bool changed) { Document = doc; compiled = null; undo.Clear(); redo.Clear(); undoBytes = 0; dirty = changed; projectPath = null; legacyOffsets.Checked = false; canvas.AutoScrollPosition = Point.Empty; ResizeCanvas(); headerInfo.Text = doc.Width + " × " + doc.Height + " tiles  •  one image pixel = one map cell  •  Z −128…127"; }
        private long DocumentBytes(MapDocument doc) { return (long)doc.Land.Length * 7 + doc.Statics.Count * 24L; }
        private void PushUndo() { long bytes = DocumentBytes(Document); while (undo.Count > 0 && (undoBytes + bytes > 160L * 1024 * 1024 || undo.Count >= 20)) { undoBytes -= DocumentBytes(undo.First.Value); undo.RemoveFirst(); } undo.AddLast(Document.Clone()); undoBytes += bytes; redo.Clear(); }
        private void Undo() { if (busy || undo.Count == 0) return; redo.AddLast(Document); Document = undo.Last.Value; undoBytes -= DocumentBytes(Document); undo.RemoveLast(); compiled = null; dirty = true; ResizeCanvas(); SetStatus("Undo. Resolve transitions to rebuild the preview."); }
        private void Redo() { if (busy || redo.Count == 0) return; undo.AddLast(Document); undoBytes += DocumentBytes(Document); Document = redo.Last.Value; redo.RemoveLast(); compiled = null; dirty = true; ResizeCanvas(); }
        private void NewMap()
        {
            if (busy || !ConfirmDiscard()) return;
            using (var dialog = new Form { Text = "New map", ClientSize = new Size(325, 190), FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent, MaximizeBox = false, MinimizeBox = false })
            {
                var w = Number(8, 8192, 128, 140); var h = Number(8, 8192, 128, 140); w.Increment = 8; h.Increment = 8;
                var flow = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), FlowDirection = FlowDirection.TopDown }; dialog.Controls.Add(flow); flow.Controls.Add(Row("Width", w)); flow.Controls.Add(Row("Height", h)); flow.Controls.Add(new Label { Text = "Use multiples of 8 for UO export.", AutoSize = true });
                var ok = new Button { Text = "Create", DialogResult = DialogResult.OK }; flow.Controls.Add(ok); dialog.AcceptButton = ok;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                var doc = new MapDocument((int)w.Value, (int)h.Value); var t = terrains.SelectedItem as TerrainDefinition ?? Catalog.Terrains[0]; FillMaterial(doc, t); ResetDocument(doc, true); SetStatus("New map: " + doc.Width + " × " + doc.Height);
            }
        }
        private void OpenProject() { if (busy || !ConfirmDiscard()) return; using (var file = new OpenFileDialog { Filter = "Terrain Studio project|*.uostudio" }) { if (file.ShowDialog(this) != DialogResult.OK) return; var doc = MapIO.LoadProject(file.FileName); ResetDocument(doc, false); projectPath = file.FileName; SetStatus("Opened " + Path.GetFileName(file.FileName)); } }
        private void SaveProject() { if (busy) return; using (var file = new SaveFileDialog { Filter = "Terrain Studio project|*.uostudio", FileName = projectPath == null ? "Untitled.uostudio" : Path.GetFileName(projectPath), OverwritePrompt = true }) { if (file.ShowDialog(this) != DialogResult.OK) return; MapIO.SaveProject(Document, file.FileName); projectPath = file.FileName; dirty = false; SetStatus("Saved editable map, exact heights and manually placed statics."); } }
        private void ImportImage()
        {
            if (busy) return;
            var mode = Choose("Import image", new[] { "Terrain colors (exact Landscaper palette)", "Height — grayscale, Z = shade − 128", "Height — legacy green / blue palette" }); if (mode < 0) return;
            using (var file = new OpenFileDialog { Filter = "Lossless images|*.png;*.bmp" })
            {
                if (file.ShowDialog(this) != DialogResult.OK) return;
                using (var bmp = new Bitmap(file.FileName))
                {
                    if (mode == 0) { var map = TerrainImages.Import(bmp, Catalog); if (!ConfirmDiscard()) return; ResetDocument(map, true); SetStatus("Terrain imported exactly. Height starts at Z = 0; import its matching height image next."); }
                    else { if (bmp.Width != Document.Width || bmp.Height != Document.Height) throw new ArgumentException("Image must match the map: " + Document.Width + " × " + Document.Height + ". Images are never resized."); var z = HeightImages.Import(bmp, mode == 2, Catalog.LegacyAltitudes); PushUndo(); Document.Elevation = z; compiled = null; dirty = true; canvas.Invalidate(); SetStatus("Height imported exactly: no stretching, normalization or skipped height values."); }
                }
            }
        }
        private void ExportImage()
        {
            var mode = Choose("Export image", new[] { "Height — exact 256-shade grayscale PNG", "Terrain — exact material palette PNG" }); if (mode < 0) return;
            using (var file = new SaveFileDialog { Filter = "PNG image|*.png", FileName = mode == 0 ? "height.png" : "terrain.png", OverwritePrompt = true }) { if (file.ShowDialog(this) != DialogResult.OK) return; using (var bmp = mode == 0 ? HeightImages.Export(Document) : TerrainImages.Export(Document, Catalog)) bmp.Save(file.FileName, ImageFormat.Png); SetStatus("Exported source image. Grayscale 0 = Z −128; 128 = Z 0; 255 = Z 127."); }
        }
        private int Choose(string title, string[] choices)
        {
            using (var form = new Form { Text = title, ClientSize = new Size(445, 165), FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, StartPosition = FormStartPosition.CenterParent })
            {
                var list = new ListBox { Dock = DockStyle.Top, Height = 110, Font = Font }; list.Items.AddRange(choices); list.SelectedIndex = 0; form.Controls.Add(list);
                var ok = new Button { Text = "Continue", Dock = DockStyle.Bottom, Height = 36, DialogResult = DialogResult.OK }; form.Controls.Add(ok); form.AcceptButton = ok; return form.ShowDialog(this) == DialogResult.OK ? list.SelectedIndex : -1;
            }
        }
        private void ShowBuild(CompileResult result)
        {
            compiled = result;
            report.Text = String.Format("Matched cells: {0:N0}\r\nUnresolved cells: {1:N0}\r\nConflicting cells: {2:N0}\r\n\r\n{3}\r\n\r\n{4}", result.Matched, result.Missing, result.Conflicts, String.Join("\r\n", result.Notes), Catalog.Summary);
            canvas.Invalidate(); SetStatus("Transition preview ready. Unresolved cells keep their original tile; exact manual tiles are preserved.");
        }
        private async void ResolveTransitions()
        {
            if (busy) return; busy = true; Enabled = false; UseWaitCursor = true; SetStatus("Resolving transition rules…");
            try { var input = Document; bool offsets = legacyOffsets.Checked, autocorrect = legacyAutocorrect.Checked; var result = await Task.Run(() => Catalog.Compile(input, offsets, 0, clientLand, clientStatics, false, autocorrect)); ShowBuild(result); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Build failed", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            finally { busy = false; Enabled = true; UseWaitCursor = false; }
        }
        private async void ExportUo()
        {
            if (busy) return;
            using (var folder = new FolderBrowserDialog { Description = "Choose an output folder. Existing map0.mul / statics0.mul / staidx0.mul files will never be overwritten." })
            {
                if (folder.ShowDialog(this) != DialogResult.OK) return;
                string path = folder.SelectedPath; busy = true; Enabled = false; UseWaitCursor = true; SetStatus("Building UO map files…");
                try { var input = Document; bool offsets = legacyOffsets.Checked, autocorrect = legacyAutocorrect.Checked; var result = await Task.Run(() => Catalog.Compile(input, offsets, 0, clientLand, clientStatics, false, autocorrect)); ShowBuild(result); await Task.Run(() => MapIO.SaveMul(result.Map, path, 0)); File.WriteAllText(Path.Combine(path, "terrain-studio-build-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".txt"), report.Text + "\r\nDimensions: " + Document.Width + " x " + Document.Height + "\r\nClient/server facet dimensions must match.\r\n"); SetStatus("Exported map0.mul, statics0.mul and staidx0.mul. See the build report for coverage gaps."); MessageBox.Show(this, "Exported UO files to:\n" + path + "\n\nConfigure matching facet dimensions in your client/server.\nUnresolved cells: " + result.Missing + "; conflicting cells: " + result.Conflicts + ".", "Export complete"); }
                catch (Exception ex) { MessageBox.Show(this, ex.Message, "Export failed", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                finally { busy = false; Enabled = true; UseWaitCursor = false; }
            }
        }
        private void LoadClient()
        {
            using (var folder = new FolderBrowserDialog { Description = "Choose your UO client data folder. Files are read only." })
            {
                if (folder.ShowDialog(this) != DialogResult.OK) return;
                ConnectClient(folder.SelectedPath, true);
            }
        }
        public void ConnectClient(string folder, bool persist)
        {
            var assets = ClientAssets.Open(folder); ClearPreview(); if (Assets != null) Assets.Dispose(); Assets = assets;
            clientLand = new HashSet<int>(); clientStatics = new HashSet<int>();
            for (int id = 0; id < 16384; id++) { int texture = assets.LandTextureId(id); if (assets.HasLandArt(id) || (texture != 0 && assets.HasTexture(texture))) clientLand.Add(id); }
            for (int id = 0; id < 65536; id++) if (assets.HasStaticArt(id)) clientStatics.Add(id);
            // A missing archive cannot establish that the whole namespace is absent.
            if (clientLand.Count == 0) clientLand = null;
            if (clientStatics.Count == 0) clientStatics = null;
            compiled = null;
            report.Text = assets.Summary + "\r\n" + String.Join("\r\n", assets.Warnings); UpdateSelection(); canvas.Invalidate();
            SetStatus("Connected: " + folder + ". Use Tiles to browse real artwork; Audit checks catalog coverage.");
            if (persist)
            {
                try { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client-path.txt"), Path.GetFullPath(folder), Encoding.UTF8); }
                catch (IOException) { report.AppendText("\r\nClient connected, but the folder setting could not be saved."); }
                catch (UnauthorizedAccessException) { report.AppendText("\r\nClient connected, but the folder setting could not be saved."); }
            }
        }
        public void TryLoadConfiguredClient()
        {
            try
            {
                string setting = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client-path.txt");
                string folder = File.Exists(setting) ? File.ReadAllText(setting).Trim() : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Electronic Arts", "Ultima Online Classic");
                if (Directory.Exists(folder)) ConnectClient(folder, false);
            }
            catch (Exception ex) { report.Text = "Automatic client loading failed: " + ex.Message + "\r\nChoose Client files to select another folder."; }
        }
        private CompileResult CompileMap(MapDocument map, bool offsets) { return Catalog.Compile(map, offsets, 0, clientLand, clientStatics, false, legacyAutocorrect.Checked); }
        private void OpenTransitionLab()
        {
            using (var lab = new TransitionLabForm(Catalog, Assets, clientLand, clientStatics))
            {
                if (lab.ShowDialog(this) != DialogResult.OK || !ConfirmDiscard()) return;
                legacyOffsets.Checked = lab.ApplyOffsets; legacyAutocorrect.Checked = lab.AllowAutocorrect;
                zoom.Value = 12;
                ResetDocument(lab.TestSource.Clone(), true); ShowBuild(CompileMap(Document, legacyOffsets.Checked));
                SetStatus("Loaded a 32 x 32 transition experiment. Edit, save project, or export UO to a fresh test folder.");
            }
        }
        private void BrowseTiles()
        {
            if (Assets == null) { LoadClient(); if (Assets == null) return; }
            using (var browser = new AssetBrowser(Assets))
            {
                if (browser.ShowDialog(this) != DialogResult.OK) return;
                if (browser.SelectedIsStatic) { staticId.Value = browser.SelectedTileId; paintMode.SelectedIndex = 3; }
                else { landId.Value = browser.SelectedTileId; paintMode.SelectedIndex = 1; }
                UpdateSelection(); SetStatus("Selected exact " + (browser.SelectedIsStatic ? "static " : "land tile ") + browser.SelectedTileId + ". Paint anywhere on the map.");
            }
        }
        private async void AuditClient()
        {
            if (busy) return; if (Assets == null) { LoadClient(); if (Assets == null) return; }
            using (var folder = new FolderBrowserDialog { Description = "Choose where to save the client tile inventory and transition coverage reports." })
            {
                if (folder.ShowDialog(this) != DialogResult.OK) return;
                string destination = Path.Combine(folder.SelectedPath, "UO-audit-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff"));
                string clientPath = Assets.Folder; busy = true; Enabled = false; UseWaitCursor = true; SetStatus("Auditing client artwork and transition references…");
                try
                {
                    string summary = await Task.Run(() => { using (var independent = ClientAssets.Open(clientPath)) return ClientAudit.Write(Catalog, independent, destination); });
                    report.Text = summary; SetStatus("Audit saved to " + destination); MessageBox.Show(this, summary + "\r\n\r\n" + destination, "Client audit");
                }
                catch (Exception ex) { MessageBox.Show(this, ex.Message, "Audit failed", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                finally { busy = false; Enabled = true; UseWaitCursor = false; }
            }
        }
        private void SaveReport() { using (var file = new SaveFileDialog { Filter = "Text report|*.txt", FileName = "terrain-coverage.txt" }) { if (file.ShowDialog(this) != DialogResult.OK) return; File.WriteAllText(file.FileName, report.Text + "\r\n\r\nCatalog warnings:\r\n" + String.Join("\r\n", Catalog.Warnings), Encoding.UTF8); } }
        public void MakeExample()
        {
            var doc = new MapDocument(128, 128);
            var grass = Catalog.Terrains.FirstOrDefault(t => t.Name == "Grass") ?? Catalog.Terrains[0];
            var sand = Catalog.Terrains.FirstOrDefault(t => t.Name == "Sand") ?? grass;
            var rock = Catalog.Terrains.FirstOrDefault(t => t.Name == "Rock") ?? sand;
            for (int y = 0; y < 128; y++) for (int x = 0; x < 128; x++)
            {
                double radius = Math.Sqrt((x - 64) * (x - 64) + (y - 64) * (y - 64));
                var material = radius < 24 ? rock : radius < 42 ? sand : grass; int i = y * 128 + x;
                doc.Land[i] = material.TileId; doc.Materials[i] = material.Id; doc.Elevation[i] = (sbyte)Math.Max(0, 38 - (int)radius);
            }
            ResetDocument(doc, true); ShowBuild(CompileMap(doc, false)); SetStatus("Example: one-unit grass / sand / rock hill. " + (Assets == null ? "Client artwork is not loaded." : "Actual tile art in a flat diagnostic view; use Heights to inspect Z."));
        }
        internal void PointerDown(int x, int y, MouseButtons button)
        {
            if (busy || x < 0 || y < 0 || x >= Document.Width || y >= Document.Height) return;
            if (button == MouseButtons.Right) { int i = y * Document.Width + x; landId.Value = DisplayMap.Land[i]; altitude.Value = DisplayMap.Elevation[i]; var terrain = TerrainById.ContainsKey(Document.Materials[i]) ? TerrainById[Document.Materials[i]] : null; if (terrain != null && terrains.Items.Contains(terrain)) terrains.SelectedItem = terrain; else paintMode.SelectedIndex = 1; Inspect(x, y); return; }
            if (button != MouseButtons.Left) return; PushUndo(); stroking = true; lastX = x; lastY = y; PaintAt(x, y);
        }
        internal void PointerMove(int x, int y)
        {
            if (x < 0 || y < 0 || x >= Document.Width || y >= Document.Height) return;
            if (stroking && (x != lastX || y != lastY))
            {
                int dx = x - lastX, dy = y - lastY, steps = Math.Max(Math.Abs(dx), Math.Abs(dy));
                for (int n = 1; n <= steps; n++) PaintAt(lastX + (int)Math.Round(dx * (double)n / steps), lastY + (int)Math.Round(dy * (double)n / steps));
                lastX = x; lastY = y;
            }
            Inspect(x, y);
        }
        internal void PointerUp() { stroking = false; }
        private void PaintAt(int x, int y)
        {
            int size = (int)brushSize.Value, startX = x - (size - 1) / 2, startY = y - (size - 1) / 2, mode = paintMode.SelectedIndex;
            var terrain = terrains.SelectedItem as TerrainDefinition;
            for (int yy = Math.Max(0, startY); yy < Math.Min(Document.Height, startY + size); yy++) for (int xx = Math.Max(0, startX); xx < Math.Min(Document.Width, startX + size); xx++)
            {
                int i = yy * Document.Width + xx;
                if (mode == 0 && terrain != null) { Document.Land[i] = terrain.TileId; Document.Materials[i] = terrain.Id; }
                else if (mode == 1) { Document.Land[i] = (ushort)landId.Value; Document.Materials[i] = -1; }
                else if (mode == 2) Document.Elevation[i] = (sbyte)altitude.Value;
                else if (mode == 3) { ushort id = (ushort)staticId.Value; sbyte z = (sbyte)altitude.Value; ushort h = (ushort)hue.Value; if (!Document.Statics.Any(s => s.X == xx && s.Y == yy && s.Id == id && s.Z == z && s.Hue == h)) Document.Statics.Add(new StaticPlacement { X = xx, Y = yy, Id = id, Z = z, Hue = h }); }
                else if (mode == 4) Document.Statics.RemoveAll(s => s.X == xx && s.Y == yy);
            }
            dirty = true; compiled = null; canvas.Invalidate();
        }
        private void Inspect(int x, int y) { int i = y * Document.Width + x; var map = DisplayMap; string terrain = TerrainById.ContainsKey(Document.Materials[i]) ? TerrainById[Document.Materials[i]].Name : "Exact tile"; SetStatus(String.Format("X {0}  Y {1}   |   {2}   |   Land {3} / 0x{3:X4}   |   Z {4}   |   Shade {5}   |   {6}", x, y, terrain, map.Land[i], map.Elevation[i], map.Elevation[i] + 128, compiled == null ? "source map" : "transition preview")); }
        protected override void Dispose(bool disposing) { if (disposing) { ClearPreview(); if (Assets != null) { Assets.Dispose(); Assets = null; } } base.Dispose(disposing); }
    }

    internal sealed class MapCanvas : ScrollableControl
    {
        private StudioForm studio;
        public MapCanvas(StudioForm form) { studio = form; AutoScroll = true; SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true); Cursor = Cursors.Cross; }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); Capture = true; studio.PointerDown((e.X - AutoScrollPosition.X) / studio.Zoom, (e.Y - AutoScrollPosition.Y) / studio.Zoom, e.Button); }
        protected override void OnMouseMove(MouseEventArgs e) { base.OnMouseMove(e); studio.PointerMove((e.X - AutoScrollPosition.X) / studio.Zoom, (e.Y - AutoScrollPosition.Y) / studio.Zoom); }
        protected override void OnMouseUp(MouseEventArgs e) { studio.PointerUp(); Capture = false; base.OnMouseUp(e); }
        protected override void OnMouseCaptureChanged(EventArgs e) { if (!Capture) studio.PointerUp(); base.OnMouseCaptureChanged(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var map = studio.DisplayMap; if (map == null) return; int zoom = studio.Zoom;
            e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor; e.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
            int x0 = Math.Max(0, (e.ClipRectangle.Left - AutoScrollPosition.X) / zoom), y0 = Math.Max(0, (e.ClipRectangle.Top - AutoScrollPosition.Y) / zoom);
            int x1 = Math.Min(map.Width, (e.ClipRectangle.Right - AutoScrollPosition.X) / zoom + 1), y1 = Math.Min(map.Height, (e.ClipRectangle.Bottom - AutoScrollPosition.Y) / zoom + 1);
            e.Graphics.TranslateTransform(AutoScrollPosition.X, AutoScrollPosition.Y);
            var images = new Dictionary<int, Bitmap>();
            try
            {
            using (var brush = new SolidBrush(Color.Black))
            {
                for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++)
                {
                    int i = y * map.Width + x; TerrainDefinition terrain; Color color;
                    if (studio.HeightView) { int z = map.Elevation[i] + 128; color = Color.FromArgb(z, z, z); }
                    else if (studio.TerrainById.TryGetValue(map.Materials[i], out terrain)) { int delta = map.Elevation[i] / 3; color = Color.FromArgb(Math.Max(0, Math.Min(255, terrain.Color.R + delta)), Math.Max(0, Math.Min(255, terrain.Color.G + delta)), Math.Max(0, Math.Min(255, terrain.Color.B + delta))); }
                    else color = Color.FromArgb(103 + (map.Land[i] * 17 % 91), 84 + (map.Land[i] * 29 % 97), 109 + (map.Land[i] * 7 % 100));
                    brush.Color = color; var rect = new Rectangle(x * zoom, y * zoom, zoom, zoom); e.Graphics.FillRectangle(brush, rect);
                    if (!studio.HeightView && studio.ShowTextures && studio.Assets != null && zoom >= 4)
                    {
                        Bitmap image;
                        if (!images.TryGetValue(map.Land[i], out image))
                        {
                            if (studio.LandArtView) { using (var diamond = studio.Assets.LandArtPreview(map.Land[i])) image = diamond == null ? null : LandArtProjection.ToTopDown(diamond); }
                            else image = studio.Assets.LandPreview(map.Land[i]);
                            images.Add(map.Land[i], image);
                        }
                        if (image != null) e.Graphics.DrawImage(image, rect);
                    }
                }
                if (studio.ShowGrid && zoom >= 8) using (var pen = new Pen(Color.FromArgb(60, 0, 0, 0))) { for (int x = x0; x <= x1; x++) e.Graphics.DrawLine(pen, x * zoom, y0 * zoom, x * zoom, y1 * zoom); for (int y = y0; y <= y1; y++) e.Graphics.DrawLine(pen, x0 * zoom, y * zoom, x1 * zoom, y * zoom); }
                using (var pen = new Pen(Color.FromArgb(230, 255, 207, 94), 2)) foreach (var s in map.Statics) if (s.X >= x0 && s.X < x1 && s.Y >= y0 && s.Y < y1) e.Graphics.DrawRectangle(pen, s.X * zoom + 1, s.Y * zoom + 1, Math.Max(1, zoom - 2), Math.Max(1, zoom - 2));
            }
            }
            finally { foreach (var image in images.Values) if (image != null) image.Dispose(); }
        }
    }
}
