(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MapImageGenerator=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Stock definitions: ServUO pub57 and RunUO master, Scripts/Misc/MapDefinitions.cs.
  // 6144-wide Britannia is the older client layout supported by ClassicUO MapLoader.
  const PRESETS=Object.freeze([
    {key:'britannia',label:'Felucca / Trammel — current',width:7168,height:4096,files:'map0 / map1'},
    {key:'britannia-legacy',label:'Felucca / Trammel — older clients',width:6144,height:4096,files:'map0 / map1'},
    {key:'ilshenar',label:'Ilshenar',width:2304,height:1600,files:'map2'},
    {key:'malas',label:'Malas',width:2560,height:2048,files:'map3'},
    {key:'tokuno',label:'Tokuno',width:1448,height:1448,files:'map4'},
    {key:'ter-mur',label:'Ter Mur',width:1280,height:4096,files:'map5'},
    {key:'test',label:'Small test map — custom server size',width:128,height:128,files:'custom configuration'}
  ].map(p=>Object.freeze(p)));
  function dimensions(options={}){
    const key=options.preset||'britannia',preset=PRESETS.find(p=>p.key===key);
    if(!preset&&key!=='custom')throw new RangeError('Choose a known map-size preset or Custom.');
    const width=preset?preset.width:options.width,height=preset?preset.height:options.height;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<8||height<8||width>8192||height>8192||width%8||height%8||width*height>33554432)
      throw new RangeError('Use dimensions 8–8192 in multiples of 8, with at most 33,554,432 pixels per image.');
    return {width,height,pixels:width*height,preset: key,label:preset?preset.label:'Custom map',files:preset?preset.files:'custom configuration'};
  }
  function validate(materials,options={}){
    const size=dimensions(options),materialId=options.materialId===undefined?1:options.materialId,z=options.z===undefined?0:options.z;
    if(!Number.isInteger(z)||z< -128||z>127)throw new RangeError('Starting height must be a whole number from -128 through 127.');
    if(!Array.isArray(materials))throw new TypeError('A terrain palette is required.');
    const terrain=materials.find(m=>m.id===materialId);
    if(!Number.isInteger(materialId)||!terrain)throw new RangeError('Choose a starting terrain from the palette.');
    if(materials.filter(m=>m.r===terrain.r&&m.g===terrain.g&&m.b===terrain.b).length!==1)
      throw new RangeError('This terrain shares its color with another material and cannot be saved unambiguously as Terrain.png. Choose another starting terrain.');
    return {...size,materialId,z,shade:z+128,terrainName:terrain.name};
  }
  function create(Document,materials,options={}){
    const settings=validate(materials,options);
    if(typeof Document!=='function')throw new TypeError('The map-image document constructor is required.');
    // Populate a detached document directly. Defaults are independent map inputs,
    // not linked paint strokes, and do not allocate full-map undo snapshots.
    const doc=new Document(settings.width,settings.height,materials);
    doc.terrain.fill(settings.materialId);doc.altitude.fill(settings.shade);
    return {document:doc,settings};
  }
  return {PRESETS,dimensions,validate,create};
});
