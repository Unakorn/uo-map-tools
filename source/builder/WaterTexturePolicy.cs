using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;

namespace TerrainStudio
{
    /// <summary>
    /// The supplied UOL shallow-water rules use dry substrate plus static water.
    /// Texture-only builds instead need a real water surface at the source height.
    /// This deliberately small policy is not a replacement shoreline catalog.
    /// </summary>
    public sealed class WaterTexturePolicy
    {
        private readonly List<ushort> candidates = new List<ushort>();
        private readonly HashSet<ushort> valid = new HashSet<ushort>();
        private WaterTexturePolicy() { }

        public static WaterTexturePolicy Inspect(ClientAssets assets)
        {
            if (assets == null) throw new ArgumentNullException("assets");
            var result = new WaterTexturePolicy();
            // Canonical water surfaces verified in the supplied client. Wet alone is
            // insufficient: acid and TerrainFallback entries also carry that flag.
            foreach (ushort id in new ushort[] { 310, 311 })
            {
                int texture = assets.LandTextureId(id);
                if ((assets.LandFlags(id) & 0x80UL) == 0 || !String.Equals(assets.LandName(id), "water", StringComparison.OrdinalIgnoreCase)) continue;
                if ((texture != 310 && texture != 311) || !assets.HasTexture(texture)) continue;
                int resolved = assets.TextureSourceId(texture);
                if (resolved != 310 && resolved != 311) continue;
                // Bounds alone do not establish a usable 64/128-square RGB555 texture.
                using (Bitmap preview = assets.TexturePreview(texture))
                {
                    if (preview == null) continue;
                    result.candidates.Add(id); result.valid.Add(id);
                }
            }
            return result;
        }

        public WaterTextureCorrection Apply(Catalog catalog, MapDocument source, MapDocument compiled)
        {
            if (catalog == null || source == null || compiled == null) throw new ArgumentNullException();
            if (source.Width != compiled.Width || source.Height != compiled.Height) throw new ArgumentException("Water correction requires matching source and compiled dimensions.");
            var waterMaterials = new HashSet<int>();
            foreach (TerrainDefinition terrain in catalog.Terrains)
            {
                string expected = terrain.Id == 5 ? "Deep Water" : terrain.Id == 6 ? "Shallow Water" : terrain.Id == 9 ? "Water" : null;
                if (expected != null && String.Equals(terrain.Name, expected, StringComparison.OrdinalIgnoreCase)) waterMaterials.Add(terrain.Id);
            }
            var result = new WaterTextureCorrection();
            for (int i = 0; i < source.Materials.Length; i++) if (waterMaterials.Contains(source.Materials[i])) result.WaterCells++;
            if (result.WaterCells == 0) return result;
            if (candidates.Count == 0)
                throw new InvalidDataException("Texture-only water requires a genuine Wet water surface with a valid water texture (land IDs 310/311, textures 310/311). None is available in this client. Dry seabed, flat water art and static water are not substitutes. No output files were written.");
            for (int i = 0; i < source.Materials.Length; i++)
            {
                // Source material identity is authoritative. Never turn a bank, sand,
                // custom material or explicit manual placement into water by its tile ID.
                if (!waterMaterials.Contains(source.Materials[i]) || valid.Contains(compiled.Land[i])) continue;
                int x = i % source.Width, y = i / source.Width;
                uint variant = unchecked((uint)x * 0x9E3779B1U ^ (uint)y * 0x85EBCA77U);
                variant ^= variant >> 16;
                compiled.Land[i] = candidates[(int)(variant % (uint)candidates.Count)];
                result.CorrectedCells++;
            }
            return result;
        }
    }

    public sealed class WaterTextureCorrection
    {
        public int WaterCells, CorrectedCells;
        public override string ToString()
        {
            return String.Format("Texture-only water: {0:N0} source water cells; {1:N0} corrected to verified Wet water texture surfaces; {2:N0} existing verified water surfaces retained. Only known Water / Shallow Water / Deep Water materials are affected. All heights and non-water cells are preserved by this correction; no static water is added. These are static texture variants, not animated water frames. Legacy unresolved transition counts remain unchanged; shoreline texture blending is not supplied by this correction.", WaterCells, CorrectedCells, WaterCells - CorrectedCells);
        }
    }
}

namespace TerrainStudio {
    // Explicit shoreline-only exception: 45x45 animated wave edges, not the
    // 89x89 versions which would spill across multiple map cells.
    public sealed class AnimatedShorelinePolicy {
        readonly bool[] available=new bool[4];
        static readonly ushort[] ids={8114,8104,8099,8109}; // N,E,S,W in map coordinates
        static readonly int[] dx={0,1,0,-1},dy={-1,0,1,0};
        public static AnimatedShorelinePolicy Inspect(ClientAssets assets,string directory) {
            var policy=new AnimatedShorelinePolicy();string path=Path.Combine(directory,"animdata.mul");
            if(!File.Exists(path))return policy;byte[] anim=File.ReadAllBytes(path);
            for(int k=0;k<4;k++) {int id=ids[k],p=id*68+4*((id>>3)+1);
                if(p+68>anim.Length||anim[p+65]<2||anim[p+65]>64||!String.Equals(assets.StaticName(id),"wave",StringComparison.OrdinalIgnoreCase))continue;
                bool valid=true;for(int f=0;f<anim[p+65];f++){int frame=id+unchecked((sbyte)anim[p+f]);if(frame<0||frame>65535||!assets.HasStaticArt(frame)){valid=false;break;}}
                using(Bitmap preview=assets.StaticPreview(id))if(preview==null||preview.Width!=45||preview.Height!=45)valid=false;
                policy.available[k]=valid;
            }return policy;
        }
        static bool Water(int id){return id==5||id==6||id==9;}
        public int Apply(MapDocument source,MapDocument target,out int skipped) {
            int count=0;skipped=0;
            for(int y=0;y<source.Height;y++)for(int x=0;x<source.Width;x++){
                int i=y*source.Width+x;if(!Water(source.Materials[i]))continue;
                bool flat=true;for(int yy=Math.Max(0,y-1);yy<=Math.Min(source.Height-1,y+1);yy++)for(int xx=Math.Max(0,x-1);xx<=Math.Min(source.Width-1,x+1);xx++){
                    int n=yy*source.Width+xx;if(Water(source.Materials[n])&&source.Elevation[n]!=source.Elevation[i])flat=false;
                }
                for(int k=0;k<4;k++){int xx=x+dx[k],yy=y+dy[k];if(xx<0||yy<0||xx>=source.Width||yy>=source.Height)continue;
                    int material=source.Materials[yy*source.Width+xx];if(Water(material)||material<=0||material==19)continue;
                    if(!flat){skipped++;continue;}
                    if(!available[k])throw new InvalidDataException("Animated shoreline wave artwork or animation frames are unavailable in this client. No output written.");
                    target.Statics.Add(new StaticPlacement{X=x,Y=y,Id=ids[k],Z=source.Elevation[i],Hue=0});count++;
                }
            }return count;
        }
    }
}

namespace TerrainStudio {
 public sealed class SandCornerPolicy {
  readonly System.Collections.Generic.Dictionary<string,ushort> corners=new System.Collections.Generic.Dictionary<string,ushort>();
  static bool Water(int m){return m==5||m==6||m==9;}
  readonly System.Collections.Generic.Dictionary<string,ushort> sides=new System.Collections.Generic.Dictionary<string,ushort>();
  readonly System.Collections.Generic.HashSet<ushort> cornerArt=new System.Collections.Generic.HashSet<ushort>();
  public int CompletedCorners {get;private set;}
  readonly System.Collections.Generic.HashSet<ushort> sideArt=new System.Collections.Generic.HashSet<ushort>();
  public int CompletedSides {get;private set;}
  static bool Sand(int m){return m==4||m==67||m==129;}
  public static SandCornerPolicy Inspect(Catalog catalog,ClientAssets assets){var p=new SandCornerPolicy();foreach(ushort side in new ushort[]{6045,6047,6049,6051})if(assets.HasStaticArt(side)){using(Bitmap b=assets.StaticPreview(side))if(b!=null)p.sideArt.Add(side);}foreach(ushort id in new ushort[]{6053,6054,6055,6056,6057,6058,6059,6060})if(assets.HasStaticArt(id)){using(Bitmap b=assets.StaticPreview(id))if(b!=null)p.cornerArt.Add(id);}foreach(var r in catalog.RuleInventory()){
   if(r.CenterMaterialId!=4)continue;
   foreach(ushort side in r.StaticTileIds)if(side>=6045&&side<=6052&&assets.HasStaticArt(side)){
    string key=r.Key.Replace("4D","06");if(!p.sides.ContainsKey(key)||r.Key.IndexOf("4D",StringComparison.Ordinal)<0)p.sides[key]=side;break;
   }
   foreach(ushort id in r.StaticTileIds)if(id>=6045&&id<=6066&&assets.HasStaticArt(id)){using(Bitmap b=assets.StaticPreview(id)){if(b!=null){p.corners[r.Key]=id;break;}}}
  }return p;}
  public int ApplySides(MapDocument source,MapDocument target){int count=0;CompletedSides=0;
   for(int y=1;y<source.Height-1;y++)for(int x=1;x<source.Width-1;x++){
    int i=y*source.Width+x;if(!Sand(source.Materials[i]))continue;
    int cardinal=0;foreach(int d in new int[]{-source.Width,1,source.Width,-1})if(Water(source.Materials[i+d]))cardinal++;
    if(cardinal!=1)continue;string key="";int? z=null;bool valid=true;
    for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int j=(y+dy)*source.Width+x+dx,m=source.Materials[j];if(Water(m)){key+="06";if(z.HasValue&&z.Value!=source.Elevation[j])valid=false;z=source.Elevation[j];}else if(Sand(m))key+="04";else valid=false;}
    ushort id;if(!valid||!z.HasValue||source.Elevation[i]!=z.Value)continue;
    if(!sides.TryGetValue(key,out id)){
     id=(ushort)(Water(source.Materials[i-source.Width])?6049:Water(source.Materials[i+1])?6051:Water(source.Materials[i+source.Width])?6047:6045);
     if(!sideArt.Contains(id))continue;CompletedSides++;
    }
    target.Statics.Add(new StaticPlacement{X=x,Y=y,Id=id,Z=(sbyte)z.Value,Hue=0});count++;
   }return count;
  }
  public int Apply(MapDocument source,MapDocument target){int count=0;CompletedCorners=0;for(int y=1;y<source.Height-1;y++)for(int x=1;x<source.Width-1;x++){
   int i=y*source.Width+x;if(!Sand(source.Materials[i]))continue;
   bool n=Water(source.Materials[i-source.Width]),e=Water(source.Materials[i+1]),s=Water(source.Materials[i+source.Width]),w=Water(source.Materials[i-1]);
   int cardinal=(n?1:0)+(e?1:0)+(s?1:0)+(w?1:0);
   // Concave bank corners: two adjoining water sides. Convex bank corners:
   // diagonal-only water. Straight banks and narrow opposite-side strips stay unchanged.
   if(!(cardinal==0||(cardinal==2&&((n&&e)||(e&&s)||(s&&w)||(w&&n)))))continue;
   string key="";int? waterZ=null;bool valid=true;
   for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int j=(y+dy)*source.Width+x+dx,m=source.Materials[j];
    if(Water(m)){key+="06";if(waterZ.HasValue&&waterZ.Value!=source.Elevation[j])valid=false;waterZ=source.Elevation[j];}
    else if(Sand(m))key+="04";else valid=false;
   }
   ushort id;if(!valid||!waterZ.HasValue||source.Elevation[i]!=waterZ.Value)continue;
   if(!corners.TryGetValue(key,out id)){
    // Complete only missing orientations, keeping every existing catalog placement.
    // Large pieces wrap adjoining water sides; small pieces cap a single diagonal.
    if(cardinal==2) id=(ushort)(n&&e?6059:e&&s?6060:s&&w?6057:6058);
    else {bool nw=Water(source.Materials[i-source.Width-1]),ne=Water(source.Materials[i-source.Width+1]),se=Water(source.Materials[i+source.Width+1]),sw=Water(source.Materials[i+source.Width-1]);
     if((nw?1:0)+(ne?1:0)+(se?1:0)+(sw?1:0)!=1)continue;
     id=(ushort)(nw?6055:ne?6056:se?6054:6053);
    }
    if(!cornerArt.Contains(id))continue;CompletedCorners++;
   }
   target.Statics.Add(new StaticPlacement{X=x,Y=y,Id=id,Z=(sbyte)waterZ.Value,Hue=0});count++;
  }return count;}
 }
}
