/* Editable roads and independent hillside ribbons. Exact height writes optionally update linked terrain in the same transaction. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MapPaintRoad=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SESSIONS=new WeakMap(),PLANS=new WeakMap(),CHECKPOINTS=new WeakMap(),UNSET=65535,EPS=1e-7;
  const MAX_CROP=4194304,MAX_POINTS=8192,MAX_KNOTS=512,MAX_SAMPLES=65536,MAX_STITCHES=2048,MAX_WORK=80000000,MAX_REACH=2048;
  const DEFAULTS=Object.freeze({width:1,startZ:0,endZ:32,spacing:16,curvature:50,leftRise:20,rightRise:20,shoulderWidth:2,shoulderRise:2});
  const LIMITS={width:[1,64],startZ:[-128,127],endZ:[-128,127],spacing:[4,128],curvature:[0,100],leftRise:[-128,127],rightRise:[-128,127],shoulderWidth:[0,64],shoulderRise:[-128,127]};
  function integer(n,min,max,name){if(!Number.isSafeInteger(n)||n<min||n>max)throw new RangeError(`${name} must be an integer from ${min} to ${max}`);return n;}
  function options(value={},old=DEFAULTS){if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Road options must be an object');const next={};for(const [key,[min,max]]of Object.entries(LIMITS))next[key]=integer(value[key]===undefined?old[key]:value[key],min,max,'Road '+key);return Object.freeze(next);}
  function tick(budget,n=1){budget.used+=n;if(budget.used>MAX_WORK)throw new RangeError('This Road preview is too complex. Use a shorter road or a smaller hillside.');}
  function frozenPoint(p){return Object.freeze({x:p.x,y:p.y});}
  function clampZ(z){return Math.max(-128,Math.min(127,z));}
  function smooth(t){return t*t*(3-2*t);}
  function contains(r,x,y){return x>=0&&y>=0&&x<r.width&&y<r.height&&r.mask[y*r.width+x]===1;}
  function state(session,owner){const r=SESSIONS.get(session);if(!r||r.owner!==owner)throw new Error('This Road belongs to a different document');if(r.finished)throw new Error('This Road has already been '+r.finished);owner._idle();if(owner.currentLayer!=='altitude'||owner.width!==r.width||owner.height!==r.height||owner.altitude!==r.altitude||owner._paintLink!==r.link||(r.link&&owner.terrain!==r.terrain)||owner.selection!==r.selectionRef||owner.selectionRevision!==r.selectionRevision)throw new Error('The Road preview is stale; draw again after changing the image or selection');return r;}
  // Traverse all crossed cell faces. Exact corner crossings inspect both side
  // cells, so a ray cannot leak through the corner of an unselected hole.
  function trace(r,ax,ay,bx,by,budget){
    const dx=bx-ax,dy=by-ay;let x=Math.round(ax),y=Math.round(ay),last={x,y},t=0;
    if(!contains(r,x,y))return {point:last,clipped:true,t:0};
    if(Math.hypot(dx,dy)<EPS)return {point:last,clipped:false,t:1};
    const sx=Math.sign(dx),sy=Math.sign(dy),tx=dx?Math.abs(1/dx):Infinity,ty=dy?Math.abs(1/dy):Infinity;
    const clipped=(at,axis)=>{const inset=axis===0?tx*.5:axis===1?ty*.5:Math.max(tx,ty)*.5,reach=Math.max(0,at-inset);return {point:{x:ax+dx*reach,y:ay+dy*reach},cell:last,clipped:true,t:Math.max(0,at)};};
    let nx=dx?(x+(sx>0?.5:-.5)-ax)/dx:Infinity,ny=dy?(y+(sy>0?.5:-.5)-ay)/dy:Infinity;
    while(Math.min(nx,ny)<=1+1e-12){tick(budget);t=Math.min(nx,ny);const both=Number.isFinite(nx)&&Number.isFinite(ny)&&Math.abs(nx-ny)<=Number.EPSILON*8*Math.max(1,Math.abs(nx),Math.abs(ny));
      if(both){if(!contains(r,x+sx,y)||!contains(r,x,y+sy)||!contains(r,x+sx,y+sy))return clipped(t,2);x+=sx;y+=sy;nx+=tx;ny+=ty;}
      else if(nx<ny){if(!contains(r,x+sx,y))return clipped(t,0);x+=sx;nx+=tx;}
      else {if(!contains(r,x,y+sy))return clipped(t,1);y+=sy;ny+=ty;}
      last={x,y};
    }
    return {point:{x:bx,y:by},clipped:false,t:1};
  }
  function segments(points){const list=[];let length=0;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,n=Math.hypot(dx,dy);if(n<EPS)continue;list.push({index:list.length,x:a.x,y:a.y,dx,dy,length:n,squared:n*n,station:length,nx:dy/n,ny:-dx/n,minX:Math.min(a.x,b.x),minY:Math.min(a.y,b.y),maxX:Math.max(a.x,b.x),maxY:Math.max(a.y,b.y)});length+=n;}if(!list.length)list.push({index:0,x:points[0].x,y:points[0].y,dx:0,dy:0,length:0,squared:0,station:0,nx:0,ny:-1,minX:points[0].x,maxX:points[0].x,minY:points[0].y,maxY:points[0].y});return {list,length};}
  function boxDistance(n,x,y){const dx=Math.max(n.minX-x,0,x-n.maxX),dy=Math.max(n.minY-y,0,y-n.maxY);return dx*dx+dy*dy;}
  function tree(items){let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of items){minX=Math.min(minX,p.minX);minY=Math.min(minY,p.minY);maxX=Math.max(maxX,p.maxX);maxY=Math.max(maxY,p.maxY);}const node={minX,minY,maxX,maxY};if(items.length<=8)node.items=items;else{const axis=maxX-minX>=maxY-minY?'X':'Y';items.sort((a,b)=>a['min'+axis]+a['max'+axis]-b['min'+axis]-b['max'+axis]);const mid=items.length>>1;node.a=tree(items.slice(0,mid));node.b=tree(items.slice(mid));}return node;}
  function nearest(root,x,y,budget){let best=null,distance=Infinity;function visit(n){tick(budget);if(boxDistance(n,x,y)>distance+EPS)return;if(n.items){for(const s of n.items){const t=s.squared?Math.max(0,Math.min(1,((x-s.x)*s.dx+(y-s.y)*s.dy)/s.squared)):0,qx=s.x+s.dx*t,qy=s.y+s.dy*t,d=(x-qx)**2+(y-qy)**2;if(d<distance-EPS||Math.abs(d-distance)<=EPS&&(!best||s.index>best.s.index)){distance=d;best={s,t,x:qx,y:qy,distance:d,station:s.station+s.length*t};}}}else if(boxDistance(n.a,x,y)<boxDistance(n.b,x,y)){visit(n.a);visit(n.b);}else{visit(n.b);visit(n.a);}}visit(root);return best;}
  function at(path,station){let lo=0,hi=path.list.length-1;while(lo<hi){const m=(lo+hi)>>1,s=path.list[m];if(s.station+s.length<station-EPS)lo=m+1;else hi=m;}const s=path.list[lo],t=s.length?Math.max(0,Math.min(1,(station-s.station)/s.length)):0;return {x:s.x+s.dx*t,y:s.y+s.dy*t,nx:s.nx,ny:s.ny,station};}
  function roadZ(settings,path,station){return settings.startZ+(settings.endZ-settings.startZ)*(path.length?station/path.length:0);}
  function sampleCurve(knots,curvature){if(knots.length===1)return [frozenPoint(knots[0])];const out=[frozenPoint(knots[0])],k=curvature/100;
    for(let i=0;i<knots.length-1;i++){const p=knots[Math.max(0,i-1)],a=knots[i],b=knots[i+1],q=knots[Math.min(knots.length-1,i+2)],tx=(b.x-p.x)*.5*k,ty=(b.y-p.y)*.5*k,ux=(q.x-a.x)*.5*k,uy=(q.y-a.y)*.5*k;
      const steps=Math.max(1,Math.ceil((Math.hypot(b.x-a.x,b.y-a.y)+Math.hypot(tx,ty)+Math.hypot(ux,uy))*4));if(out.length+steps>MAX_SAMPLES)throw new RangeError('This road has too much curve detail. Use a shorter road.');
      for(let j=1;j<=steps;j++){const t=j/steps,t2=t*t,t3=t2*t;let x,y;if(!k){x=a.x+(b.x-a.x)*t;y=a.y+(b.y-a.y)*t;}else{x=(2*t3-3*t2+1)*a.x+(t3-2*t2+t)*tx+(-2*t3+3*t2)*b.x+(t3-t2)*ux;y=(2*t3-3*t2+1)*a.y+(t3-2*t2+t)*ty+(-2*t3+3*t2)*b.y+(t3-t2)*uy;}out.push(Object.freeze({x,y}));}}
    return out;
  }
  function chainFor(r,samples,budget,strict=true){const chain=[],seen=new Map();
    function allowed(x,y){if(!contains(r,x,y))return false;if(!strict)return true;const last=chain[chain.length-1];for(const [ox,oy]of [[1,0],[-1,0],[0,1],[0,-1]]){if(x+ox<0||y+oy<0||x+ox>=r.width||y+oy>=r.height)continue;const found=seen.get((y+oy)*r.width+x+ox);if(found!==undefined&&found!==chain.length-1)return false;}return !seen.has(y*r.width+x)||last&&last.x===x&&last.y===y;}
    function push(x,y){tick(budget);const last=chain[chain.length-1];if(last&&last.x===x&&last.y===y)return;if(chain.length>1&&chain[chain.length-2].x===x&&chain[chain.length-2].y===y){seen.delete(last.y*r.width+last.x);chain.pop();return;}if(!contains(r,x,y))throw new Error('The road would leave the selected area. Move its curve inward or reduce Curvature.');if(!allowed(x,y))throw new Error('The road crosses or touches itself too closely. Separate the bends to keep a single connected road.');seen.set(y*r.width+x,chain.length);chain.push({x,y});}
    push(Math.round(samples[0].x),Math.round(samples[0].y));
    for(let i=1;i<samples.length;i++){const p=samples[i],targetX=Math.round(p.x),targetY=Math.round(p.y);let last=chain[chain.length-1];while(last.x!==targetX||last.y!==targetY){const sx=Math.sign(targetX-last.x),sy=Math.sign(targetY-last.y);if(sx&&sy){const candidates=[{x:last.x+sx,y:last.y},{x:last.x,y:last.y+sy}];candidates.sort((a,b)=>(a.x-p.x)**2+(a.y-p.y)**2-((b.x-p.x)**2+(b.y-p.y)**2));const valid=candidates.find(c=>allowed(c.x,c.y));if(!valid)throw new Error('This bend is too tight for a one-cell road. Move the curve points apart.');push(valid.x,valid.y);}else push(last.x+sx,last.y+sy);last=chain[chain.length-1];}}
    return chain;
  }
  function makeControls(r,path,settings,edits,budget){
    const count=Math.ceil(path.length/settings.spacing)+1;
    if(count>MAX_STITCHES)throw new RangeError('Too many Road stitches. Increase Spacing or use a shorter road.');
    const stations=[];for(let s=0;s<path.length;s+=settings.spacing)stations.push(s);stations.push(path.length);
    let clippedHandles=0;
    const controls=stations.map((station,index)=>{
      const c=at(path,station),base=roadZ(settings,path,station),edit=edits[index]||{},sides={};
      for(const side of ['left','right']){
        const sign=side==='left'?1:-1,e=edit[side]||{},reach=Math.max(32,settings.width/2+16),dx=e.dx===undefined?c.nx*reach*sign:e.dx,dy=e.dy===undefined?c.ny*reach*sign:e.dy;
        const end=trace(r,c.x,c.y,Math.round(c.x+dx),Math.round(c.y+dy),budget);if(end.clipped)clippedHandles++;
        const endpoint=end.cell||end.point,rawZ=e.z===undefined?base+settings[side+'Rise']:e.z;
        sides[side]={x:endpoint.x,y:endpoint.y,z:clampZ(Math.round(rawZ)),rawZ,overridden:e.z!==undefined,clipped:end.clipped,collapsed:false,positionEdited:e.dx!==undefined||e.dy!==undefined,autoAdjusted:false};
      }
      return {...c,index,z:clampZ(Math.round(base)),...sides};
    });
    // Untouched automatic endpoints can collide after clipping to an irregular
    // boundary. Space those defaults locally before constructing the mesh. User
    // positions and explicitly edited heights stay fixed and are checked later.
    const occupied=new Map(),entries=[];
    for(const c of controls)for(const side of ['left','right'])entries.push({c,side,e:c[side]});
    const key=e=>e.y*r.width+e.x,automatic=e=>!e.positionEdited&&!e.overridden;
    for(const {e}of entries)if(!automatic(e)&&!occupied.has(key(e)))occupied.set(key(e),e.z);
    const offsets=[];for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)if(dx*dx+dy*dy<=9&&(dx||dy))offsets.push({dx,dy,d2:dx*dx+dy*dy});
    offsets.sort((a,b)=>a.d2-b.d2||a.dy-b.dy||a.dx-b.dx);
    for(const {c,side,e}of entries){
      if(!automatic(e))continue;const previous=occupied.get(key(e));
      if(previous!==undefined&&previous!==e.z){
        let found=null;
        for(const offset of offsets){tick(budget);const x=e.x+offset.dx,y=e.y+offset.dy,prior=occupied.get(y*r.width+x);
          if(!contains(r,x,y)||(prior!==undefined&&prior!==e.z)||((x-c.x)*c.nx+(y-c.y)*c.ny)*(side==='left'?1:-1)<-EPS)continue;
          if(trace(r,c.x,c.y,x,y,budget).clipped)continue;found={x,y};break;
        }
        if(!found)throw new Error('Automatic hillside endpoints overlap too tightly. Increase Stitch spacing or move the road away from this boundary.');
        e.x=found.x;e.y=found.y;e.autoAdjusted=true;
      }
      if(!occupied.has(key(e)))occupied.set(key(e),e.z);
    }
    return {controls,clipped:clippedHandles};
  }
  function geometry(r,knots,settings,edits,drawing=r.drawing){const budget={used:0},samples=sampleCurve(knots,drawing?0:settings.curvature),path=segments(samples),chain=chainFor(r,samples,budget,!drawing),prepared=makeControls(r,path,settings,edits,budget);return {samples,path,chain,controls:prepared.controls,clippedHandles:prepared.clipped,work:budget.used};}
  function expose(r){r.exposedPoints=Object.freeze(r.knots.map(frozenPoint));r.exposedSamples=Object.freeze(r.geometry.samples.slice());r.exposedStitches=Object.freeze(r.geometry.controls.map(c=>Object.freeze({...c,left:Object.freeze({...c.left}),right:Object.freeze({...c.right})})));}
  function update(r,knots=r.knots,settings=r.options,edits=r.edits,drawing=r.drawing){const g=geometry(r,knots,settings,edits,drawing);r.knots=knots;r.options=settings;r.edits=edits;r.geometry=g;r.revision++;r.plan=null;expose(r);}
  function cloneEdits(edits){return edits.map(e=>({left:e.left?{...e.left}:undefined,right:e.right?{...e.right}:undefined}));}
  function create(owner,x,y,value,helpers){owner._idle();if(owner.currentLayer!=='altitude')throw new Error('Road is available only in the altitude image');integer(x,0,owner.width-1,'Road x');integer(y,0,owner.height-1,'Road y');const settings=options(value);for(const p of owner.selection)if(p!==0&&p!==1)throw new RangeError('Selection must be binary');if(!owner.selection[y*owner.width+x])throw new Error('Start the road inside the selected area');
    const mask=owner.selectionActive?helpers.connected(owner.selection,owner.width,owner.height,x,y,owner.selection):owner.selection.slice();
    const r={owner,helpers,width:owner.width,height:owner.height,altitude:owner.altitude,terrain:owner.terrain,link:owner._paintLink,beforeTerrain:owner._paintLink?owner.terrain.slice():null,selectionRef:owner.selection,selectionRevision:owner.selectionRevision,selection:helpers.packMask(owner.selection),mask,beforeAltitude:owner.altitude.slice(),options:settings,knots:[{x,y}],raw:[{x,y}],edits:[],revision:0,plan:null,finished:null,drawing:true,clipped:false};update(r);
    const session=Object.freeze({get options(){return r.options;},get points(){return r.exposedPoints;},get sampledPoints(){return r.exposedSamples;},get stitches(){return r.exposedStitches;},get totalLength(){return r.geometry.path.length;},get revision(){return r.revision;},get clipped(){return r.clipped;},get drawing(){return r.drawing;},
      addPoint(px,py){state(session,owner);if(!r.drawing)throw new Error('The road is already drawn; move its curve points');integer(px,-1000000000,1000000000,'Road x');integer(py,-1000000000,1000000000,'Road y');if(r.clipped)return session;const last=r.raw[r.raw.length-1];if(last.x===px&&last.y===py)return session;if(r.raw.length>=MAX_POINTS)throw new RangeError('This road is too long. Apply it and start another.');const hit=trace(r,last.x,last.y,px,py,{used:0}),hitPoint=hit.cell||hit.point;if(last.x!==hitPoint.x||last.y!==hitPoint.y){const raw=[...r.raw,hitPoint];update(r,raw);r.raw=raw;}r.clipped=hit.clipped;return session;},
      finishDrawing(){state(session,owner);if(!r.drawing)return session;const p=segments(r.raw),knots=[];if(p.length<EPS)throw new Error('Draw a longer road before applying it; a single point has no hillside ribbon.');const spacing=Math.max(4,r.options.spacing);for(let s=0;s<p.length;s+=spacing){const q=at(p,s);knots.push({x:Math.round(q.x),y:Math.round(q.y)});}const end=r.raw[r.raw.length-1];if(!knots.length||knots[knots.length-1].x!==end.x||knots[knots.length-1].y!==end.y)knots.push({...end});if(knots.length===2){const middle=at(p,p.length/2);knots.splice(1,0,{x:Math.round(middle.x),y:Math.round(middle.y)});}if(knots.length>MAX_KNOTS)throw new RangeError('Too many Road curve points. Increase Spacing or draw a shorter road.');update(r,knots,r.options,r.edits,false);r.drawing=false;return session;},
      movePoint(index,px,py){state(session,owner);integer(index,0,r.knots.length-1,'Road curve point');integer(px,0,r.width-1,'Road x');integer(py,0,r.height-1,'Road y');const knots=r.knots.map(p=>({...p}));knots[index]={x:px,y:py};update(r,knots);return session;},
      setHandle(index,side,px,py){state(session,owner);integer(index,0,r.geometry.controls.length-1,'Road stitch');if(side!=='left'&&side!=='right')throw new RangeError('Road side must be left or right');integer(px,-MAX_REACH,r.width+MAX_REACH,'Stitch x');integer(py,-MAX_REACH,r.height+MAX_REACH,'Stitch y');const c=r.geometry.controls[index],dx=px-c.x,dy=py-c.y;if(Math.hypot(dx,dy)>MAX_REACH)throw new RangeError('A Road stitch can reach at most 2048 pixels');if((dx*c.nx+dy*c.ny)*(side==='left'?1:-1)<-EPS)throw new Error('Keep this stitch on its own side of the road; the other side has a separate handle');const edits=cloneEdits(r.edits);while(edits.length<=index)edits.push({});edits[index][side]={...edits[index][side],dx,dy};update(r,r.knots,r.options,edits);return session;},
      setEdgeZ(index,side,z){state(session,owner);integer(index,0,r.geometry.controls.length-1,'Road stitch');if(side!=='left'&&side!=='right')throw new RangeError('Road side must be left or right');integer(z,-128,127,'Edge Z');const edits=cloneEdits(r.edits);while(edits.length<=index)edits.push({});edits[index][side]={...edits[index][side],z};update(r,r.knots,r.options,edits);return session;},
      resetEdgeZ(index,side){state(session,owner);integer(index,0,r.geometry.controls.length-1,'Road stitch');if(side!=='left'&&side!=='right')throw new RangeError('Road side must be left or right');const edits=cloneEdits(r.edits);if(edits[index]&&edits[index][side])delete edits[index][side].z;update(r,r.knots,r.options,edits);return session;},
      setOptions(value){state(session,owner);const next=options(value,r.options);if(value.curvature!==undefined)r.requestedCurvature=next.curvature;update(r,r.knots,next,next.spacing===r.options.spacing?r.edits:[]);return session;},
      checkpoint(){state(session,owner);const token=Object.freeze({});CHECKPOINTS.set(token,{session,knots:r.knots.map(p=>({...p})),raw:r.raw.map(p=>({...p})),options:r.options,edits:cloneEdits(r.edits),drawing:r.drawing,clipped:r.clipped,requestedCurvature:r.requestedCurvature});return token;},
      restore(token){state(session,owner);const saved=CHECKPOINTS.get(token);if(!saved||saved.session!==session)throw new Error('This Road checkpoint belongs to another road');update(r,saved.knots.map(p=>({...p})),saved.options,cloneEdits(saved.edits),saved.drawing);r.raw=saved.raw.map(p=>({...p}));r.drawing=saved.drawing;r.clipped=saved.clipped;r.requestedCurvature=saved.requestedCurvature;return session;},
      cancel(){if(r.finished)return false;r.finished='canceled';r.plan=null;r.mask=r.beforeAltitude=r.beforeTerrain=r.selection=null;return true;}
    });SESSIONS.set(session,r);return session;
  }
  function controlAt(r,station,side){const cs=r.geometry.controls;if(cs.length===1)return cs[0][side];let i=Math.min(cs.length-2,Math.floor(station/r.options.spacing));const a=cs[i],b=cs[i+1],t=b.station>a.station?Math.max(0,Math.min(1,(station-a.station)/(b.station-a.station))):0;return {dx:(a[side].x-a.x)*(1-t)+(b[side].x-b.x)*t,dy:(a[side].y-a.y)*(1-t)+(b[side].y-b.y)*t,rawZ:a[side].rawZ*(1-t)+b[side].rawZ*t};}
  function profile(base,edge,distance,length,settings){const sw=settings.shoulderWidth;if(length<=EPS)return base;if(!sw||length<=sw)return base+(edge-base)*smooth(Math.min(1,distance/length));if(distance<=sw)return base+settings.shoulderRise*smooth(Math.max(0,distance/sw));const u=Math.max(0,Math.min(1,(distance-sw)/(length-sw))),shoulder=base+settings.shoulderRise;return shoulder+(edge-shoulder)*u*u;}
  function constrainEdges(r,g,b,shades,road,sum,weights,clampedMask,budget){
    const anchors=new Map(),effective=g.controls.map(c=>({...c,left:{...c.left},right:{...c.right}}));let collapsedHandles=0;
    const index=(x,y)=>(y-b.top)*b.width+x-b.left;
    for(const c of effective)for(const side of ['left','right']){
      const e=c[side],i=index(e.x,e.y);tick(budget);
      if(i<0||i>=shades.length||e.x<b.left||e.y<b.top||e.x>=b.left+b.width||e.y>=b.top+b.height||shades[i]===UNSET){
        if(r.drawing)continue;
        throw new Error('A hillside endpoint falls outside its ribbon. Move that stitch away from a fold or draw a longer road.');
      }
      if(road[i]){
        const z=shades[i]-128;
        if(e.overridden&&e.z!==z)throw new Error('This edge point is on the protected road. Move its stitch away before assigning a different edge height.');
        e.requestedZ=e.rawZ;e.z=z;e.rawZ=z;e.collapsed=true;collapsedHandles++;continue;
      }
      e.collapsed=false;
      const previous=anchors.get(i);
      if(previous&&previous.z!==e.z)throw new Error('Two hillside endpoints share one pixel but request different heights. Move one stitch or give both the same edge height.');
      if(!previous)anchors.set(i,{x:e.x,y:e.y,i,z:e.z,delta:e.z-clampZ(sum[i]/weights[i])});
    }
    let extraClamped=0;
    if([...anchors.values()].some(a=>Math.abs(a.delta)>1e-10)){
      // Compact Shepard kernels have an exact limit at each anchor, and a
      // zero-background weight makes the field tend continuously to zero at R.
      // Distance to the actual raster road, rather than only its guide, keeps
      // cardinal bridge pixels protected without a discontinuous road-edge pin.
      const radius=Math.max(4,Math.min(16,r.options.spacing/2)),radius2=radius*radius,background=1/radius2,bins=new Map();
      for(const a of anchors.values()){const key=Math.floor(a.x/radius)+','+Math.floor(a.y/radius);if(!bins.has(key))bins.set(key,[]);bins.get(key).push(a);}
      tick(budget,shades.length*3);const distance=new Uint32Array(shades.length);distance.fill(0x3FFFFFFF);for(let i=0;i<road.length;i++)if(road[i])distance[i]=0;r.helpers.edgeDistanceSquared(distance,b.width,b.height);
      for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){
        const i=y*b.width+x;if(road[i]||shades[i]===UNSET)continue;tick(budget);const px=x+b.left,py=y+b.top,bx=Math.floor(px/radius),by=Math.floor(py/radius);
        let total=background,weighted=0,nearest2=Infinity,exact=null;
        for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++)for(const a of bins.get((bx+ox)+','+(by+oy))||[]){
          tick(budget);const d2=(px-a.x)**2+(py-a.y)**2;if(d2>=radius2)continue;nearest2=Math.min(nearest2,d2);if(d2===0){exact=a;continue;}const falloff=1-d2/radius2,w=falloff*falloff/d2;total+=w;weighted+=w*a.delta;
        }
        if(exact){shades[i]=exact.z+128;continue;} // Exact d -> 0 limit of the same continuous field.
        if(nearest2===Infinity)continue;
        const dr=Math.sqrt(distance[i]),da=Math.sqrt(nearest2),correction=weighted/total*(dr/(dr+da)),z=clampZ(sum[i]/weights[i])+correction;
        if((z<-128-EPS||z>127+EPS)&&!clampedMask[i]){extraClamped++;clampedMask[i]=1;}shades[i]=Math.round(clampZ(z)+128+1e-9);
      }
    }
    // Verify the exact user-visible constraints after all overlap and rounding.
    for(const c of effective)for(const side of ['left','right']){const e=c[side],i=index(e.x,e.y);if(!r.drawing&&shades[i]!==e.z+128)throw new Error('The Road could not satisfy an edge height. Move the conflicting stitch and preview again.');}
    return {effective:Object.freeze(effective.map(c=>Object.freeze({...c,left:Object.freeze(c.left),right:Object.freeze(c.right)}))),collapsedHandles,extraClamped,edgeAnchors:anchors.size};
  }
  function plan(owner,session){const r=state(session,owner);if(r.plan)return r.plan;const g=r.geometry,settings=r.options,budget={used:g.work},pathTree=tree(g.path.list.slice()),radius=settings.width/2;
    // Exact stitch stations must be vertices of the hillside mesh. Sampling only
    // the smooth guide can otherwise leave a skewed endpoint outside the mesh.
    const stations=[...new Set([...g.path.list.map(s=>s.station),...g.controls.map(c=>c.station),g.path.length])].sort((a,b)=>a-b),sections=stations.map(s=>at(g.path,s));
    const ribbons={left:[],right:[]};let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    function bound(p,pad=0){minX=Math.min(minX,p.x-pad);minY=Math.min(minY,p.y-pad);maxX=Math.max(maxX,p.x+pad);maxY=Math.max(maxY,p.y+pad);}
    for(const q of sections){bound(q,radius+1);for(const side of ['left','right']){const sign=side==='left'?1:-1,h=controlAt(r,q.station,side),dx=h.dx===undefined?h.x-q.x:h.dx,dy=h.dy===undefined?h.y-q.y:h.dy;const end=trace(r,q.x,q.y,q.x+dx,q.y+dy,budget).point,start={x:q.x+q.nx*radius*sign,y:q.y+q.ny*radius*sign};const length=Math.hypot(end.x-start.x,end.y-start.y),base=roadZ(settings,g.path,q.station),edge=h.rawZ;const common={base,edge,length,ox:q.x,oy:q.y,station:q.station};ribbons[side].push({start:{...start,...common,u:0},end:{...end,...common,u:1}});bound(end);}}
    const left=Math.max(0,Math.floor(minX)),top=Math.max(0,Math.floor(minY)),right=Math.min(r.width-1,Math.ceil(maxX)),bottom=Math.min(r.height-1,Math.ceil(maxY)),width=right-left+1,height=bottom-top+1,count=width*height;
    if(count>MAX_CROP)throw new RangeError('This Road and its hills cover too large an area (maximum 4,194,304 pixels in their bounds). Shorten the road or its stitches.');
    const bounds=Object.freeze({left,top,width,height}),shades=new Uint16Array(count);shades.fill(UNSET);const road=new Uint8Array(count),clampedMask=new Uint8Array(count),sum=new Float64Array(count),weights=new Float64Array(count);
    function triangle(a,b,c){const den=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(den)<EPS)return;const x0=Math.max(left,Math.ceil(Math.min(a.x,b.x,c.x))),x1=Math.min(right,Math.floor(Math.max(a.x,b.x,c.x))),y0=Math.max(top,Math.ceil(Math.min(a.y,b.y,c.y))),y1=Math.min(bottom,Math.floor(Math.max(a.y,b.y,c.y)));for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){tick(budget);if(!contains(r,x,y))continue;const v=((b.y-c.y)*(x-c.x)+(c.x-b.x)*(y-c.y))/den,w=((c.y-a.y)*(x-c.x)+(a.x-c.x)*(y-c.y))/den,t=1-v-w;if(v<-EPS||w<-EPS||t<-EPS)continue;const mix=key=>a[key]*v+b[key]*w+c[key]*t,ox=mix('ox'),oy=mix('oy');if(trace(r,ox,oy,x,y,budget).clipped)continue;const length=mix('length'),u=mix('u'),z=profile(mix('base'),mix('edge'),u*length,length,settings),weight=1/(.5+Math.hypot(x-ox,y-oy)),i=(y-top)*width+x-left;sum[i]+=z*weight;weights[i]+=weight;}}
    for(const side of ['left','right']){const list=ribbons[side];for(let i=1;i<list.length;i++){const a=list[i-1],b=list[i];triangle(a.start,a.end,b.end);triangle(a.start,b.end,b.start);}}
    // The protected road is rasterized independently and wins every overlap.
    const chainSet=new Set(g.chain.map(p=>p.y*r.width+p.x));let roadPixels=0,maxRoadStepZ=0,lastZ=null;
    for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){tick(budget);const i=(y-top)*width+x-left;if(settings.width===1&&!chainSet.has(y*r.width+x))continue;const p=nearest(pathTree,x,y,budget),signed=(x-p.x)*p.s.nx+(y-p.y)*p.s.ny,isRoad=settings.width===1||p.distance<radius*radius-EPS||Math.abs(p.distance-radius*radius)<=EPS&&signed<0;if(!isRoad)continue;if(!contains(r,x,y))throw new Error('The selected road width does not fit here. Widen the selection or reduce Width.');road[i]=1;shades[i]=Math.round(roadZ(settings,g.path,p.station)+128+1e-9);roadPixels++;}
    let pixelCount=0,clampedPixels=0;for(let i=0;i<count;i++){if(!road[i]&&weights[i]){const z=sum[i]/weights[i];if(z<-128-EPS||z>127+EPS){clampedPixels++;clampedMask[i]=1;}shades[i]=Math.round(clampZ(z)+128+1e-9);}if(shades[i]!==UNSET)pixelCount++;}
    const constrained=constrainEdges(r,g,bounds,shades,road,sum,weights,clampedMask,budget);clampedPixels+=constrained.extraClamped;
    for(const p of g.chain){const z=shades[(p.y-top)*width+p.x-left]-128;if(lastZ!==null)maxRoadStepZ=Math.max(maxRoadStepZ,Math.abs(z-lastZ));lastZ=z;}
    function local(x,y){return Number.isInteger(x)&&Number.isInteger(y)&&x>=left&&y>=top&&x<=right&&y<=bottom?(y-top)*width+x-left:-1;}
    const preview=Object.freeze({mode:'road',options:settings,bounds,pixelCount,roadPixels,clampedPixels,maxRoadStepZ,clipped:r.clipped,clippedHandles:g.clippedHandles,collapsedHandles:constrained.collapsedHandles,edgeAnchors:constrained.edgeAnchors,workUnits:budget.used,
      valueAt(x,y,layer='altitude'){if(layer!=='altitude'||r.finished==='canceled')return undefined;const i=local(x,y);return i<0||shades[i]===UNSET?undefined:shades[i];},
      roadAt(x,y){const i=local(x,y);return i>=0&&road[i]===1;}
    });PLANS.set(preview,{session,revision:r.revision,shades});r.exposedStitches=constrained.effective;r.plan=preview;return preview;
  }
  function apply(owner,preview){const saved=PLANS.get(preview);if(!saved)throw new Error('This is not a Road preview');const r=state(saved.session,owner);if(r.drawing)throw new Error('Finish drawing the road before applying it');if(saved.revision!==r.revision||!r.helpers.samePackedMask(owner.selection,r.selection))throw new Error('The Road preview is stale; preview again after changing the road or selection');const b=preview.bounds;for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){const i=y*b.width+x;if(saved.shades[i]!==UNSET){const target=(y+b.top)*r.width+x+b.left;if(owner.altitude[target]!==r.beforeAltitude[target]||(r.beforeTerrain&&owner.terrain[target]!==r.beforeTerrain[target]))throw new Error('The Road source heights changed; draw a new road');}}const result=owner._edit(()=>{for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++){const shade=saved.shades[y*b.width+x];if(shade!==UNSET)owner._write((y+b.top)*r.width+x+b.left,shade);}},'altitude',r.link);r.finished='applied';return Object.assign(result,{mode:'road',footprintPixels:preview.pixelCount,roadPixels:preview.roadPixels,clampedPixels:preview.clampedPixels,maxRoadStepZ:preview.maxRoadStepZ});}
  return Object.freeze({create,plan,apply,MAX_CROP,MAX_POINTS,MAX_WORK,DEFAULTS});
});
