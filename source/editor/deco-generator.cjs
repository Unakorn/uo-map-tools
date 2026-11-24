(function(r,f){if(typeof module==='object'&&module.exports)module.exports=f();else r.DecoGenerator=f();})(globalThis,function(){
'use strict';
const EMPTY=65535;
// Bounded typed-array chunks avoid millions of retained placement objects.
class Placements {
 constructor(){this.length=0;this.chunks=[];}
 push(p){const chunk=this.length>>>16,offset=this.length&65535;if(!this.chunks[chunk])this.chunks[chunk]={indices:new Uint32Array(65536),presets:new Uint16Array(65536)};this.chunks[chunk].indices[offset]=p.index;this.chunks[chunk].presets[offset]=p.preset;this.length++;}
 *[Symbol.iterator](){for(let i=0;i<this.length;i++){const c=this.chunks[i>>>16],j=i&65535;yield {index:c.indices[j],preset:c.presets[j]};}}
 every(fn){for(const p of this)if(!fn(p))return false;return true;}
}
const groups=[
 {name:'Jungle',terrain:[10,44,68,130],trees:[1,2,3,4,5,6,7,8,9,10,11,12],plants:[54,55,56,57,58,76,79,91]},
 {name:'Forest',terrain:[11,43,61,63,65,66,72,131],trees:[19,21,23,25,26,27,29,31,33,35],plants:[54,55,56,57,58,65,66,67,68,76,83]},
 {name:'Grass',terrain:[1,42,62,83,128],trees:[14,15],plants:[59,60,61,62,63,64,69,70,71,73,74,75,77,82,85,86,88]},

];
const byTerrain=new Map(groups.flatMap(g=>g.terrain.map(id=>[id,g])));
const paving=new Set([15,16,17,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,51,52,53,54,56,57,58]);
function protectedPlots(doc){
 const w=doc.width,h=doc.height,n=w*h,outside=new Uint8Array(n),queue=new Int32Array(n);let head=0,tail=0;
 const add=i=>{if(!outside[i]&&!paving.has(doc.terrain[i])){outside[i]=1;queue[tail++]=i;}};
 for(let x=0;x<w;x++){add(x);add((h-1)*w+x);}for(let y=0;y<h;y++){add(y*w);add(y*w+w-1);}
 while(head<tail){const i=queue[head++],x=i%w;if(x)add(i-1);if(x+1<w)add(i+1);if(i>=w)add(i-w);if(i+w<n)add(i+w);}
 return outside; // zero means paving or an interior enclosed by paving.
}
function walls(doc,options={}) {
 const w=doc.width,h=doc.height,seen=new Uint8Array(w*h),placements=new Placements();let plots=0,skipped=0;
 const red=i=>[15,34,39,53].includes(doc.terrain[i]);
 const allowed=(x,y)=> (options.scope==='whole'||doc.selection[y*w+x])&&(!options.center||(x-options.center.x)**2+(y-options.center.y)**2<=options.radius**2);
 for(let start=0;start<w*h;start++)if(!seen[start]&&red(start)){
 const queue=[start];seen[start]=1;let x0=w,y0=h,x1=0,y1=0;
 for(let q=0;q<queue.length;q++){const i=queue[q],x=i%w,y=Math.floor(i/w);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);for(const n of [x?i-1:-1,x+1<w?i+1:-1,y?i-w:-1,y+1<h?i+w:-1])if(n>=0&&!seen[n]&&red(n)&&doc.terrain[n]===doc.terrain[start]){seen[n]=1;queue.push(n);}}
 if(!queue.some(i=>allowed(i%w,Math.floor(i/w))))continue;
 let valid=x1-x0>=2&&y1-y0>=2&&x1+1<w&&y1+1<h&&(queue.length===(x1-x0+1)*(y1-y0+1)||queue.length===2*(x1-x0+y1-y0)),z=doc.altitude[start];
 for(let y=y0;y<=y1+1&&valid;y++)for(let x=x0;x<=x1+1;x++)if(doc.altitude[y*w+x]!==z||z===EMPTY)valid=false;
 const pending=[];
 for(let y=y0;y<=y1&&valid;y++)for(let x=x0;x<=x1;x++)if(x===x0||x===x1||y===y0||y===y1){const i=y*w+x;const preset=136;if(!red(i)||!allowed(x,y)||(doc.deco[i]!==EMPTY&&doc.deco[i]!==preset&&![112,113,114,115].includes(doc.deco[i]))){valid=false;break;}if(doc.deco[i]!==preset)pending.push({index:i,preset});}
 if(valid){for(const p of pending)placements.push(p);if(pending.length)plots++;}else skipped++;
 }
 return {placements,plots,skipped};
}
function plan(doc,options={}){
 const s={scope:'patch',radius:128,density:2,plants:6,spacing:4,seed:1,repairTrees:true,walls:false,...options};
 if(!['patch','whole'].includes(s.scope))throw Error('Invalid decoration scope');
 for(const [key,lo,hi]of [['radius',8,1024],['density',0,30],['plants',0,50],['spacing',1,32],['seed',0,2147483647]])if(!Number.isInteger(s[key])||s[key]<lo||s[key]>hi)throw Error('Invalid decoration '+key);
 let seed=s.seed>>>0;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const w=doc.width,h=doc.height,n=w*h,open=protectedPlots(doc),whole=s.scope==='whole';
 const allowed=i=>open[i]&&(whole||doc.selection[i])&&doc.altitude[i]!==EMPTY&&byTerrain.has(doc.terrain[i]);
 let center=null,seen=0;
 if(!whole){for(let i=0;i<n;i++)if(allowed(i)){seen++;if(rand()<1/seen)center={x:i%w,y:Math.floor(i/w)};}if(!center)return {placements:[],center:null};}
 const x0=whole?0:Math.max(0,center.x-s.radius),x1=whole?w-1:Math.min(w-1,center.x+s.radius),y0=whole?0:Math.max(0,center.y-s.radius),y1=whole?h-1:Math.min(h-1,center.y+s.radius);
 const placements=new Placements(),effective=doc.deco.slice();
 const inScope=i=>(whole||doc.selection[i])&&(whole||(i%w-center.x)**2+(Math.floor(i/w)-center.y)**2<=s.radius*s.radius);
 let repaired=0;
 if(s.repairTrees)for(let i=0;i<n;i++)if(inScope(i)&&effective[i]>=1&&effective[i]<=44){const g=byTerrain.get(doc.terrain[i]);if(!g||!g.trees.includes(effective[i])){const safe=g&&open[i]?g.trees[((Math.imul(i+1,31)+s.seed)>>>0)%g.trees.length]:EMPTY;placements.push({index:i,preset:safe});effective[i]=safe;repaired++;}}
 const add=p=>placements.push(p);
 const near=new Uint8Array(n),blocked=new Uint8Array(n),chosen=new Uint8Array(n);
 function disk(i,r,mask){const cx=i%w,cy=Math.floor(i/w);for(let y=Math.max(0,cy-r);y<=Math.min(h-1,cy+r);y++)for(let x=Math.max(0,cx-r);x<=Math.min(w-1,cx+r);x++)if((x-cx)**2+(y-cy)**2<=r*r)mask[y*w+x]=1;}
 for(let i=0;i<n;i++)if(effective[i]!==EMPTY&&effective[i]>=1&&effective[i]<=53){disk(i,s.spacing,blocked);if(effective[i]<=44)disk(i,3,near);}
 function within(i,x,y){return allowed(i)&&effective[i]===EMPTY&&!chosen[i]&&(whole||(x-center.x)**2+(y-center.y)**2<=s.radius*s.radius);}
 // Smooth deterministic patchiness without looking at elevation or water proximity.
 const cluster=(x,y)=>.55+.45*(Math.sin((x+s.seed%97)/17)*Math.cos((y+s.seed%131)/23)+1)/2;
 for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const i=y*w+x;if(!within(i,x,y)||blocked[i])continue;const g=byTerrain.get(doc.terrain[i]),rate=s.density/100*(g.name==='Grass'?.3:1)*cluster(x,y);if(rand()>=rate)continue;const id=g.trees[Math.floor(rand()*g.trees.length)];add({index:i,preset:id});chosen[i]=1;disk(i,s.spacing,blocked);if(id<=44)disk(i,3,near);}
 for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const i=y*w+x;if(!within(i,x,y))continue;const g=byTerrain.get(doc.terrain[i]);if(!g.plants.length||rand()>=s.plants/100*cluster(x,y)*(near[i]?1:.35))continue;add({index:i,preset:g.plants[Math.floor(rand()*g.plants.length)]});chosen[i]=1;}
 let wallResult={placements:[],plots:0,skipped:0};if(s.walls){wallResult=walls(doc,{scope:s.scope,center:whole?null:center,radius:s.radius});for(const p of wallResult.placements)placements.push(p);}return {placements,center,repaired,wallPlots:wallResult.plots,skippedPlots:wallResult.skipped};
}
function housing(doc,options={}) {
 const s={density:2,plants:6,spacing:4,seed:1,...options};
 for(const [k,lo,hi]of [['density',0,30],['plants',0,50],['spacing',1,32],['seed',0,2147483647]])if(!Number.isInteger(s[k])||s[k]<lo||s[k]>hi)throw Error('Invalid housing decoration '+k);
 const swamp=new Set([41,70]),snow=new Set([12,45,71,84,132]),target=i=>swamp.has(doc.terrain[i])||snow.has(doc.terrain[i]);
 const w=doc.width,h=doc.height,n=w*h,protectedMask=new Uint8Array(n),blocked=new Uint8Array(n),open=protectedPlots(doc),placements=new Placements();let protectedCells=0,cleared=0,added=0,seed=s.seed>>>0;
 const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 // Protect exact flat rendered cells plus one surrounding tile, including unselected neighbors.
 for(let y=0;y<h-1;y++)for(let x=0;x<w-1;x++){const i=y*w+x,z=doc.altitude[i];if(!target(i)||z===EMPTY||z!==doc.altitude[i+1]||z!==doc.altitude[i+w]||z!==doc.altitude[i+w+1])continue;
 for(let yy=Math.max(0,y-1);yy<=Math.min(h-1,y+1);yy++)for(let xx=Math.max(0,x-1);xx<=Math.min(w-1,x+1);xx++)protectedMask[yy*w+xx]=1;
 }
 const disk=i=>{const x=i%w,y=Math.floor(i/w);for(let yy=Math.max(0,y-s.spacing);yy<=Math.min(h-1,y+s.spacing);yy++)for(let xx=Math.max(0,x-s.spacing);xx<=Math.min(w-1,x+s.spacing);xx++)if((xx-x)**2+(yy-y)**2<=s.spacing*s.spacing)blocked[yy*w+xx]=1;};
 for(let i=0;i<n;i++){if(doc.selection[i]&&target(i)&&protectedMask[i]){protectedCells++;if(doc.deco[i]>=1&&doc.deco[i]<=53){placements.push({index:i,preset:EMPTY});cleared++;}}if(doc.deco[i]>=1&&doc.deco[i]<=53)disk(i);}
 for(let y=0;y<h-1;y++)for(let x=0;x<w-1;x++){const i=y*w+x;if(!doc.selection[i]||!target(i)||!open[i]||doc.deco[i]!==EMPTY||doc.altitude[i]===EMPTY||doc.altitude[i+1]===EMPTY||doc.altitude[i+w]===EMPTY||doc.altitude[i+w+1]===EMPTY)continue;
 const wet=swamp.has(doc.terrain[i]),trees=wet?[16,17,18,35,37,39,41,43]:[16,17,18,25,26,45,46,47],plants=wet?[54,55,65,66,72,75,87]:[71,86];let preset;
 if(!protectedMask[i]&&!blocked[i]&&rand()<s.density/100){preset=trees[Math.floor(rand()*trees.length)];disk(i);}else if(rand()<s.plants/100)preset=plants[Math.floor(rand()*plants.length)];else continue;
 placements.push({index:i,preset});added++;
 }
 return {placements,protectedCells,cleared,added};
}
return {plan,walls,groups,protectedPlots,housing};
});

