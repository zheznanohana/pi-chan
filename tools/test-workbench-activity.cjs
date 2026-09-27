const assert=require('node:assert/strict');
const {createWorkbenchActivity}=require('../workbench-activity.cjs');
(async()=>{
 let now=0,ready=false;
 const tracker=createWorkbenchActivity({now:()=>now,status:async()=>({ready})});
 assert.equal(await tracker.isBusy(),false);
 ready=true;now=6000;assert.equal(await tracker.isBusy(),true);
 tracker.update({clientId:'one',connected:true,isStreaming:false});assert.equal(await tracker.isBusy(),false);
 tracker.update({clientId:'two',connected:true,isStreaming:true});assert.equal(await tracker.isBusy(),true);
 tracker.update({clientId:'two',connected:false});assert.equal(await tracker.isBusy(),false);
 now+=31000;assert.equal(await tracker.isBusy(),true);
 ready=false;now+=6000;assert.equal(await tracker.isBusy(),false);
 assert.throws(()=>tracker.update({clientId:42}));
 console.log('PASS: unavailable/idle/busy/multiple clients/stale observer/validation');
})().catch(e=>{console.error(e);process.exitCode=1});
