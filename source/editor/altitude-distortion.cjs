/* Seeded integer-height bumps and gullies, with optional paired terrain mapping. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.MapPaintDistortion=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const UNSET=65535,MAX_CROP=4194304,PLANS=new WeakMap();
  function integer(v,min,max,name){if(!Number.isSafeInteger(v)||v<min||v>max)throw new RangeError(`${name} must be a whole number from ${min} to ${max}`);return v;}
  function smooth(t){return t*t*(3-2*t);}
  function hash(x,y,seed){let n=(Math.imul(x,374761393)^Math.imul(y,668265263)^seed)>>>0;n=Math.imul(n^(n>>>13),1274126177);n=(n^(n>>>16))>>>0;return n/4294967295*2-1;}
  function noise(x,y,seed){const ix=Math.floor(x),iy=Math.floor(y),u=smooth(x-ix),v=smooth(y-iy),a=hash(ix,iy,seed),b=hash(ix+1,iy,seed),c=hash(ix,iy+1,seed),d=hash(ix+1,iy+1,seed);return (a+(b-a)*u)*(1-v)+(c+(d-c)*u)*v;}
  function plan(owner,input={},helpers){
    owner._idle();
    if(owner.currentLayer!=='altitude')throw new Error('Bumps and gullies work only on the altitude image');
    if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Bumps and gullies settings must be an object');
    const options=Object.freeze({roughness:integer(input.roughness??3,0,64,'Height variation'),scale:integer(input.scale??24,2,256,'Feature size'),seed:integer(input.seed??1337,0,4294967295,'Seed'),edgeFade:integer(input.edgeFade??8,1,64,'Edge fade')});
    if(!owner.selectionActive)throw new Error('Select the hills to shape before previewing bumps and gullies');
    const mask=owner.selection,protection=input.protectMask;
    if(protection!==undefined&&(!(protection instanceof Uint8Array)||protection.length!==mask.length))throw new TypeError('Protected road mask must match the image dimensions');
    let left=owner.width,top=owner.height,right=-1,bottom=-1,selected=0;
    for(let i=0;i<mask.length;i++){
      if(mask[i]!==0&&mask[i]!==1)throw new RangeError('Selection must be binary');
      if(protection&&protection[i]!==0&&protection[i]!==1)throw new RangeError('Protected road mask must be binary');
      if(!mask[i])continue;selected++;const x=i%owner.width,y=Math.floor(i/owner.width);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
    }
    if(!selected)throw new Error('Select a nonempty area for bumps and gullies');
    // One outside pixel around the selection supplies exact boundary-distance seeds,
    // including virtual pixels outside the document. Protected roads are seeds too.
    const width=right-left+3,height=bottom-top+3,count=width*height;
    if(count>MAX_CROP)throw new RangeError('Bumps and gullies support a selected bounding box of up to 4,194,304 pixels including its edge. Select a smaller region.');
    const link=owner._paintLink,beforeTerrain=link?new Uint16Array(count):null;
    const source=new Uint16Array(count),gate=new Uint8Array(count),distances=new Uint32Array(count),shades=new Uint16Array(count);source.fill(UNSET);shades.fill(UNSET);
    let protectedPixels=0;
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
      const target=y*owner.width+x,i=(y-top+1)*width+x-left+1,shade=owner.altitude[target];source[i]=shade;if(beforeTerrain)beforeTerrain[i]=owner.terrain[target];
      if(shade!==UNSET&&shade>255)throw new RangeError('Source contains an invalid altitude shade');
      if(mask[target]&&protection&&protection[target])protectedPixels++;
      if(mask[target]&&shade!==UNSET&&!(protection&&protection[target])){gate[i]=1;distances[i]=0x3fffffff;}
    }
    helpers.edgeDistanceSquared(distances,width,height);
    let pixelCount=0,changedPixels=0,clippedPixels=0;
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
      const i=(y-top+1)*width+x-left+1;if(!gate[i])continue;
      const fade=smooth(Math.min(1,Math.max(0,(Math.sqrt(distances[i])-1)/options.edgeFade)));
      if(fade===0)continue;
      const u=x/options.scale,v=y/options.scale;
      const n=(noise(u,v,options.seed)+.5*noise(u*2,v*2,(options.seed^0x9e3779b9)>>>0)+.25*noise(u*4,v*4,(options.seed^0x85ebca6b)>>>0))/1.75;
      const wanted=Math.round(source[i]+n*options.roughness*fade),shade=Math.max(0,Math.min(255,wanted));
      if(wanted!==shade)clippedPixels++;shades[i]=shade;pixelCount++;if(shade!==source[i])changedPixels++;
    }
    const bounds=Object.freeze({left,top,width:right-left+1,height:bottom-top+1});
    const record={owner,options,bounds,width,source,link,beforeTerrain,terrainRef:owner.terrain,gate,shades,selection:helpers.packMask(mask),selectionRevision:owner.selectionRevision,selectionRef:mask,altitudeRef:owner.altitude,documentWidth:owner.width,documentHeight:owner.height,finished:null,helpers};
    const preview=Object.freeze({mode:'distort',options,bounds,pixelCount,changedPixels,protectedPixels,clippedPixels,
      valueAt:(x,y,layer='altitude')=>{if(record.finished==='canceled'||layer!=='altitude'||!Number.isInteger(x)||!Number.isInteger(y)||x<left||y<top||x>right||y>bottom)return undefined;const shade=record.shades[(y-top+1)*width+x-left+1];return shade===UNSET?undefined:shade;},
      cancel:()=>{if(record.finished)return false;record.finished='canceled';record.source=record.beforeTerrain=record.gate=record.shades=record.selection=null;return true;}
    });
    PLANS.set(preview,record);return preview;
  }
  function apply(owner,preview){
    const r=PLANS.get(preview);if(!r||r.owner!==owner)throw new Error('This bumps and gullies preview belongs to a different document');
    if(r.finished)throw new Error(`This bumps and gullies preview has already been ${r.finished}`);owner._idle();
    const stale=()=>{throw new Error('The bumps and gullies preview is stale; preview again after editing the source or selection');};
    if(owner.currentLayer!=='altitude'||!owner.selectionActive||owner.width!==r.documentWidth||owner.height!==r.documentHeight||owner.altitude!==r.altitudeRef||owner._paintLink!==r.link||(r.link&&owner.terrain!==r.terrainRef)||owner.selection!==r.selectionRef||owner.selectionRevision!==r.selectionRevision||!r.helpers.samePackedMask(owner.selection,r.selection))stale();
    const b=r.bounds;
    for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){const i=(y+1)*r.width+x+1;const target=(y+b.top)*owner.width+x+b.left;if(owner.altitude[target]!==r.source[i]||(r.beforeTerrain&&owner.terrain[target]!==r.beforeTerrain[i]))stale();}
    const result=owner._edit(()=>{for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){const shade=r.shades[(y+1)*r.width+x+1];if(shade!==UNSET)owner._write((y+b.top)*owner.width+x+b.left,shade);}},'altitude',r.link);
    r.finished='applied';return Object.assign(result,{mode:'distort',seed:r.options.seed,clippedPixels:preview.clippedPixels,footprintPixels:preview.pixelCount});
  }
  return Object.freeze({plan,apply,MAX_CROP});
});
