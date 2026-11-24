(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.CityPlots=factory();})(globalThis,function(){
'use strict';
function plan(doc,o={}){
 const s={count:20,min:8,max:16,gap:4,relief:12,seed:1,material:39,siteBorder:0,siteBlend:0,...o};
 if(s.scope!==undefined&&!['patch','whole'].includes(s.scope))throw Error('Invalid city scope');
 const whole=s.scope==='whole';
 if(s.altitudeOnly!==undefined&&typeof s.altitudeOnly!=='boolean')throw Error('Invalid house-site mode');
 if(s.altitudeOnly&&whole)throw Error('House sites must respect selection.');
 for(const [k,lo,hi]of [['siteBorder',0,16],['siteBlend',0,32],['count',1,200],['min',3,64],['max',3,64],['gap',1,32],['relief',0,255],['seed',0,2147483647]])if(!Number.isInteger(s[k])||s[k]<lo||s[k]>hi)throw Error('Invalid city '+k);
 if(s.max<s.min)throw Error('Maximum size must be at least minimum size.');
 const materials=[15,16,22,23,24,34,39,53];if(!materials.includes(s.material))throw Error('Choose a city paving material.');
 const land=new Set([1,4,7,8,10,11,61,62,63,65,66,67,72,128,129,131]);if(s.altitudeOnly)for(const id of [12,41,45,70,71,84,132])land.add(id);let seed=s.seed>>>0;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const w=doc.width,h=doc.height,occupied=new Uint8Array(w*h),plots=[];let anchor=null;let x0=0,y0=0,x1=w,y1=h;
 if(s.altitudeOnly){x0=w;y0=h;x1=0;y1=0;for(let i=0;i<w*h;i++)if(doc.selection[i]){const x=i%w,y=Math.floor(i/w);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);}if(x1<=x0||y1<=y0)return [];}
 const generator=typeof module==='object'&&module.exports?require('./deco-generator.cjs'):globalThis.DecoGenerator;
 const open=generator.protectedPlots(doc);
 // First viable low-relief site anchors the city. Later lots cluster around it.
 for(let attempt=0;attempt<20000&&plots.length<s.count;attempt++){
  const bw=s.min+Math.floor(rand()*(s.max-s.min+1)),bh=s.min+Math.floor(rand()*(s.max-s.min+1));
  const padding=Math.max(s.gap,s.siteBorder+s.siteBlend+1);
  const reach=Math.ceil(Math.sqrt(s.count))*(s.max+s.gap)*2;
  const x=anchor&&!whole&&!s.altitudeOnly?Math.floor(anchor.x+(rand()-.5)*reach):x0+Math.floor(rand()*(x1-x0)),y=anchor&&!whole&&!s.altitudeOnly?Math.floor(anchor.y+(rand()-.5)*reach):y0+Math.floor(rand()*(y1-y0));
  if(x<padding||y<padding||x+bw+padding>w||y+bh+padding>h)continue;
  let okay=true,lo=256,hi=-1;const shades=[];
  for(let yy=y-padding;yy<y+bh+padding&&okay;yy++)for(let xx=x-padding;xx<x+bw+padding;xx++){
   const i=yy*w+xx,z=doc.altitude[i];if(!open[i]||(!whole&&!doc.selection[i])||!land.has(doc.terrain[i])||z===65535||occupied[i]||(doc.deco&&doc.deco[i]!==65535)){okay=false;break;}
   lo=Math.min(lo,z);hi=Math.max(hi,z);if(hi-lo>s.relief){okay=false;break;}if(xx>=x&&xx<x+bw&&yy>=y&&yy<y+bh)shades.push(z);
  }
  if(!okay)continue;shades.sort((a,b)=>a-b);const shade=shades[Math.floor(shades.length/2)],material=s.material;
  plots.push({x,y,width:bw,height:bh,shade,material,siteBorder:s.siteBorder,siteBlend:s.siteBlend});if(!anchor)anchor={x,y};
  // Reserve the complete height-vertex footprint as well as the paving cells.
  for(let yy=y-s.siteBorder-s.siteBlend;yy<=y+bh+s.siteBorder+s.siteBlend;yy++)for(let xx=x-s.siteBorder-s.siteBlend;xx<=x+bw+s.siteBorder+s.siteBlend;xx++)occupied[yy*w+xx]=1;
 }
 return plots;
}
function foundations(doc,options={}) {
 const w=doc.width,h=doc.height,seen=new Uint8Array(w*h),reserved=new Uint8Array(w*h),plots=[];let skipped=0;
 const paving=new Set([15,16,22,23,24,34,39,53]);
 for(let start=0;start<w*h;start++)if(!seen[start]&&paving.has(doc.terrain[start])){
 const material=doc.terrain[start],queue=[start];seen[start]=1;let x0=w,y0=h,x1=0,y1=0;
 for(let q=0;q<queue.length;q++){const i=queue[q],x=i%w,y=Math.floor(i/w);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);for(const n of [x?i-1:-1,x+1<w?i+1:-1,y?i-w:-1,y+1<h?i+w:-1])if(n>=0&&!seen[n]&&doc.terrain[n]===material){seen[n]=1;queue.push(n);}}
 if(options.scope!=='whole'&&!queue.some(i=>doc.selection[i]))continue;
 let valid=x1-x0>=2&&y1-y0>=2&&x1+1<w&&y1+1<h&&(queue.length===(x1-x0+1)*(y1-y0+1)||queue.length===2*(x1-x0+y1-y0));const shades=[];
 if(valid&&queue.length!==(x1-x0+1)*(y1-y0+1))for(const i of queue){const x=i%w,y=Math.floor(i/w);if(x!==x0&&x!==x1&&y!==y0&&y!==y1){valid=false;break;}}
 for(let y=y0;y<=y1+1&&valid;y++)for(let x=x0;x<=x1+1;x++){const i=y*w+x;if((options.scope!=='whole'&&!doc.selection[i])||reserved[i]||doc.altitude[i]===65535){valid=false;break;}shades.push(doc.altitude[i]);}
 if(!valid){skipped++;continue;}shades.sort((a,b)=>a-b);const shade=shades[Math.floor(shades.length/2)];plots.push({x:x0,y:y0,width:x1-x0+1,height:y1-y0+1,shade,material});for(let y=y0;y<=y1+1;y++)for(let x=x0;x<=x1+1;x++)reserved[y*w+x]=1;
 }
 return {plots,skipped};
}
function assertFlat(doc,plots){for(const p of plots)for(let y=p.y;y<=p.y+p.height;y++)for(let x=p.x;x<=p.x+p.width;x++)if(doc.altitude[y*doc.width+x]!==p.shade)throw Error('City foundation is not exactly flat; no changes committed.');}
return {plan,foundations,assertFlat};
});
