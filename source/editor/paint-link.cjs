/* Numeric HTML-hex mapping between exact terrain IDs and grayscale altitude shades.
 * #RRGGBB is treated as one unsigned integer, not as an RGB distance or luminance.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MapPaintLink=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const UNSET=65535,GRAY_STEP=0x010101;
  function integer(value,min,max,label){
    if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError(label+' must be an integer from '+min+' to '+max);
    return value;
  }
  function createMapping(materials){
    if(!Array.isArray(materials)||materials.length===0)throw new TypeError('materials must be a nonempty array');
    if(materials.length>UNSET)throw new RangeError('At most 65535 distinct material IDs are supported');
    const terrainToAltitude=new Uint16Array(65536);terrainToAltitude.fill(UNSET);
    const altitudeToTerrain=new Uint16Array(256),ids=new Set(),byCode=new Map();
    for(let index=0;index<materials.length;index++){
      const item=materials[index];
      if(item===null||typeof item!=='object')throw new TypeError('Material at index '+index+' must be an object');
      const id=integer(item.id,0,UNSET-1,'Material ID');
      if(ids.has(id))throw new RangeError('Duplicate material ID '+id);
      ids.add(id);
      const r=integer(item.r,0,255,'Red channel'),g=integer(item.g,0,255,'Green channel'),b=integer(item.b,0,255,'Blue channel');
      const code=(r<<16)|(g<<8)|b;
      terrainToAltitude[id]=Math.round(code/GRAY_STEP);
      if(!byCode.has(code)||id<byCode.get(code))byCode.set(code,id);
    }
    // Collapse identical codes to the lowest ID before searching adjacent codes.
    const colors=Array.from(byCode,entry=>({code:entry[0],id:entry[1]})).sort((a,b)=>a.code-b.code);
    for(let shade=0;shade<256;shade++){
      const code=shade*GRAY_STEP;let lo=0,hi=colors.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(colors[mid].code<code)lo=mid+1;else hi=mid;}
      let match;
      if(lo===0)match=colors[0];
      else if(lo===colors.length)match=colors[lo-1];
      else match=code-colors[lo-1].code<=colors[lo].code-code?colors[lo-1]:colors[lo];
      altitudeToTerrain[shade]=match.id;
    }
    return {terrainToAltitude,altitudeToTerrain};
  }
  return {createMapping};
});
