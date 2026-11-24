(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.AITheme=factory();})(globalThis,function(){
 'use strict';
 const UNSET=65535;
 function capture(doc){
  if(doc.terrain.length>4194304)throw Error('Experimental AI Theme supports up to 4,194,304 pixels.');
  const s={width:doc.width,height:doc.height,terrain:doc.terrain.slice(),altitude:doc.altitude.slice(),selection:doc.selection.slice(),selectionActive:doc.selectionActive};
  if(!s.selection.some(Boolean))throw Error('The selection is empty.');
  return s;
 }
 function summarize(s,palette){
  const groups=new Map(),adjacency=new Map();let unset=0;
  for(let i=0;i<s.terrain.length;i++){
   if(!s.selection[i])continue;const id=s.terrain[i];if(id===UNSET){unset++;continue;}
   if(!groups.has(id))groups.set(id,{sourceId:id,pixels:0,minZ:127,maxZ:-128,totalZ:0,heightPixels:0});
   const g=groups.get(id);g.pixels++;if(s.altitude[i]!==UNSET){let z=s.altitude[i]-128;g.minZ=Math.min(g.minZ,z);g.maxZ=Math.max(g.maxZ,z);g.totalZ+=z;g.heightPixels++;}
   const x=i%s.width,y=Math.floor(i/s.width);
   for(const [dx,dy] of [[1,0],[0,1],[1,1],[-1,1],[-1,0],[0,-1],[-1,-1],[1,-1]]){if(x+dx<0||x+dx>=s.width||y+dy<0||y+dy>=s.height)continue;const j=i+dy*s.width+dx;if(j<i&&s.selection[j])continue;const other=s.terrain[j];if(other===id||other===UNSET)continue;const k=[id,other].sort((a,b)=>a-b).join(':');adjacency.set(k,(adjacency.get(k)||0)+1);}
  }
  if(!groups.size)throw Error('Generate or paint terrain first. Unset pixels are not themed.');
  return {width:s.width,height:s.height,scope:s.selectionActive?'selection':'whole map',unsetPreserved:unset,groups:[...groups.values()].map(g=>{const p=palette.find(p=>p.id===g.sourceId);return {sourceId:g.sourceId,name:p?.name||'Unknown',rgb:p?.rgb,pixels:g.pixels,minZ:g.heightPixels?g.minZ:null,maxZ:g.heightPixels?g.maxZ:null,meanZ:g.heightPixels?Math.round(g.totalZ/g.heightPixels):null};}),adjacency:[...adjacency].map(([pair,count])=>({pair,count})),groupMeaning:'One source color is one group, including disconnected regions. Adjacency includes diagonals and selection boundaries.'};
 }
 function validate(plan,summary,catalog){
  if(!plan||typeof plan.title!=='string'||typeof plan.summary!=='string'||!Array.isArray(plan.assignments))throw Error('AI returned an invalid theme plan.');
  const wanted=new Set(summary.groups.map(g=>g.sourceId)),allowed=new Set(catalog.materials.filter(m=>m.baseTextureAvailable).map(m=>m.id)),map=new Map();
  for(const a of plan.assignments){if(!Number.isInteger(a.sourceId)||!wanted.has(a.sourceId)||map.has(a.sourceId)||!Number.isInteger(a.targetId)||!allowed.has(a.targetId)||typeof a.reason!=='string')throw Error('AI assignments must cover each source exactly once and use texture-backed palette materials.');map.set(a.sourceId,a.targetId);}
  if(map.size!==wanted.size)throw Error('AI omitted a source color. Nothing was changed.');return map;
 }
 function proposal(s,map){const out=s.terrain.slice();for(let i=0;i<out.length;i++)if(s.selection[i]&&map.has(out[i]))out[i]=map.get(out[i]);return out;}
 async function audit(s,out,catalog,yieldFn=()=>Promise.resolve()){
  const counts={},examples=[],hex=Array.from({length:256},(_,i)=>i.toString(16).toUpperCase().padStart(2,'0'));let checked=0;
  for(let y=0;y<s.height;y++){
   for(let x=0;x<s.width;x++){
    let key='',affected=false,valid=true;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const i=Math.max(0,Math.min(s.height-1,y+dy))*s.width+Math.max(0,Math.min(s.width-1,x+dx));affected ||= !!s.selection[i];const id=out[i];if(!Number.isInteger(id)||id<0||id>255)valid=false;else key+=hex[id];}
    if(!affected)continue;checked++;const state=valid?(catalog.rules[key]||'MissingRule'):'UnsetNeighborhood';counts[state]=(counts[state]||0)+1;if(state!=='Matched'&&examples.length<8)examples.push({x,y,state});
   }
   if(y%32===0)await yieldFn();
  }
  return {checked,matched:counts.Matched||0,unresolved:checked-(counts.Matched||0),counts,examples};
 }
 function apply(doc,s,out){
  if(doc.width!==s.width||doc.height!==s.height||doc.selectionActive!==s.selectionActive)throw Error('The map changed. Generate a fresh proposal.');
  for(let i=0;i<out.length;i++)if(doc.terrain[i]!==s.terrain[i]||doc.altitude[i]!==s.altitude[i]||doc.selection[i]!==s.selection[i])throw Error('The map or selection changed. Generate a fresh proposal.');
  return doc._edit(()=>{for(let i=0;i<out.length;i++)if(s.selection[i]&&out[i]!==s.terrain[i])doc._write(i,out[i]);},'terrain',null);
 }
 return {capture,summarize,validate,proposal,audit,apply};
});
