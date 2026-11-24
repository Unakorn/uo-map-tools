using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace TerrainStudio
{
    public static class MapBuildDefaults
    {
        public static string ClientPath()
        {
            string setting = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client-path.txt");
            if (File.Exists(setting)) return File.ReadAllText(setting).Trim();
            string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Electronic Arts", "Ultima Online Classic");
            return Directory.Exists(installed) ? installed : "";
        }
        public static string OutputPath()
        {
            string setting = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "output-path.txt");
            return File.Exists(setting) ? File.ReadAllText(setting).Trim() : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "UO Maps");
        }
    }

    // One build action consumes two images. There is no terrain editor or transition preview here.
    public sealed class MapBuildForm : Form
    {
        readonly Catalog catalog;
        readonly TextBox terrainPath = new TextBox(), altitudePath = new TextBox(), outputPath = new TextBox(), clientPath = new TextBox();
        readonly ComboBox facet = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        readonly Button buildButton = new Button { Text = "Build map", Width = 145, Height = 36 };
        readonly Button openOutput = new Button { Text = "Open output folder", AutoSize = true, Height = 36, Enabled = false };
        readonly Label resultStatus = new Label { Dock = DockStyle.Fill, AutoEllipsis = true, Padding = new Padding(0, 7, 0, 0), Text = "Choose your terrain and altitude images, then build." };
        readonly TextBox report = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, BackColor = Color.FromArgb(19, 24, 30), ForeColor = Color.Gainsboro, BorderStyle = BorderStyle.None };
        readonly TableLayoutPanel inputs;
        public MapBuildResult LastResult { get; private set; }
        public bool IsBuilding { get; private set; }

        public MapBuildForm(Catalog catalog, string initialClientPath = null)
        {
            if (catalog == null) throw new ArgumentNullException("catalog"); this.catalog = catalog;
            Text = "UO Map Builder"; Size = new Size(800, 600); MinimumSize = new Size(680, 550);
            StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 9F);
            BackColor = Color.FromArgb(27, 33, 41); ForeColor = Color.WhiteSmoke;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(18) };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 64)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 204));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 60)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); Controls.Add(layout);
            layout.Controls.Add(new Label { Text = "BUILD A UO MAP\r\nTerrain image + altitude image → transitions and map files", Dock = DockStyle.Fill, Font = new Font("Segoe UI", 12F), Padding = new Padding(0, 2, 0, 0) });
            inputs = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 5 };
            inputs.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110)); inputs.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); inputs.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 88));
            AddInput(0, "Terrain image", terrainPath, false); AddInput(1, "Altitude image", altitudePath, false);
            AddInput(2, "Output folder", outputPath, true); AddInput(3, "Client data", clientPath, true);
            inputs.RowStyles.Add(new RowStyle(SizeType.Percent, 20));
            inputs.Controls.Add(new Label { Text = "Map file", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 4);
            facet.Items.AddRange(new[] { "0 — Felucca (map0.mul)", "1 — Trammel (map1.mul)", "2 — Ilshenar (map2.mul)", "3 — Malas (map3.mul)", "4 — Tokuno (map4.mul)", "5 — Ter Mur (map5.mul)" });
            facet.SelectedIndex = 0; facet.Dock = DockStyle.Fill; facet.Margin = new Padding(3, 9, 8, 3); inputs.Controls.Add(facet, 1, 4); layout.Controls.Add(inputs);
            outputPath.Text = MapBuildDefaults.OutputPath(); clientPath.Text = initialClientPath ?? MapBuildDefaults.ClientPath();
            layout.Controls.Add(new Label { Dock = DockStyle.Fill, Text = "Exact PNG/BMP colors; one pixel per tile. Altitude is grayscale: Z = shade − 128.\r\nOptional Decorations.png beside terrain is included automatically at exact tile Z.\r\nEach build creates a new folder; your images and previous builds stay intact." });
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false }; actions.Controls.Add(buildButton); actions.Controls.Add(openOutput); layout.Controls.Add(actions);
            layout.Controls.Add(resultStatus); layout.Controls.Add(report);
            buildButton.Click += async delegate { await BuildAsync(); };
            openOutput.Click += delegate { if (LastResult != null) Process.Start(new ProcessStartInfo(LastResult.OutputDirectory) { UseShellExecute = true }); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (IsBuilding) { e.Cancel = true; resultStatus.Text = "The build is still running. This window can close when it finishes."; } };
        }
        void AddInput(int row, string name, TextBox input, bool folder)
        {
            inputs.RowStyles.Add(new RowStyle(SizeType.Percent, 20));
            inputs.Controls.Add(new Label { Text = name, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, row);
            input.Dock = DockStyle.Fill; input.Margin = new Padding(3, 9, 8, 3); inputs.Controls.Add(input, 1, row);
            var browse = new Button { Text = "Browse…", Dock = DockStyle.Fill, Margin = new Padding(0, 6, 0, 5) };
            browse.Click += delegate
            {
                if (folder)
                {
                    using (var dialog = new FolderBrowserDialog { Description = name == "Client data" ? "Select the UO client data folder. It is read only." : "Choose where new completed map folders will be created." })
                    { if (Directory.Exists(input.Text)) dialog.SelectedPath = input.Text; if (dialog.ShowDialog(this) == DialogResult.OK) input.Text = dialog.SelectedPath; }
                }
                else using (var dialog = new OpenFileDialog { Filter = "Exact map images|*.png;*.bmp", Title = "Choose " + name.ToLowerInvariant(), CheckFileExists = true })
                { if (dialog.ShowDialog(this) == DialogResult.OK) input.Text = dialog.FileName; }
            };
            inputs.Controls.Add(browse, 2, row);
        }
        public async Task BuildAsync()
        {
            if (IsBuilding) return;
            IsBuilding = true; LastResult = null; inputs.Enabled = buildButton.Enabled = openOutput.Enabled = false; UseWaitCursor = true; report.Clear();
            var options = new MapBuildOptions { TerrainPath = terrainPath.Text.Trim(), AltitudePath = altitudePath.Text.Trim(), OutputDirectory = outputPath.Text.Trim(), ClientPath = clientPath.Text.Trim(), RequireTerrainTextures = true, Facet = facet.SelectedIndex };
            IProgress<string> progress = new Progress<string>(message => { if (!IsDisposed && IsBuilding) resultStatus.Text = message; });
            try
            {
                LastResult = await Task.Run(() => MapBuildJob.Run(catalog, options, message => progress.Report(message)));
                report.Text = LastResult.Report;
                resultStatus.Text = String.Format("Built {0} × {1} as map{3}.mul. Unresolved transition cells: {2:N0}.", LastResult.Width, LastResult.Height, LastResult.Missing, LastResult.Facet);
                openOutput.Enabled = true;
            }
            catch (Exception ex) { resultStatus.Text = "Build failed. Your input images are unchanged."; report.Text = ex.Message; }
            finally { IsBuilding = false; inputs.Enabled = buildButton.Enabled = true; UseWaitCursor = false; }
        }
    }
}

