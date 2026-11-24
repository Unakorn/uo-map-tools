using System;
using System.Drawing;
using System.Text;
namespace TerrainStudio {
public static class AllAssetsProbe {
public static int Main(string[] args) {
var report = new StringBuilder();
int land=0, landFail=0, statics=0, staticFail=0, textures=0, textureFail=0, directLand=0, directStatic=0, directTexture=0;
using(var assets=ClientAssets.Open(args[0])) {
for(int id=0;id<16384;id++) {
if(assets.HasDirectLandArt(id)) directLand++;
if(!assets.HasLandArt(id)) continue;
land++; using(Bitmap b=assets.LandArtPreview(id)) if(b==null) {landFail++;if(landFail<20) report.AppendLine("Land decode failed "+id);}
}
Console.WriteLine("All land records decoded.");
for(int id=0;id<65536;id++) {
if(assets.HasDirectStaticArt(id)) directStatic++;
if(!assets.HasStaticArt(id)) continue;
statics++; using(Bitmap b=assets.StaticPreview(id)) if(b==null) {staticFail++;if(staticFail<20) report.AppendLine("Static decode failed "+id);}
}
Console.WriteLine("All static records decoded.");
for(int id=0;id<assets.TextureCount;id++) {
if(assets.HasDirectTexture(id)) directTexture++;
if(!assets.HasTexture(id)) continue;
textures++; using(Bitmap b=assets.TexturePreview(id)) if(b==null) {textureFail++;if(textureFail<20) report.AppendLine("Texture decode failed "+id);}
}
report.AppendLine(String.Format("Land {0} (direct {1}), failed {2}; statics {3} (direct {4}), failed {5}; textures {6} (direct {7}), failed {8}.",land,directLand,landFail,statics,directStatic,staticFail,textures,directTexture,textureFail));
report.AppendLine(assets.Summary);
foreach(string warning in assets.Warnings)report.AppendLine(warning);
}
Console.WriteLine(report.ToString());
if(args.Length>1)System.IO.File.WriteAllText(args[1],report.ToString());
return landFail+staticFail+textureFail==0?0:1;
}
}}
