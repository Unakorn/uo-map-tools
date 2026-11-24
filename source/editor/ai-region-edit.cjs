(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./ai-theme.cjs'),require('./water-inset.cjs'));else root.AIRegionEdit=factory(root.AITheme,root.WaterInset);})(globalThis,function(theme,inset){
 'use strict';
 function prepare(snapshot,plan,summary,catalog,pixels){
  const mapping=theme.validate(plan,summary,catalog),proposed=theme.proposal(snapshot,mapping),sections=new Uint32Array(proposed.length);
  for(let i=0;i<proposed.length;i++){
   sections[i]=snapshot.terrain[i]*65536+snapshot.altitude[i];
   if(snapshot.selection[i]&&[5,6,9].includes(proposed[i])&&![5,6,9].includes(snapshot.terrain[i])&&snapshot.altitude[i]===65535)throw Error('Water needs an existing heightmap. Generate and posterize altitude first.');
  }
  const result=inset.apply(snapshot.terrain,proposed,snapshot.width,snapshot.height,snapshot.selection,pixels,original=>original,sections);
  return {...result,assignments:mapping};
 }
 return {prepare};
});
