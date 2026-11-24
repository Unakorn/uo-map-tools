using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace TerrainStudio
{
    // Owns only its preview bitmaps. The caller owns ClientAssets and keeps it alive.
    public sealed class AssetBrowser : Form
    {
        public int SelectedTileId { get; private set; }
        public bool SelectedIsStatic { get; private set; }
        internal int FilteredCount { get { return filtered.Count; } }
        internal int[] CurrentPageIds { get { return filtered.Skip(page * PageSize).Take(PageSize).ToArray(); } }
        private const int PageSize = 30;
        private readonly ClientAssets assets;
        private ComboBox kind, associatedLand;
        private TextBox query;
        private CheckBox showEmpty;
        private Label count, pageLabel, details;
        private Button choose, previous, next;
        private PictureBox preview;
        private TileGrid grid;
        private List<int> filtered = new List<int>();
        private readonly Dictionary<int, List<int>> landsByTexture = new Dictionary<int, List<int>>();
        private int page, selected = -1;
        private bool updating;
        private static readonly Color Ink = Color.FromArgb(220, 231, 239);
        private static readonly Color Dark = Color.FromArgb(17, 23, 29);

        public AssetBrowser(ClientAssets client)
        {
            if (client == null) throw new ArgumentNullException("client");
            assets = client; Text = "UO tile browser — client artwork";
            Size = new Size(1140, 820); MinimumSize = new Size(980, 700);
            StartPosition = FormStartPosition.CenterParent; BackColor = Dark; ForeColor = Ink; Font = new Font("Segoe UI", 9);
            for (int id = 0; id < 16384; id++)
            {
                int texture = assets.LandTextureId(id); if (texture == 0) continue;
                List<int> ids; if (!landsByTexture.TryGetValue(texture, out ids)) landsByTexture.Add(texture, ids = new List<int>()); ids.Add(id);
            }
            var root = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 4, ColumnCount = 1, Padding = new Padding(12) };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 30)); root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); Controls.Add(root);
            var filters = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            kind = new ComboBox { Width = 160, DropDownStyle = ComboBoxStyle.DropDownList, ForeColor = Color.Black };
            kind.Items.AddRange(new[] { "Land artwork", "Static artwork", "Terrain textures" }); kind.SelectedIndex = 0;
            query = new TextBox { Width = 235, BackColor = Color.FromArgb(30, 39, 47), ForeColor = Ink };
            showEmpty = new CheckBox { Text = "Include missing slots", AutoSize = true, Padding = new Padding(8, 3, 0, 0) };
            filters.Controls.Add(kind); filters.Controls.Add(new Label { Text = "Name / ID / 0xID", AutoSize = true, Padding = new Padding(10, 5, 0, 0) }); filters.Controls.Add(query); filters.Controls.Add(showEmpty); root.Controls.Add(filters);
            count = new Label { Dock = DockStyle.Fill, ForeColor = Color.FromArgb(143, 196, 206) }; root.Controls.Add(count);
            var body = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
            body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 255));
            grid = new TileGrid(this) { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 12, 0) }; body.Controls.Add(grid);
            var inspector = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false };
            preview = new PictureBox { Width = 245, Height = 230, BackColor = Color.Black, SizeMode = PictureBoxSizeMode.Zoom }; inspector.Controls.Add(preview);
            details = new Label { Width = 245, Height = 160, Padding = new Padding(0, 8, 0, 0), ForeColor = Ink }; inspector.Controls.Add(details);
            associatedLand = new ComboBox { Width = 245, DropDownStyle = ComboBoxStyle.DropDownList, Visible = false, ForeColor = Color.Black }; inspector.Controls.Add(associatedLand);
            choose = new Button { Text = "Use this tile", Width = 245, Height = 36, BackColor = Color.FromArgb(50, 95, 110), ForeColor = Ink, FlatStyle = FlatStyle.Flat, Enabled = false }; choose.Click += delegate { AcceptTile(); }; inspector.Controls.Add(choose);
            inspector.Controls.Add(new Label { Text = "Existing art does not imply an automatic transition rule. Exact tile placement keeps the ID you choose.\n\nStatic previews are unhued; tile animation is not played.", Width = 245, Height = 105, Padding = new Padding(0, 12, 0, 0), ForeColor = Color.FromArgb(161, 179, 193) });
            body.Controls.Add(inspector); root.Controls.Add(body);
            var navigation = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Padding = new Padding(0, 8, 0, 0) };
            previous = new Button { Text = "← Previous", Width = 110, ForeColor = Ink, BackColor = Color.FromArgb(49, 61, 73), FlatStyle = FlatStyle.Flat }; previous.Click += delegate { ChangePage(page - 1); }; navigation.Controls.Add(previous);
            pageLabel = new Label { Width = 170, Height = 27, TextAlign = ContentAlignment.MiddleCenter }; navigation.Controls.Add(pageLabel);
            next = new Button { Text = "Next →", Width = 110, ForeColor = Ink, BackColor = Color.FromArgb(49, 61, 73), FlatStyle = FlatStyle.Flat }; next.Click += delegate { ChangePage(page + 1); }; navigation.Controls.Add(next);
            navigation.Controls.Add(new Label { Text = "Double-click a tile to select it.", AutoSize = true, Padding = new Padding(18, 5, 0, 0) }); root.Controls.Add(navigation);
            kind.SelectedIndexChanged += delegate { if (!updating) RefreshFilter(); }; query.TextChanged += delegate { if (!updating) RefreshFilter(); }; showEmpty.CheckedChanged += delegate { if (!updating) RefreshFilter(); };
            RefreshFilter();
        }

        internal void SetFilter(int mode, string search, bool includeEmpty)
        {
            if (mode < 0 || mode > 2) throw new ArgumentOutOfRangeException("mode");
            updating = true; kind.SelectedIndex = mode; query.Text = search ?? ""; showEmpty.Checked = includeEmpty; updating = false; RefreshFilter();
        }
        private void RefreshFilter()
        {
            filtered.Clear(); string text = query.Text.Trim(); int numeric;
            bool isNumber = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? Int32.TryParse(text.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out numeric) : Int32.TryParse(text, out numeric);
            int maximum = kind.SelectedIndex == 0 ? 16384 : kind.SelectedIndex == 1 ? 65536 : assets.TextureCount;
            for (int id = 0; id < maximum; id++)
            {
                if (!showEmpty.Checked && !Present(id)) continue;
                if (text.Length != 0 && !(isNumber ? numeric == id : NameOf(id).IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0)) continue;
                filtered.Add(id);
            }
            page = 0; selected = -1; ClearDetail(); UpdatePage();
            count.Text = String.Format("{0:N0} matching {1} slots. {2}", filtered.Count, kind.SelectedIndex == 0 ? "land" : kind.SelectedIndex == 1 ? "static" : "texture", showEmpty.Checked ? "Missing slots are explicitly labeled." : "Showing indexed artwork entries; blank placeholder art may still exist.");
        }
        private bool Present(int id) { return kind.SelectedIndex == 0 ? assets.HasLandArt(id) : kind.SelectedIndex == 1 ? assets.HasStaticArt(id) : assets.HasTexture(id); }
        private string NameOf(int id) { return kind.SelectedIndex == 0 ? assets.LandName(id) : kind.SelectedIndex == 1 ? assets.StaticName(id) : "Texture " + id; }
        private Bitmap LoadArtwork(int id) { return kind.SelectedIndex == 0 ? assets.LandArtPreview(id) : kind.SelectedIndex == 1 ? assets.StaticPreview(id) : assets.TexturePreview(id); }
        private void ChangePage(int value) { if (value < 0 || value >= Math.Max(1, (filtered.Count + PageSize - 1) / PageSize)) return; page = value; UpdatePage(); }
        private void UpdatePage() { grid.Reload(); int pages = Math.Max(1, (filtered.Count + PageSize - 1) / PageSize); pageLabel.Text = "Page " + (page + 1) + " of " + pages; previous.Enabled = page > 0; next.Enabled = page + 1 < pages; }
        private void ClearDetail() { var old = preview.Image; preview.Image = null; if (old != null) old.Dispose(); choose.Enabled = false; choose.Text = "Use this tile"; associatedLand.Items.Clear(); associatedLand.Visible = false; details.Text = "Select an artwork tile to inspect its exact ID."; }
        internal bool SelectById(int id)
        {
            if (!filtered.Contains(id)) return false;
            selected = id; ClearDetail(); preview.Image = LoadArtwork(id); string name = NameOf(id);
            details.Text = String.Format("{0}\r\nID {1}  /  0x{1:X4}\r\n{2}", name, id, preview.Image == null ? "No decodable artwork." : "Artwork " + preview.Image.Width + " × " + preview.Image.Height);
            if (kind.SelectedIndex == 0) details.Text += "\r\nTexture ID: " + assets.LandTextureId(id) + "\r\nThis is the flat land diamond.";
            if (kind.SelectedIndex == 2)
            {
                List<int> linked;
                if (landsByTexture.TryGetValue(id, out linked))
                {
                    foreach (int land in linked) associatedLand.Items.Add(new LandChoice { Id = land, Name = assets.LandName(land) });
                    associatedLand.Visible = true; associatedLand.SelectedIndex = 0; choose.Enabled = true; choose.Text = "Use associated land tile";
                    details.Text += "\r\n" + linked.Count + " land tile(s) reference this texture.\r\nChoose a land ID below to paint it.";
                }
                else details.Text += "\r\nNo land ID directly references this texture. A texture ID cannot be written as a land ID.";
            }
            else { choose.Enabled = true; choose.Text = "Use this " + (kind.SelectedIndex == 0 ? "land tile" : "static tile"); }
            grid.Invalidate(); return true;
        }
        private void AcceptTile()
        {
            if (selected < 0 || !choose.Enabled) return;
            SelectedTileId = kind.SelectedIndex == 2 ? ((LandChoice)associatedLand.SelectedItem).Id : selected;
            SelectedIsStatic = kind.SelectedIndex == 1; DialogResult = DialogResult.OK; Close();
        }
        protected override void Dispose(bool disposing) { if (disposing) ClearDetail(); base.Dispose(disposing); }
        private sealed class LandChoice { public int Id; public string Name; public override string ToString() { return Id + " / 0x" + Id.ToString("X4") + " — " + Name; } }

        private sealed class TileGrid : Control
        {
            private readonly AssetBrowser browser;
            private readonly Dictionary<int, Bitmap> bitmaps = new Dictionary<int, Bitmap>();
            private int[] ids = new int[0];
            public TileGrid(AssetBrowser owner) { browser = owner; SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true); Cursor = Cursors.Hand; }
            public void Reload() { ClearImages(); ids = browser.CurrentPageIds; foreach (int id in ids) bitmaps.Add(id, browser.LoadArtwork(id)); Invalidate(); }
            private void ClearImages() { foreach (var bmp in bitmaps.Values) if (bmp != null) bmp.Dispose(); bitmaps.Clear(); }
            protected override void Dispose(bool disposing) { if (disposing) ClearImages(); base.Dispose(disposing); }
            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.Clear(Dark); int cw = Math.Max(1, Width / 6), ch = Math.Max(1, Height / 5);
                e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor; e.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
                for (int i = 0; i < ids.Length; i++)
                {
                    int id = ids[i]; var rect = new Rectangle(i % 6 * cw + 2, i / 6 * ch + 2, cw - 4, ch - 4);
                    using (var fill = new SolidBrush(id == browser.selected ? Color.FromArgb(39, 85, 99) : Color.FromArgb(27, 35, 43))) e.Graphics.FillRectangle(fill, rect);
                    using (var pen = new Pen(id == browser.selected ? Color.FromArgb(130, 216, 230) : Color.FromArgb(58, 71, 84))) e.Graphics.DrawRectangle(pen, rect);
                    var bmp = bitmaps[id]; var area = new Rectangle(rect.X + 5, rect.Y + 5, rect.Width - 10, Math.Max(1, rect.Height - 43));
                    if (bmp != null)
                    {
                        double scale = Math.Min(area.Width / (double)bmp.Width, area.Height / (double)bmp.Height);
                        int w = Math.Max(1, (int)(bmp.Width * scale)), h = Math.Max(1, (int)(bmp.Height * scale)); e.Graphics.DrawImage(bmp, new Rectangle(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h));
                    }
                    else TextRenderer.DrawText(e.Graphics, "No art", Font, area, Color.FromArgb(180, 153, 150), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                    TextRenderer.DrawText(e.Graphics, id + " / 0x" + id.ToString("X4"), Font, new Rectangle(rect.X + 3, rect.Bottom - 36, rect.Width - 6, 17), Ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis);
                    TextRenderer.DrawText(e.Graphics, browser.NameOf(id), Font, new Rectangle(rect.X + 3, rect.Bottom - 19, rect.Width - 6, 17), Color.FromArgb(161, 179, 193), TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis);
                }
            }
            protected override void OnMouseClick(MouseEventArgs e) { base.OnMouseClick(e); int cell = Math.Min(5, e.X / Math.Max(1, Width / 6)) + Math.Min(4, e.Y / Math.Max(1, Height / 5)) * 6; if (cell >= 0 && cell < ids.Length) browser.SelectById(ids[cell]); }
            protected override void OnMouseDoubleClick(MouseEventArgs e) { OnMouseClick(e); browser.AcceptTile(); base.OnMouseDoubleClick(e); }
        }
    }
}
