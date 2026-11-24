/* Saves the two exact map images as one new folder, or packages that folder in a stored ZIP. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MapImageSave=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const NAMES=['Terrain.png','Heightmap.png','Decorations.png'],MAX32=0xffffffff,DEFAULT_ZONE='America/Los_Angeles';
  function partsFor(date,timeZone){
    if(!(date instanceof Date)||!Number.isFinite(date.getTime()))throw new TypeError('A valid save date is required');
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  }
  function randomId(){
    const crypto=globalThis.crypto;
    if(crypto&&typeof crypto.randomUUID==='function')return crypto.randomUUID().replace(/-/g,'');
    if(crypto&&typeof crypto.getRandomValues==='function')return Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
    throw new Error('Secure random folder naming is unavailable in this browser');
  }
  function makeFolderName(options={}){
    const date=options.now===undefined?new Date():typeof options.now==='function'?options.now():options.now;
    const p=partsFor(date,options.timeZone||DEFAULT_ZONE),id=(options.randomId||randomId)();
    if(typeof id!=='string'||!/^[a-fA-F0-9]{32}$/.test(id.replace(/-/g,'')))throw new TypeError('A full 128-bit random folder identifier is required');
    return `UO Map ${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${id.replace(/-/g,'').toLowerCase()}`;
  }
  function orderedFiles(files,kind){
    if(!Array.isArray(files)||(files.length!==2&&files.length!==3))throw new TypeError('Supply both Terrain.png and Heightmap.png');
    const byName=new Map();
    for(const file of files){
      if(!file||!NAMES.includes(file.name)||byName.has(file.name))throw new TypeError('Use Terrain.png, Heightmap.png and optional Decorations.png, once each');
      if(kind==='blob'){
        if(typeof Blob==='undefined'||!(file.blob instanceof Blob)||!Number.isSafeInteger(file.blob.size)||file.blob.size<1)throw new TypeError(file.name+' must have a nonempty encoded image Blob');
      }else{
        if(!(file.data instanceof Uint8Array)||!ArrayBuffer.isView(file.data))throw new TypeError(file.name+' must contain Uint8Array image bytes');
        if(typeof SharedArrayBuffer!=='undefined'&&file.data.buffer instanceof SharedArrayBuffer)throw new TypeError('Shared image buffers cannot be archived safely');
        if(!Number.isSafeInteger(file.data.byteLength)||file.data.byteLength<1)throw new TypeError(file.name+' must have nonempty image bytes');
        if(file.data.byteLength>MAX32)throw new RangeError('Image exceeds the ZIP32 size limit');
      }
      // Snapshot descriptors before the first await; Blob contents themselves are immutable.
      byName.set(file.name,kind==='blob'?{name:file.name,blob:file.blob}:{name:file.name,data:file.data});
    }
    if(!byName.has('Terrain.png')||!byName.has('Heightmap.png'))throw new TypeError('Terrain.png and Heightmap.png are required');
    return NAMES.filter(name=>byName.has(name)).map(name=>byName.get(name));
  }
  function notFound(error){return error&&error.name==='NotFoundError';}
  function collision(error){return error&&error.name==='TypeMismatchError';}
  async function sameEntry(left,right){
    if(left===right)return true;
    if(left&&typeof left.isSameEntry==='function')return await left.isSameEntry(right);
    return false;
  }
  async function empty(directory){
    if(!directory||typeof directory.entries!=='function')throw new TypeError('Directory enumeration is unavailable');
    for await(const entry of directory.entries())return false;
    return true;
  }
  async function cleanup(parent,name,directory,claimed){
    const errors=[];
    try{
      let current;
      try{current=await parent.getDirectoryHandle(name,{create:false});}catch(error){if(notFound(error))return {remains:false,errors};throw error;}
      if(!await sameEntry(directory,current))return {remains:true,errors:['The folder was replaced; its contents were preserved.']};
      for(const file of claimed){
        try{
          let entry;
          try{entry=await directory.getFileHandle(file.name,{create:false});}catch(error){if(notFound(error))continue;throw error;}
          if(!await sameEntry(file.handle,entry)){errors.push(file.name+' was replaced and was preserved.');continue;}
          await directory.removeEntry(file.name,{recursive:false});
        }catch(error){errors.push('Could not remove '+file.name+': '+error.message);}
      }
      if(!await empty(directory))return {remains:true,errors};
      // Both identity and emptiness are checked. The nonrecursive removal is the final guard.
      current=await parent.getDirectoryHandle(name,{create:false});
      if(!await sameEntry(directory,current))return {remains:true,errors:['The folder was replaced; its contents were preserved.']};
      await parent.removeEntry(name,{recursive:false});
      return {remains:false,errors};
    }catch(error){
      if(notFound(error))return {remains:false,errors};
      errors.push(error.message);return {remains:true,errors};
    }
  }
  function saveError(original,folderName,state){
    const suffix=state.remains?` The incomplete folder "${folderName}" remains; other files were preserved.`:'';
    const error=new Error((original&&original.message||String(original))+suffix);
    error.name=original&&original.name||'Error';error.cause=original;
    error.folderName=folderName;error.incompleteFolderRemains=state.remains;error.cleanupErrors=state.errors;
    return error;
  }
  async function writeNewFolder(parent,files,options={}){
    // Both immutable encoded images are validated before asking the filesystem to create anything.
    const ordered=orderedFiles(files,'blob');
    if(!parent||typeof parent.getDirectoryHandle!=='function'||typeof parent.removeEntry!=='function')throw new TypeError('A writable parent directory handle is required');
    const attempts=options.maxAttempts===undefined?16:options.maxAttempts;
    if(!Number.isSafeInteger(attempts)||attempts<1||attempts>100)throw new RangeError('Folder attempts must be from 1 to 100');
    for(let attempt=0;attempt<attempts;attempt++){
      const folderName=makeFolderName(options);
      try{await parent.getDirectoryHandle(folderName,{create:false});continue;}catch(error){if(collision(error))continue;if(!notFound(error))throw error;}
      let directory=null,claimedFolder=false,writer=null;const claimed=[];
      try{
        // File System Access has no exclusive directory-create operation. A cryptographic identifier,
        // existing-name probe and empty-directory check avoid normal reuse, but are not a race lock.
        directory=await parent.getDirectoryHandle(folderName,{create:true});
        if(!await empty(directory))throw new Error('The new save folder already contains files and was not used');
        claimedFolder=true;
        for(const file of ordered){
          try{await directory.getFileHandle(file.name,{create:false});throw new Error(file.name+' already exists in the new folder and was not overwritten');}catch(error){if(!notFound(error))throw error;}
          const handle=await directory.getFileHandle(file.name,{create:true});
          // A file appearing between the probe and create must not be truncated if it has contents.
          if((await handle.getFile()).size!==0)throw new Error(file.name+' appeared in the new folder and was not overwritten');
          claimed.push({name:file.name,handle});
          writer=await handle.createWritable();
          await writer.write(file.blob);await writer.close();writer=null;
        }
        let count=0;
        for await(const [name,handle] of directory.entries()){
          const own=claimed.find(file=>file.name===name);
          if(!own||!await sameEntry(own.handle,handle))throw new Error('Different files appeared in the new save folder');
          count++;
        }
        if(count!==ordered.length)throw new Error('An image disappeared before the folder save completed');
        return {folderName,handle:directory};
      }catch(error){
        if(writer&&typeof writer.abort==='function'){try{await writer.abort();}catch(ignore){}}
        const state=claimedFolder?await cleanup(parent,folderName,directory,claimed):{remains:directory!==null,errors:[]};
        throw saveError(error,folderName,state);
      }
    }
    throw new Error('Could not find a new image folder name; no existing folder was reused');
  }
  const crcTable=Uint32Array.from({length:256},(_,value)=>{
    let crc=value;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;
  });
  function crc32(bytes){let crc=0xffffffff;for(let i=0;i<bytes.length;i++)crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
  function safeFolderName(name){
    if(typeof name!=='string'||!name||name.length>255||/[\x00-\x1f<>:"/\\|?*]/.test(name)||/[. ]$/.test(name)||name==='.'||name==='..'||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw new TypeError('A safe single folder name is required');
    return name;
  }
  function createZip(folderName,files){
    safeFolderName(folderName);const ordered=orderedFiles(files,'data'),encoder=new TextEncoder();
    const p=partsFor(new Date(),DEFAULT_ZONE),year=Math.max(1980,Math.min(2107,Number(p.year)));
    const dosDate=((year-1980)<<9)|(Number(p.month)<<5)|Number(p.day),dosTime=(Number(p.hour)<<11)|(Number(p.minute)<<5)|(Number(p.second)>>>1);
    const entries=[{name:folderName+'/',data:new Uint8Array(0),directory:true},...ordered.map(file=>({name:folderName+'/'+file.name,data:file.data,directory:false}))];
    const localParts=[],centralParts=[];let offset=0,centralSize=0;
    for(const entry of entries){
      const name=encoder.encode(entry.name),size=entry.data.byteLength;
      if(name.length>0xffff)throw new RangeError('ZIP entry name exceeds the ZIP32 limit');
      const nextOffset=offset+30+name.length+size;
      if(nextOffset>MAX32)throw new RangeError('Archive data exceeds the ZIP32 size limit');
      const crc=crc32(entry.data),local=new Uint8Array(30),l=new DataView(local.buffer);
      l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x0800,true);l.setUint16(8,0,true);
      l.setUint16(10,dosTime,true);l.setUint16(12,dosDate,true);l.setUint32(14,crc,true);l.setUint32(18,size,true);l.setUint32(22,size,true);l.setUint16(26,name.length,true);
      const central=new Uint8Array(46),c=new DataView(central.buffer);
      c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(10,0,true);
      c.setUint16(12,dosTime,true);c.setUint16(14,dosDate,true);c.setUint32(16,crc,true);c.setUint32(20,size,true);c.setUint32(24,size,true);
      c.setUint16(28,name.length,true);c.setUint32(38,entry.directory?0x10:0,true);c.setUint32(42,offset,true);
      localParts.push(local,name,entry.data);centralParts.push(central,name);offset=nextOffset;centralSize+=46+name.length;
    }
    if(centralSize>MAX32||offset+centralSize+22>MAX32)throw new RangeError('Archive exceeds the ZIP32 size limit');
    const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
    // Blob takes immutable snapshots of the parts; image payloads are never concatenated into a giant array.
    return new Blob([...localParts,...centralParts,end],{type:'application/zip'});
  }
  return {makeFolderName,writeNewFolder,createZip};
});

