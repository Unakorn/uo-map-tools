(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MapGrowth=factory();})(globalThis,function(){
'use strict';
function plan(doc,limit=6,radius=1){
 if(!Number.isInteger(limit)||limit<1||limit>4096)throw Error('Maximum patch size must be 1–4096 pixels.');
 if(!Number.isInteger(radius)||radius<1||radius>64)throw Error('Growth must be 1–64 pixels.');
 const src=doc.terrain,n=src.length,w=doc.width,out=src.slice(),seen=new Uint8Array(n),queue=new Uint32Array(n),owner=new Int32Array(n);owner.fill(-1);
 const neighbors=(i,fn)=>{const x=i%w;if(x)fn(i-1);if(x+1<w)fn(i+1);if(i>=w)fn(i-w);if(i+w<n)fn(i+w);};
 let frontier=[];
 // Measure complete original components, never selection-clipped fragments.
 for(let start=0;start<n;start++)if(!seen[start]&&src[start]!==65535){let head=0,tail=1,selected=true;queue[0]=start;seen[start]=1;
  while(head<tail){const i=queue[head++];if(!doc.selection[i])selected=false;neighbors(i,j=>{if(!seen[j]&&src[j]===src[start]){seen[j]=1;queue[tail++]=j;}});}
  if(selected&&tail<=limit)for(let k=0;k<tail;k++){const i=queue[k];owner[i]=src[i];frontier.push(i);}
 }
 // Simultaneous rings: competing colors leave an unchanged seam, never overwrite seeds.
 for(let step=0;step<radius&&frontier.length;step++){
  const claims=new Map();for(const i of frontier)neighbors(i,j=>{if(owner[j]!==-1||!doc.selection[j]||src[j]===65535)return;const color=owner[i];if(!claims.has(j))claims.set(j,color);else if(claims.get(j)!==color)claims.set(j,-2);});
  frontier=[];for(const [i,color]of claims){owner[i]=color;if(color>=0){out[i]=color;frontier.push(i);}}
 }
 return out;
}
return {plan};
});
