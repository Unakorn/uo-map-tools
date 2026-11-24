(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MapConsumption=factory();})(globalThis,function(){
 'use strict';
 function plan(doc,limit=6){
  if(!Number.isInteger(limit)||limit<1||limit>4096)throw Error('Maximum patch size must be 1–4096 pixels.');
  const source=doc.terrain,n=source.length,w=doc.width,labels=new Uint32Array(n),queue=new Uint32Array(n),sizes=new Uint32Array(n+1),eligible=new Uint8Array(n+1),out=source.slice();let component=0,patches=0,changed=0;
  function neighbors(i,fn){const x=i%w;if(x)fn(i-1);if(x+1<w)fn(i+1);if(i>=w)fn(i-w);if(i+w<n)fn(i+w);}
  // Measure whole components, including outside the selection: a cropped piece
  // of a large region must never be mistaken for a small isolated patch.
  for(let start=0;start<n;start++)if(!labels[start]&&source[start]!==65535){
   const id=++component,color=source[start];let head=0,tail=1,selected=true;queue[0]=start;labels[start]=id;
   while(head<tail){const i=queue[head++];if(!doc.selection[i])selected=false;neighbors(i,j=>{if(!labels[j]&&source[j]===color){labels[j]=id;queue[tail++]=j;}});}
   sizes[id]=tail;eligible[id]=selected&&tail<=limit?1:0;
  }
  for(let start=0;start<n;start++){
   const id=labels[start];if(!id||!eligible[id])continue;eligible[id]=0;
   const votes=new Map();let head=0,tail=1;queue[0]=start;labels[start]=0;
   while(head<tail){const i=queue[head++];neighbors(i,j=>{const other=labels[j];if(other===id){labels[j]=0;queue[tail++]=j;}else if(other&&sizes[other]>limit){votes.set(source[j],(votes.get(source[j])||0)+1);}});}
   let best=-1,count=0,tie=false;for(const [color,v] of votes){if(v>count){best=color;count=v;tie=false;}else if(v===count)tie=true;}
   // Only a stable larger neighbor may consume a patch. Ties stay untouched.
   if(best<0||tie)continue;patches++;changed+=tail;for(let k=0;k<tail;k++)out[queue[k]]=best;
  }
  return {terrain:out,patches,changed};
 }
 return {plan};
});
