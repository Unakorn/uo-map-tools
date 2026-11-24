using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace TerrainStudio
{
    // An isolated experiment: changing these controls never edits the open project.
    public sealed class TransitionLabForm : Form
    {
        readonly Catalog catalog;
        readonly ClientAssets assets;
        readonly ISet<int> availableLand, availableStatics;
        readonly ComboBox background = Choice(), foreground = Choice(), shape = Choice();
        readonly NumericUpDown width = Number(1, 8, 1), backgroundZ = Number(-128, 127, 0), foregroundZ = Number(-128, 127, 0);
        readonly CheckBox offsets = new CheckBox { Text = "Legacy Z offsets", AutoSize = true };
        readonly CheckBox autocorrect = new CheckBox { Text = "Allow legacy autocorrect", AutoSize = true };
        readonly CheckBox issues = new CheckBox { Text = "Mark missing rules / art", Checked = true, AutoSize = true };
        readonly CheckBox grid = new CheckBox { Text = "Grid", Checked = true, AutoSize = true };
        readonly Label summary = new Label { Dock = DockStyle.Fill, Padding = new Padding(12, 4, 12, 0) };
        readonly TextBox inspector = new TextBox { Dock = DockStyle.Fill, ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None, BackColor = Color.FromArgb(26, 31, 38), ForeColor = Color.WhiteSmoke };
        readonly Button use = new Button { Text = "Use test map", AutoSize = true };
        readonly LabCanvas sourceView, resultView;
        readonly Dictionary<int, Bitmap> images = new Dictionary<int, Bitmap>();
        bool updating;
        int selectedX = 15, selectedY = 15;
        public MapDocument TestSource { get; private set; }
        public CompileResult Result { get; private set; }
        public bool ApplyOffsets { get { return offsets.Checked; } }
        public bool AllowAutocorrect { get { return autocorrect.Checked; } }

        public TransitionLabForm(Catalog catalog, ClientAssets assets, ISet<int> availableLand, ISet<int> availableStatics)
        {
            this.catalog = catalog; this.assets = assets; this.availableLand = availableLand; this.availableStatics = availableStatics;
            Text = "Transition lab — one tile at a time";
            Size = new Size(1200, 860); MinimumSize = new Size(1000, 760); StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.FromArgb(19, 24, 30); ForeColor = Color.WhiteSmoke; Font = new Font("Segoe UI", 9F);
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6 };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 46)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 102));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 56)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 104)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 45)); Controls.Add(root);
            root.Controls.Add(new Label { Text = "TRANSITION LAB    /    Compare narrow banks, corners and islands", Dock = DockStyle.Fill, Padding = new Padding(12, 12, 0, 0), Font = new Font(Font.FontFamily, 13, FontStyle.Bold) });
            var controls = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8, 0, 8, 0), WrapContents = true, AutoScroll = true };
            background.Width = foreground.Width = 180; shape.Width = 155;
            controls.Controls.Add(Field("Surrounding terrain", background)); controls.Controls.Add(Field("Shape terrain", foreground));
            var swap = new Button { Text = "Swap", Width = 62, Height = 29, Margin = new Padding(3, 23, 3, 3) };
            swap.Click += delegate { updating = true; int prior = background.SelectedIndex; background.SelectedIndex = foreground.SelectedIndex; foreground.SelectedIndex = prior; decimal z = backgroundZ.Value; backgroundZ.Value = foregroundZ.Value; foregroundZ.Value = z; updating = false; Rebuild(); }; controls.Controls.Add(swap);
            controls.Controls.Add(Field("Shape", shape)); controls.Controls.Add(Field("Width (tiles)", width));
            controls.Controls.Add(Field("Surrounding Z", backgroundZ)); controls.Controls.Add(Field("Shape Z", foregroundZ));
            var flags = new FlowLayoutPanel { Width = 900, Height = 30, Margin = new Padding(4, 0, 0, 0) };
            flags.Controls.Add(autocorrect); flags.Controls.Add(offsets); flags.Controls.Add(issues); flags.Controls.Add(grid); controls.Controls.Add(flags); root.Controls.Add(controls);
            root.Controls.Add(summary);
            var panes = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Padding = new Padding(8, 0, 8, 0) };
            panes.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); panes.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            panes.RowStyles.Add(new RowStyle(SizeType.Absolute, 24)); panes.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            panes.Controls.Add(new Label { Text = "SOURCE  /  Exact material cells", AutoSize = true }, 0, 0);
            panes.Controls.Add(new Label { Text = "RESOLVED  /  Client land art, viewed from above", AutoSize = true }, 1, 0);
            sourceView = new LabCanvas(this, false); resultView = new LabCanvas(this, true);
            panes.Controls.Add(sourceView, 0, 1); panes.Controls.Add(resultView, 1, 1); root.Controls.Add(panes);
            var detail = new Panel { Dock = DockStyle.Fill, Padding = new Padding(12, 4, 12, 4) }; detail.Controls.Add(inspector); root.Controls.Add(detail);
            var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(10, 5, 0, 0) };
            use.Click += delegate { if (Result != null) { DialogResult = DialogResult.OK; Close(); } }; footer.Controls.Add(use);
            var save = new Button { Text = "Save test report", AutoSize = true };
            save.Click += delegate { using (var dialog = new SaveFileDialog { Filter = "Text report|*.txt", FileName = "transition-test.txt" }) if (dialog.ShowDialog(this) == DialogResult.OK) { try { File.WriteAllText(dialog.FileName, ReportText(), Encoding.UTF8); } catch (Exception ex) { MessageBox.Show(this, ex.Message, "Could not save report"); } } }; footer.Controls.Add(save);
            var close = new Button { Text = "Close", AutoSize = true, DialogResult = DialogResult.Cancel }; footer.Controls.Add(close); CancelButton = close; root.Controls.Add(footer);
            updating = true;
            foreach (var terrain in catalog.Terrains) { background.Items.Add(terrain); foreground.Items.Add(terrain); }
            background.SelectedItem = catalog.Terrains.FirstOrDefault(t => t.Name == "Grass") ?? catalog.Terrains[0];
            foreground.SelectedItem = catalog.Terrains.FirstOrDefault(t => t.Name == "Sand") ?? catalog.Terrains[0];
            shape.Items.AddRange(TransitionLab.Shapes); shape.SelectedIndex = 0;
            background.SelectedIndexChanged += delegate { Rebuild(); }; foreground.SelectedIndexChanged += delegate { Rebuild(); }; shape.SelectedIndexChanged += delegate { Rebuild(); };
            width.ValueChanged += delegate { Rebuild(); }; backgroundZ.ValueChanged += delegate { Rebuild(); }; foregroundZ.ValueChanged += delegate { Rebuild(); }; offsets.CheckedChanged += delegate { Rebuild(); };
            autocorrect.CheckedChanged += delegate { Rebuild(); };
            issues.CheckedChanged += delegate { resultView.Invalidate(); }; grid.CheckedChanged += delegate { sourceView.Invalidate(); resultView.Invalidate(); };
            updating = false; Rebuild();
        }

        static ComboBox Choice() { return new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, DropDownWidth = 280 }; }
        static NumericUpDown Number(int min, int max, int value) { return new NumericUpDown { Minimum = min, Maximum = max, Value = value, Width = 90 }; }
        static Control Field(string title, Control input)
        {
            var field = new Panel { Width = input.Width + 6, Height = 55, Margin = new Padding(3) };
            field.Controls.Add(new Label { Text = title, AutoSize = true }); input.Location = new Point(0, 22); field.Controls.Add(input); return field;
        }
        void Rebuild()
        {
            if (updating) return;
            try
            {
                TestSource = TransitionLab.Create((TerrainDefinition)background.SelectedItem, (TerrainDefinition)foreground.SelectedItem, (string)shape.SelectedItem, (int)width.Value, (int)backgroundZ.Value, (int)foregroundZ.Value);
                Result = catalog.Compile(TestSource, offsets.Checked, 0, availableLand, availableStatics, true, autocorrect.Checked);
                int boundary = 0, missing = 0;
                for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++) if (IsBoundary(TestSource, x, y)) { boundary++; var state = Result.States[y * 32 + x]; if (state != CellResolution.Matched && state != CellResolution.LegacyAutocorrect) missing++; }
                summary.Text = String.Format("Width {0}: {1} / {2} boundary cells matched. Whole map: {3} matched, {4} unresolved ({6} autocorrect skipped).\r\nOrange = unresolved; magenta = legacy autocorrect; cyan dot = static. {5}", width.Value, boundary - missing, boundary, Result.Matched, Result.Missing,
                    assets == null ? "No client loaded: colors stand in for artwork." : "Flat preview: slopes/statics need in-game testing.", Result.AutocorrectSkipped);
                use.Enabled = true;
            }
            catch (Exception ex) { Result = null; use.Enabled = false; summary.Text = "Cannot build this test: " + ex.Message; }
            Inspect(selectedX, selectedY); sourceView.Invalidate(); resultView.Invalidate();
        }
        public static bool IsBoundary(MapDocument map, int x, int y)
        {
            int center = map.Materials[y * map.Width + x];
            for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++)
            {
                int nx = Math.Max(0, Math.Min(map.Width - 1, x + dx)), ny = Math.Max(0, Math.Min(map.Height - 1, y + dy));
                if (map.Materials[ny * map.Width + nx] != center) return true;
            }
            return false;
        }
        void Inspect(int x, int y)
        {
            selectedX = x; selectedY = y;
            if (TestSource == null || Result == null) { inspector.Text = "Adjust the test settings to build a valid preview."; return; }
            int i = y * 32 + x; var material = catalog.Terrains.First(t => t.Id == TestSource.Materials[i]);
            var statics = Result.Map.Statics.Where(s => s.X == x && s.Y == y).Select(s => String.Format("0x{0:X4} at Z {1}", s.Id, s.Z));
            inspector.Text = String.Format("Cell ({0}, {1})  ·  {2}  ·  {3}\r\nLand: 0x{4:X4} → 0x{5:X4}     Height: {6} → {7}\r\nStatics: {8}\r\nClick either preview to inspect. Matched means a catalog rule exists; it does not certify visual correctness.", x, y, material.Name, Result.States[i], TestSource.Land[i], Result.Map.Land[i], TestSource.Elevation[i], Result.Map.Elevation[i], String.Join(", ", statics.DefaultIfEmpty("none")));
            sourceView.Invalidate(); resultView.Invalidate();
        }
        public string ReportText()
        {
            var text = new StringBuilder("UO Terrain Studio — transition experiment\r\n");
            text.AppendLine("Surrounding: " + background.SelectedItem + "; shape: " + foreground.SelectedItem);
            text.AppendLine("Shape: " + shape.SelectedItem + "; width: " + width.Value + "; source heights: " + backgroundZ.Value + " / " + foregroundZ.Value);
            text.AppendLine("Seed: 0; legacy offsets: " + offsets.Checked + "; allow legacy autocorrect: " + autocorrect.Checked); text.AppendLine("No minimum terrain width is enforced. This test does not establish visual correctness."); text.AppendLine(summary.Text);
            if (Result == null) return text.ToString();
            text.AppendLine(String.Join("\r\n", Result.Notes));
            text.AppendLine("\r\nUnresolved / legacy autocorrect cells (x,y,status,source land,result land,source Z,result Z):");
            for (int i = 0; i < Result.States.Length; i++) if (Result.States[i] != CellResolution.Matched && Result.States[i] != CellResolution.Manual)
                text.AppendLine(String.Format("{0},{1},{2},{3},{4},{5},{6}", i % 32, i / 32, Result.States[i], TestSource.Land[i], Result.Map.Land[i], TestSource.Elevation[i], Result.Map.Elevation[i]));
            return text.ToString();
        }
        Bitmap Art(int id)
        {
            Bitmap image;
            if (!images.TryGetValue(id, out image))
            {
                using (var diamond = assets.LandArtPreview(id)) image = diamond == null ? null : LandArtProjection.ToTopDown(diamond);
                images.Add(id, image);
            }
            return image;
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) foreach (var image in images.Values) if (image != null) image.Dispose();
            images.Clear(); base.Dispose(disposing);
        }
        sealed class LabCanvas : Control
        {
            readonly TransitionLabForm lab; readonly bool resolved;
            public LabCanvas(TransitionLabForm lab, bool resolved) { this.lab = lab; this.resolved = resolved; Dock = DockStyle.Fill; BackColor = Color.Black; DoubleBuffered = true; ResizeRedraw = true; Cursor = Cursors.Cross; }
            Rectangle BoundsForMap { get { int side = Math.Max(32, Math.Min(ClientSize.Width, ClientSize.Height) / 32 * 32); return new Rectangle((ClientSize.Width - side) / 2, (ClientSize.Height - side) / 2, side, side); } }
            protected override void OnMouseDown(MouseEventArgs e)
            {
                base.OnMouseDown(e); Rectangle area = BoundsForMap;
                if (area.Contains(e.Location)) lab.Inspect((e.X - area.X) / (area.Width / 32), (e.Y - area.Y) / (area.Height / 32));
            }
            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e); var map = resolved ? (lab.Result == null ? null : lab.Result.Map) : lab.TestSource; if (map == null) return;
                var area = BoundsForMap; int step = area.Width / 32;
                e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor; e.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
                using (var brush = new SolidBrush(Color.Black)) using (var missing = new Pen(Color.FromArgb(255, 165, 65))) using (var lines = new Pen(Color.FromArgb(65, 0, 0, 0)))
                {
                    for (int y = 0; y < 32; y++) for (int x = 0; x < 32; x++)
                    {
                        int i = y * 32 + x; var cell = new Rectangle(area.X + x * step, area.Y + y * step, step, step);
                        brush.Color = lab.catalog.Terrains.First(t => t.Id == map.Materials[i]).Color; e.Graphics.FillRectangle(brush, cell);
                        if (resolved && lab.assets != null) { var image = lab.Art(map.Land[i]); if (image != null) e.Graphics.DrawImage(image, cell); }
                        if (lab.grid.Checked) e.Graphics.DrawRectangle(lines, cell);
                        if (resolved && lab.issues.Checked && lab.Result.States[i] != CellResolution.Matched)
                        { missing.Color = lab.Result.States[i] == CellResolution.LegacyAutocorrect ? Color.Magenta : Color.FromArgb(255, 165, 65); e.Graphics.DrawRectangle(missing, cell.X + 1, cell.Y + 1, Math.Max(1, step - 3), Math.Max(1, step - 3)); }
                    }
                    if (resolved) foreach (var s in map.Statics) e.Graphics.FillRectangle(Brushes.Cyan, area.X + s.X * step + 2, area.Y + s.Y * step + 2, Math.Max(2, step / 4), Math.Max(2, step / 4));
                    using (var selected = new Pen(Color.White, 2)) e.Graphics.DrawRectangle(selected, area.X + lab.selectedX * step, area.Y + lab.selectedY * step, step, step);
                }
            }
        }
    }
}
