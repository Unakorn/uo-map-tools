(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WaterInset=factory();})(globalThis,function(){
 'use strict';
 const water=id=>id===5||id===6||id===9;
 function apply(source,proposed,width,height,selection,pixels,borderMaterial,sections=source){
  if(![1,2].includes(pixels))throw Error('Water inset must be 1 or 2 pixels.');
  if(source.length!==width*height||proposed.length!==source.length||selection.length!==source.length||sections.length!==source.length)throw Error('Invalid water inset dimensions.');
  const output=proposed.slice();let mask=new Uint8Array(source.length),retained=0;
  // Preserve existing water; the caller supplies exact altitude sections for new water.
  for(let i=0;i<mask.length;i++)mask[i]=selection[i]&&water(proposed[i])&&!water(source[i])?1:0;
  const original=mask.slice();
  for(let step=0;step<pixels;step++){
   const next=mask.slice();
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;if(!mask[i])continue;
    for(let dy=-1;dy<=1&&next[i];dy++)for(let dx=-1;dx<=1;dx++){
     const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;
     const j=ny*width+nx;if(!mask[j]||sections[j]!==sections[i]){next[i]=0;break;}
    }
   }
   mask=next;
  }
  for(let i=0;i<mask.length;i++)if(original[i]&&!mask[i]){output[i]=typeof borderMaterial==='function'?borderMaterial(source[i],i):borderMaterial;retained++;}
  return {terrain:output,retained};
 }
 return {apply};
});
