(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.TerrainBoundaryFilters=factory();})(globalThis,function(){
 'use strict';
 const UNSET=65535,water=id=>id===5||id===6||id===9;
 const smooth=t=>t*t*(3-2*t);
 function width(v,label){if(!Number.isInteger(v)||v<1||v>32)throw Error(label+' must be 1–32 pixels.');}
 function neighbors(i,w,n,visit){const x=i%w;if(x)visit(i-1);if(x+1<w)visit(i+1);if(i>=w)visit(i-w);if(i+w<n)visit(i+w);}
 function smoothBoundaries(doc,pixels=5){
  width(pixels,'Width');const src=doc.altitude,terrain=doc.terrain,mask=doc.selection,n=src.length,w=doc.width;
  const distance=new Uint16Array(n);distance.fill(UNSET);const target=new Float64Array(n),count=new Uint8Array(n),queue=new Uint32Array(n),out=src.slice();let head=0,tail=0;
  for(let i=0;i<n;i++)if(mask[i]&&src[i]!==UNSET&&terrain[i]!==UNSET){
   neighbors(i,w,n,j=>{if(terrain[j]!==UNSET&&src[j]!==UNSET&&terrain[j]!==terrain[i]){target[i]+=(src[i]+src[j])/2;count[i]++;}});
   if(count[i]){target[i]/=count[i];distance[i]=1;queue[tail++]=i;count[i]=1;}
  }
  while(head<tail){const i=queue[head++],d=distance[i];if(d>=pixels)continue;
   neighbors(i,w,n,j=>{if(!mask[j]||terrain[j]!==terrain[i]||src[j]===UNSET)return;
    if(distance[j]===UNSET){distance[j]=d+1;target[j]=target[i];count[j]=1;queue[tail++]=j;}
    else if(distance[j]===d+1){target[j]=(target[j]*count[j]+target[i])/(count[j]+1);count[j]++;}
   });
  }
  for(let k=0;k<tail;k++){const i=queue[k],blend=smooth((pixels-distance[i]+1)/pixels);out[i]=Math.round(src[i]*(1-blend)+target[i]*blend);}
  return {altitude:out,mask:mask,affected:tail};
 }
 function flattenWater(doc,flatPixels=5,blendPixels=5){
  width(flatPixels,'Flat bank');width(blendPixels,'Blend');
  const src=doc.altitude,terrain=doc.terrain,n=src.length,w=doc.width,selected=doc.selection;
  const seen=new Uint8Array(n),queue=new Uint32Array(n),distance=new Uint16Array(n),levels=new Uint16Array(n),out=src.slice(),mask=new Uint8Array(n);distance.fill(UNSET);
  let components=0,waterPixels=0;
  // Derive each selected water body's level from its most common ORIGINAL shade.
  // Stable lowest-height tie break; no cross-body averaging.
  for(let start=0;start<n;start++)if(!seen[start]&&selected[start]&&water(terrain[start])&&src[start]!==UNSET){
   let head=0,tail=1;queue[0]=start;seen[start]=1;const histogram=new Uint32Array(256);
   while(head<tail){const i=queue[head++];histogram[src[i]]++;neighbors(i,w,n,j=>{if(!seen[j]&&selected[j]&&water(terrain[j])&&src[j]!==UNSET){seen[j]=1;queue[tail++]=j;}});}
   let level=0;for(let z=1;z<256;z++)if(histogram[z]>histogram[level])level=z;
   for(let k=0;k<tail;k++){const i=queue[k];out[i]=level;levels[i]=level;distance[i]=0;mask[i]=1;}waterPixels+=tail;components++;
  }
  if(!waterPixels)throw Error('Select water terrain (Water, Shallow Water or Deep Water), or deselect to process all water.');
  let head=0,tail=0;for(let i=0;i<n;i++)if(mask[i])queue[tail++]=i;
  const reach=flatPixels+blendPixels;
  // The water selection is the anchor. Banks intentionally extend beyond it.
  while(head<tail){const i=queue[head++],d=distance[i];if(d>=reach)continue;
   neighbors(i,w,n,j=>{if(water(terrain[j])||terrain[j]===UNSET||src[j]===UNSET)return;
    if(distance[j]===UNSET){distance[j]=d+1;levels[j]=levels[i];mask[j]=1;queue[tail++]=j;}
    else if(distance[j]===d+1)levels[j]=Math.min(levels[j],levels[i]);
   });
  }
  let flatBank=0,blendBank=0;
  for(let k=0;k<tail;k++){const i=queue[k],d=distance[i];if(!d)continue;if(d<=flatPixels){out[i]=levels[i];flatBank++;}else{const t=smooth((d-flatPixels)/blendPixels);out[i]=Math.round(levels[i]*(1-t)+src[i]*t);blendBank++;}}
  return {altitude:out,mask,components,waterPixels,flatBank,blendBank};
 }
 return {smoothBoundaries,flattenWater};
});
