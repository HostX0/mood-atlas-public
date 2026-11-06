import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCSV,mapCSV,normaliseTracks,mergeTracks,videoId,playlistId,exportCSV,cleanBackup} from '../static/core.mjs';
test('CSV BOM and quoted commas',()=>{const x=parseCSV('\uFEFFTitle,Artist\r\n"A, song",Artist');assert.equal(x.headers[0],'Title');assert.equal(x.rows[0][0],'A, song');});
test('semicolon and tab',()=>{assert.equal(parseCSV('Title;Artist\nX;Y').rows[0][1],'Y');assert.equal(parseCSV('Title\tArtist\nX\tY').rows[0][1],'Y');});
test('unclosed quotes fail',()=>assert.throws(()=>parseCSV('Title,Artist\n"unclosed,Artist')));
test('map and dedup per playlist',()=>{const p=parseCSV('Track,Artist,Playlist\nA,B,One\nA,B,One\nA,B,Two');assert.equal(normaliseTracks(mapCSV(p,0,1,2,'Default')).length,2);assert.throws(()=>mapCSV(p,0,0,2,'Default'));});
test('YouTube links not lookalikes',()=>{assert.equal(videoId('https://music.youtube.com/watch?v=abcdefghijk'),'abcdefghijk');assert.equal(videoId('https://youtu.be/abcdefghijk'),'abcdefghijk');assert.equal(videoId('https://youtube.com.evil.test/watch?v=abcdefghijk'),null);});
test('CSV formula protection',()=>assert.ok(exportCSV([['=HYPERLINK("evil")']]).includes("'=HYPERLINK")));
test('backup strips secrets',()=>{const b=cleanBackup({version:1,auth:{cookie:'SECRET'},tracks:[{title:'A',artist:'B',playlist:'C',status:'ready',choice:{videoId:'abcdefghijk',cookie:'SECRET'}}],groups:{}});assert.ok(!JSON.stringify(b).includes('SECRET'));});
test('merging repeated imports preserves IDs, decisions and existing destination groups',()=>{
 const current=[{id:'7',title:'A',artist:'B',playlist:'One',status:'added',choice:{videoId:'abcdefghijk'}}];
 const merged=mergeTracks(current,[{title:'A',artist:'B',playlist:'one'},{title:'C',artist:'D',playlist:'ONE'}]);
 assert.equal(merged.added,1);assert.equal(merged.duplicates,1);assert.equal(merged.tracks[0],current[0]);assert.equal(merged.tracks[1].id,'8');assert.equal(merged.tracks[1].playlist,'One');
});
test('backup round trip remaps paused-task IDs and retains recording eligibility',()=>{
 const b=cleanBackup({version:1,revision:8,tracks:[{id:'7',title:'A',playlist:'One',status:'ready',choice:{videoId:'abcdefghijk',autoEligible:true,confident:false}}],groups:{One:{marker:'a'.repeat(32),playlistId:'PLabcdefghijk',destinationName:'Destination',account:'b'.repeat(64)}},task:{kind:'transfer',playlist:'One',status:'paused',trackIds:['7','unknown']},settings:{matchMode:'safe'}});
 assert.deepEqual(b.task.trackIds,['0']);assert.ok(b.tracks[0].choice.autoEligible);assert.equal(b.revision,8);assert.equal(b.settings.matchMode,'safe');assert.equal(b.groups.One.destinationName,'Destination');assert.equal(cleanBackup(b).task.trackIds[0],'0');
});
test('quoted delimiters in the header and repeated case-insensitive columns',()=>{assert.equal(parseCSV('"Song; title",Artist\nAria,Argy').headers.length,2);assert.throws(()=>parseCSV('Title,title\nA,B'));});
test('recovery playlist links reject lookalikes and executable schemes',()=>{assert.equal(playlistId('https://music.youtube.com/playlist?list=PLabcdefghijk'),'PLabcdefghijk');assert.equal(playlistId('https://youtube.com.evil.test/playlist?list=PLabcdefghijk'),null);assert.equal(playlistId('javascript:alert(1)'),null);});
test('separate collection tasks survive backup without crossing their track IDs',()=>{
 const b=cleanBackup({version:1,tracks:[{id:'8',title:'A',playlist:'One'},{id:'9',title:'B',playlist:'Two'}],tasks:{One:{kind:'matching',playlist:'One',status:'paused',trackIds:['8','9']},Two:{kind:'transfer',playlist:'Two',status:'paused',trackIds:['9']}}});
 assert.deepEqual(b.tasks.One.trackIds,['0']);assert.deepEqual(b.tasks.Two.trackIds,['1']);
});
