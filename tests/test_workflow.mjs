import test from 'node:test';
import assert from 'node:assert/strict';
import {applyMatches, auditChoices, bulkEdit, editSnapshot, filterTracks, nextStep, suggestion, transferLocked, researchTargets, uniqueVideos, versionConflict} from '../static/workflow.mjs';
const candidate = (extra = {}) => ({videoId: 'abcdefghijk', title: 'Aria', artist: 'Argy', score: .95, confident: true, autoEligible: true, reason: 'high_similarity', ...extra});
const track = (extra = {}) => ({id: '0', title: 'Aria', artist: 'Argy', playlist: 'One', status: 'pending', candidates: [], choice: null, ...extra});
test('automatic preparation accepts suitable ambiguous recordings, precise mode keeps them for review', () => {
  const c = candidate({confident: false, reason: 'ambiguous_recording'});
  assert.equal(applyMatches(track(), [c], 'auto').status, 'ready');
  assert.equal(applyMatches(track(), [c], 'safe').status, 'review');
});
test('album-only and performer-substitution version conflicts cannot be approved in bulk', () => {
  for (const c of [candidate({album: 'Opera Karaoke'}), candidate({artist: 'A Tribute Cover Band'}), candidate({title: 'Aria (Live)'})]) {
    const t = track({status: 'review', candidates: [c]});
    assert.ok(versionConflict(t, c)); assert.equal(suggestion(t), null);
    assert.deepEqual(bulkEdit([t], 'accept'), {changed: 0, unresolved: 1}); assert.equal(t.status, 'review');
  }
});
test('an explicitly requested live version is eligible while a studio substitute is not', () => {
  const t = track({title: 'Aria Live', candidates: [candidate({title: 'Aria Live'})]});
  assert.ok(suggestion(t)); assert.ok(versionConflict(t, candidate()));
});
test('bulk decisions preserve completed rows and provide enough state for undo', () => {
  const a = track({status: 'review', candidates: [candidate()]}), b = track({id: '1', status: 'added', choice: candidate()});
  const before = editSnapshot([a, b]); assert.equal(bulkEdit([a, b], 'accept').changed, 1);
  assert.equal(a.status, 'ready'); assert.equal(a.decisionSource, 'bulk');
  bulkEdit([a, b], 'skip'); assert.equal(a.status, 'skipped'); assert.equal(b.status, 'added');
  Object.assign(a, before[0]); assert.equal(a.choice, null); assert.equal(a.status, 'review');
});
test('all filtered results remain reachable and duplicate choices count once', () => {
  const rows = Array.from({length: 105}, (_, i) => track({id: String(i), title: i % 2 ? 'أغنية' : 'Ária', status: i < 2 ? 'added' : 'ready', choice: candidate()}));
  assert.equal(filterTracks(rows.map(t => ({...t, choice: null})), 'ready', 'aria').length, 52);
  assert.equal(filterTracks(rows, 'ready', 'aria').length, 103); assert.equal(uniqueVideos(rows).length, 1);
});
test('next action covers partial completion, unresolved songs, empty results and deferrals', () => {
  assert.equal(nextStep([]).kind, 'empty');
  assert.equal(nextStep([track({status: 'ready'}), track()]).kind, 'transfer');
  assert.equal(nextStep([track()]).kind, 'prepare');
  assert.equal(nextStep([track({status: 'review'})]).kind, 'review');
  assert.equal(nextStep([track({status: 'added'}), track({status: 'skipped'})]).kind, 'complete');
  assert.equal(nextStep([track({status: 'skipped'})]).kind, 'deferred');
});
test('unfinished transfer choices are fixed until reconciliation or an explicit new copy', () => {
  const task = {kind: 'transfer', status: 'paused', trackIds: ['0']};
  assert.ok(transferLocked(track({status: 'ready'}), task));
  assert.equal(transferLocked(track({id: '1'}), task), false);
  assert.equal(transferLocked(track(), {...task, status: 'complete'}), false);
  assert.equal(transferLocked(track(), {...task, kind: 'matching'}), false);
});
test('legacy automatic version substitutions return to review without changing explicit or completed choices', () => {
  const choice = candidate({album: 'Karaoke Hits'}), automatic = track({status: 'ready', choice});
  const explicit = track({status: 'ready', choice, decisionSource: 'manual'}), completed = track({status: 'added', choice});
  assert.equal(auditChoices([automatic, explicit, completed]), 1);
  assert.equal(automatic.status, 'review'); assert.equal(automatic.choice, null); assert.equal(explicit.status, 'ready'); assert.equal(completed.status, 'added');
});
test('whole-collection research includes ready and deferred rows, preserves manual and transferred choices by default', () => {
 const rows=[track({id:'0'}),track({id:'1',status:'ready',choice:candidate()}),track({id:'2',status:'review'}),track({id:'3',status:'skipped'}),track({id:'4',status:'ready',decisionSource:'manual'}),track({id:'5',status:'added'})];
 assert.deepEqual(researchTargets(rows).map(t=>t.id),['0','1','2','3']);
 assert.equal(researchTargets(rows,{keepManual:false}).length,5);
 assert.deepEqual(researchTargets(rows,{scope:'unresolved'}).map(t=>t.id),['0','2']);
 assert.equal(researchTargets(rows,{},t=>t.id==='1').length,3);
});
