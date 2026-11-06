import test from 'node:test';
import assert from 'node:assert/strict';
import {retryPlan, itemFailure, canAutoContinue} from '../static/resilience.mjs';
test('temporary failures back off and server cooldowns are respected',()=>{
 assert.deepEqual(retryPlan({code:'NETWORK'},1,1000),{retry:true,at:3500});
 assert.equal(retryPlan({code:'NETWORK'},50,1000).at,61000);
 assert.equal(retryPlan({code:'THROTTLED',retryAt:301000},1,1000).at,301000);
 for(const code of ['OFFLINE','ADD_UNCERTAIN','EXTENSION_TIMEOUT','BUSY'])assert.ok(retryPlan({code},1,0).retry);
});
test('identity, storage and uncertain-creation errors require an explicit remedy',()=>{
 for(const code of ['ACCOUNT_CHANGED','APP_LOGIN','STORAGE','STATE_CONFLICT','WRONG_PLAYLIST','RESPONSE_CHANGED','SEARCH_REJECTED'])assert.equal(retryPlan({code},1,0).retry,false);
 assert.ok(retryPlan({code:'CREATE_UNCERTAIN'},3,0).retry);assert.equal(retryPlan({code:'CREATE_UNCERTAIN'},4,0).retry,false);
});
test('a repeatedly failing search row can be isolated, while disconnection and throttling remain resumable',()=>{
 assert.ok(itemFailure({trackId:'a',code:'NETWORK',status:502},3));
 assert.equal(itemFailure({trackId:'a',code:'NETWORK',status:502},2),false);
 for(const code of ['OFFLINE','THROTTLED','ACCOUNT_CHANGED'])assert.equal(itemFailure({trackId:'a',code,status:502},8),false);
});
test('automatic continuation survives reload while an intentional pause stays paused',()=>{
 assert.ok(canAutoContinue({status:'paused',autoContinue:true}));
 assert.ok(canAutoContinue({status:'paused'}));
 assert.equal(canAutoContinue({status:'paused',autoContinue:false}),false);
 assert.equal(canAutoContinue({status:'complete',autoContinue:true}),false);
});
