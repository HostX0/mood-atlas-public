export function parseCSV(text){
 text=String(text).replace(/^\uFEFF/,'');const first=text.split(/\r?\n/)[0]||'';
 const counts={',':0,';':0,'\t':0};let headerQuoted=false;
 for(let i=0;i<first.length;i++){if(first[i]==='"'){if(headerQuoted&&first[i+1]==='"')i++;else headerQuoted=!headerQuoted;}else if(!headerQuoted&&Object.hasOwn(counts,first[i]))counts[first[i]]++;}
 const delimiter=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else if(quoted)quoted=false;else if(!field)quoted=true;else field+=c;}
 else if(c===delimiter&&!quoted){row.push(field);field='';}
 else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(s=>s.trim()))rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw new Error('The CSV file has an unclosed quote.');row.push(field);if(row.some(s=>s.trim()))rows.push(row);
 if(rows.length<2)throw new Error('The file needs a header row and at least one song.');const headers=rows.shift().map(s=>s.trim());
 if(new Set(headers.map(s=>s.toLowerCase())).size!==headers.length)throw new Error('The CSV has duplicate column names.');return{headers,rows};
}
export function mapCSV(parsed,title,artist,playlist,defaultName){
 if(!Number.isInteger(title)||title<0||title>=parsed.headers.length)throw new Error('Select the song title column.');
 const columns=[title,artist,playlist].filter(n=>n>=0);if(new Set(columns).size!==columns.length)throw new Error('Select a different column for each field.');
 return parsed.rows.map(r=>({title:(r[title]||'').trim().slice(0,500),artist:(r[artist]||'').trim().slice(0,500),playlist:((playlist>=0?r[playlist]:'')||defaultName||'My playlist').trim().slice(0,150)})).filter(r=>r.title);
}
export function mergeTracks(current,incoming){
 const fresh=normaliseTracks(incoming),key=t=>JSON.stringify([t.playlist,t.title,t.artist].map(s=>String(s||'').trim().toLowerCase()));
 const seen=new Set(current.map(key)),names=new Map(current.map(t=>[t.playlist.toLowerCase(),t.playlist]));
 const result=[...current];let added=0,duplicates=incoming.filter(t=>t.title).length-fresh.length,nextId=Math.max(-1,...current.map(t=>Number(t.id)).filter(Number.isFinite))+1;
 for(const track of fresh){track.playlist=names.get(track.playlist.toLowerCase())||track.playlist;names.set(track.playlist.toLowerCase(),track.playlist);const k=key(track);if(seen.has(k)){duplicates++;continue;}seen.add(k);result.push({...track,id:String(nextId++),decisionSource:null,error:null});added++;}
 if(result.length>20000)throw new Error('The library would exceed 20,000 tracks. Download a backup and work with smaller libraries.');
 return{tracks:result,added,duplicates};
}
export function normaliseTracks(input){
 if(!Array.isArray(input)||input.length>20000)throw new Error('Choose a file with at most 20,000 tracks.');const result=[],seen=new Set();
 for(const item of input){const title=String(item.title||'').trim().slice(0,500),artist=String(item.artist||'').trim().slice(0,500),playlist=String(item.playlist||'My playlist').trim().slice(0,150);if(!title)continue;
 const key=JSON.stringify([playlist.toLowerCase(),title.toLowerCase(),artist.toLowerCase()]);if(seen.has(key))continue;seen.add(key);result.push({id:String(result.length),title,artist,playlist,status:'pending',candidates:[],choice:null});}return result;
}
export function videoId(value){
 if(/^[A-Za-z0-9_-]{11}$/.test(value))return value;try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol))return null;let id;
 if(u.hostname==='youtu.be')id=u.pathname.split('/')[1];else if(['youtube.com','www.youtube.com','music.youtube.com','m.youtube.com'].includes(u.hostname))id=u.searchParams.get('v')||(/^\/(shorts|embed)\//.test(u.pathname)?u.pathname.split('/')[2]:null);
 return /^[A-Za-z0-9_-]{11}$/.test(id||'')?id:null;}catch{return null;}
}
export function csvCell(value){let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function playlistId(value){try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||!['youtube.com','www.youtube.com','music.youtube.com','m.youtube.com'].includes(u.hostname))return null;const id=u.searchParams.get('list');return /^[A-Za-z0-9_-]{10,100}$/.test(id||'')?id:null;}catch{return null;}}
export function exportCSV(rows){return '\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');}
export function cleanBackup(data){
 if(!data||data.version!==1||!Array.isArray(data.tracks)||data.tracks.length>20000)throw new Error('This is not a valid Mood Atlas backup.');const statuses=new Set(['pending','review','ready','added','skipped']);
 const tracks=data.tracks.map((t,i)=>{if(typeof t.title!=='string'||typeof t.playlist!=='string')throw new Error('The backup has an invalid track.');
 const clean=c=>c&&videoId(c.videoId)?{videoId:videoId(c.videoId),title:String(c.title||'').slice(0,500),artist:String(c.artist||'').slice(0,500),score:Math.max(0,Math.min(1,Number(c.score)||0)),duration:String(c.duration||'').slice(0,25),album:String(c.album||'').slice(0,200),reason:String(c.reason||'').slice(0,100),confident:c.confident===true,autoEligible:c.autoEligible===true}:null;
 const choice=clean(t.choice);let status=statuses.has(t.status)?t.status:'pending';if(['ready','added'].includes(status)&&!choice)status='review';
 return{id:String(i),title:t.title.slice(0,500),artist:String(t.artist||'').slice(0,500),playlist:t.playlist.slice(0,150),status,choice,candidates:(Array.isArray(t.candidates)?t.candidates:[]).slice(0,8).map(clean).filter(Boolean),decisionSource:['automatic','confident','manual','bulk'].includes(t.decisionSource)?t.decisionSource:null,error:t.error?String(t.error).slice(0,100):null};});
 const groups=Object.create(null);for(const name of new Set(tracks.map(t=>t.playlist))){const g=data.groups?.[name];if(g&&/^[a-f0-9]{32}$/.test(g.marker||''))groups[name]={marker:g.marker,playlistId:/^[A-Za-z0-9_-]{10,100}$/.test(g.playlistId||'')?g.playlistId:null,account:String(g.account||'').slice(0,64),accountName:String(g.accountName||'').slice(0,200),destinationName:String(g.destinationName||name).slice(0,150),transport:g.transport==='extension'?'extension':'legacy'};}
 const idMap=new Map(data.tracks.map((t,i)=>[String(t.id??i),String(i)]));
 const names = new Set(tracks.map(t => t.playlist));
 const decodeTask = (raw, all = false) => {
  if (!raw || !['matching', 'transfer'].includes(raw.kind) || (all ? raw.kind !== 'matching' : !names.has(raw.playlist))) return null;
  const decodeIds = ids => (Array.isArray(ids) ? ids : []).map(id => idMap.get(String(id)))
    .filter(id => id !== undefined && (all || tracks[Number(id)].playlist === raw.playlist));
  const trackIds = decodeIds(raw.trackIds);
  return {kind: raw.kind, playlist: all ? null : raw.playlist, trackIds,
    status: ['running', 'paused', 'complete'].includes(raw.status) ? raw.status : 'paused',
    done: Math.min(trackIds.length, Math.max(0, Math.floor(Number(raw.done) || 0))), total: trackIds.length,
    updated: Number(raw.updated) || 0, code: String(raw.code || '').slice(0, 80), retryAt: Math.max(0, Number(raw.retryAt) || 0),
    refresh: raw.refresh === true, matchMode: raw.matchMode === 'safe' ? 'safe' : 'auto',
    autoContinue: raw.autoContinue !== false, failedIds: decodeIds(raw.failedIds)};
 };
 const tasks = Object.create(null);
 for (const name of names) {
  const value = decodeTask(data.tasks?.[name]);
  if (value?.playlist === name) tasks[name] = value;
 }
 const task = decodeTask(data.task);
 if (task) tasks[task.playlist] = task;
 let batch = null;
 const rawBatch = data.batch;
 if (rawBatch && ['search', 'transfer'].includes(rawBatch.phase)) {
  const existing = value => Array.isArray(value) ? [...new Set(value.filter(name => names.has(name)))] : [];
  const queue = existing(rawBatch.queue);
  batch = {phase: rawBatch.phase, names: existing(rawBatch.names), queue,
    index: Math.min(queue.length, Math.max(0, Math.floor(Number(rawBatch.index) || 0))),
    status: ['running', 'paused', 'complete'].includes(rawBatch.status) ? rawBatch.status : 'paused',
    autoContinue: rawBatch.autoContinue !== false, code: String(rawBatch.code || '').slice(0, 80),
    search: decodeTask(rawBatch.search, true),
    account: /^[a-f0-9]{64}$/.test(rawBatch.account || '') ? rawBatch.account : null,
    accountName: String(rawBatch.accountName || '').slice(0, 200), excluded: existing(rawBatch.excluded), issues: existing(rawBatch.issues)};
 }
 const receipts=(Array.isArray(data.receipts)?data.receipts:[]).slice(-20).filter(r=>/^[A-Za-z0-9_-]{10,100}$/.test(r.playlistId||'')).map(r=>({playlistId:r.playlistId,name:String(r.name||'').slice(0,150),count:Math.max(0,Number(r.count)||0),at:Number(r.at)||0}));
 return{version:1,revision:Math.max(0,Number(data.revision)||0),tracks,groups,selected:tracks.some(t=>t.playlist===data.selected)?data.selected:tracks[0]?.playlist||null,task,tasks,batch,receipts,settings:{matchMode:data.settings?.matchMode==='safe'?'safe':'auto'},savedAt:Number(data.savedAt)||0};
}
