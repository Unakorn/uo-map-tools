/* UI adapted from the user's Chrome Paint editor: chrome shell, pointer transactions,
   keyboard navigation, unsaved-document guard, and shortcut recording flow. */
(() => {
  'use strict';
  const {MapPaintDocument,UNSET,MAX_PROJECT_BYTES}=window.MapPaintCore;
  const {DEFAULT_SHORTCUTS,matchShortcut,shortcutFromEvent,assignShortcut,validateBindings}=window.MapPaintShortcuts;
  const palette=window.UOPalette, materials=palette.materials, byId=new Map(materials.map(m=>[m.id,m]));
  const paintLink=window.MapPaintLink.createMapping(materials);
  const root=document.getElementById('chrome-editor'), el=id=>document.getElementById(id);
  const surface=el('surface'), altitudeSurface=el('surface-altitude'), surfaces=[surface,altitudeSurface];
  const contexts=new Map(surfaces.map(canvas=>[canvas,canvas.getContext('2d',{alpha:false})]));
  const overview=el('overview'),overviewCtx=overview.getContext('2d',{alpha:false}),overviewGeometry=window.MapPaintOverview;
  const toolNames={pencil:'Pencil',fill:'Exact fill',eraser:'Erase to unset',wand:'Exact-color wand',pixel:'Pixel selection brush',freehand:'Freehand Select',rectangle:'Rectangle selection',ellipse:'Ellipse selection',gradient:'Shape gradient',path:'Path gradient',ramp:'Forward ramp',road:'Road and hillsides',flatten:'Flatten mountain',blur:'Blur brush',mountain:'Mountains',eyedropper:'Sample value'};
  const altitudeTools=new Set(['gradient','mountain','path','ramp','blur','road','flatten']);
  const actionNames={...toolNames,'select-all':'Select all',deselect:'Deselect','invert-selection':'Invert selection',undo:'Undo',redo:'Redo','save-project':'Save project'};
  const grass=materials.find(m=>m.name==='Grass')||materials[0];
  const sand=materials.find(m=>m.name==='Sand')||materials.find(m=>m.id!==grass.id)||grass;
  const state={matchSurroundings:false,tool:'pencil',layout:'side-by-side',linkedPainting:true,material:grass.id,secondaryMaterial:sand.id,z:0,secondaryZ:32,terrainSlot:'primary',altitudeSlot:'primary',size:1,selectionPixels:1,gradientEdge:0,gradientCenter:32,pathHeight:127,pathEdge:0,pathPreviewFirst:false,landformMode:'range',landformBase:0,landformPeak:48,landformSlope:1,landformSize:48,landformRoughness:25,landformDetail:12,landformSeed:1337,landformRandom:false,landformPreviewFirst:false,connected:true,continued:false,grid:true,selectionOutline:true,zoom:4,zoomTarget:4,offsetX:32,offsetY:32,bindings:{...DEFAULT_SHORTCUTS}};
  const selectionTools=new Set(['wand','pixel','rectangle','ellipse','freehand']);
  state.blurRadius=4;state.blurStrength=50;state.blurSize=32;state.meltWidth=8;
  const smoothingFields=[['blur-radius','blurRadius',1,64],['blur-strength','blurStrength',1,100],['blur-size','blurSize',1,256],['melt-width','meltWidth',1,128]];
  Object.assign(state,{distortRoughness:3,distortScale:24,distortEdgeFade:8,distortSeed:1337,distortRandom:false,distortProtectRoads:true});
  const distortFields=[['distort-roughness','distortRoughness',0,64],['distort-scale','distortScale',2,256],['distort-edge-fade','distortEdgeFade',1,64],['distort-seed','distortSeed',0,4294967295]];
  Object.assign(state,{roadStart:0,roadEnd:32,roadWidth:1,roadCurvature:50,roadSpacing:16,roadShoulderWidth:2,roadShoulderRise:2,roadLeftRise:20,roadRightRise:20});
  const roadFields=[['road-start','roadStart',-128,127,'startZ'],['road-end','roadEnd',-128,127,'endZ'],['road-width','roadWidth',1,64,'width'],['road-curvature','roadCurvature',0,100,'curvature'],['road-spacing','roadSpacing',4,128,'spacing'],['road-shoulder-width','roadShoulderWidth',0,64,'shoulderWidth'],['road-shoulder-rise','roadShoulderRise',-128,127,'shoulderRise'],['road-left-rise','roadLeftRise',-128,127,'leftRise'],['road-right-rise','roadRightRise',-128,127,'rightRise']];
  Object.assign(state,{flattenZ:0,flattenWidth:1,flattenLeftReach:16,flattenRightReach:16,flattenProfile:'auto',flattenSample:true});
  const flattenFields=[['flatten-z','flattenZ',-128,127,'flatZ'],['flatten-width','flattenWidth',1,64,'width'],['flatten-left-reach','flattenLeftReach',1,128,'leftReach'],['flatten-right-reach','flattenRightReach',1,128,'rightReach']];
  const flattenProfiles=['auto','high-flat-low','high-flat-high','low-flat-high'];
  const heldSideButtons=new Set(),suppressSideAux=new Set();
  let doc=new MapPaintDocument(1448,1448,materials), name='Untitled map', dirty=false, pendingReplace=null;
  let decoMode=false,decoVisible=true,decoDrag=null,decoPrimary=1,decoSecondary=45;
  const decoEntries=window.DecoPalette.entries,decoById=new Map(decoEntries.map(e=>[e.id,e]));
  let drag=null, renderQueued=false, cursor={x:0,y:0,visible:false}, importLayer='terrain';
  let isBusy=false, zoomAnimation=null, zoomFrame=0, viewportSize=null;
  let saveDirectory=null;
  let spaceHeld=false,hoveredSurface=null,selectionHintMask=null,selectionHintRevision=-1,selectionHintEmpty=false;
  let snapshotDocument=null,snapshotListRevision=-1,snapshotEntries=[],selectedSnapshotId=null;
  let snapshotMatchId=null,snapshotMatchRevision=-1,snapshotMatches=false;
  let landformPreview=null,landformJob=null,rampPreview=null;
  let smoothingPreview=null,smoothingJob=null,blurPreview=null;
  let selectionStrokePreview=null;
  let roadSession=null,roadPreview=null,selectedRoadHandle=null,roadHandleSignature='',roadPreviewError='';
  let flattenSession=null,flattenPreview=null,flattenPreviewError='';
  let protectedRoadMask=null;
  let altitudeTarget='z',altitudePaletteSignature='',altitudePaletteSelection='';
  const altitudeButtons=[];
  // Put the active tool's controls first; palette colors stay independent.
  el('tool-title').after(el('height-panel'),el('gradient-panel'),el('path-panel'),el('ramp-panel'),el('road-panel'),el('flatten-panel'),el('blur-panel'),el('landform-panel'));
  el('color-slots').after(el('terrain-panel'));
  const landformFields=[['landform-base','landformBase',-128,127,1],['landform-peak','landformPeak',-128,127,1],['landform-slope','landformSlope',.1,8,0],['landform-size','landformSize',1,8192,1],['landform-roughness','landformRoughness',0,100,1],['landform-detail','landformDetail',1,8192,1],['landform-seed','landformSeed',0,4294967295,1]];
  const pathFields=[['path-height','pathHeight',-128,127,1],['path-edge','pathEdge',-128,127,1]];
  const canPickSaveFolder=()=>window.isSecureContext&&typeof window.showDirectoryPicker==='function';
  const colorTable=new Uint32Array(65536);
  for(const m of materials)colorTable[m.id]=(0xff000000|(m.b<<16)|(m.g<<8)|m.r)>>>0;
  function status(text){el('status').textContent=text;el('error').textContent='';}
  function error(err){el('error').textContent=String(err.message||err);}
  function idle(){return !drag&&!decoDrag&&!isBusy;}
  function safely(action){try{const result=action();if(result&&typeof result.catch==='function')result.catch(error);return result;}catch(err){error(err);}}
  function value(){return doc.currentLayer==='terrain'?state.material:state.z+128;}
  function slotKey(layer=doc.currentLayer,slot=state[layer+'Slot']){return layer==='terrain'?(slot==='secondary'?'secondaryMaterial':'material'):(slot==='secondary'?'secondaryZ':'z');}
  function slotValue(layer,slot){const chosen=state[slotKey(layer,slot)];return layer==='altitude'?chosen+128:chosen;}
  function viewLayer(canvas){return state.layout==='single'?doc.currentLayer:canvas===altitudeSurface?'altitude':'terrain';}
  function activeSurface(layer=doc.currentLayer){return state.layout!=='single'&&layer==='altitude'?altitudeSurface:surface;}
  function visibleSurfaces(){return state.layout==='single'?[surface]:surfaces;}
  function viewportBounds(){const sizes=visibleSurfaces().map(canvas=>canvas.getBoundingClientRect());return {width:Math.min(...sizes.map(r=>r.width)),height:Math.min(...sizes.map(r=>r.height))};}
  function point(e,canvas=e.currentTarget){const r=canvas.getBoundingClientRect();return {x:Math.floor((e.clientX-r.left-state.offsetX)/state.zoom),y:Math.floor((e.clientY-r.top-state.offsetY)/state.zoom)};}
  function inside(p){return p.x>=0&&p.y>=0&&p.x<doc.width&&p.y<doc.height;}
  function bounded(p){return {x:Math.max(0,Math.min(doc.width-1,p.x)),y:Math.max(0,Math.min(doc.height-1,p.y))};}
  function docToScreen(x,y,layer=doc.currentLayer){const r=activeSurface(layer).getBoundingClientRect();return {x:r.left+state.offsetX+(x+.5)*state.zoom,y:r.top+state.offsetY+(y+.5)*state.zoom};}
  const rainbowFrames=new Map();
  function rainbowColor(position,time){
    const hue=((position/96-time/2400)%1+1)%1,light=.52+.1*Math.sin(position/23-time/350),a=Math.min(light,1-light);
    const channel=n=>{const k=(n+hue*12)%12;return Math.round(255*(light-a*Math.max(-1,Math.min(k-3,9-k,1))));};return [channel(0),channel(8),channel(4)];
  }
  function rainbowStroke(ctx,x,y,size,time){
    const span=Math.max(6,size),g=ctx.createLinearGradient(x,y,x+span,y+span);
    for(let i=0;i<=24;i++)g.addColorStop(i/24,'rgb('+rainbowColor(i*96/24,time).join(',')+')');return g;
  }
  setInterval(()=>{if(document.hidden)return;const time=performance.now();for(const canvas of visibleSurfaces()){const f=rainbowFrames.get(canvas);if(f&&f.active)f.draw(time);}},60);
  function requestRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;render();});}
  function displayValue(x,y,layer,data){const source=flattenPreview||roadPreview||blurPreview||smoothingPreview||rampPreview||landformPreview,preview=source&&source.valueAt(x,y,layer);return preview===undefined||preview===null?data[y*doc.width+x]:preview;}
  // View-only pixel grid. Soft Gaussian line coverage fades at low magnification;
  // at 4x, each line locks to the first screen pixel of its real source cell.
  function gridCoverage(coordinate,offset,z){
    if(!state.grid||z<=.75)return 0;
    if(z>=4)return Math.floor((coordinate-offset)/z)!==Math.floor((coordinate-1-offset)/z)?1:0;
    const phase=((coordinate-offset)%z+z)%z,distance=Math.min(phase,z-phase),sigma=.35+(4-z)*.22;
    return Math.exp(-distance*distance/(2*sigma*sigma))*Math.min(1,(z-.75)/3.25);
  }
  function render(){for(const canvas of visibleSurfaces())renderView(canvas,viewLayer(canvas));renderOverview();}
  function renderOverview(){
    const bounds=overview.getBoundingClientRect();if(bounds.width<=0||bounds.height<=0)return;
    const size=Math.max(17,Math.round(bounds.width));if(overview.width!==size)overview.width=size;if(overview.height!==size)overview.height=size;
    const frame=overviewGeometry.layout(doc.width,doc.height,size),data=doc.activeData;
    const image=overviewCtx.createImageData(size,size),pixels=new Uint32Array(image.data.buffer);pixels.fill(0xff000000);
    // Sample directly into the fixed thumbnail; never allocate a full-map RGBA
    // buffer or resample either editable image just to draw its overview.
    // Include raster cells touched by a subpixel-thin map, then clamp the
    // sample. A valid wide/short map must not fall between all pixel centers.
    for(let y=Math.floor(frame.top);y<Math.ceil(frame.top+frame.height);y++){
      const my=Math.max(0,Math.min(doc.height-1,Math.floor((y+.5-frame.top)/frame.scale)));
      for(let x=Math.floor(frame.left);x<Math.ceil(frame.left+frame.width);x++){
        const mx=Math.max(0,Math.min(doc.width-1,Math.floor((x+.5-frame.left)/frame.scale)));
        const v=displayValue(mx,my,doc.currentLayer,data);if(v===UNSET)continue;
        pixels[y*size+x]=doc.currentLayer==='terrain'?colorTable[v]:(0xff000000|(v<<16)|(v<<8)|v)>>>0;
      }
    }
    overviewCtx.putImageData(image,0,0);overviewCtx.save();
    // Put the frame outside the sampled cells, including maps thinner than one
    // preview pixel; fractional borders would otherwise cover their colors.
    overviewCtx.strokeStyle='#71849a';overviewCtx.lineWidth=1;overviewCtx.strokeRect(Math.floor(frame.left)-.5,Math.floor(frame.top)-.5,Math.ceil(frame.left+frame.width)-Math.floor(frame.left)+1,Math.ceil(frame.top+frame.height)-Math.floor(frame.top)+1);
    const view=viewportBounds(),visible=overviewGeometry.viewport(doc.width,doc.height,state.zoom,state.offsetX,state.offsetY,view.width,view.height,size);
    if(visible){overviewCtx.beginPath();overviewCtx.rect(frame.left,frame.top,frame.width,frame.height);overviewCtx.clip();
      overviewCtx.strokeStyle='#000';overviewCtx.lineWidth=3;overviewCtx.strokeRect(visible.x,visible.y,visible.width,visible.height);
      overviewCtx.strokeStyle='#70e7ff';overviewCtx.lineWidth=1;overviewCtx.strokeRect(visible.x,visible.y,visible.width,visible.height);
    }
    overviewCtx.restore();
  }
  function renderView(canvas,layer){
    const ctx=contexts.get(canvas),r=canvas.getBoundingClientRect(),w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));
    if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
    const edges=[];const image=ctx.createImageData(w,h),out=new Uint32Array(image.data.buffer),data=doc[layer];
    const showSelection=state.selectionOutline&&(selectionStrokePreview?selectionStrokePreview.selectionActive:doc.selectionActive)&&state.zoom>=2,s=doc.selection;
    const selectedAt=(x,y)=>x>=0&&y>=0&&x<doc.width&&y<doc.height&&(selectionStrokePreview?selectionStrokePreview.selectedAt(x,y):s[y*doc.width+x]===1);
    const xx=new Int32Array(w),gx=new Float32Array(w);for(let x=0;x<w;x++){xx[x]=Math.floor((x-state.offsetX)/state.zoom);gx[x]=gridCoverage(x,state.offsetX,state.zoom);}
    for(let y=0;y<h;y++){
      const dy=Math.floor((y-state.offsetY)/state.zoom),row=dy*doc.width,gy=gridCoverage(y,state.offsetY,state.zoom);
      const above=Math.floor((y-1-state.offsetY)/state.zoom),below=Math.floor((y+1-state.offsetY)/state.zoom);
      for(let x=0;x<w;x++){
        const dx=xx[x],at=y*w+x;
        if(dx<0||dy<0||dx>=doc.width||dy>=doc.height){out[at]=0xff0000ff;continue;}
        const v=displayValue(dx,dy,layer,data);
        if(v===UNSET)out[at]=0xff000000;
        else out[at]=layer==='terrain'?colorTable[v]:(0xff000000|(v<<16)|(v<<8)|v)>>>0;
        if(layer==='terrain'&&decoVisible&&doc.deco[row+dx]!==UNSET){const entry=decoById.get(doc.deco[row+dx]),rgb=entry?entry.rgb:[255,255,255];out[at]=(0xff000000|(rgb[2]<<16)|(rgb[1]<<8)|rgb[0])>>>0;}
        const coverage=Math.max(gx[x],gy);
        if(coverage>0){const color=out[at],r=color&255,g=(color>>>8)&255,b=(color>>>16)&255;
          const ink=v===UNSET?160:(r*.299+g*.587+b*.114<128?255:0),alpha=coverage*(v===UNSET?1:.2);
          out[at]=(0xff000000|(Math.round(b+(ink-b)*alpha)<<16)|(Math.round(g+(ink-g)*alpha)<<8)|Math.round(r+(ink-r)*alpha))>>>0;
        }
        // The guide occupies only UNSELECTED screen pixels. It never lays a
        // pale antialiased stroke over the inside edge of the selected artwork.
        if(showSelection&&!selectedAt(dx,dy)&&((x+y)&7)<5){
          const left=x?xx[x-1]:Math.floor((-1-state.offsetX)/state.zoom),right=x+1<w?xx[x+1]:Math.floor((w-state.offsetX)/state.zoom);
          if((left!==dx&&selectedAt(left,dy))||(right!==dx&&selectedAt(right,dy))||(above!==dy&&selectedAt(dx,above))||(below!==dy&&selectedAt(dx,below)))edges.push(at);
        }
      }
    }
    const drawGuides=time=>{
    for(const at of edges){const c=rainbowColor(at%w+Math.floor(at/w),time);out[at]=(0xff000000|(c[2]<<16)|(c[1]<<8)|c[0])>>>0;}
    ctx.putImageData(image,0,0);ctx.imageSmoothingEnabled=false;
    const z=state.zoom,ox=state.offsetX,oy=state.offsetY;
    ctx.save();ctx.strokeStyle='#ececec';ctx.lineWidth=1;ctx.strokeRect(ox-.5,oy-.5,doc.width*z+1,doc.height*z+1);
    if(drag&&drag.kind==='freehand'){ctx.save();ctx.beginPath();drag.points.forEach((p,i)=>{if(i)ctx.lineTo(ox+(p.x+.5)*z,oy+(p.y+.5)*z);else ctx.moveTo(ox+(p.x+.5)*z,oy+(p.y+.5)*z);});ctx.closePath();ctx.fillStyle='rgba(80,190,255,.15)';ctx.fill('evenodd');ctx.strokeStyle=rainbowStroke(ctx,ox,oy,150,time);ctx.lineWidth=1.5;ctx.stroke();ctx.restore();}
    if(drag&&['rectangle','ellipse'].includes(drag.kind)&&drag.last){ctx.save();ctx.setLineDash([4,3]);const a=drag.start,b=drag.last,l=ox+Math.min(a.x,b.x)*z,t=oy+Math.min(a.y,b.y)*z,rw=(Math.abs(a.x-b.x)+1)*z,rh=(Math.abs(a.y-b.y)+1)*z;ctx.strokeStyle=rainbowStroke(ctx,l,t,Math.max(rw,rh),time);ctx.lineWidth=1.5;if(drag.kind==='ellipse'){ctx.beginPath();ctx.ellipse(l+rw/2,t+rh/2,rw/2,rh/2,0,0,Math.PI*2);ctx.stroke();}else ctx.strokeRect(l,t,rw,rh);ctx.restore();}
    if(drag&&drag.kind==='landform'&&['ridge','path'].includes(drag.options.mode)){ctx.strokeStyle='#70e7ff';ctx.lineWidth=2;ctx.setLineDash([5,3]);ctx.beginPath();for(let i=0;i<drag.points.length;i++){const p=drag.points[i];ctx[i?'lineTo':'moveTo'](ox+(p.x+.5)*z,oy+(p.y+.5)*z);}ctx.stroke();ctx.setLineDash([]);}
    if(roadSession&&layer==='altitude')renderRoadGuides(ctx);
    if(flattenSession&&layer==='altitude')renderRoadGuides(ctx,flattenSession,false);
    if(cursor.visible){ctx.save();ctx.strokeStyle=rainbowStroke(ctx,ox+cursor.x*z,oy+cursor.y*z,state.tool==='blur'?state.blurSize*z:z,time);ctx.lineWidth=1.5;if(state.tool==='blur'&&layer==='altitude'){ctx.beginPath();ctx.arc(ox+(cursor.x+.5)*z,oy+(cursor.y+.5)*z,state.blurSize*z/2,0,Math.PI*2);ctx.stroke();}else ctx.strokeRect(ox+cursor.x*z+.5,oy+cursor.y*z+.5,Math.max(1,z-1),Math.max(1,z-1));ctx.restore();}
    ctx.restore();
    };
    rainbowFrames.set(canvas,{active:cursor.visible||edges.length>0||!!(drag&&['rectangle','ellipse','freehand'].includes(drag.kind)),draw:drawGuides});
    drawGuides(performance.now());
  }
  el('simple-filter').addEventListener('change',()=>{el('simple-filter-controls').hidden=!el('simple-filter').value;const kind=el('simple-filter').value,terraces=kind==='housing-terraces',edges=['flatten-edges','smooth-boundaries','water-banks'].includes(kind),water=kind==='water-banks';const city=kind==='city'||kind==='city-whole'||kind==='house-sites',deco=kind==='deco-housing'||kind==='deco-patch'||kind==='deco-whole'||kind==='deco-walls'||kind==='city-level';el('deco-gen-controls').hidden=!deco||kind==='deco-walls'||kind==='city-level';el('deco-gen-radius').parentElement.hidden=kind==='deco-whole'||kind==='deco-housing';el('deco-gen-walls').parentElement.hidden=kind==='deco-housing';el('deco-gen-repair').parentElement.hidden=kind==='deco-housing';el('terrace-controls').hidden=!terraces;el('city-controls').hidden=!city;el('city-material').hidden=kind==='house-sites';const growth=kind==='growth',consumption=kind==='consumption'||growth;el('growth-controls').hidden=!growth;el('consumption-controls').hidden=!consumption;el('simple-filter-strength-label').hidden=edges||consumption||city||deco||terraces;el('edge-flatten-controls').hidden=!edges;el('boundary-blend-controls').hidden=!water;el('boundary-width-label').textContent=water?'Flat bank':kind==='smooth-boundaries'?'Each side':'Width';el('boundary-filter-note').hidden=!(edges||consumption||city||deco||terraces);el('boundary-filter-note').textContent=kind==='deco-housing'?'Swamp/snow plants on flats and slopes. Trees/rocks stay off flat cells + one tile clearance; existing trees/rocks there are removed. Compatible plants preserved. Respects selection. Terrain/heights unchanged.':terraces?'Dense flat pads across every selected height (whole map if no selection). No site screening or count limit. Terrain/deco unchanged. Pad edges and selection cutouts may slope; interiors are flat.':kind==='house-sites'?'Scatters flat house sites inside selection (whole map if none). Min/max are tile widths and lengths. Terrain and decorations unchanged; occupied sites skipped. One Undo.':kind==='city-level'?'Levels complete existing plot foundations and all outer tile vertices. Terrain and decorations unchanged. Respects selection.':kind==='deco-walls'?'Complete stone paver / red brick rectangles in selection (or whole map). Flat foundations only. Existing conflicts skipped.':deco?(kind==='deco-whole'?'Whole map: ignores selection. Strict terrain trees; checked repair corrects old trees. Optional stone walls.':'One seeded patch inside selection (or map). Strict terrain trees; checked repair corrects old trees. Optional stone walls.'):kind==='city-whole'?'Whole map: ignores selection; Plots is the total across the map. Level sites + filled plots; outer edges blended. Existing scenery protected.':city?'Finds dry sites, levels foundations plus flat border, blends into surrounding ground, then paves plots. One Undo.':growth?'Grows small side-connected terrain patches inside selection. Altitude unchanged.':consumption?'Consumes small side-connected terrain patches into a larger surrounding color. Altitude unchanged.':water?'Levels selected water; extends banks outside the water selection. Terrain unchanged.':kind==='smooth-boundaries'?'Smooths altitude within each touching color. Terrain unchanged.':'Extends lower heights inside selection. Terrain unchanged.';});
  el('simple-filter-strength').addEventListener('input',()=>{el('simple-filter-value').textContent=el('simple-filter-strength').value+'%';});
  el('simple-filter-apply').addEventListener('click',()=>safely(async()=>{if(!idle())return;if(roadSession||flattenSession||smoothingPreview||landformPreview)throw new Error('Apply or Cancel the pending preview first.');const kind=el('simple-filter').value;if(!kind)return;if(kind==='housing-terraces'){const options={min:Number(el('terrace-min').value),max:Number(el('terrace-max').value),seed:Number(el('terrace-seed').value)};isBusy=true;status('Flattening housing terraces…');syncUI();try{await new Promise(resolve=>setTimeout(resolve,50));const r=doc.createHousingTerraces(options);edited(r,'Housing terraces — '+r.pads.toLocaleString()+' pads; '+r.pixels.toLocaleString()+' selected height pixels covered; '+r.partialPads.toLocaleString()+' clipped pads');}finally{isBusy=false;syncUI();requestRender();}return;}if(kind==='posterize'){const strength=Number(el('simple-filter-strength').value);isBusy=true;status('Posterizing altitude and preparing Undo… Large maps may take several seconds.');syncUI();try{await new Promise(resolve=>setTimeout(resolve,50));edited(doc.applySimpleFilter(kind,strength),'Posterize');}finally{isBusy=false;syncUI();requestRender();}return;}if(kind==='city-level'){const r=doc.levelCityFoundations();edited(r,'Foundations — '+r.leveled+' leveled; '+r.plots+' verified flat; '+r.skipped+' skipped');return;}if(kind==='deco-housing'||kind==='deco-patch'||kind==='deco-whole'||kind==='deco-walls'){const options={housingSafe:kind==='deco-housing',scope:kind==='deco-whole'?'whole':'patch',wallsOnly:kind==='deco-walls',walls:el('deco-gen-walls').checked,repairTrees:el('deco-gen-repair').checked};for(const key of ['radius','density','plants','spacing','seed'])options[key]=Number(el('deco-gen-'+key).value);isBusy=true;status('Generating decorations and preparing Undo… Whole Felucca maps may take several seconds.');syncUI();let result;try{await new Promise(resolve=>setTimeout(resolve,50));result=doc.generateDecorations(options);}finally{isBusy=false;syncUI();requestRender();}decoVisible=true;el('deco-visible').checked=true;edited(result,kind==='deco-housing'?'Swamp/snow — '+result.added+' added; '+result.cleared+' cleared; '+result.protectedCells+' flat/clearance pixels protected':'Decorate — '+result.placements+' changes; '+result.repaired+' trees corrected; '+result.wallPlots+' plots walled; '+result.skippedPlots+' plots skipped');return;}if(kind==='city'||kind==='city-whole'||kind==='house-sites'){const options={scope:kind==='city-whole'?'whole':'patch',altitudeOnly:kind==='house-sites'};for(const key of ['count','min','max','gap','relief','seed','material','siteBorder','siteBlend'])options[key]=Number(el('city-'+key).value);isBusy=true;status('Preparing flat sites…');syncUI();try{await new Promise(resolve=>setTimeout(resolve,50));const result=doc.createCityPlots(options);edited(result,(options.altitudeOnly?'Flat house sites — ':'City plots — ')+result.plots+' placed; sites leveled and edges blended');}finally{isBusy=false;syncUI();requestRender();}return;}if(kind==='growth'){edited(doc.growTerrainPatches(Number(el('consumption-limit').value),Number(el('growth-radius').value)),'Growth — terrain expanded; altitude unchanged');return;}if(kind==='consumption'){const result=doc.consumeTerrainPatches(Number(el('consumption-limit').value));edited(result,'Consumption — '+result.consumedPatches+' patches removed; altitude unchanged');return;}if(kind==='smooth-boundaries'||kind==='water-banks'){edited(doc.applyTerrainBoundaryFilter(kind,Number(el('edge-flatten-width').value),Number(el('boundary-blend-width').value)),kind==='water-banks'?'Flatten water + smooth banks — altitude only':'Smooth terrain boundaries — altitude only');return;}if(kind==='flatten-edges')edited(doc.flattenTerrainEdges(Number(el('edge-flatten-width').value)),'Flatten terrain edges — altitude only');else edited(doc.applySimpleFilter(kind,Number(el('simple-filter-strength').value)),'Filter');}));
  function syncPendingShape(){
    const pending=!!(roadSession&&!roadSession.drawing||flattenSession&&!flattenSession.drawing);el('pending-shape').hidden=!pending;
    el('pending-shape-label').textContent=(roadSession?'Road':'Flatten')+' preview — Apply to update both linked images';
    el('pending-shape-apply').disabled=!idle()||!(roadPreview||flattenPreview);el('pending-shape-cancel').disabled=!idle();
  }
  el('pending-shape-apply').addEventListener('click',()=>safely(()=>roadSession?applyRoadPreview():applyFlattenPreview()));
  el('pending-shape-cancel').addEventListener('click',()=>{if(idle()){if(roadSession)cancelRoadPreview();else cancelFlattenPreview();}});
  function syncUI(){syncPendingShape();
    el('save-project').disabled=!idle()||!!smoothingPreview||!!roadSession||!!flattenSession;el('save-map-images').disabled=!idle()||!!smoothingPreview||!!roadSession||!!flattenSession;el('download-map-images').disabled=!idle()||!!smoothingPreview||!!roadSession||!!flattenSession;el('save-location').disabled=!idle()||!canPickSaveFolder();
    el('generate-images').disabled=!idle();
    if(doc.currentLayer!=='altitude'&&altitudeTools.has(state.tool))state.tool='pencil';
    el('map-views').dataset.layout=state.layout;el('altitude-view').hidden=state.layout==='single';
    el('view-layout').value=state.layout;el('view-layout').disabled=!idle();
    el('fit-pixels').disabled=!idle();
    overview.setAttribute('aria-label',(doc.currentLayer==='terrain'?'Terrain':'Altitude')+' map overview. Click or drag to move both views. Arrow keys pan; Home centers the map.');overview.setAttribute('aria-disabled',String(!idle()));
    const primaryLayer=state.layout==='single'?doc.currentLayer:'terrain';
    for(const [pane,button,layer]of [[el('primary-view'),el('primary-view-title'),primaryLayer],[el('altitude-view'),el('altitude-view-title'),'altitude']]){
      const active=doc.currentLayer===layer;pane.dataset.active=String(active);button.setAttribute('aria-pressed',String(active));button.disabled=!idle();button.textContent=(layer==='terrain'?(decoMode?'Deco layer over terrain':'Terrain image'):'Altitude image')+(active?' · Editing':' · Click to edit');
    }
    surface.setAttribute('aria-label',(primaryLayer==='terrain'?'Terrain':'Altitude')+' map image canvas. Arrow keys move one pixel; Enter uses the selected tool.');
    el('document-title').textContent=name+(dirty?' • edited':'');el('dimensions').textContent=doc.width+' × '+doc.height+' cells';
    el('layer').value=doc.currentLayer;el('terrain-panel').hidden=doc.currentLayer!=='terrain';el('height-panel').hidden=doc.currentLayer!=='altitude'||altitudeTools.has(state.tool);
    syncColorSlots();syncAltitudePalette();
    el('gradient-panel').hidden=state.tool!=='gradient'||doc.currentLayer!=='altitude';
    el('path-panel').hidden=state.tool!=='path'||doc.currentLayer!=='altitude';
    el('ramp-panel').hidden=state.tool!=='ramp'||doc.currentLayer!=='altitude';
    syncRoadUI();
    syncFlattenUI();
    el('blur-panel').hidden=state.tool!=='blur'||doc.currentLayer!=='altitude';
    for(const [id,key]of smoothingFields){const field=el(id);if(document.activeElement!==field&&Number.isInteger(field.valueAsNumber)&&field.validity.valid)field.value=state[key];field.disabled=!idle();}
    for(const [id,key]of distortFields){const field=el(id);if(document.activeElement!==field&&Number.isInteger(field.valueAsNumber)&&field.validity.valid)field.value=state[key];field.disabled=!idle();}
    el('distort-random').checked=state.distortRandom;el('distort-random').disabled=!idle();el('distort-protect-roads').checked=state.distortProtectRoads;el('distort-protect-roads').disabled=!idle()||!protectedRoadMask;el('distort-preview').disabled=!idle()||!doc.selectionActive;
    el('blur-selection').disabled=!idle();el('blur-selection').textContent=doc.selectionActive?'Blur selection':'Blur image';el('melt-edges').disabled=!idle()||!doc.selectionActive;
    el('smoothing-apply').disabled=el('smoothing-cancel').disabled=!idle()||!smoothingPreview;
    el('smoothing-note').textContent=blurPreview?'Brush preview. Release to apply; Esc discards it.':smoothingPreview?(smoothingPreview.mode==='distort'?'Bumps / gullies · Seed '+smoothingPreview.options.seed:smoothingPreview.mode==='melt'?'Melt edges':'Blur selection')+' preview. Apply or Cancel before saving.'+(smoothingPreview.clippedPixels?' '+smoothingPreview.clippedPixels.toLocaleString()+' pixels reached the altitude limits.':''):'Filters preview first. Outside the selection stays unchanged.';
    for(const [id,key]of [['ramp-start','z'],['ramp-end','secondaryZ'],['ramp-size','size']]){if(document.activeElement!==el(id))el(id).value=state[key];el(id).disabled=!idle();}
    el('landform-panel').hidden=state.tool!=='mountain'||doc.currentLayer!=='altitude';
    el('landform-mode').value=state.landformMode;el('landform-mode').disabled=!idle();
    for(const [id,key]of [...landformFields,...pathFields]){if(document.activeElement!==el(id))el(id).value=state[key];el(id).disabled=!idle();}
    for(const [id,key]of [['landform-random','landformRandom'],['landform-preview-first','landformPreviewFirst']]){el(id).checked=state[key];el(id).disabled=!idle();}
    el('landform-size-label').textContent=state.landformMode==='ridge'?'Ridge width (px)':'Feature size (px)';
    el('landform-instructions').textContent=state.landformMode==='range'?'Click to replace selected heights with seeded mountain ranges, valleys and broad lowlands. No selection uses the whole map.':state.landformMode==='ridge'?'Select an area. Drag a ridge line inside it in the altitude image, then release. Esc cancels.':'Select an area, then click inside it in the altitude image. Only that connected selected area changes.';
    const pathPreview=landformPreview&&landformPreview.options.mode==='path';
    el('landform-preview-controls').hidden=!landformPreview||pathPreview;el('landform-apply').disabled=!landformPreview||!idle();el('landform-cancel').disabled=!landformPreview||!idle();
    el('landform-preview-note').textContent=landformPreview&&!pathPreview?'Preview only · Seed '+landformPreview.seed+'. Images are unchanged until Apply. Esc cancels.':'';
    el('path-preview-first').checked=state.pathPreviewFirst;el('path-preview-first').disabled=!idle();
    el('path-preview-controls').hidden=!pathPreview;el('path-apply').disabled=el('path-cancel').disabled=!pathPreview||!idle();
    el('path-preview-note').textContent=pathPreview?'Preview only. Images are unchanged until Apply. Esc cancels.':'';
    el('gradient-edge').value=state.gradientEdge;el('gradient-center').value=state.gradientCenter;el('grid-visible').checked=state.grid;el('selection-visible').checked=state.selectionOutline;
    el('grid-status').textContent=(state.grid?(state.zoom>=4?'Grid: single pixels':state.zoom>.75?'Grid: soft pixel edges':'Grid: faded below pixel detail'):'Grid off')+' · Red = outside map';
    const pickedZ=state[slotKey('altitude')];if(document.activeElement!==el('height'))el('height').value=pickedZ;el('height-label').textContent=(state.altitudeSlot==='secondary'?'Secondary':'Primary')+' height Z';el('brush-size').value=state.size;el('connected').checked=state.connected;
    el('match-surroundings').checked=state.matchSurroundings;el('match-surroundings').disabled=state.connected||!idle();el('continued').checked=state.continued;el('continued').disabled=!state.connected||!idle();el('connected').disabled=!idle();
    if(selectionHintMask!==doc.selection||selectionHintRevision!==doc.selectionRevision){selectionHintMask=doc.selection;selectionHintRevision=doc.selectionRevision;selectionHintEmpty=doc.selectionActive&&doc.selection.indexOf(1)===-1;}
    const selectionButtons=state.tool==='pixel'?'Left/right drag: add · Ctrl + right-drag: remove.':'Left: replace · Right: add · Ctrl + right: remove.';
    el('selection-note').textContent=selectionStrokePreview?'Selection preview · Release to apply · Esc: cancel drag.':doc.selectionActive?(selectionHintEmpty?'Selection is empty. Add pixels or Deselect to paint freely.':state.selectionOutline?selectionButtons+' Esc: cancel drag.':'Selection edge hidden. '+selectionButtons):'No selection: painting is unrestricted. Left or right starts one; Ctrl + right removes only an existing selection.';
    if(document.activeElement!==el('selection-pixels'))el('selection-pixels').value=state.selectionPixels;
    el('expand-selection').disabled=el('contract-selection').disabled=!doc.selectionActive||!idle();el('selection-pixels').disabled=!idle();
    syncSelectionSnapshots();
    el('shade-value').textContent=(state.altitudeSlot==='secondary'?'Secondary':'Primary')+' · Shade '+(pickedZ+128)+' · RGB '+Array(3).fill(pickedZ+128).join(', ');
    el('tool-title').textContent=toolNames[state.tool].toUpperCase();
    root.querySelectorAll('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===state.tool)));
    root.querySelectorAll('[data-key]').forEach(b=>b.textContent=state.bindings[b.dataset.key]||'—');
    const pickedMaterial=state[slotKey('terrain')];root.querySelectorAll('[data-material]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.material)===pickedMaterial)));
    const m=byId.get(state.material),picked=byId.get(pickedMaterial);el('material-note').textContent=picked?(state.terrainSlot==='secondary'?'Secondary':'Primary')+' · '+picked.name+' · '+picked.rgb+' · Material '+picked.id:'';
    el('linked-painting').checked=state.linkedPainting;el('linked-painting').disabled=!idle();
    const hex=n=>'#'+n.toString(16).padStart(6,'0').toUpperCase();
    let linkNote='Independent painting. Enable to update matching pixels in both images.';
    if(state.linkedPainting){
      if(state.tool==='eraser')linkNote='Erase clears matching pixels in both images.';
      else if(doc.currentLayer==='terrain'){const shade=paintLink.terrainToAltitude[state.material];linkNote=m.name+' '+m.rgb.toUpperCase()+' → Altitude '+hex(shade*0x010101)+' (Z '+(shade-128)+').';}
      else if(altitudeTools.has(state.tool))linkNote='Terrain updates when applied using the nearest HTML color code.';
      else{const shade=state.z+128,match=byId.get(paintLink.altitudeToTerrain[shade]);linkNote='Altitude '+hex(shade*0x010101)+' (Z '+state.z+') → '+match.name+' '+match.rgb.toUpperCase()+'.';}
    }
    el('paint-link-note').textContent=linkNote;
    const duplicate=palette.duplicateColors.some(d=>d.materialIds.includes(pickedMaterial));
    if(duplicate)el('material-note').textContent+=' · Shared legacy color: use project save to keep this material ID.';
    el('undo').disabled=(!doc.canUndo&&!roadSession&&!flattenSession)||!idle();el('redo').disabled=!doc.canRedo||!idle();
    el('layer-status').textContent=(doc.currentLayer==='terrain'?'Terrain material colors':'Altitude: Z = gray shade − 128')+' · '+Math.round(doc.historyBytes/1048576)+' MB undo history';
    for(const canvas of surfaces)canvas.style.cursor=drag&&drag.kind==='pan'?'grabbing':spaceHeld?'grab':state.tool==='eyedropper'?'copy':'crosshair';
    let option=Array.from(el('zoom').options).find(o=>Math.abs(Number(o.value)-state.zoom)<1e-7);
    if(!option){option=el('zoom').querySelector('[data-fit]')||new Option();option.dataset.fit='true';option.value=state.zoom;option.textContent=(state.zoom*100).toFixed(1)+'%';if(!option.parentNode)el('zoom').add(option);}
    el('zoom').value=option.value;
  }
  function syncSelectionSnapshots(){
    const list=el('selection-snapshot-list'),field=el('selection-snapshot-name');
    if(snapshotDocument!==doc){snapshotDocument=doc;snapshotListRevision=-1;snapshotEntries=[];selectedSnapshotId=null;snapshotMatchId=null;snapshotMatchRevision=-1;field.value='';}
    if(snapshotListRevision!==doc.snapshotRevision){
      const previous=snapshotEntries.find(item=>item.id===selectedSnapshotId),scroll=list.scrollTop;
      snapshotEntries=doc.listSelectionSnapshots();snapshotListRevision=doc.snapshotRevision;
      const selected=snapshotEntries.find(item=>item.id===selectedSnapshotId);
      if(!selected){selectedSnapshotId=null;if(previous&&field.value===previous.name)field.value='';}
      else if(previous&&field.value===previous.name)field.value=selected.name;
      list.replaceChildren(...snapshotEntries.map(item=>new Option(item.name,String(item.id))));
      if(!snapshotEntries.length){const empty=new Option('No saved selections','');empty.disabled=true;list.add(empty);}
      list.value=selectedSnapshotId===null?'':String(selectedSnapshotId);list.scrollTop=scroll;
      snapshotMatchId=null;snapshotMatchRevision=-1;
    }
    const selected=snapshotEntries.find(item=>item.id===selectedSnapshotId);
    if(selected&&(snapshotMatchId!==selected.id||snapshotMatchRevision!==doc.selectionRevision)){
      snapshotMatches=doc.matchesSelectionSnapshot(selected.id);snapshotMatchId=selected.id;snapshotMatchRevision=doc.selectionRevision;
    }
    list.disabled=!idle()||!snapshotEntries.length;field.disabled=!idle();
    el('save-selection-snapshot').disabled=!idle()||!doc.selectionActive||selectionHintEmpty||!field.value.trim();
    el('rename-selection-snapshot').disabled=!idle()||!selected||!field.value.trim();
    el('delete-selection-snapshot').disabled=!idle()||!selected;
    el('selection-snapshot-status').textContent=selected?(snapshotMatches?'Current selection: '+selected.name+' · '+selected.selectedPixels.toLocaleString()+' pixels.':'Current selection differs. Saved “'+selected.name+'” is unchanged.'):(snapshotEntries.length?'Click a saved name to restore its exact selection.':!doc.selectionActive?'Select an area, give it a name, then save it.':selectionHintEmpty?'The selection is empty. Select some pixels before saving.':'Name this selection to keep its exact shape.');
  }
  function restoreSnapshotFromList(){
    if(!idle())return;const id=Number(el('selection-snapshot-list').value),entry=snapshotEntries.find(item=>item.id===id);if(!entry)return;
    selectedSnapshotId=id;el('selection-snapshot-name').value=entry.name;cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);
    // Native lists emit change, then click. Skip a second restore when that first
    // event already restored the exact mask; clicking the same row later still works.
    const matches=snapshotMatchId===id&&snapshotMatchRevision===doc.selectionRevision?snapshotMatches:doc.matchesSelectionSnapshot(id);
    if(!matches){const result=doc.restoreSelectionSnapshot(id);dirty=dirty||Boolean(result.changed);selectionHintMask=null;}
    status('Restored selection “'+entry.name+'”. Image pixels are unchanged.');syncUI();requestRender();
  }
  function saveSelectionSnapshot(){
    if(!idle())return;cancelLandformPreview(false);const result=doc.saveSelectionSnapshot(el('selection-snapshot-name').value);
    dirty=dirty||Boolean(result.changed);selectedSnapshotId=result.id;el('selection-snapshot-name').value=result.name;
    status('Saved selection “'+result.name+'”. Save project keeps it with your map.');syncUI();requestRender();
  }
  function renameSelectionSnapshot(){
    if(!idle()||selectedSnapshotId===null)return;cancelLandformPreview(false);const result=doc.renameSelectionSnapshot(selectedSnapshotId,el('selection-snapshot-name').value);
    dirty=dirty||Boolean(result.changed);el('selection-snapshot-name').value=result.name;status('Selection named “'+result.name+'”.');syncUI();requestRender();
  }
  function deleteSelectionSnapshot(){
    if(!idle()||selectedSnapshotId===null)return;cancelLandformPreview(false);const entry=snapshotEntries.find(item=>item.id===selectedSnapshotId),result=doc.deleteSelectionSnapshot(selectedSnapshotId);
    dirty=dirty||Boolean(result.changed);selectedSnapshotId=null;el('selection-snapshot-name').value='';status('Deleted saved selection “'+entry.name+'”. Undo restores it.');syncUI();requestRender();
  }
  el('selection-snapshot-name').addEventListener('input',syncSelectionSnapshots);
  for(const type of ['change','click'])el('selection-snapshot-list').addEventListener(type,()=>safely(restoreSnapshotFromList));
  el('selection-snapshot-list').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();safely(restoreSnapshotFromList);}});
  for(const [id,action]of [['save-selection-snapshot',saveSelectionSnapshot],['rename-selection-snapshot',renameSelectionSnapshot],['delete-selection-snapshot',deleteSelectionSnapshot]])el(id).addEventListener('click',()=>safely(action));
  function paletteList(){
    const search=el('terrain-search').value.toLowerCase();el('terrain-list').replaceChildren();
    for(const m of materials){if(search&&!m.name.toLowerCase().includes(search)&&String(m.id)!==search)continue;
      const b=document.createElement('button');b.className='material';b.dataset.material=m.id;b.type='button';b.setAttribute('aria-label',m.name+' material '+m.id);b.title='Left-click: Primary. Right-click: Secondary.';
      const swatch=document.createElement('span');swatch.style.background=m.rgb;b.append(swatch,document.createTextNode(m.name));
      if(palette.duplicateColors.some(d=>d.materialIds.includes(m.id))){const note=document.createElement('em');note.textContent='shared RGB';b.append(note);}
      bindPaletteColor(b,slot=>{if(!idle())return;cancelLandformPreview(false);state.terrainSlot=slot;state[slotKey('terrain',slot)]=m.id;syncUI();saveSettings();status((slot==='primary'?'Primary':'Secondary')+' terrain set to '+m.name+'.');});el('terrain-list').append(b);
    }syncUI();
  }
  function bindPaletteColor(button,assign){
    button.addEventListener('click',event=>{if(event.button===0)assign('primary');});
    button.addEventListener('auxclick',event=>{if(event.button===2)event.preventDefault();});
    // Cancel the original swatch's menu before changing any readout or layout.
    button.addEventListener('contextmenu',event=>{event.preventDefault();if(event.button===2)assign('secondary');});
  }
  // Keep context menus suppressed in gaps between palette swatches too.
  for(const id of ['terrain-list','altitude-palette'])el(id).addEventListener('contextmenu',event=>event.preventDefault());
  function syncColorSlots(){
    const layer=doc.currentLayer,active=state[layer+'Slot'];el('color-slots-title').textContent=layer==='terrain'?'TERRAIN COLORS':'ALTITUDE COLORS';
    for(const slot of ['primary','secondary']){
      const stored=state[slotKey(layer,slot)],material=layer==='terrain'?byId.get(stored):null;
      const color=material?material.rgb:'#'+(stored+128).toString(16).padStart(2,'0').repeat(3),label=slot==='primary'?'Primary':'Secondary';
      el(slot+'-color-swatch').style.background=color;el(slot+'-color-value').textContent=material?material.name:'Z '+stored;
      el(slot+'-color').setAttribute('aria-pressed',String(slot===active));el(slot+'-color').disabled=!idle();el(slot+'-color').setAttribute('aria-label',label+' '+layer+' color: '+(material?material.name+' '+material.rgb:'Z '+stored+', shade '+(stored+128))+'. Click to sample into this slot with Mouse 3.');
    }
    el('color-slot-note').textContent='Palette: left-click sets Primary; right-click sets Secondary. Mouse 3 samples into '+(active==='primary'?'Primary':'Secondary')+' '+layer+'. The other image keeps its own colors.';
  }
  function chooseColorSlot(slot){
    if(!idle()||!['primary','secondary'].includes(slot))return;
    state[doc.currentLayer+'Slot']=slot;if(doc.currentLayer==='altitude'){el('height').value=state[slotKey('altitude')];if(!['gradient','mountain','path'].includes(state.tool))altitudeTarget=slotKey('altitude');}syncUI();saveSettings();
    status('Mouse 3 now samples into '+slot+' '+doc.currentLayer+'.');
  }
  function altitudeTargets(){
    const paint=[['z','Primary height Z'],['secondaryZ','Secondary height Z']];
    if(state.tool==='gradient')return [['gradientCenter','Clicked point Z'],['gradientEdge','Edge Z']];
    if(state.tool==='path')return [['pathHeight','Path height'],['pathEdge','Edge height']];
    if(state.tool==='mountain')return [['landformPeak','Peak Z'],['landformBase','Base Z']];
    return paint;
  }
  function syncAltitudePalette(){
    el('altitude-palette-panel').hidden=doc.currentLayer!=='altitude';
    const targets=altitudeTargets(),signature=targets.map(([key])=>key).join(','),toolHeight=['gradient','mountain','path'].includes(state.tool);
    if(!toolHeight)altitudeTarget=slotKey('altitude');
    if(!targets.some(([key])=>key===altitudeTarget))altitudeTarget=targets[0][0];
    if(signature!==altitudePaletteSignature){el('altitude-target').replaceChildren(...targets.map(([key,label])=>new Option(label,key)));altitudePaletteSignature=signature;}
    el('altitude-target').value=altitudeTarget;el('altitude-target').disabled=!idle();
    el('altitude-tool-height').hidden=!toolHeight;el('altitude-use-primary').disabled=el('altitude-use-secondary').disabled=!idle();
    el('altitude-endpoint-value').textContent=toolHeight?targets.find(([key])=>key===altitudeTarget)[1]+': '+state[altitudeTarget]+'. Copy a stored height below.':'';
    const z=state[slotKey('altitude')],shade=z+128,hex='#'+shade.toString(16).padStart(2,'0').repeat(3).toUpperCase();
    el('altitude-value').textContent=(state.altitudeSlot==='primary'?'Primary':'Secondary')+' · Z '+z+' · Shade '+shade+' · '+hex;el('altitude-color').style.background=hex;
    const selection=state.altitudeSlot+':'+shade+':'+idle();
    if(selection!==altitudePaletteSelection){for(const button of altitudeButtons){const selected=Number(button.dataset.shade)===shade;button.setAttribute('aria-pressed',String(selected));button.tabIndex=selected?0:-1;button.disabled=!idle();}altitudePaletteSelection=selection;}
  }
  function chooseAltitudeShade(shade,slot='primary'){
    if(!idle()||doc.currentLayer!=='altitude')return;
    cancelLandformPreview(false);state.altitudeSlot=slot;state[slotKey('altitude',slot)]=shade-128;el('height').value=shade-128;el(slot==='primary'?'ramp-start':'ramp-end').value=shade-128;syncUI();saveSettings();
    status((slot==='primary'?'Primary':'Secondary')+' altitude set to Z '+(shade-128)+'.');
  }
  function copyAltitudeToTool(slot){
    if(!idle()||doc.currentLayer!=='altitude'||!['gradient','mountain','path'].includes(state.tool))return;
    cancelLandformPreview(false);state[altitudeTarget]=state[slotKey('altitude',slot)];syncUI();saveSettings();
    status(altitudeTargets().find(([key])=>key===altitudeTarget)[1]+' set to '+state[altitudeTarget]+' from '+slot+'.');
  }
  function buildAltitudePalette(){
    for(let shade=0;shade<256;shade++){
      const button=document.createElement('button'),hex='#'+shade.toString(16).padStart(2,'0').repeat(3).toUpperCase();
      button.type='button';button.dataset.shade=shade;button.style.background=hex;button.tabIndex=-1;
      button.title='Z '+(shade-128)+' · Shade '+shade+' · '+hex+' · Left: Primary · Right: Secondary';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed','false');
      bindPaletteColor(button,slot=>chooseAltitudeShade(shade,slot));altitudeButtons.push(button);el('altitude-palette').append(button);
    }
    el('altitude-palette').addEventListener('keydown',event=>{
      const button=event.target.closest('[data-shade]');if(!button||!idle())return;
      const shade=Number(button.dataset.shade);let next;
      if(event.key==='ArrowLeft')next=shade-1;else if(event.key==='ArrowRight')next=shade+1;
      else if(event.key==='ArrowUp')next=shade-16;else if(event.key==='ArrowDown')next=shade+16;
      else if(event.key==='Home')next=event.ctrlKey?0:shade-shade%16;
      else if(event.key==='End')next=event.ctrlKey?255:shade-shade%16+15;else return;
      event.preventDefault();event.stopPropagation();next=Math.max(0,Math.min(255,next));
      for(const entry of altitudeButtons)entry.tabIndex=entry===altitudeButtons[next]?0:-1;
      altitudeButtons[next].focus({preventScroll:true});
    });
    el('altitude-target').addEventListener('change',()=>{if(!idle())return;const target=el('altitude-target').value;if(altitudeTargets().some(([key])=>key===target)){altitudeTarget=target;if(['z','secondaryZ'].includes(target))state.altitudeSlot=target==='z'?'primary':'secondary';syncUI();saveSettings();}});
    for(const slot of ['primary','secondary'])el('altitude-use-'+slot).addEventListener('click',()=>copyAltitudeToTool(slot));
    for(const [id,fixedKey]of [['height',null],['gradient-edge','gradientEdge'],['gradient-center','gradientCenter'],['path-height','pathHeight'],['path-edge','pathEdge'],['landform-base','landformBase'],['landform-peak','landformPeak']])el(id).addEventListener('focus',()=>{const key=fixedKey||slotKey('altitude');if(altitudeTargets().some(([candidate])=>candidate===key)){altitudeTarget=key;syncAltitudePalette();}});
  }
  function stopZoom(){if(zoomFrame)cancelAnimationFrame(zoomFrame);zoomFrame=0;zoomAnimation=null;state.zoomTarget=state.zoom;}
  function fit(){stopZoom();const r=viewportBounds();viewportSize=r;state.zoom=Math.min(32,Math.max(.015625,Math.min((r.width-64)/doc.width,(r.height-64)/doc.height)));state.zoomTarget=state.zoom;state.offsetX=(r.width-doc.width*state.zoom)/2;state.offsetY=(r.height-doc.height*state.zoom)/2;syncUI();requestRender();}
  function setZoom(z,anchor){if(!Number.isFinite(z)||z<.015625||z>32)return;stopZoom();const r=viewportBounds(),p=anchor||{x:r.width/2,y:r.height/2};const dx=(p.x-state.offsetX)/state.zoom,dy=(p.y-state.offsetY)/state.zoom;state.zoom=z;state.zoomTarget=z;state.offsetX=p.x-dx*z;state.offsetY=p.y-dy*z;syncUI();requestRender();}
  function resizeViewport(){
    const next=viewportBounds();
    if(!viewportSize){viewportSize=next;requestRender();return;}
    if(next.width===viewportSize.width&&next.height===viewportSize.height)return;
    // A responsive layout may physically move a captured canvas. Roll back its
    // gesture before accepting coordinates in the new layout; async edits defer.
    if(drag){finish(true);return;}
    if(isBusy){requestRender();return;}
    stopZoom();state.offsetX+=(next.width-viewportSize.width)/2;state.offsetY+=(next.height-viewportSize.height)/2;viewportSize=next;syncUI();requestRender();
  }
  function setLayout(layout){
    if(!idle()||!['single','side-by-side','stacked'].includes(layout)){syncUI();return;}
    stopZoom();viewportSize=viewportBounds();state.layout=layout;syncUI();resizeViewport();requestRender();saveSettings();
  }
  function activateLayer(layer){
    if(layer==='altitude'&&decoMode&&idle())decoButton.click();
    if(!idle())return false;if(doc.currentLayer===layer)return true;
    cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);doc.currentLayer=layer;syncUI();if(layer==='altitude')el('inspector-controls').scrollTop=0;requestRender();return true;
  }
  function centerMapAt(p){const view=viewportBounds();state.offsetX=view.width/2-p.x*state.zoom;state.offsetY=view.height/2-p.y*state.zoom;cursor.visible=false;requestRender();}
  function navigateOverview(e){const r=overview.getBoundingClientRect();if(!r.width||!r.height)return;centerMapAt(overviewGeometry.mapPoint((e.clientX-r.left)*overview.width/r.width,(e.clientY-r.top)*overview.height/r.height,doc.width,doc.height,overview.width));}
  function pixelInfo(p){
    if(!inside(p))return;const i=p.y*doc.width+p.x,preview=flattenPreview||roadPreview||rampPreview||blurPreview||smoothingPreview,t=preview?displayValue(p.x,p.y,'terrain',doc.terrain):doc.terrain[i],a=preview?displayValue(p.x,p.y,'altitude',doc.altitude):doc.altitude[i];
    el('pixel-info').textContent=(flattenPreview?'Flatten preview · ':roadPreview?'Road preview · ':blurPreview?'Blur brush preview · ':smoothingPreview?'Filter preview · ':rampPreview?'Ramp preview · ':'')+'X '+p.x+' · Y '+p.y+' · Terrain: '+(t===UNSET?'Unset':byId.get(t).name+' / '+t)+' · Altitude: '+(a===UNSET?'Unset':'Z '+(a-128)+' / shade '+a);
  }
  function animateZoom(z,anchor){
    const dx=(anchor.x-state.offsetX)/state.zoom,dy=(anchor.y-state.offsetY)/state.zoom;stopZoom();
    state.zoomTarget=z;zoomAnimation={from:state.zoom,to:z,start:performance.now(),anchor,dx,dy};
    function frame(now){const a=zoomAnimation;if(!a)return;const t=Math.min(1,(now-a.start)/140),ease=1-Math.pow(1-t,3);
      state.zoom=a.from+(a.to-a.from)*ease;state.offsetX=a.anchor.x-a.dx*state.zoom;state.offsetY=a.anchor.y-a.dy*state.zoom;
      if(t===1){state.zoom=a.to;state.zoomTarget=a.to;zoomAnimation=null;zoomFrame=0;}else zoomFrame=requestAnimationFrame(frame);
      syncUI();requestRender();
    }zoomFrame=requestAnimationFrame(frame);
  }
  function edited(stats,label){dirty=dirty||stats.changed>0;status(label+': '+stats.changed.toLocaleString()+' selected pixels changed.'+(typeof stats.linkedChanged==='number'?' '+stats.linkedChanged.toLocaleString()+' matching pixels updated in the other image.':''));syncUI();requestRender();}
  function cancelLandformPreview(announce=true){
    const pending=!!landformPreview,pathPreview=landformPreview&&landformPreview.options.mode==='path';landformPreview=null;
    if(pending){if(announce)status(pathPreview?'Path gradient preview canceled. Images are unchanged.':'Mountain preview canceled. Images and seed are unchanged.');syncUI();requestRender();}
    return pending;
  }
  function cancelSmoothingPreview(announce=true){
    const pending=!!smoothingPreview;if(smoothingPreview)smoothingPreview.cancel();smoothingPreview=null;
    if(pending){if(announce)status('Filter preview canceled. Image pixels are unchanged.');syncUI();requestRender();}return pending;
  }
  function roadOptions(){return Object.fromEntries(roadFields.map(([,key,,,option])=>[option,state[key]]));}
  function roadEdge(){const stitch=roadSession&&selectedRoadHandle&&roadSession.stitches[selectedRoadHandle.index];return stitch&&stitch[selectedRoadHandle.side];}
  function grayHex(z){return '#'+(z+128).toString(16).padStart(2,'0').repeat(3).toUpperCase();}
  function selectRoadHandle(index,side){
    if(!roadSession||!Number.isInteger(index)||!roadSession.stitches[index]||!['left','right'].includes(side))return false;
    selectedRoadHandle={index,side};const edge=roadEdge();el('road-edge-z').value=el('road-edge-slider').value=edge.z;
    syncRoadUI();requestRender();return true;
  }
  function syncRoadUI(){
    el('road-panel').hidden=state.tool!=='road'||doc.currentLayer!=='altitude';
    for(const [id,key]of roadFields){const field=el(id);if(document.activeElement!==field&&Number.isInteger(field.valueAsNumber)&&field.validity.valid)field.value=state[key];field.disabled=!idle();}
    el('road-curvature-value').textContent=state.roadCurvature+'%';
    const stitches=roadSession&&roadSession.totalLength>0?roadSession.stitches:[],list=el('road-handle-select'),signature=String(stitches.length);
    if(signature!==roadHandleSignature){
      roadHandleSignature=signature;list.replaceChildren();
      if(!stitches.length)list.add(new Option('Draw a road to edit its edges',''));
      else{list.add(new Option('Choose an edge endpoint',''));for(const stitch of stitches)for(const side of ['left','right'])list.add(new Option('Stitch '+(stitch.index+1)+' · '+(side==='left'?'Left':'Right'),stitch.index+':'+side));}
    }
    if(selectedRoadHandle&&!stitches[selectedRoadHandle.index])selectedRoadHandle=null;
    list.value=selectedRoadHandle?selectedRoadHandle.index+':'+selectedRoadHandle.side:'';list.disabled=!idle()||!stitches.length;
    const edge=roadEdge(),active=!!edge&&idle();
    for(const id of ['road-edge-z','road-edge-slider','road-edge-primary','road-edge-secondary','road-edge-reset'])el(id).disabled=!active;
    if(edge){
      const field=el('road-edge-z');if(document.activeElement!==field&&Number.isInteger(field.valueAsNumber)&&field.validity.valid)field.value=edge.z;
      el('road-edge-slider').value=edge.z;el('road-edge-color').style.background=grayHex(edge.z);
      el('road-edge-readout').textContent=(selectedRoadHandle.side==='left'?'Left':'Right')+' · Z '+edge.z+' · '+grayHex(edge.z)+(edge.overridden?' · Fixed height':' · Follows road');
    }else{el('road-edge-color').style.background='#808080';el('road-edge-readout').textContent='Click a stitch dot; hover and wheel to change its height.';}
    el('road-apply').disabled=!idle()||!roadSession||!roadPreview;el('road-cancel').disabled=!idle()||!roadSession;
    el('road-note').textContent=roadPreviewError||(!roadSession?'Draw inside the altitude image. Size 1 uses flat-side connections.':drag&&drag.kind==='road-draw'?'Drawing preview. Release to adjust the curve and stitches.':
      'Preview only. Drag white points to bend the road; drag either stitch dot to shape its hillside. Wheel over a dot changes its Z. Apply or Cancel before saving.'+(roadPreview?' Largest road step: '+roadPreview.maxRoadStepZ+' Z.':'')+(roadPreview&&roadPreview.clipped?' The road stopped at the selection boundary.':'')+(roadPreview&&roadPreview.clampedPixels?' '+roadPreview.clampedPixels.toLocaleString()+' pixels reached the altitude limits.':''));
  }
  function renderRoadGuides(ctx,session=roadSession,handles=true){
    const z=state.zoom,ox=state.offsetX,oy=state.offsetY,screen=p=>({x:ox+(p.x+.5)*z,y:oy+(p.y+.5)*z});
    const points=session.sampledPoints;
    ctx.save();ctx.lineWidth=1.3;ctx.strokeStyle='#10283d';ctx.beginPath();
    for(let i=0;i<points.length;i++){const p=screen(points[i]);ctx[i?'lineTo':'moveTo'](p.x,p.y);}ctx.stroke();
    ctx.strokeStyle='#fff';ctx.lineWidth=.8;ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);
    if(!handles){
      if(points.length){const start=screen(points[0]);ctx.fillStyle='#70e7ff';ctx.beginPath();ctx.arc(start.x,start.y,3,0,Math.PI*2);ctx.fill();}
      if(points.length>1){let i=points.length-2;const end=points[points.length-1];while(i>0&&Math.hypot(end.x-points[i].x,end.y-points[i].y)<1)i--;const p=screen(end),angle=Math.atan2(end.y-points[i].y,end.x-points[i].x);ctx.strokeStyle='#70e7ff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(p.x-9*Math.cos(angle-.5),p.y-9*Math.sin(angle-.5));ctx.lineTo(p.x,p.y);ctx.lineTo(p.x-9*Math.cos(angle+.5),p.y-9*Math.sin(angle+.5));ctx.stroke();}
      ctx.restore();return;
    }
    for(const knot of roadSession.points){const p=screen(knot);ctx.fillStyle='#fff';ctx.fillRect(p.x-3,p.y-3,6,6);ctx.strokeStyle='#14263a';ctx.lineWidth=1;ctx.strokeRect(p.x-3.5,p.y-3.5,7,7);}
    for(const stitch of roadSession.totalLength>0?roadSession.stitches:[]){const start=screen(stitch);
      for(const side of ['left','right']){const edge=stitch[side],end=screen(edge),color=side==='left'?'#55d8ff':'#ffb66e';
        ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.stroke();
        const selected=selectedRoadHandle&&selectedRoadHandle.index===stitch.index&&selectedRoadHandle.side===side;
        ctx.beginPath();ctx.arc(end.x,end.y,selected?7:6,0,Math.PI*2);ctx.fillStyle=selected?'#ffe46f':color;ctx.fill();
        ctx.beginPath();ctx.arc(end.x,end.y,4.5,0,Math.PI*2);ctx.fillStyle=grayHex(edge.z);ctx.fill();ctx.strokeStyle=edge.z>=0?'#15263b':'#fff';ctx.lineWidth=1;ctx.stroke();
      }
    }
    ctx.restore();
  }
  function hitRoadControl(event,canvas,edgesOnly=false){
    if(!roadSession||viewLayer(canvas)!=='altitude')return null;const bounds=canvas.getBoundingClientRect(),x=event.clientX-bounds.left,y=event.clientY-bounds.top;
    const distance=p=>Math.hypot(state.offsetX+(p.x+.5)*state.zoom-x,state.offsetY+(p.y+.5)*state.zoom-y);
    let best=null,nearest=9;
    for(const stitch of roadSession.totalLength>0?roadSession.stitches:[])for(const side of ['left','right']){const d=distance(stitch[side]);if(d<nearest){nearest=d;best={kind:'edge',index:stitch.index,side};}}
    if(!edgesOnly&&!best)for(let index=0;index<roadSession.points.length;index++){const d=distance(roadSession.points[index]);if(d<nearest){nearest=d;best={kind:'point',index};}}
    return best;
  }
  function refreshRoadPreview(){
    if(!roadSession)return null;
    try{roadPreview=doc.planRoad(roadSession);roadPreviewError='';return roadPreview;}
    catch(err){roadPreview=null;roadPreviewError=err.message||String(err);throw err;}
    finally{syncRoadUI();syncPendingShape();requestRender();}
  }
  function mutateRoad(action){
    if(!roadSession)return;const checkpoint=roadSession.checkpoint(),chosen=selectedRoadHandle?{...selectedRoadHandle}:null;
    try{action(roadSession);return refreshRoadPreview();}
    catch(err){roadSession.restore(checkpoint);selectedRoadHandle=chosen;try{refreshRoadPreview();}catch{}throw err;}
  }
  function cancelRoadPreview(announce=true){
    const pending=!!roadSession;if(roadSession)roadSession.cancel();roadSession=null;roadPreview=null;selectedRoadHandle=null;roadPreviewError='';roadHandleSignature='';
    for(const canvas of surfaces)canvas.removeAttribute('title');
    if(pending){if(announce)status('Road preview canceled. Image pixels are unchanged.');syncUI();requestRender();}return pending;
  }
  function commitRoadInputs(){
    const values=roadFields.map(([id,key,min,max,option])=>{const field=el(id),v=field.valueAsNumber;if(!Number.isInteger(v)||v<min||v>max)throw new Error((field.labels[0]?field.labels[0].textContent.trim():id)+' must be a whole number from '+min+' to '+max+'.');return {key,option,value:v};});
    if(!values.some(({key,value})=>state[key]!==value))return false;
    const options=Object.fromEntries(values.map(({option,value})=>[option,value]));
    if(roadSession)mutateRoad(session=>session.setOptions(options));
    for(const {key,value}of values)state[key]=value;saveSettings();syncUI();requestRender();return true;
  }
  function changeRoadEdgeZ(z){
    if(!idle()||!roadEdge())return;
    if(!Number.isInteger(z)||z<-128||z>127)throw new Error('Edge height must be a whole number from -128 to 127.');
    const {index,side}=selectedRoadHandle;mutateRoad(session=>session.setEdgeZ(index,side,z));
    el('road-edge-z').value=el('road-edge-slider').value=z;syncRoadUI();pixelInfo(cursor);
  }
  function applyRoadPreview(){
    if(!idle()||!roadSession)return;commitRoadInputs();
    if(roadEdge()){const value=el('road-edge-z').valueAsNumber;if(!Number.isInteger(value)||value<-128||value>127)throw new Error('Edge height must be a whole number from -128 to 127.');if(value!==roadEdge().z)changeRoadEdgeZ(value);}
    const preview=refreshRoadPreview();if(!preview)return;
    // Capture the reviewed road footprint before Apply consumes the transient plan.
    // Update protection only after a successful atomic edit; Undo conservatively
    // retains the mask during this document session.
    const b=preview.bounds,roadIndices=[];for(let y=b.top;y<b.top+b.height;y++)for(let x=b.left;x<b.left+b.width;x++)if(preview.roadAt(x,y))roadIndices.push(y*doc.width+x);
    const nextProtected=protectedRoadMask||new Uint8Array(doc.width*doc.height);
    const result=doc.applyRoad(preview);for(const index of roadIndices)nextProtected[index]=1;protectedRoadMask=nextProtected;
    roadSession=null;roadPreview=null;selectedRoadHandle=null;roadPreviewError='';roadHandleSignature='';
    edited(result,'Road and hillsides');return result;
  }
  function beginRoadPointer(event,canvas,p){
    commitRoadInputs();
    if(roadSession){
      const hit=hitRoadControl(event,canvas);if(!hit){status('Drag a white curve point or a stitch dot. Apply or Cancel before drawing another road.');return;}
      if(hit.kind==='edge')selectRoadHandle(hit.index,hit.side);else selectedRoadHandle=null;
      drag={id:event.pointerId,surface:canvas,layer:'altitude',kind:'road-edit',buttonMask:1,control:hit,checkpoint:roadSession.checkpoint()};
    }else{
      cancelSmoothingPreview(false);roadSession=doc.createRoad(p.x,p.y,roadOptions());roadPreviewError='';
      try{refreshRoadPreview();}catch(err){cancelRoadPreview(false);throw err;}
      drag={id:event.pointerId,surface:canvas,layer:'altitude',kind:'road-draw',buttonMask:1};
    }
    canvas.setPointerCapture(event.pointerId);status('Road preview. Release to adjust. Terrain updates when applied if Linked painting is on.');syncUI();requestRender();
  }
  function appendRoadPoint(p){
    if(!drag||!['road-draw','road-edit'].includes(drag.kind)||!roadSession)return;
    const target=bounded(p);
    try{mutateRoad(session=>{if(drag.kind==='road-draw')session.addPoint(target.x,target.y);else{const c=drag.control;if(c.kind==='point')session.movePoint(c.index,target.x,target.y);else session.setHandle(c.index,c.side,target.x,target.y);}});if(drag.lastError){drag.lastError=null;el('error').textContent='';}pixelInfo(target);}
    catch(err){drag.lastError=err;error(err);}
  }
  for(const [id]of roadFields)el(id).addEventListener(id==='road-curvature'?'input':'change',()=>safely(()=>{if(idle())commitRoadInputs();}));
  el('road-handle-select').addEventListener('change',()=>{if(!idle())return;const [index,side]=el('road-handle-select').value.split(':');if(side)selectRoadHandle(Number(index),side);else{selectedRoadHandle=null;syncRoadUI();requestRender();}});
  el('road-edge-z').addEventListener('change',()=>safely(()=>changeRoadEdgeZ(el('road-edge-z').valueAsNumber)));
  el('road-edge-slider').addEventListener('input',()=>safely(()=>changeRoadEdgeZ(el('road-edge-slider').valueAsNumber)));
  for(const slot of ['primary','secondary'])el('road-edge-'+slot).addEventListener('click',()=>safely(()=>changeRoadEdgeZ(state[slot==='primary'?'z':'secondaryZ'])));
  el('road-edge-reset').addEventListener('click',()=>safely(()=>{if(idle()&&roadEdge()){const {index,side}=selectedRoadHandle;mutateRoad(session=>session.resetEdgeZ(index,side));el('road-edge-z').value=roadEdge().z;syncRoadUI();}}));
  el('road-apply').addEventListener('click',()=>safely(applyRoadPreview));el('road-cancel').addEventListener('click',()=>{if(idle())cancelRoadPreview();});
  function flattenOptions(){return {...Object.fromEntries(flattenFields.map(([,key,,,option])=>[option,state[key]])),profile:state.flattenProfile};}
  function syncFlattenUI(){
    el('flatten-panel').hidden=state.tool!=='flatten'||doc.currentLayer!=='altitude';
    for(const [id,key]of flattenFields){const field=el(id);if(document.activeElement!==field&&Number.isInteger(field.valueAsNumber)&&field.validity.valid)field.value=state[key];field.disabled=!idle();}
    el('flatten-profile').value=state.flattenProfile;el('flatten-profile').disabled=!idle();el('flatten-sample').checked=state.flattenSample;el('flatten-sample').disabled=!idle();
    el('flatten-apply').disabled=!idle()||!flattenSession||flattenSession.drawing||!flattenPreview;el('flatten-cancel').disabled=!idle()||!flattenSession;
    el('flatten-note').textContent=flattenPreviewError?flattenPreviewError+' Adjust the profile, Flat Z or reach before applying.':!flattenSession?'Draw a level road across the altitude image. Sampling takes its starting height once.':drag&&drag.kind==='flatten-draw'?'Drawing preview. Release, adjust the controls, then Apply.':'Preview only · Flat Z '+state.flattenZ+'. Terrain updates when applied if Linked painting is on.'+(flattenPreview&&flattenPreview.clipped?' Selection boundaries clipped the effect.':'');
  }
  function refreshFlattenPreview(){
    if(!flattenSession)return null;
    try{flattenPreview=doc.planFlatten(flattenSession);flattenPreviewError='';}
    catch(err){flattenPreview=null;flattenPreviewError=err.message||String(err);}
    syncFlattenUI();syncPendingShape();requestRender();return flattenPreview;
  }
  function cancelFlattenPreview(announce=true){
    const pending=!!flattenSession;if(flattenSession)flattenSession.cancel();flattenSession=null;flattenPreview=null;flattenPreviewError='';
    if(pending){if(announce)status('Flatten canceled. Image pixels are unchanged.');syncUI();requestRender();}return pending;
  }
  function commitFlattenInputs(){
    const values=flattenFields.map(([id,key,min,max,option])=>{const field=el(id),value=field.valueAsNumber;if(!Number.isInteger(value)||value<min||value>max)throw new Error(field.labels[0].textContent.trim()+' must be a whole number from '+min+' to '+max+'.');return {key,option,value};});
    const profile=el('flatten-profile').value;if(!flattenProfiles.includes(profile))throw new Error('Choose a Flatten profile.');
    const changed=values.some(({key,value})=>state[key]!==value)||profile!==state.flattenProfile;
    if(values.some(({key,value})=>key==='flattenZ'&&state[key]!==value))el('flatten-sample').checked=false;
    if(changed&&flattenSession)flattenSession.setOptions({...Object.fromEntries(values.map(({option,value})=>[option,value])),profile});
    for(const {key,value}of values)state[key]=value;state.flattenProfile=profile;state.flattenSample=el('flatten-sample').checked;saveSettings();
    if(changed&&flattenSession){refreshFlattenPreview();status(flattenPreview?'Flatten preview updated. Apply to commit, or Cancel.':'Flatten needs a settings change before Apply.');if(flattenPreviewError)error(new Error(flattenPreviewError));}
    syncUI();requestRender();return changed;
  }
  function beginFlattenPointer(event,canvas,p){
    commitFlattenInputs();
    if(flattenSession){status('Adjust the Flatten controls, then Apply or Cancel before drawing another path.');return;}
    const shade=doc.altitude[p.y*doc.width+p.x];
    if(shade===UNSET)throw new Error('Start Flatten on a painted altitude pixel.');
    if(state.flattenSample){state.flattenZ=shade-128;el('flatten-z').value=state.flattenZ;saveSettings();}
    cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);
    flattenSession=doc.createFlatten(p.x,p.y,flattenOptions());flattenPreviewError='';refreshFlattenPreview();
    drag={id:event.pointerId,surface:canvas,layer:'altitude',kind:'flatten-draw',buttonMask:1};canvas.setPointerCapture(event.pointerId);
    status('Flatten preview. Release to adjust controls. Terrain updates when applied if Linked painting is on.');syncUI();requestRender();
  }
  function appendFlattenPoint(p){
    if(!drag||drag.kind!=='flatten-draw'||!flattenSession)return;
    const checkpoint=flattenSession.checkpoint();
    try{flattenSession.addPoint(p.x,p.y);drag.lastError=null;el('error').textContent='';}
    catch(err){flattenSession.restore(checkpoint);drag.lastError=err;error(err);}
    refreshFlattenPreview();pixelInfo(p);
  }
  function applyFlattenPreview(){
    if(!idle()||!flattenSession)return;commitFlattenInputs();if(flattenSession.drawing)return;
    const preview=refreshFlattenPreview();if(!preview){status('Flatten is not ready. Adjust its settings or Cancel.');error(new Error(flattenPreviewError));return;}
    const b=preview.bounds,roadIndices=[];for(let y=b.top;y<b.top+b.height;y++)for(let x=b.left;x<b.left+b.width;x++)if(preview.plateauAt(x,y))roadIndices.push(y*doc.width+x);
    const nextProtected=protectedRoadMask||new Uint8Array(doc.width*doc.height),result=doc.applyFlatten(preview);for(const index of roadIndices)nextProtected[index]=1;protectedRoadMask=nextProtected;
    flattenSession=null;flattenPreview=null;flattenPreviewError='';edited(result,'Flatten mountain');pixelInfo(cursor);return result;
  }
  for(const [id]of flattenFields)el(id).addEventListener('change',()=>safely(()=>{if(idle())commitFlattenInputs();}));
  el('flatten-z').addEventListener('input',()=>{if(!idle())return;state.flattenSample=false;el('flatten-sample').checked=false;});
  el('flatten-profile').addEventListener('change',()=>safely(()=>{if(idle())commitFlattenInputs();}));
  el('flatten-sample').addEventListener('change',()=>{if(!idle())return;state.flattenSample=el('flatten-sample').checked;saveSettings();syncFlattenUI();});
  el('flatten-apply').addEventListener('click',()=>safely(applyFlattenPreview));el('flatten-cancel').addEventListener('click',()=>{if(idle())cancelFlattenPreview();});
  function commitSmoothingInputs(){
    const values=smoothingFields.map(([id,key,min,max])=>{const value=el(id).valueAsNumber;if(!Number.isInteger(value)||value<min||value>max)throw new Error(el(id).labels[0].textContent.trim()+' must be a whole number from '+min+' to '+max+'.');return [key,value];});
    const changed=values.some(([key,value])=>state[key]!==value);
    if(changed){for(const [key,value]of values)state[key]=value;if(cancelSmoothingPreview(false))status('Settings changed. Preview Blur or Melt again before applying.');saveSettings();syncUI();requestRender();}return changed;
  }
  function commitDistortInputs(){
    const values=distortFields.map(([id,key,min,max])=>{const value=el(id).valueAsNumber;if(!Number.isInteger(value)||value<min||value>max)throw new Error(el(id).labels[0].textContent.trim()+' must be a whole number from '+min+' to '+max+'.');return [key,value];});
    const changed=values.some(([key,value])=>state[key]!==value);
    if(changed){for(const [key,value]of values)state[key]=value;if(cancelSmoothingPreview(false))status('Settings changed. Preview bumps / gullies again before applying.');saveSettings();syncUI();requestRender();}return changed;
  }
  async function prepareSmoothing(mode){
    if(!idle())return;if(!['blur','melt','distort'].includes(mode))throw new Error('Choose Blur, Melt edges, or bumps / gullies.');if(mode==='distort')commitDistortInputs();else commitSmoothingInputs();
    if(doc.selectionActive&&doc.selection.indexOf(1)===-1)throw new Error('The selection is empty. Select an area before applying a filter.');
    if((mode==='melt'||mode==='distort')&&!doc.selectionActive)throw new Error('Select a nonempty area before using '+(mode==='distort'?'bumps / gullies.':'Melt edges.'));
    activateLayer('altitude');cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);stopZoom();
    const target=doc,job={canceled:false};smoothingJob=job;isBusy=true;status(mode==='distort'?'Previewing bumps and gullies…':mode==='melt'?'Previewing the selected inside edge…':'Previewing altitude blur…');syncUI();
    try{
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));if(job.canceled||target!==doc)return;
      let seed=state.distortSeed;if(mode==='distort'&&state.distortRandom){const values=new Uint32Array(1);do{crypto.getRandomValues(values);}while(values[0]===state.distortSeed);seed=values[0];}
      const plan=mode==='distort'?target.planDistort({roughness:state.distortRoughness,scale:state.distortScale,edgeFade:state.distortEdgeFade,seed,protectMask:state.distortProtectRoads&&protectedRoadMask?protectedRoadMask:undefined}):mode==='melt'?target.planMelt({width:state.meltWidth,strength:state.blurStrength}):target.planBlur({radius:state.blurRadius,strength:state.blurStrength});
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));if(job.canceled||target!==doc){plan.cancel();return;}
      smoothingPreview=plan;status((mode==='distort'?'Bumps / gullies · Seed '+seed:mode==='melt'?'Melt edges':'Blur')+' preview ready. Apply to commit, or Cancel.');
    }catch(err){status('Filter was not applied.');throw err;}
    finally{if(smoothingJob===job)smoothingJob=null;isBusy=false;resizeViewport();syncUI();requestRender();}
  }
  function applySmoothingPreview(){
    if(!idle()||!smoothingPreview)return;if(smoothingPreview.mode==='distort')commitDistortInputs();else commitSmoothingInputs();if(!smoothingPreview)return;const plan=smoothingPreview;
    try{const result=plan.mode==='distort'?doc.applyDistort(plan):doc.applySmoothing(plan);if(plan.mode==='distort'){state.distortSeed=plan.options.seed;el('distort-seed').value=state.distortSeed;saveSettings();}smoothingPreview=null;edited(result,plan.mode==='distort'?'Bumps / gullies':plan.mode==='melt'?'Melt edges':'Blur selection');pixelInfo(cursor);return result;}
    catch(err){cancelSmoothingPreview(false);throw err;}
  }
  function appendBlurPoint(p){
    if(!drag||drag.kind!=='blur')return;try{drag.session.addPoint(p.x,p.y);pixelInfo(p);requestRender();}catch(err){finish(true);throw err;}
  }
  for(const [id]of smoothingFields)el(id).addEventListener('change',()=>safely(()=>{if(idle())commitSmoothingInputs();}));
  for(const [id]of distortFields)el(id).addEventListener('change',()=>safely(()=>{if(idle())commitDistortInputs();}));
  for(const [id,key]of [['distort-random','distortRandom'],['distort-protect-roads','distortProtectRoads']])el(id).addEventListener('change',()=>{if(!idle())return;state[key]=el(id).checked;cancelSmoothingPreview(false);saveSettings();syncUI();});
  el('distort-preview').addEventListener('click',()=>safely(()=>prepareSmoothing('distort')));
  el('blur-selection').addEventListener('click',()=>safely(()=>prepareSmoothing('blur')));el('melt-edges').addEventListener('click',()=>safely(()=>prepareSmoothing('melt')));
  el('smoothing-apply').addEventListener('click',()=>safely(applySmoothingPreview));el('smoothing-cancel').addEventListener('click',()=>{if(idle())cancelSmoothingPreview();});
  function landformOptions(){
    let seed=state.landformSeed;
    if(state.landformRandom){const values=new Uint32Array(1);do{crypto.getRandomValues(values);}while(values[0]===state.landformSeed);seed=values[0];}
    return {mode:state.landformMode,baseZ:state.landformBase,peakZ:state.landformPeak,slope:state.landformSlope,featureSize:state.landformSize,roughness:state.landformRoughness,detailScale:state.landformDetail,seed};
  }
  function commitLandform(plan){
    const stats=doc.applyLandform(plan),path=plan.options.mode==='path';landformPreview=null;if(!path)state.landformSeed=plan.seed;saveSettings();
    edited(stats,path?'Path gradient':({mountain:'Mountain',hills:'Hills',ridge:'Ridge'})[plan.options.mode]+' · Seed '+plan.seed);
    pixelInfo(cursor);
    return stats;
  }
  function applyLandformPreview(){
    if(!idle()||!landformPreview)return;
    const plan=landformPreview;
    try{return commitLandform(plan);}catch(err){cancelLandformPreview(false);status('Preview was not applied. Create a fresh preview.');throw err;}
  }
  async function prepareLandform(p,options,points=[p]){
    if(!idle())return;cancelLandformPreview(false);stopZoom();const target=doc,path=options.mode==='path',previewFirst=path?state.pathPreviewFirst:state.landformPreviewFirst,job={canceled:false,mode:options.mode};landformJob=job;isBusy=true;status(path?'Fitting the gradient from your path to the selected edge…':'Shaping '+options.mode+' elevations…');syncUI();
    try{
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
      if(job.canceled||target!==doc)return;
      const plan=target.planLandform(p.x,p.y,{...options,points});
      // Let cancellation queued while planning run before a direct commit.
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
      if(job.canceled||target!==doc)return;
      cursor={...p,visible:true};
      if(previewFirst){landformPreview=plan;status(path?'Path gradient preview ready. Apply to change the images, or Cancel.':'Preview ready · Seed '+plan.seed+'. Apply to change the images, or Cancel.');}
      else commitLandform(plan);
    }catch(err){status(path?'Path gradient was not applied.':'Mountain tool was not applied.');throw err;}
    finally{if(landformJob===job)landformJob=null;isBusy=false;resizeViewport();syncUI();requestRender();}
  }
  function appendRidgePoint(p){if(!drag||drag.kind!=='landform'||!['ridge','path'].includes(drag.options.mode))return;const last=drag.points[drag.points.length-1];if(last.x!==p.x||last.y!==p.y)drag.points.push(p);}
  function appendRampPoint(p){
    if(!drag||drag.kind!=='ramp')return;
    try{drag.session.addPoint(p.x,p.y);pixelInfo(p);status('Ramp preview · '+drag.session.totalLength.toFixed(1)+' pixels long. Release to apply; Escape cancels.');requestRender();}
    catch(err){finish(true);throw err;}
  }
  async function applyGradient(p){
    if(!idle())return;cancelLandformPreview(false);stopZoom();isBusy=true;status('Fitting the altitude gradient to the selected outline…');syncUI();
    try{await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));const stats=doc.altitudeGradient(p.x,p.y,state.gradientEdge,state.gradientCenter);cursor={x:p.x,y:p.y,visible:true};edited(stats,'Shape gradient');const v=doc.altitude[p.y*doc.width+p.x];el('pixel-info').textContent='X '+p.x+' · Y '+p.y+' · Z '+(v-128)+' / shade '+v;}
    catch(err){status('Gradient was not applied.');throw err;}
    finally{isBusy=false;resizeViewport();syncUI();requestRender();}
  }
  async function resizeSelection(direction){
    if(!idle())return;cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);const pixels=el('selection-pixels').valueAsNumber;
    if(!Number.isInteger(pixels)||pixels<1||pixels>8192)throw new Error('Selection size must be a whole number from 1 to 8192 image pixels.');
    state.selectionPixels=pixels;saveSettings();stopZoom();isBusy=true;status(direction==='expand'?'Expanding the selection…':'Contracting the selection…');syncUI();
    try{await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));const result=doc[direction==='expand'?'expandSelection':'contractSelection'](pixels);dirty=dirty||result.changed>0;
      status((direction==='expand'?'Expanded':'Contracted')+' by '+pixels+' image pixel'+(pixels===1?'':'s')+'. '+result.changed.toLocaleString()+' pixels '+(direction==='expand'?'added.':'removed.')+(result.selectedPixels===0?' Selection is empty; Undo restores it.':''));
    }catch(err){status('Selection was not changed.');throw err;}
    finally{isBusy=false;resizeViewport();syncUI();requestRender();}
  }
  function selectionStatus(operation){return operation==='subtract'?'Removed affected pixels from the selection.':operation==='add'?'Added to the selection.':'New selection created.';}
  function selectPoint(p,operation=state.tool==='pixel'?'add':'replace'){
    if(operation==='subtract'&&!doc.selectionActive){status('No selection to remove pixels from.');return;}
    cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);
    if(state.tool==='pixel'){const session=doc.createSelectionStroke(p.x,p.y,{operation});try{const result=doc.applySelectionStroke(session);dirty=dirty||Boolean(result.selectionChanged);}catch(err){session.cancel();throw err;}}
    else doc.select(p.x,p.y,{contiguous:state.connected,diagonal:state.continued,matchSurroundings:state.matchSurroundings,operation});
    status(selectionStatus(operation));syncUI();requestRender();
  }
  function appendSelectionPoint(p){
    if(!drag||!['pixel-select','wand-select'].includes(drag.kind))return;
    try{drag.session.addPoint(p.x,p.y);requestRender();}catch(err){finish(true);throw err;}
  }
  function sample(p,layer=doc.currentLayer){if(!inside(p))return;const v=doc[layer][p.y*doc.width+p.x];if(v===UNSET){status('This '+layer+' pixel is unset. Color unchanged.');return;}state[slotKey(layer)]=layer==='terrain'?v:v-128;if(layer==='altitude'){el('height').value=v-128;el(state.altitudeSlot==='primary'?'ramp-start':'ramp-end').value=v-128;if(doc.currentLayer==='altitude'&&!['gradient','mountain','path'].includes(state.tool))altitudeTarget=slotKey('altitude');}syncUI();status('Sampled '+layer+' '+(layer==='terrain'?byId.get(v).name:'Z '+(v-128))+' into '+state[layer+'Slot']+'.');saveSettings();}
  function appendPaintPoint(p){
    if(!drag||drag.kind!=='paint')return;
    if(!inside(p)){drag.last=null;return;}const a=drag.last||p;doc.paintLine(a.x,a.y,p.x,p.y,drag.value,drag.size);drag.last=p;requestRender();
  }
  function gestureButton(gesture){return gesture.buttonMask===8?3:gesture.buttonMask===2?2:gesture.buttonMask===4?1:0;}
  function finish(cancel=false){
    if(!drag)return;const current=drag;drag=null;
    safely(()=>{
      if(current.kind==='paint'){if(cancel){doc.cancelStroke();status('Stroke canceled.');}else edited(doc.endStroke(),'Paint');}
      else if(['pixel-select','wand-select'].includes(current.kind)){
        selectionStrokePreview=null;
        if(cancel){current.session.cancel();status('Selection stroke canceled. Previous selection kept.');}
        else{try{const result=current.kind==='wand-select'?current.session.apply():doc.applySelectionStroke(current.session);dirty=dirty||Boolean(result.selectionChanged);status(selectionStatus(current.operation));}catch(err){current.session.cancel();throw err;}}
      }
      else if(current.kind==='ramp'){
        rampPreview=null;
        if(cancel){current.session.cancel();status('Ramp canceled. Images are unchanged.');}
        else{try{edited(doc.applyRamp(current.session),'Ramp');}catch(err){current.session.cancel();throw err;}}
      }
      else if(current.kind==='blur'){
        blurPreview=null;
        if(cancel){current.session.cancel();status('Blur stroke canceled. Image pixels are unchanged.');}
        else{try{edited(doc.applyBlurBrush(current.session),'Blur brush');pixelInfo(cursor);}catch(err){current.session.cancel();throw err;}}
      }
      else if(current.kind==='road-draw'){
        if(cancel)cancelRoadPreview();
        else{try{roadSession.finishDrawing();refreshRoadPreview();status('Road ready — click Apply above the images or press Enter. You can still adjust the white points and edge dots first.');if(current.lastError)error(current.lastError);}catch(err){roadPreview=null;roadPreviewError=err.message||String(err);throw err;}}
      }
      else if(current.kind==='flatten-draw'){
        if(cancel)cancelFlattenPreview();
        else{try{flattenSession.finishDrawing();refreshFlattenPreview();status(flattenPreview?'Flatten ready. Adjust its height, width, reaches or profile, then Apply.':'Flatten needs a settings change before Apply.');if(flattenPreviewError)error(new Error(flattenPreviewError));else if(current.lastError)error(current.lastError);}catch(err){cancelFlattenPreview(false);status('Flatten path was not applied. Draw a longer valid path.');throw err;}}
      }
      else if(current.kind==='road-edit'){
        if(cancel){roadSession.restore(current.checkpoint);refreshRoadPreview();status('Handle movement canceled. Previous road preview kept.');}
        else{refreshRoadPreview();status(current.lastError?'Road preview kept at its last valid position.':'Road preview updated. Apply or Cancel when ready.');if(current.lastError)error(current.lastError);}
      }
      else if(current.kind==='landform'){if(cancel)status(current.options.mode==='path'?'Path gradient canceled. Images are unchanged.':'Mountain gesture canceled. Images and seed are unchanged.');else return prepareLandform(current.start,current.options,current.points);}
      else if(current.kind==='freehand'){if(cancel)status('Freehand selection cancelled.');else{doc.selectFreehand(current.points,{operation:current.operation});status(selectionStatus(current.operation));}}
      else if(['rectangle','ellipse'].includes(current.kind)){if(cancel)status('Selection drag canceled. Previous selection kept.');else{const a=current.start,b=current.last||a;if(current.kind==='rectangle'){const left=Math.max(0,Math.min(a.x,b.x)),top=Math.max(0,Math.min(a.y,b.y)),right=Math.min(doc.width-1,Math.max(a.x,b.x)),bottom=Math.min(doc.height-1,Math.max(a.y,b.y));if(left<=right&&top<=bottom){doc.selectRect(left,top,right,bottom,{operation:current.operation});status(selectionStatus(current.operation));}else status('Rectangle stayed outside the image. Previous selection kept.');}else{doc.selectEllipse(a.x,a.y,b.x,b.y,{operation:current.operation});status(selectionStatus(current.operation));}}}
      else if(current.kind==='pan'&&cancel){state.offsetX=current.ox;state.offsetY=current.oy;status('Pan canceled.');}
    });if(current.surface.hasPointerCapture(current.id))current.surface.releasePointerCapture(current.id);resizeViewport();syncUI();requestRender();
  }
  function commitPaintHeightInput(){
    const field=el('height'),key=slotKey('altitude'),next=field.valueAsNumber;
    if(!Number.isInteger(next)||next<-128||next>127){field.value=state[key];throw new Error('Use a whole altitude from -128 to 127. No painting was applied.');}
    state[key]=next;saveSettings();
  }
  function commitFocusedPathHeight(){
    const entry=pathFields.find(([id])=>document.activeElement===el(id));if(!entry)return true;
    const [id,key,min,max]=entry,field=el(id),next=field.valueAsNumber;
    if(!Number.isInteger(next)||next<min||next>max){field.value=state[key];status('Path gradient not started. Use a whole height from '+min+' to '+max+'.');syncUI();return false;}
    state[key]=next;saveSettings();syncUI();return true;
  }
  function commitRampInput(id){
    const entry={'ramp-start':['z',-128,127],'ramp-end':['secondaryZ',-128,127],'ramp-size':['size',1,64]}[id];
    if(!entry)return;const [key,min,max]=entry,field=el(id),next=field.valueAsNumber;
    if(!Number.isInteger(next)||next<min||next>max){field.value=state[key];throw new Error('Ramp not started. Use a whole '+(key==='size'?'width':'height')+' from '+min+' to '+max+'.');}
    state[key]=next;if(key!=='size')state.altitudeSlot=key==='z'?'primary':'secondary';saveSettings();
  }
  function fillSelectionFromMouse(event){
    if(decoMode&&doc.currentLayer==='terrain'){if(idle())edited(doc.fillDecoSelection(event.button===4?decoPrimary:decoSecondary),'Decoration selection fill');return;}
    if(!idle()||root.querySelector('dialog[open]'))return;
    if(!doc.selectionActive||doc.selection.indexOf(1)===-1){status('Select a nonempty area first. Mouse 5 uses Primary; Mouse 4 uses Secondary.');return;}
    // Side-button default suppression keeps input focus. Commit a valid typed
    // height before activating another canvas or syncUI can replace that text.
    if(document.activeElement===el('height')){commitPaintHeightInput();el('height').blur();}
    const canvas=surfaces.includes(event.target)?event.target:null;
    if(canvas)activateLayer(viewLayer(canvas));
    cancelLandformPreview(false);const slot=event.button===4?'primary':'secondary';
    edited(doc.fillSelection(slotValue(doc.currentLayer,slot)),(slot==='primary'?'Primary':'Secondary')+' selection fill');
    if(canvas){const p=point(event,canvas);if(inside(p))cursor={...p,visible:true};}pixelInfo(cursor);
  }
  root.addEventListener('mousedown',event=>{
    if(event.button===1){event.preventDefault();event.stopPropagation();return;}
    if(event.button!==3&&event.button!==4)return;
    event.preventDefault();event.stopPropagation();suppressSideAux.add(event.button);
    if(heldSideButtons.has(event.button))return;heldSideButtons.add(event.button);
    if(selectionTools.has(state.tool))safely(()=>fillSelectionFromMouse(event));
    else if(event.button===4&&idle()&&!root.querySelector('dialog[open]')&&surfaces.includes(event.target)){
      const canvas=event.target,p=point(event,canvas);
      if(inside(p)){const bounds=canvas.getBoundingClientRect();setZoom(13.37,{x:event.clientX-bounds.left,y:event.clientY-bounds.top});status('Mouse 5: 1337% zoom at the clicked point.');}
    }
  },{capture:true});
  function releaseSideButton(button){heldSideButtons.delete(button);setTimeout(()=>{if(!heldSideButtons.has(button))suppressSideAux.delete(button);},0);}
  root.addEventListener('pointermove',event=>{
    if(event.button!==3&&event.button!==4)return;
    // During a mouse chord, Pointer Events emits a transition move. The first
    // button's canceled pointerdown can suppress compatibility mousedown.
    event.preventDefault();if(event.buttons&(event.button===3?8:16)){heldSideButtons.add(event.button);suppressSideAux.add(event.button);}else releaseSideButton(event.button);
  },{capture:true});
  for(const type of ['pointerup','mouseup','auxclick'])window.addEventListener(type,event=>{
    if(event.button===1){if(root.contains(event.target)){event.preventDefault();event.stopPropagation();}return;}
    if(event.button!==3&&event.button!==4)return;
    const intercepted=heldSideButtons.has(event.button)||suppressSideAux.has(event.button)||root.contains(event.target);
    if(type!=='auxclick')releaseSideButton(event.button);else suppressSideAux.delete(event.button);
    if(intercepted){event.preventDefault();if(type!=='pointerup')event.stopPropagation();}
  },{capture:true});
  for(const canvas of surfaces){
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('pointerenter',()=>{hoveredSurface=canvas;});
  canvas.addEventListener('focus',()=>{if(idle())activateLayer(viewLayer(canvas));});
  canvas.addEventListener('pointerdown',e=>safely(()=>{
    // Selection fills use mousedown. Pencil's side-button eraser needs native
    // pointer capture, so it starts here and suppresses compatibility mousedown.
    if(e.button===4||(e.button===3&&state.tool!=='pencil'))return;
    if(e.button===1){e.preventDefault();if(idle()&&!root.querySelector('dialog[open]'))sample(point(e),viewLayer(canvas));return;}
    if(e.button===3){e.preventDefault();heldSideButtons.add(3);suppressSideAux.add(3);}
    if(!idle())return;stopZoom();const p=point(e),layer=viewLayer(canvas);
    if(e.button===0&&spaceHeld){e.preventDefault();drag={id:e.pointerId,surface:canvas,layer:doc.currentLayer,kind:'pan',temporaryPan:true,buttonMask:1,sx:e.clientX,sy:e.clientY,ox:state.offsetX,oy:state.offsetY};canvas.setPointerCapture(e.pointerId);syncUI();return;}
    if(altitudeTools.has(state.tool)&&layer==='terrain'&&e.button===0){e.preventDefault();status('Use the '+toolNames[state.tool]+' tool in the altitude image.');return;}
    if(state.tool==='blur'&&e.button===0){e.preventDefault();commitSmoothingInputs();if(smoothingPreview){status('Apply or Cancel the filter preview before using the brush.');return;}}
    if(state.tool==='path'&&e.button===0){e.preventDefault();if(!commitFocusedPathHeight())return;}
    if(state.tool==='ramp'&&e.button===0){e.preventDefault();commitRampInput(document.activeElement.id);}
    if(state.tool==='road'&&e.button===0){e.preventDefault();commitRoadInputs();}
    if(state.tool==='flatten'&&e.button===0){e.preventDefault();commitFlattenInputs();}
    if((e.button===0||e.button===2)&&state.tool==='pencil'&&document.activeElement===el('height')){commitPaintHeightInput();el('height').blur();}
    activateLayer(layer);canvas.focus({preventScroll:true});pixelInfo(p);
    if(!inside(p)&&!(['rectangle','freehand'].includes(state.tool)&&(e.button===0||e.button===2)))return;
    cancelLandformPreview(false);
    if(selectionTools.has(state.tool)&&(e.button===0||e.button===2)){
      e.preventDefault();cursor={...p,visible:false};const operation=e.button===2&&e.ctrlKey?'subtract':state.tool==='pixel'?'add':e.button===2&&doc.selectionActive?'add':'replace';
      if(operation==='subtract'&&!doc.selectionActive){status('No selection to remove pixels from.');return;}
      cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);
      if(state.tool==='wand'){const session=doc.createWandStroke(p.x,p.y,{operation,contiguous:state.connected,diagonal:state.continued,matchSurroundings:state.matchSurroundings});selectionStrokePreview=session;drag={id:e.pointerId,surface:canvas,layer,kind:'wand-select',buttonMask:e.button===2?2:1,operation,session};canvas.setPointerCapture(e.pointerId);syncUI();requestRender();return;}
      if(state.tool==='pixel'){
        const session=doc.createSelectionStroke(p.x,p.y,{operation});selectionStrokePreview=session;
        drag={id:e.pointerId,surface:canvas,layer,kind:'pixel-select',buttonMask:e.button===2?2:1,operation,session};canvas.setPointerCapture(e.pointerId);
        status((operation==='subtract'?'Removing':'Adding')+' selection pixels. Release to apply; Esc cancels.');syncUI();requestRender();return;
      }
      drag={id:e.pointerId,surface:canvas,layer,kind:state.tool,points:[p],buttonMask:e.button===2?2:1,start:p,last:p,operation};canvas.setPointerCapture(e.pointerId);syncUI();requestRender();return;
    }
    if(e.button===2&&state.tool!=='pencil'){e.preventDefault();sample(p);return;}if(e.button!==0&&!(state.tool==='pencil'&&(e.button===2||e.button===3)))return;e.preventDefault();cursor={...p,visible:false};
    if(state.tool==='road'){beginRoadPointer(e,canvas,p);return;}
    if(state.tool==='flatten'){beginFlattenPointer(e,canvas,p);return;}
    if(state.tool==='eyedropper'){sample(p);return;}
    if(state.tool==='fill'){edited(doc.flood(p.x,p.y,value(),{contiguous:state.connected,diagonal:state.continued,matchSurroundings:state.matchSurroundings}),'Fill');return;}
    if(state.tool==='gradient')return applyGradient(p);
    if(state.tool==='blur'){
      const session=doc.createBlurBrush(p.x,p.y,{radius:state.blurRadius,strength:state.blurStrength,size:state.blurSize});
      blurPreview=session;drag={id:e.pointerId,surface:canvas,layer,kind:'blur',buttonMask:1,session};canvas.setPointerCapture(e.pointerId);
      status('Blur brush preview. Release to apply; Escape cancels.');syncUI();pixelInfo(p);requestRender();return;
    }
    if(state.tool==='ramp'){
      if(doc.selectionActive&&doc.selection.indexOf(1)===-1){status('Selection is empty. Deselect or select some pixels before drawing a ramp.');return;}
      const session=doc.createRamp(p.x,p.y,{startZ:state.z,endZ:state.secondaryZ,size:state.size,sampleEnd:el('ramp-sample-mode').value==='sample'});
      rampPreview=session;drag={id:e.pointerId,surface:canvas,layer,kind:'ramp',buttonMask:1,session};canvas.setPointerCapture(e.pointerId);
      status('Ramp preview: drag to extend from Primary to Secondary. Release to apply; Escape cancels.');syncUI();pixelInfo(p);requestRender();return;
    }
    if(state.tool==='mountain'||state.tool==='path'){
      if((!doc.selectionActive&&!(state.tool==='mountain'&&state.landformMode==='range'))||!doc.selection[p.y*doc.width+p.x])throw new Error('Select an area first, then click inside that selection in the altitude image.');
      const options=state.tool==='path'?{mode:'path',baseZ:state.pathEdge,peakZ:state.pathHeight}:landformOptions();
      drag={id:e.pointerId,surface:canvas,layer,kind:'landform',buttonMask:1,start:p,points:[p],options};canvas.setPointerCapture(e.pointerId);syncUI();requestRender();return;
    }
    if(doc.selectionActive&&doc.selection.indexOf(1)===-1){selectionHintMask=null;status('Selection is empty. Deselect to paint freely, or make a new selection.');syncUI();return;}
    doc.beginStroke();drag={id:e.pointerId,surface:canvas,layer,kind:'paint',buttonMask:e.button===3?8:e.button===2?2:1,last:p,value:state.tool==='eraser'||e.button===3?UNSET:e.button===2?slotValue(layer,'secondary'):value(),size:state.size};canvas.setPointerCapture(e.pointerId);doc.paintLine(p.x,p.y,p.x,p.y,drag.value,drag.size);syncUI();requestRender();
  }));
  canvas.addEventListener('pointermove',e=>safely(()=>{
    if(drag&&(drag.id!==e.pointerId||drag.surface!==canvas))return;
    if(drag&&[1,3,4].includes(e.button)&&e.button!==gestureButton(drag)){e.preventDefault();return;}
    const p=point(e);pixelInfo(p);if(inside(p))cursor={...p,visible:true};else cursor.visible=false;
    const hoveredEdge=hitRoadControl(e,canvas,true);if(hoveredEdge){cursor.visible=false;const endpoint=roadSession.stitches[hoveredEdge.index][hoveredEdge.side];canvas.title=(hoveredEdge.side==='left'?'Left':'Right')+' edge · Z '+endpoint.z+' · '+grayHex(endpoint.z)+' · Wheel changes height';}else canvas.removeAttribute('title');requestRender();
    if(!drag)return;
    // A mouse may release its original button while another remains pressed.
    // Pointer Events reports that as a move, not pointerup. End only that drag.
    if(drag.kind==='freehand'){const last=drag.points[drag.points.length-1];if(last.x!==p.x||last.y!==p.y){if(drag.points.length>=20000){finish(true);throw Error('Outline too long. Try a shorter outline.');}drag.points.push(p);}if(!(e.buttons&drag.buttonMask))finish();requestRender();return;}
    if(!(e.buttons&drag.buttonMask)){if(['rectangle','ellipse'].includes(drag.kind))drag.last=drag.kind==='rectangle'?p:bounded(p);appendPaintPoint(p);appendSelectionPoint(p);appendRidgePoint(p);appendRampPoint(p);appendBlurPoint(p);appendRoadPoint(p);appendFlattenPoint(p);finish();return;}
    if(drag.kind==='pan'){state.offsetX=drag.ox+e.clientX-drag.sx;state.offsetY=drag.oy+e.clientY-drag.sy;requestRender();return;}
    if(['rectangle','ellipse'].includes(drag.kind)){drag.last=drag.kind==='rectangle'?p:bounded(p);requestRender();return;}
    if(['pixel-select','wand-select'].includes(drag.kind)){appendSelectionPoint(p);return;}
    if(drag.kind==='landform'){appendRidgePoint(p);requestRender();return;}
    if(drag.kind==='ramp'){appendRampPoint(p);return;}
    if(drag.kind==='blur'){appendBlurPoint(p);return;}
    if(drag.kind==='road-draw'||drag.kind==='road-edit'){appendRoadPoint(p);return;}
    if(drag.kind==='flatten-draw'){appendFlattenPoint(p);return;}
    appendPaintPoint(p);
  }));
  canvas.addEventListener('pointerup',e=>safely(()=>{if([1,3,4].includes(e.button))e.preventDefault();if(drag&&drag.id===e.pointerId&&drag.surface===canvas&&!(e.buttons&drag.buttonMask)&&e.button===gestureButton(drag)){if(drag.kind==='freehand')drag.points.push(point(e));if(['rectangle','ellipse'].includes(drag.kind))drag.last=drag.kind==='rectangle'?point(e):bounded(point(e));appendPaintPoint(point(e));appendSelectionPoint(point(e));appendRidgePoint(point(e));appendRampPoint(point(e));appendBlurPoint(point(e));appendRoadPoint(point(e));appendFlattenPoint(point(e));finish();}}));
  canvas.addEventListener('pointercancel',e=>{if(drag&&drag.id===e.pointerId&&drag.surface===canvas){if(drag.buttonMask===8)releaseSideButton(3);finish(true);}});
  canvas.addEventListener('lostpointercapture',e=>{if(drag&&drag.id===e.pointerId&&drag.surface===canvas)finish(true);});
  canvas.addEventListener('pointerleave',()=>{if(hoveredSurface===canvas)hoveredSurface=null;if(!drag){cursor.visible=false;requestRender();}});
  canvas.addEventListener('wheel',e=>{e.preventDefault();if(!idle()||!e.deltaY)return;
    const hit=hitRoadControl(e,canvas,true);if(hit){safely(()=>{stopZoom();selectRoadHandle(hit.index,hit.side);const step=e.ctrlKey?10:1;changeRoadEdgeZ(Math.max(-128,Math.min(127,roadEdge().z+(e.deltaY<0?step:-step))));const edge=roadEdge();canvas.title=(hit.side==='left'?'Left':'Right')+' edge · Z '+edge.z+' · '+grayHex(edge.z)+' · Wheel changes height';});return;}
    const r=canvas.getBoundingClientRect(),step=e.ctrlKey ? .1 : .01;
    const target=Math.max(.015625,Math.min(32,Math.round((state.zoomTarget+(e.deltaY<0?step:-step))*1000000)/1000000));
    animateZoom(target,{x:e.clientX-r.left,y:e.clientY-r.top});
  },{passive:false});
  }
  function spacePanTarget(event){
    if(root.querySelector('dialog[open]')||event.ctrlKey||event.altKey||event.metaKey)return false;
    const target=event.target instanceof Element?event.target:null;
    if(target&&target.closest('input,textarea,select,[contenteditable],[role="textbox"],[role="combobox"],[role="spinbutton"]'))return false;
    if(hoveredSurface)return true;
    if(target&&target.closest('button,a,summary,[role="button"]'))return false;
    return target===document.body||target===document.documentElement||root.contains(target);
  }
  window.addEventListener('keydown',event=>{
    if(event.code!=='Space'&&event.key!==' ')return;
    if(spaceHeld){event.preventDefault();event.stopPropagation();return;}
    if(!spacePanTarget(event))return;
    event.preventDefault();event.stopPropagation();if(event.repeat||!idle())return;
    spaceHeld=true;syncUI();
  },{capture:true});
  window.addEventListener('keyup',event=>{
    if(event.code!=='Space'&&event.key!==' ')return;
    if(!spaceHeld)return;event.preventDefault();event.stopPropagation();spaceHeld=false;
    if(drag&&drag.temporaryPan)finish();syncUI();
  },{capture:true});
  window.addEventListener('blur',()=>{spaceHeld=false;hoveredSurface=null;heldSideButtons.clear();suppressSideAux.clear();finish(true);syncUI();if(smoothingJob){smoothingJob.canceled=true;status('Filter preview canceled. Images are unchanged.');}if(landformJob){landformJob.canceled=true;status(landformJob.mode==='path'?'Path gradient canceled. Images are unchanged.':'Mountain generation canceled. Images and seed are unchanged.');}});
  window.addEventListener('resize',()=>{if(drag)finish(true);resizeViewport();});
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!root.querySelector('dialog[open]')&&(drag||landformJob||landformPreview||smoothingJob||smoothingPreview||roadSession||flattenSession)){e.preventDefault();e.stopPropagation();const keepFilter=smoothingPreview&&drag&&drag.kind==='pan',keepRoad=roadSession&&drag&&['pan','road-edit'].includes(drag.kind),keepFlatten=flattenSession&&drag&&drag.kind==='pan';finish(true);if(smoothingJob){smoothingJob.canceled=true;status('Filter preview canceled. Images are unchanged.');}if(landformJob){landformJob.canceled=true;status(landformJob.mode==='path'?'Path gradient canceled. Images are unchanged.':'Mountain generation canceled. Images and seed are unchanged.');}cancelLandformPreview();if(!keepFilter)cancelSmoothingPreview();if(!keepRoad)cancelRoadPreview();if(!keepFlatten)cancelFlattenPreview();}},{capture:true});
  overview.addEventListener('pointerdown',e=>{if(!idle()||e.button!==0)return;e.preventDefault();stopZoom();overview.focus({preventScroll:true});drag={id:e.pointerId,surface:overview,kind:'pan',overview:true,buttonMask:1,ox:state.offsetX,oy:state.offsetY};overview.setPointerCapture(e.pointerId);navigateOverview(e);syncUI();});
  overview.addEventListener('pointermove',e=>{if(!drag||!drag.overview||drag.id!==e.pointerId)return;if(!(e.buttons&drag.buttonMask)){finish();return;}navigateOverview(e);});
  overview.addEventListener('pointerup',e=>{if(e.button===3||e.button===4){e.preventDefault();return;}if(drag&&drag.overview&&drag.id===e.pointerId&&e.button===0&&!(e.buttons&drag.buttonMask)){navigateOverview(e);finish();status('Overview: moved both views.');}});
  for(const event of ['pointercancel','lostpointercapture'])overview.addEventListener(event,e=>{if(drag&&drag.overview&&drag.id===e.pointerId)finish(true);});
  overview.addEventListener('keydown',e=>{if(!idle()||e.ctrlKey||e.altKey||e.metaKey)return;const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!moves[e.key]&&e.key!=='Home')return;e.preventDefault();e.stopPropagation();stopZoom();
    if(e.key==='Home')centerMapAt({x:doc.width/2,y:doc.height/2});else{const view=viewportBounds(),[dx,dy]=moves[e.key];state.offsetX-=dx*Math.max(state.zoom,view.width/4);state.offsetY-=dy*Math.max(state.zoom,view.height/4);cursor.visible=false;requestRender();}
    status('Overview: moved both views.');
  });
  function dispatch(action){if(!idle())return;if(decoMode&&altitudeTools.has(action))decoButton.click();safely(()=>{
    if(action==='flatten'&&state.tool==='flatten'&&flattenSession){status('Flatten preview kept. Adjust the controls, then Apply or Cancel.');activeSurface('altitude').focus({preventScroll:true});return;}
    if(action==='save-project'&&flattenSession){status('Apply or Cancel the Flatten preview before saving.');return;}
    if(action==='undo'&&flattenSession){cancelFlattenPreview();return;}
    cancelFlattenPreview(false);
    if(action==='road'&&state.tool==='road'&&roadSession){status('Road preview kept. Adjust its points and stitches, then Apply or Cancel.');activeSurface('altitude').focus({preventScroll:true});return;}
    if(action==='save-project'&&roadSession){status('Apply or Cancel the road preview before saving.');return;}
    if(action==='undo'&&roadSession){cancelRoadPreview();return;}
    cancelRoadPreview(false);
    if(action==='blur'&&state.tool==='blur'&&smoothingPreview){status('Filter preview kept. Apply or Cancel before using the brush.');activeSurface().focus({preventScroll:true});return;}
    if(action==='save-project'&&smoothingPreview){status('Apply or Cancel the filter preview before saving.');return;}
    const discardedFilter=cancelSmoothingPreview(false);
    cancelLandformPreview(false);
    selectionHintMask=null;
    if(Object.hasOwn(toolNames,action)){state.tool=action;if(altitudeTools.has(action)){doc.currentLayer='altitude';altitudeTarget=action==='gradient'?'gradientCenter':action==='path'?'pathHeight':['ramp','blur','road','flatten'].includes(action)?'z':'landformPeak';el('pixel-info').textContent=action==='flatten'?'Draw a level road; its slopes meet the existing mountain.':action==='road'?'Draw a road, then bend points and angle each stitch independently.':action==='blur'?'Left-drag to blur altitude, or preview Blur/Melt filters.':action==='ramp'?'Left-drag a live ramp from Primary to Secondary.':action==='path'?'Draw a new path inside the selected area.':'Click inside a selected shape to place the peak or depression.';}status(action==='flatten'?'Draw a road path in altitude. Release, adjust the controls, then Apply.':action==='road'?'Draw a road in the altitude image. Release to bend its points and edit independent stitch dots. Terrain updates when applied if Linked painting is on.':action==='blur'?'Left-drag to blur altitude. Release applies one edit; Escape cancels. Filters preview before Apply.':action==='gradient'?'Set Edge Z and Clicked point Z, then click inside the selected shape.':action==='ramp'?'Primary starts the ramp; Secondary ends it. Left-drag for a live preview, release to apply.':action==='path'?'Set Path height and Edge height, then drag a new line through the selected altitude area.':action==='mountain'?'Select an area. Choose Mountain or Hills and click, or choose Ridge and drag a line.':toolNames[action]+' selected.');saveSettings();}
    else if(action==='select-all')doc.selectAll();else if(action==='deselect'){doc.deselect();status('Selection removed. Painting is unrestricted.');}else if(action==='invert-selection')doc.invertSelection();
    else if(action==='undo'){if(doc.undo()){dirty=true;status('Undid the last change.');}}else if(action==='redo'){if(doc.redo()){dirty=true;status('Redid the last change.');}}
    else if(action==='save-project')saveProject();if(discardedFilter)status('Filter preview canceled. '+el('status').textContent);syncUI();requestRender();activeSurface().focus({preventScroll:true});
    if(Object.hasOwn(toolNames,action)&&doc.currentLayer==='altitude')el('inspector-controls').scrollTop=0;
  });}
  root.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>dispatch(b.dataset.tool)));
  for(const slot of ['primary','secondary'])el(slot+'-color').addEventListener('click',()=>chooseColorSlot(slot));
  // Previews are disposable views, never part of an export or a later edit.
  // View controls can move/inspect a preview without generating another seed.
  root.addEventListener('click',e=>{const button=e.target.closest('button');if(landformPreview&&button&&!['ai-theme','landform-apply','landform-cancel','path-apply','path-cancel','fit','fit-pixels','primary-color','secondary-color'].includes(button.id))cancelLandformPreview(false);},{capture:true});
  root.addEventListener('change',e=>{if(landformPreview&&!['grid-visible','selection-visible','zoom','view-layout','altitude-target','selection-snapshot-list','selection-snapshot-name','linked-painting'].includes(e.target.id))cancelLandformPreview(false);},{capture:true});
  for(const [id,action]of [['select-all','select-all'],['deselect','deselect'],['invert','invert-selection'],['undo','undo'],['redo','redo']])el(id).addEventListener('click',()=>dispatch(action));
  el('fill-selection').addEventListener('click',()=>{if(idle())safely(()=>{cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);edited(doc.fillSelection(value()),'Paint selection');});});
  el('selection-pixels').addEventListener('change',()=>{if(!idle())return;const pixels=el('selection-pixels').valueAsNumber;if(Number.isInteger(pixels)&&pixels>=1&&pixels<=8192){state.selectionPixels=pixels;saveSettings();}});
  for(const direction of ['expand','contract'])el(direction+'-selection').addEventListener('click',()=>safely(()=>resizeSelection(direction)));
  el('layer').addEventListener('change',()=>{if(!idle()){syncUI();return;}const layer=el('layer').value;cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);doc.currentLayer=layer;cursor.visible=false;el('pixel-info').textContent='One pixel = one map cell · '+doc.currentLayer+' image';syncUI();if(doc.currentLayer==='altitude')el('inspector-controls').scrollTop=0;requestRender();status('Editing '+doc.currentLayer+' image.'+(state.linkedPainting?' Applied edits also update the other image.':' The other image is preserved.'));});
  el('view-layout').addEventListener('change',()=>setLayout(el('view-layout').value));
  el('linked-painting').addEventListener('change',()=>safely(()=>{if(idle()){
    const enabled=el('linked-painting').checked,canceled=!!(landformPreview||smoothingPreview||roadSession||flattenSession);
    cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);
    doc.setPaintLink(enabled?paintLink:null);state.linkedPainting=enabled;saveSettings();
    status(canceled?'Linked painting changed; preview canceled. Draw or preview again.':enabled?'Linked painting on. Terrain updates when height edits are applied.':'Linked painting off. Edits leave the other image unchanged.');
  }syncUI();}));
  for(const [id,canvas]of [['primary-view-title',surface],['altitude-view-title',altitudeSurface]])el(id).addEventListener('click',()=>{if(activateLayer(viewLayer(canvas)))canvas.focus({preventScroll:true});});
  el('brush-size').addEventListener('change',()=>{if(!idle())return;state.size=Math.max(1,Math.min(64,Math.round(Number(el('brush-size').value)||1)));syncUI();saveSettings();});
  el('height').addEventListener('change',()=>safely(()=>{if(!idle())return;commitPaintHeightInput();syncUI();}));
  for(const [id,key]of [['gradient-edge','gradientEdge'],['gradient-center','gradientCenter']])el(id).addEventListener('change',()=>{if(!idle())return;state[key]=Math.max(-128,Math.min(127,Math.round(Number(el(id).value)||0)));syncUI();saveSettings();});
  el('gradient-swap').addEventListener('click',()=>{if(!idle())return;[state.gradientEdge,state.gradientCenter]=[state.gradientCenter,state.gradientEdge];syncUI();saveSettings();});
  for(const [id,key,min,max,integer]of [...landformFields,...pathFields])el(id).addEventListener('change',()=>safely(()=>{
    if(!idle()){el(id).value=state[key];return;}const next=el(id).valueAsNumber;
    if(!Number.isFinite(next)||next<min||next>max||(integer&&!Number.isInteger(next))){el(id).value=state[key];throw new Error('Use '+(integer?'a whole number':'a number')+' from '+min+' to '+max+' for '+el(id).closest('label').textContent.trim()+'.');}
    state[key]=next;syncUI();saveSettings();
  }));
  el('landform-mode').addEventListener('change',()=>{if(!idle())return;const mode=el('landform-mode').value;if(['range','mountain','hills','ridge'].includes(mode))state.landformMode=mode;syncUI();saveSettings();});
  for(const [id,key]of [['landform-random','landformRandom'],['landform-preview-first','landformPreviewFirst'],['path-preview-first','pathPreviewFirst']])el(id).addEventListener('change',()=>{if(!idle())return;state[key]=el(id).checked;syncUI();saveSettings();});
  el('landform-apply').addEventListener('click',()=>safely(applyLandformPreview));el('landform-cancel').addEventListener('click',()=>cancelLandformPreview());
  el('path-apply').addEventListener('click',()=>safely(applyLandformPreview));el('path-cancel').addEventListener('click',()=>cancelLandformPreview());
  for(const id of ['ramp-start','ramp-end','ramp-size'])el(id).addEventListener('change',()=>safely(()=>{if(!idle())return;commitRampInput(id);syncUI();}));
  for(const [id,slot]of [['ramp-start','primary'],['ramp-end','secondary']])el(id).addEventListener('focus',()=>{if(!idle())return;state.altitudeSlot=slot;syncUI();saveSettings();});
  el('grid-visible').addEventListener('change',()=>{state.grid=el('grid-visible').checked;syncUI();requestRender();saveSettings();});
  el('selection-visible').addEventListener('change',()=>{state.selectionOutline=el('selection-visible').checked;syncUI();requestRender();saveSettings();});
  for(const [id,change]of [['height-minus',-1],['height-plus',1],['height-zero',0]])el(id).addEventListener('click',()=>{if(!idle())return;const key=slotKey('altitude');state[key]=change===0?0:Math.max(-128,Math.min(127,state[key]+change));syncUI();saveSettings();});
  el('connected').addEventListener('change',()=>{if(idle())state.connected=el('connected').checked;syncUI();});
  el('match-surroundings').addEventListener('change',()=>{if(idle()&&!state.connected)state.matchSurroundings=el('match-surroundings').checked;syncUI();});
  el('continued').addEventListener('change',()=>{if(idle()&&state.connected)state.continued=el('continued').checked;syncUI();});
  el('terrain-search').addEventListener('input',paletteList);el('fit').addEventListener('click',()=>{if(idle())fit();});el('zoom').addEventListener('change',()=>{if(idle())setZoom(Number(el('zoom').value));});
  el('fit-pixels').addEventListener('click',()=>{if(idle()){setZoom(13.37);status('Fit pixels: 1337%. Fit map shows the whole map again.');}});
  function download(bytes,filename,type){const url=URL.createObjectURL(new Blob([bytes],{type})),link=document.createElement('a');link.download=filename;link.href=url;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function basename(){return name.replace(/\.[^.]*$/,'').replace(/[<>:"/\\|?*]/g,'_')||'uo-map';}
  async function encodeMapPNG(layer){
    const output=document.createElement('canvas');
    try{const pixels=layer==='deco'?doc.exportDecoRGBA(decoEntries):doc.exportRGBA(layer);output.width=doc.width;output.height=doc.height;const c=output.getContext('2d');c.putImageData(new ImageData(pixels,doc.width,doc.height),0,0);const blob=await new Promise(resolve=>output.toBlob(resolve,'image/png'));if(!blob)throw new Error('PNG encoding failed. Save the project before retrying.');return blob;}
    finally{output.width=output.height=1;}
  }
  function checkImagesComplete(){
    for(const layer of ['terrain','altitude']){const i=doc[layer].indexOf(UNSET);if(i!==-1)throw new Error('Unset '+layer+' pixel at ('+(i%doc.width)+', '+Math.floor(i/doc.width)+'); complete both images before saving. Save project can keep unfinished work.');}
  }
  function pickSaveFolder(){return window.showDirectoryPicker({id:'uo-map-images',mode:'readwrite',startIn:saveDirectory||'documents'});}
  function folderAccessFailure(err){return err&&['NotAllowedError','SecurityError','NotFoundError'].includes(err.name);}
  function explainFolderAccess(err){
    const explained=new Error((err.message||String(err))+' Choose another folder with Save location, or use Download PNGs to get both images in a ZIP.');
    explained.name=err.name||'Error';explained.cause=err;
    for(const key of ['folderName','incompleteFolderRemains','cleanupErrors'])if(Object.hasOwn(err,key))explained[key]=err[key];
    return explained;
  }
  async function chooseSaveLocation(){
    if(!idle()||!canPickSaveFolder())return;isBusy=true;syncUI();
    try{const chosen=await pickSaveFolder();saveDirectory=chosen;status('Map images will save into new folders inside '+chosen.name+'.');}
    catch(err){if(err.name==='AbortError')status('Save location unchanged.');else if(folderAccessFailure(err)){saveDirectory=null;status('The browser could not open that folder.');throw explainFolderAccess(err);}else throw err;}
    finally{isBusy=false;resizeViewport();syncUI();}
  }
  async function saveMapImages(downloadOnly=false){
    if(typeof downloadOnly!=='boolean')throw new TypeError('Choose folder save or explicit image download.');
    if(flattenSession){status('Apply or Cancel the Flatten preview before saving.');return;}if(roadSession){status('Apply or Cancel the road preview before saving.');return;}
    if(smoothingPreview){status('Apply or Cancel the filter preview before saving.');return;}
    if(!idle())return;cancelLandformPreview(false);checkImagesComplete();stopZoom();isBusy=true;syncUI();
    let parent=downloadOnly?null:saveDirectory,zipFallback=downloadOnly||!canPickSaveFolder();
    try{
      if(!zipFallback){
        if(!parent){
          try{parent=await pickSaveFolder();saveDirectory=parent;}
          catch(err){if(err.name==='AbortError'){status('Map-image save canceled. No files were written.');return;}if(err.name==='NotSupportedError')zipFallback=true;else throw err;}
        }else if(typeof parent.queryPermission==='function'&&await parent.queryPermission({mode:'readwrite'})!=='granted'){
          if(typeof parent.requestPermission!=='function'||await parent.requestPermission({mode:'readwrite'})!=='granted'){const denied=new Error('Folder access was not granted.');denied.name='NotAllowedError';throw denied;}
        }
      }
      status('Preparing Terrain.png, Heightmap.png and Decorations.png…');
      // Both complete, exact images must encode successfully before a folder or file is created.
      const files=[{name:'Terrain.png',blob:await encodeMapPNG('terrain')},{name:'Heightmap.png',blob:await encodeMapPNG('altitude')},{name:'Decorations.png',blob:await encodeMapPNG('deco')}];
      if(zipFallback){
        const folderName=window.MapImageSave.makeFolderName();
        const entries=[];for(const file of files)entries.push({name:file.name,data:new Uint8Array(await file.blob.arrayBuffer())});
        const zip=window.MapImageSave.createZip(folderName,entries);download(zip,folderName+'.zip','application/zip');
        status((downloadOnly?'':'Folder saving is unavailable in this browser. ')+'Requested '+folderName+'.zip containing Terrain.png, Heightmap.png and Decorations.png; extract it to use the new folder.');
      }else{
        const saved=await window.MapImageSave.writeNewFolder(parent,files);
        status('Saved Terrain.png, Heightmap.png and Decorations.png in '+parent.name+' / '+saved.folderName+'.');
      }
    }catch(err){if(!downloadOnly&&folderAccessFailure(err)){saveDirectory=null;status('Folder save was not completed.');throw explainFolderAccess(err);}throw err;}
    finally{isBusy=false;resizeViewport();syncUI();}
  }
  function downloadMapImages(){return saveMapImages(true);}
  function saveProject(){if(!idle())return;if(flattenSession){status('Apply or Cancel the Flatten preview before saving.');return;}if(roadSession){status('Apply or Cancel the road preview before saving.');return;}if(smoothingPreview){status('Apply or Cancel the filter preview before saving.');return;}cancelLandformPreview(false);download(doc.saveProject(),basename()+'.uomapimage','application/octet-stream');status('Project download requested. It contains both images, decoration markers, material IDs, unset pixels and named selection snapshots.');}
  el('save-project').addEventListener('click',()=>safely(saveProject));el('save-map-images').addEventListener('click',()=>safely(()=>saveMapImages()));el('download-map-images').addEventListener('click',()=>safely(downloadMapImages));el('save-location').addEventListener('click',()=>safely(chooseSaveLocation));
  function replaceDocument(next,nextName){if(window.MapRecipeUI?.recording)throw new Error('Stop or discard the recording before replacing this map.');if(drag&&['ramp','blur','road-draw','road-edit','pixel-select','wand-select','flatten-draw'].includes(drag.kind))finish(true);cancelLandformPreview(false);cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);if(smoothingJob)smoothingJob.canceled=true;if(landformJob)landformJob.canceled=true;next.setPaintLink(state.linkedPainting?paintLink:null);doc=next;protectedRoadMask=null;name=nextName||'Untitled map';dirty=false;cursor={x:0,y:0,visible:false};el('pixel-info').textContent='One pixel = one map cell · '+doc.currentLayer+' image';syncUI();fit();status('Map images opened. One pixel is one map cell.');}
  function requestReplace(action){if(!idle())return;if(!dirty&&!roadSession&&!flattenSession){safely(action);return;}pendingReplace=action;el('replace-dialog').showModal();}
  el('replace-save').addEventListener('click',()=>safely(saveProject));el('replace-confirm').addEventListener('click',()=>{const action=pendingReplace;pendingReplace=null;el('replace-dialog').close();safely(()=>action&&action());});el('replace-cancel').addEventListener('click',()=>{pendingReplace=null;el('replace-dialog').close();});el('replace-dialog').addEventListener('cancel',()=>{pendingReplace=null;});
  el('new').addEventListener('click',()=>{if(!idle())return;el('new-error').textContent='';el('new-dialog').showModal();});el('cancel-new').addEventListener('click',()=>el('new-dialog').close());
  el('size-preset').replaceChildren(...window.MapImageGenerator.PRESETS.map(p=>new Option(p.label+' — '+p.width+' × '+p.height,p.width+','+p.height)),new Option('Custom dimensions','custom'));
  el('size-preset').value='1448,1448';
  for(const id of ['new-width','new-height'])el(id).addEventListener('input',()=>{el('size-preset').value='custom';});
  el('size-preset').addEventListener('change',()=>{if(el('size-preset').value==='custom')return;const [w,h]=el('size-preset').value.split(',');el('new-width').value=w;el('new-height').value=h;});
  el('create-map').addEventListener('click',()=>{const w=Number(el('new-width').value),h=Number(el('new-height').value);try{if(!Number.isInteger(w)||!Number.isInteger(h)||w<8||h<8||w>8192||h>8192||w%8||h%8||w*h>33554432)throw new Error('Use dimensions 8–8192 in multiples of 8, with at most 33,554,432 pixels.');el('new-dialog').close();requestReplace(()=>replaceDocument(new MapPaintDocument(w,h,materials),'Untitled map'));}catch(err){el('new-error').textContent=err.message;}});
  const imageGenerator=window.MapImageGenerator;
  for(const preset of imageGenerator.PRESETS)el('generate-preset').add(new Option(preset.label+' — '+preset.width+' × '+preset.height,preset.key));
  el('generate-preset').add(new Option('Custom dimensions','custom'));
  for(const material of materials){
    if(materials.filter(other=>other.r===material.r&&other.g===material.g&&other.b===material.b).length!==1)continue;
    const hex=[material.r,material.g,material.b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
    el('generate-terrain').add(new Option(material.name+' — #'+hex,String(material.id)));
  }
  el('generate-preset').value='tokuno';el('generate-terrain').value=String(grass.id);
  function generationOptions(){return {preset:el('generate-preset').value,width:el('generate-width').valueAsNumber,height:el('generate-height').valueAsNumber,materialId:Number(el('generate-terrain').value),z:el('generate-z').valueAsNumber};}
  function updateGenerationInfo(){
    try{const info=imageGenerator.validate(materials,generationOptions());el('generate-info').textContent=info.width.toLocaleString()+' × '+info.height.toLocaleString()+' • '+info.pixels.toLocaleString()+' pixels per image.\nTerrain.png: exact palette colors. Heightmap.png: gray '+info.shade+' = Z '+info.z+'.\nMap file: '+info.files+'. Match this size and target in your server/client and the builder.';el('generate-error').textContent='';el('generate-confirm').disabled=!idle();}
    catch(err){el('generate-info').textContent='';el('generate-error').textContent=err.message;el('generate-confirm').disabled=true;}
  }
  el('generate-images').addEventListener('click',()=>{if(!idle())return;updateGenerationInfo();el('generate-dialog').showModal();});
  el('generate-preset').addEventListener('change',()=>{const preset=imageGenerator.PRESETS.find(p=>p.key===el('generate-preset').value);if(preset){el('generate-width').value=preset.width;el('generate-height').value=preset.height;}updateGenerationInfo();});
  for(const id of ['generate-width','generate-height'])el(id).addEventListener('input',()=>{el('generate-preset').value='custom';updateGenerationInfo();});
  for(const id of ['generate-terrain','generate-z'])el(id).addEventListener('input',updateGenerationInfo);
  el('generate-cancel').addEventListener('click',()=>el('generate-dialog').close());
  async function generateImages(options){
    if(!idle())return;stopZoom();isBusy=true;syncUI();status('Generating complete terrain and heightmap images…');
    try{
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
      const generated=imageGenerator.create(MapPaintDocument,materials,options);
      replaceDocument(generated.document,generated.settings.label);dirty=true;syncUI();requestRender();
      status('Generated '+generated.settings.width+' × '+generated.settings.height+' images: '+generated.settings.terrainName+', Z '+generated.settings.z+'. Save map images writes Terrain.png, Heightmap.png and Decorations.png into a new folder.');
    }finally{isBusy=false;resizeViewport();syncUI();}
  }
  el('generate-confirm').addEventListener('click',()=>{
    try{const options=generationOptions();imageGenerator.validate(materials,options);el('generate-dialog').close();requestReplace(()=>generateImages(options));}
    catch(err){el('generate-error').textContent=err.message;}
  });
  el('open-project').addEventListener('click',()=>{if(idle())el('project-file').click();});el('project-file').addEventListener('change',()=>safely(async()=>{const file=el('project-file').files[0];el('project-file').value='';if(!file)return;if(file.size>MAX_PROJECT_BYTES)throw new Error('This project exceeds the supported file size.');const bytes=new Uint8Array(await file.arrayBuffer());const next=MapPaintDocument.loadProject(bytes,materials);requestReplace(()=>replaceDocument(next,file.name));}));
  for(const layer of ['terrain','altitude'])el('import-'+layer).addEventListener('click',()=>{if(idle()){importLayer=layer;el('image-file').click();}});
  el('image-file').addEventListener('change',()=>safely(async()=>{
    const file=el('image-file').files[0],layer=importLayer;el('image-file').value='';if(!file)return;if(!/\.(png|bmp)$/i.test(file.name))throw new Error('Use a lossless UO terrain or altitude PNG/BMP.');
    cancelSmoothingPreview(false);cancelRoadPreview(false);cancelFlattenPreview(false);const target=doc;isBusy=true;syncUI();let bitmap;
    try{bitmap=await createImageBitmap(file,{colorSpaceConversion:'none',premultiplyAlpha:'none'});if(bitmap.width!==target.width||bitmap.height!==target.height)throw new Error('Image is '+bitmap.width+' × '+bitmap.height+'. Create a map with those dimensions first; this map is '+target.width+' × '+target.height+'. No resizing was performed.');const temp=document.createElement('canvas');temp.width=bitmap.width;temp.height=bitmap.height;const c=temp.getContext('2d',{willReadFrequently:true});c.imageSmoothingEnabled=false;c.drawImage(bitmap,0,0);const pixels=c.getImageData(0,0,temp.width,temp.height).data;const stats=target.importRGBA(pixels,target.width,target.height,layer);target.currentLayer=layer;edited(stats,'Import '+layer);temp.width=1;temp.height=1;}
    finally{if(bitmap)bitmap.close();isBusy=false;resizeViewport();syncUI();requestRender();}
  }));
  for(const canvas of surfaces)canvas.addEventListener('keydown',e=>safely(()=>{
    if(!idle())return;const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if(!e.ctrlKey&&!e.altKey&&!e.metaKey&&moves[e.key]){e.preventDefault();e.stopPropagation();activateLayer(viewLayer(canvas));const [dx,dy]=moves[e.key];cursor={x:Math.max(0,Math.min(doc.width-1,cursor.x+dx)),y:Math.max(0,Math.min(doc.height-1,cursor.y+dy)),visible:true};pixelInfo(cursor);requestRender();}
    if(e.key==='Enter'&&!e.repeat&&!e.ctrlKey&&!e.altKey&&!e.metaKey){e.preventDefault();if(altitudeTools.has(state.tool)&&viewLayer(canvas)!=='altitude'){status('Use the '+toolNames[state.tool]+' tool in the altitude image.');return;}activateLayer(viewLayer(canvas));if(state.tool==='flatten'){if(flattenSession)return applyFlattenPreview();status('Draw a Flatten path, then adjust the controls and Apply.');return;}if(state.tool==='road'){if(roadSession)return applyRoadPreview();status('Draw a road, then edit its curve and stitch dots before Apply.');return;}if(state.tool==='blur'){status(smoothingPreview?'Use Apply to commit the filter, or Cancel to discard it.':'Left-drag to blur altitude, or preview a filter from the sidebar.');return;}if(state.tool==='ramp'){status('Left-drag a ramp from Primary to Secondary. Release to apply; Escape cancels.');return;}if(state.tool==='path'){if(landformPreview)return applyLandformPreview();status('Drag a new path inside the selected altitude area.');return;}if(state.tool==='mountain'){if(landformPreview)return applyLandformPreview();if(state.landformMode==='ridge'){status('Drag a ridge line inside the selected altitude area.');return;}return prepareLandform(cursor,landformOptions());}cancelLandformPreview(false);if(['wand','pixel'].includes(state.tool))selectPoint(cursor);else if(state.tool==='eyedropper')sample(cursor);else if(state.tool==='fill')edited(doc.flood(cursor.x,cursor.y,value(),{contiguous:state.connected,diagonal:state.continued,matchSurroundings:state.matchSurroundings}),'Fill');else if(state.tool==='gradient')return applyGradient(cursor);else if(['pencil','eraser'].includes(state.tool)){doc.beginStroke();doc.paintLine(cursor.x,cursor.y,cursor.x,cursor.y,state.tool==='eraser'?UNSET:value(),state.size);edited(doc.endStroke(),'Paint');}}
  }));
  root.addEventListener('keydown',e=>{if(root.querySelector('dialog[open]'))return;const action=matchShortcut(e,state.bindings,{allowInteractiveTarget:surfaces.includes(e.target)});if(action){e.preventDefault();dispatch(action);}});
  let shortcutAction='pencil',draft=state.bindings.pencil,recording=false;
  for(const [id,label]of Object.entries(actionNames))el('shortcut-action').add(new Option(label,id));
  function renderShortcut(){el('shortcut-action').value=shortcutAction;el('shortcut-chord').textContent=recording?'Listening…':draft||'Unassigned';el('record').textContent=recording?'Cancel recording':'Record keys';const check=assignShortcut(state.bindings,shortcutAction,draft);el('assign').disabled=recording||!check.ok||draft===(state.bindings[shortcutAction]||'');el('remove-binding').disabled=recording||!state.bindings[shortcutAction];}
  function cancelRecord(){recording=false;draft=state.bindings[shortcutAction]||'';renderShortcut();}
  el('shortcuts').addEventListener('click',()=>{if(!idle())return;cancelRecord();el('shortcuts-status').textContent='Choose an action and record a key combination.';el('shortcut-dialog').showModal();});el('close-shortcuts').addEventListener('click',()=>{cancelRecord();el('shortcut-dialog').close();activeSurface().focus();});el('shortcut-dialog').addEventListener('cancel',cancelRecord);
  el('shortcut-action').addEventListener('change',()=>{shortcutAction=el('shortcut-action').value;cancelRecord();});el('record').addEventListener('click',()=>{if(recording){cancelRecord();return;}recording=true;renderShortcut();el('record').focus();});el('record').addEventListener('blur',()=>{if(recording)cancelRecord();});
  el('record').addEventListener('keydown',e=>{if(!recording)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelRecord();return;}if(e.key==='Tab'){cancelRecord();return;}const chord=shortcutFromEvent(e);if(!chord)return;e.preventDefault();e.stopPropagation();recording=false;draft=chord;const check=assignShortcut(state.bindings,shortcutAction,draft);el('shortcuts-status').textContent=check.ok?'Ready to assign '+chord+'.':check.message;renderShortcut();});
  el('assign').addEventListener('click',()=>{const check=assignShortcut(state.bindings,shortcutAction,draft);if(check.ok){state.bindings=check.bindings;saveSettings();syncUI();renderShortcut();el('shortcuts-status').textContent='Shortcut assigned.';}});el('remove-binding').addEventListener('click',()=>{const check=assignShortcut(state.bindings,shortcutAction,'');if(check.ok){state.bindings=check.bindings;draft='';saveSettings();syncUI();renderShortcut();}});
  function saveSettings(){try{localStorage.setItem('uo-map-paint.settings.v1',JSON.stringify({bindings:state.bindings,layout:state.layout,linkedPainting:state.linkedPainting,material:state.material,secondaryMaterial:state.secondaryMaterial,z:state.z,secondaryZ:state.secondaryZ,terrainSlot:state.terrainSlot,altitudeSlot:state.altitudeSlot,size:state.size,selectionPixels:state.selectionPixels,gradientEdge:state.gradientEdge,gradientCenter:state.gradientCenter,...Object.fromEntries([...landformFields,...pathFields,...smoothingFields,...roadFields,...distortFields,...flattenFields].map(([,key])=>[key,state[key]])),landformMode:state.landformMode,landformRandom:state.landformRandom,landformPreviewFirst:state.landformPreviewFirst,pathPreviewFirst:state.pathPreviewFirst,distortRandom:state.distortRandom,distortProtectRoads:state.distortProtectRoads,flattenSample:state.flattenSample,flattenProfile:state.flattenProfile,grid:state.grid,selectionOutline:state.selectionOutline}));}catch{}}
  try{const saved=JSON.parse(localStorage.getItem('uo-map-paint.settings.v1')||'null');if(saved){for(const key of ['material','secondaryMaterial'])if(byId.has(saved[key]))state[key]=saved[key];for(const key of ['terrainSlot','altitudeSlot'])if(['primary','secondary'].includes(saved[key]))state[key]=saved[key];for(const key of ['z','secondaryZ','gradientEdge','gradientCenter'])if(Number.isInteger(saved[key])&&saved[key]>=-128&&saved[key]<=127)state[key]=saved[key];if(Number.isInteger(saved.size)&&saved.size>=1&&saved.size<=64)state.size=saved.size;if(Number.isInteger(saved.selectionPixels)&&saved.selectionPixels>=1&&saved.selectionPixels<=8192)state.selectionPixels=saved.selectionPixels;if(typeof saved.grid==='boolean')state.grid=saved.grid;if(typeof saved.selectionOutline==='boolean')state.selectionOutline=saved.selectionOutline;
    if(['single','side-by-side','stacked'].includes(saved.layout))state.layout=saved.layout;
    if(typeof saved.linkedPainting==='boolean')state.linkedPainting=saved.linkedPainting;
    for(const [,key,min,max,integer]of [...landformFields,...pathFields])if(Number.isFinite(saved[key])&&saved[key]>=min&&saved[key]<=max&&(!integer||Number.isInteger(saved[key])))state[key]=saved[key];
    for(const [,key,min,max]of [...smoothingFields,...roadFields,...distortFields,...flattenFields])if(Number.isInteger(saved[key])&&saved[key]>=min&&saved[key]<=max)state[key]=saved[key];
    if(['range','mountain','hills','ridge'].includes(saved.landformMode))state.landformMode=saved.landformMode;
    if(flattenProfiles.includes(saved.flattenProfile))state.flattenProfile=saved.flattenProfile;
    for(const key of ['landformRandom','landformPreviewFirst','pathPreviewFirst','distortRandom','distortProtectRoads','flattenSample'])if(typeof saved[key]==='boolean')state[key]=saved[key];
    const candidate=Object.fromEntries(Object.keys(actionNames).map(id=>[id,saved.bindings&&Object.hasOwn(saved.bindings,id)?saved.bindings[id]:DEFAULT_SHORTCUTS[id]]));let checked=validateBindings(candidate);
    if(!checked.ok&&saved.bindings){for(const id of Object.keys(actionNames))if(!Object.hasOwn(saved.bindings,id))candidate[id]='';checked=validateBindings(candidate);}if(checked.ok)state.bindings=checked.bindings;
  }}catch{}
  window.addEventListener('beforeunload',e=>{if(dirty||smoothingPreview||blurPreview||roadSession||selectionStrokePreview||flattenSession){e.preventDefault();e.returnValue='';}});
  const aiDialog=el('ai-dialog'),aiMessage=el('ai-message');let aiRequest=0,aiRunning=false;
  async function aiCall(endpoint,body={}){
    if(!window.AIBridge)throw Error('Open the Image editor shortcut to connect the local AI helper.');
    let r;try{r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-UO-Token':window.AIBridge.token},body:JSON.stringify(body)});}catch{throw Error('The local AI helper is unavailable. Open the Image editor shortcut again.');}
    const data=await r.json();if(!r.ok)throw Error(data.error||'Local AI connection failed.');return data;
  }
  el('ai-theme').addEventListener('click',async()=>{
    if(!idle())return;
    if(landformPreview||smoothingPreview||roadSession||flattenSession){status('Apply or Cancel the current tool preview first.');return;}
    aiMessage.textContent='AI edits existing terrain-color sections only. Your heightmap stays exact.';aiDialog.showModal();
    try{const r=await aiCall('/status');el('ai-connection').textContent=r.connected?'Key connected. Ready to edit.':'No key connected.';}catch(e){aiMessage.textContent=e.message;}
  });
  el('ai-connect').addEventListener('click',async()=>{const key=el('ai-key').value;el('ai-key').value='';try{await aiCall('/key',{key});el('ai-connection').textContent='Key connected. Ready to edit.';}catch(e){aiMessage.textContent=e.message;}});
  el('ai-forget').addEventListener('click',async()=>{try{await aiCall('/forget');el('ai-connection').textContent='Key forgotten for this session.';}catch(e){aiMessage.textContent=e.message;}});
  function aiClose(){aiRequest++;aiRunning=false;el('ai-key').value='';el('ai-generate').disabled=false;}
  el('ai-close').addEventListener('click',()=>{aiClose();aiDialog.close();});aiDialog.addEventListener('cancel',aiClose);
  window.addEventListener('beforeunload',e=>{if(aiRunning){e.preventDefault();e.returnValue='';}});
  el('ai-generate').addEventListener('click',async()=>{
    const request=++aiRequest;aiRunning=true;el('ai-generate').disabled=true;el('ai-results').textContent='';
    const check=()=>{if(request!==aiRequest)throw Error('Edit canceled.');};
    try{
      const source=doc,snapshot=window.AITheme.capture(source),summary=window.AITheme.summarize(snapshot,materials),waterInset=Number(el('ai-water-inset').value);
      aiMessage.textContent='AI is choosing materials for your existing color sections…';
      const {plan}=await aiCall('/theme',{theme:el('ai-prompt').value,model:el('ai-model').value.trim(),map:{...summary,waterInset,allowedOperations:['exact-color section fill','contract new water within original flat altitude sections'],heightPolicy:'Original heightmap is immutable. No new shapes, brushes, landmass generation or altitude generation.'}});check();
      const prepared=window.AIRegionEdit.prepare(snapshot,plan,summary,window.AITransitions,waterInset);
      aiMessage.textContent='Checking texture transition patterns…';
      const report=await window.AITheme.audit(snapshot,prepared.terrain,window.AITransitions,async()=>{check();await new Promise(resolve=>setTimeout(resolve,0));check();});check();
      if(doc!==source)throw Error('The document changed. Try again.');
      const stats=window.AITheme.apply(source,snapshot,prepared.terrain);
      state.linkedPainting=false;doc.setPaintLink(null);saveSettings();edited(stats,'AI region edit — terrain updated; original heights preserved');
      el('ai-results').textContent=plan.title+'\n'+plan.summary+'\n\n'+plan.assignments.map(a=>(byId.get(a.sourceId)?.name||a.sourceId)+' → '+byId.get(a.targetId).name+' — '+a.reason).join('\n')+'\n\nWater inset: '+waterInset+' pixel(s); '+prepared.retained.toLocaleString()+' original rim pixels retained.\nTransition patterns: '+report.matched.toLocaleString()+' matched; '+report.unresolved.toLocaleString()+' unresolved.\nHeightmap unchanged. Linked painting OFF. Undo restores terrain. Missing transition art is not generated.';
      aiMessage.textContent='Existing map edited. Close to inspect it. No new shapes or heights were generated.';
    }catch(e){if(request===aiRequest)aiMessage.textContent=e.message;}
    finally{if(request===aiRequest){aiRunning=false;el('ai-generate').disabled=false;}}
  });

  window.MapPaintApp={recipeBusy(value){isBusy=value;syncUI();requestRender();},recipeEdited(result){edited(result,'User filter');},recipeReady(){return idle()&&!roadSession&&!flattenSession&&!smoothingPreview&&!landformPreview;},get document(){return doc;},get state(){return state;},get dirty(){return dirty;},get spaceHeld(){return spaceHeld;},get selectionStrokePreview(){return selectionStrokePreview;},get landformPreview(){return landformPreview;},get rampPreview(){return rampPreview;},get smoothingPreview(){return smoothingPreview;},get blurSession(){return blurPreview;},get flattenSession(){return flattenSession;},get flattenPreview(){return flattenPreview;},get flattenPreviewError(){return flattenPreviewError;},get roadSession(){return roadSession;},get roadPreview(){return roadPreview;},get selectedRoadHandle(){return selectedRoadHandle?{...selectedRoadHandle}:null;},get protectedRoadMask(){return protectedRoadMask?protectedRoadMask.slice():null;},refreshFlattenPreview,applyFlattenPreview,cancelFlattenPreview,refreshRoadPreview,applyRoadPreview,cancelRoadPreview,selectRoadHandle,prepareSmoothing,applySmoothingPreview,cancelSmoothingPreview,applyLandformPreview,cancelLandformPreview,dispatch,render,replaceDocument,saveMapImages,downloadMapImages,chooseSaveLocation,saveProject,docToScreen};
  const decoButton=document.createElement('button');decoButton.id='deco-access';decoButton.className='ce-button';decoButton.textContent='Deco layer access';el('shortcuts').before(decoButton);
  const decoPanel=document.createElement('section');decoPanel.id='deco-panel';decoPanel.hidden=true;
  decoPanel.innerHTML=`<header class="ce-panel-title">DECORATION LAYER</header><div class="ce-panel-body"><p>One color pixel = one scenery or wall piece. Terrain and altitude stay unchanged.</p><p>255 colors + 1 empty slot · palette full</p><label><input id="deco-visible" type="checkbox" checked> Show markers</label><p id="deco-slots"></p><label>Find decoration <input id="deco-search" type="search"></label><select id="deco-category"><option>All</option><option>Trees</option><option>Rocks</option><option>Plants</option><option>Home-grown</option><option>Walls</option></select><div id="deco-list"></div><p>Left paint: Primary · Right paint: Secondary · Mouse 4: erase · Mouse 3: sample Primary. Pencil/Erase only; selection tools still select the ground.</p><p>Save project keeps decorations. Terrain/Heightmap PNGs do not. In-game placement is not connected to the builder yet.</p><button id="deco-export" class="ce-button">Export decoration plan</button></div>`;
  el('inspector-controls').prepend(decoPanel);
  const decoStyle=document.createElement('style');decoStyle.textContent=`#deco-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:5px;max-height:430px;overflow:auto;margin-top:8px}#deco-list button{color:white;background:#172338;border:3px solid var(--marker);padding:4px;font-size:11px;cursor:pointer}#deco-list button[aria-pressed=true]{outline:2px solid white;outline-offset:-5px}#deco-list .preview{height:88px;position:relative;background:#30343a;display:block}#deco-list img{position:absolute;bottom:0;image-rendering:pixelated}#deco-list strong{display:block;padding:3px;color:#111;background:var(--marker)}#chrome-editor.deco-editing #terrain-panel,#chrome-editor.deco-editing #altitude-palette-panel,#chrome-editor.deco-editing #color-slots{display:none!important}`;document.head.append(decoStyle);
  function refreshDecoPalette(){
    el('deco-slots').textContent='Primary: '+decoById.get(decoPrimary).name+' · Secondary: '+decoById.get(decoSecondary).name;
    const q=el('deco-search').value.toLowerCase(),category=el('deco-category').value,list=el('deco-list');list.replaceChildren();
    for(const entry of decoEntries){if(category!=='All'&&entry.category!==category&&!(entry.tags||[]).includes(category)||!(entry.name+' '+(entry.plantName||'')).toLowerCase().includes(q))continue;
      const b=document.createElement('button');b.type='button';b.dataset.decoId=entry.id;b.style.setProperty('--marker',entry.hex);b.setAttribute('aria-pressed',String(entry.id===decoPrimary));b.title=entry.name+' · '+entry.hex+' · art '+entry.artIds.join(', ')+(entry.collision?' · Walk-over plant; height '+entry.collision.height:'');
      const preview=document.createElement('span');preview.className='preview';const maxW=Math.max(...entry.images.map(x=>x.width)),maxH=Math.max(...entry.images.map(x=>x.height)),scale=Math.min(1,100/maxW,88/maxH);
      for(const im of entry.images){const img=document.createElement('img');img.src=im.src;img.alt='';img.style.width=im.width*scale+'px';img.style.height=im.height*scale+'px';img.style.left='calc(50% - '+im.width*scale/2+'px)';preview.append(img);}
      const caption=document.createElement('strong');caption.textContent=entry.name;caption.style.color=(entry.rgb[0]*.299+entry.rgb[1]*.587+entry.rgb[2]*.114<145)?'#fff':'#111';const code=document.createElement('span');code.textContent=entry.hex;b.append(preview,caption,code);
      b.onclick=()=>{decoPrimary=entry.id;refreshDecoPalette();};b.oncontextmenu=e=>{e.preventDefault();decoSecondary=entry.id;refreshDecoPalette();};list.append(b);
    }
  }
  decoButton.onclick=()=>{if(!idle())return;decoMode=!decoMode;decoPanel.hidden=!decoMode;root.classList.toggle('deco-editing',decoMode);decoButton.setAttribute('aria-pressed',String(decoMode));decoButton.textContent=decoMode?'Return to terrain':'Deco layer access';if(decoMode){activateLayer('terrain');decoVisible=true;el('deco-visible').checked=true;state.tool='pencil';refreshDecoPalette();el('inspector-controls').scrollTop=0;}syncUI();requestRender();};
  for(const set of window.DecoPalette.wallSets||[]){const option=document.createElement('option');option.value=set.name;option.textContent='Walls · '+set.name;el('deco-category').append(option);}
  el('deco-visible').onchange=e=>{decoVisible=e.target.checked;requestRender();};el('deco-search').oninput=refreshDecoPalette;el('deco-category').onchange=refreshDecoPalette;
  function endDeco(cancel=false){if(!decoDrag)return;const stroke=decoDrag;decoDrag=null;try{if(cancel){doc.cancelStroke();status('Decoration stroke cancelled.');}else edited(doc.endStroke(),'Decorations');}finally{if(stroke.canvas.hasPointerCapture(stroke.id))stroke.canvas.releasePointerCapture(stroke.id);requestRender();}}
  function appendDeco(e){const p=bounded(point(e,decoDrag.canvas));doc.paintDecoLine(decoDrag.last.x,decoDrag.last.y,p.x,p.y,decoDrag.value);decoDrag.last=p;requestRender();}
  for(const canvas of surfaces){
    canvas.addEventListener('pointerdown',e=>{
      if(!decoMode||viewLayer(canvas)!=='terrain'||spaceHeld||selectionTools.has(state.tool)||e.button===4)return;
      e.preventDefault();e.stopImmediatePropagation();safely(()=>{
        if(!idle()||root.querySelector('dialog[open]'))return;const p=point(e,canvas);if(!inside(p))return;
        if(e.button===1){const value=doc.deco[p.y*doc.width+p.x];if(decoById.has(value)){decoPrimary=value;refreshDecoPalette();}return;}
        if(!['pencil','eraser'].includes(state.tool)){status('Use Pencil or Erase to edit decorations.');return;}
        if(![0,2,3].includes(e.button))return;stopZoom();decoVisible=true;el('deco-visible').checked=true;doc.beginDecoStroke();decoDrag={id:e.pointerId,canvas,last:p,value:state.tool==='eraser'||e.button===3?UNSET:e.button===2?decoSecondary:decoPrimary};canvas.setPointerCapture(e.pointerId);appendDeco(e);
      });
    },true);
    canvas.addEventListener('pointermove',e=>{if(decoDrag&&decoDrag.id===e.pointerId){e.preventDefault();e.stopImmediatePropagation();safely(()=>appendDeco(e));}},true);
    canvas.addEventListener('pointerup',e=>{if(decoDrag&&decoDrag.id===e.pointerId){e.preventDefault();e.stopImmediatePropagation();safely(()=>{appendDeco(e);endDeco();});}},true);
    for(const type of ['pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{if(decoDrag&&decoDrag.id===e.pointerId)endDeco(true);},true);
  }
  window.addEventListener('blur',()=>endDeco(true));window.addEventListener('keydown',e=>{if(e.key==='Escape'&&decoDrag){e.preventDefault();e.stopImmediatePropagation();endDeco(true);}},true);
  el('fill-selection').addEventListener('click',e=>{if(decoMode){e.preventDefault();e.stopImmediatePropagation();if(idle())safely(()=>edited(doc.fillDecoSelection(decoPrimary),'Decoration selection fill'));}},true);
  el('simple-filter-apply').addEventListener('click',e=>{if(decoMode&&!['deco-patch','deco-whole','deco-walls','city-level','city-whole','city'].includes(el('simple-filter').value)){e.preventDefault();e.stopImmediatePropagation();status('Return to terrain to apply terrain/altitude filters.');}},true);
  el('deco-export').onclick=()=>safely(()=>{if(!idle())return;const placements=[];for(let i=0;i<doc.deco.length;i++)if(doc.deco[i]!==UNSET)placements.push({preset:doc.deco[i],x:i%doc.width,y:Math.floor(i/doc.width),z:doc.altitude[i]===UNSET?null:doc.altitude[i]-128});const body={format:'uo-deco-plan',version:1,width:doc.width,height:doc.height,catalogVersion:1,presets:decoEntries.map(({id,name,artIds,hex})=>({id,name,artIds,hex})),placements};const url=URL.createObjectURL(new Blob([JSON.stringify(body)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='Decorations-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Decoration plan exported. Builder integration is not enabled yet.');});

  doc.setPaintLink(state.linkedPainting?paintLink:null);buildAltitudePalette();paletteList();syncUI();fit();const viewObserver=new ResizeObserver(resizeViewport);for(const canvas of surfaces)viewObserver.observe(canvas);
  const overviewObserver=new ResizeObserver(()=>{if(drag&&drag.overview)finish(true);requestRender();});overviewObserver.observe(overview);
})();


