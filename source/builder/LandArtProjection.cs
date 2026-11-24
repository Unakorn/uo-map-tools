using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace TerrainStudio
{
    public static class LandArtProjection
    {
        // Raw diamond: top=(x,y), right=(x+1,y), bottom=(x+1,y+1), left=(x,y+1).
        // This affine diagnostic view preserves edge direction; it is not the game slope renderer.
        public static Bitmap ToTopDown(Bitmap diamond)
        {
            if (diamond.Width != 44 || diamond.Height != 44) throw new ArgumentException("Land art must be a 44 × 44 diamond.");
            var square = new Bitmap(44, 44, PixelFormat.Format32bppArgb);
            var data = square.LockBits(new Rectangle(0, 0, 44, 44), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                int[] row = new int[44];
                for (int y = 0; y < 44; y++)
                {
                    for (int x = 0; x < 44; x++)
                    {
                        double u = (x + .5) / 44, v = (y + .5) / 44;
                        int sy = Math.Max(0, Math.Min(43, (int)Math.Floor(22 * (u + v))));
                        int width = sy < 22 ? 2 * (sy + 1) : 2 * (44 - sy);
                        int left = (44 - width) / 2;
                        int sx = Math.Max(left, Math.Min(left + width - 1, (int)Math.Floor(22 + 22 * (u - v))));
                        row[x] = diamond.GetPixel(sx, sy).ToArgb();
                    }
                    Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), 44);
                }
            }
            finally { square.UnlockBits(data); }
            return square;
        }
    }
}
