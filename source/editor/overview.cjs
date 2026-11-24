/* Geometry for a fixed-size, aspect-preserving map overview. No image data or DOM. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MapPaintOverview=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function dimension(value,name){
    if(!Number.isInteger(value)||value<1||value>8192)throw new RangeError(name+' must be an integer from 1 to 8192');
  }
  function finite(value,name){
    if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError(name+' must be a finite number');
  }
  function layout(width,height,size=176,padding=8){
    dimension(width,'width');dimension(height,'height');finite(size,'size');finite(padding,'padding');
    if(padding<0||size<=2*padding)throw new RangeError('size must be positive and greater than twice the nonnegative padding');
    const scale=(size-2*padding)/Math.max(width,height),scaledWidth=width*scale,scaledHeight=height*scale;
    return {left:(size-scaledWidth)/2,top:(size-scaledHeight)/2,width:scaledWidth,height:scaledHeight,scale};
  }
  function mapPoint(px,py,width,height,size=176,padding=8){
    finite(px,'px');finite(py,'py');const box=layout(width,height,size,padding);
    return {x:Math.max(0,Math.min(width,(px-box.left)/box.scale)),y:Math.max(0,Math.min(height,(py-box.top)/box.scale))};
  }
  function viewport(width,height,zoom,offsetX,offsetY,viewWidth,viewHeight,size=176,padding=8){
    const box=layout(width,height,size,padding);
    for(const [name,value]of Object.entries({zoom,offsetX,offsetY,viewWidth,viewHeight}))finite(value,name);
    if(zoom<=0||viewWidth<0||viewHeight<0)throw new RangeError('zoom must be positive and view dimensions must be nonnegative');
    const left=Math.max(0,-offsetX/zoom),top=Math.max(0,-offsetY/zoom);
    const right=Math.min(width,(viewWidth-offsetX)/zoom),bottom=Math.min(height,(viewHeight-offsetY)/zoom);
    if(right<=left||bottom<=top)return null;
    return {x:box.left+left*box.scale,y:box.top+top*box.scale,width:(right-left)*box.scale,height:(bottom-top)*box.scale};
  }
  return {layout,mapPoint,viewport};
});
