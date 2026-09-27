const assert=require('assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..'),listeners=new Map(),frames=new Map();let frameId=0,nativeCallback,unsubscribed=0,now=0;
const viewer={values:{},setParameter(id,value){this.values[id]=value},renderNow(){},playMotion(){},destroy(){this.destroyed=true}};
const canvas={getBoundingClientRect:()=>({left:300,top:100,width:400,height:600})};
const window={innerWidth:1000,innerHeight:800,addEventListener(type,fn,options){const rows=listeners.get(type)||[];rows.push({fn,capture:options===true||!!options?.capture});listeners.set(type,rows)},removeEventListener(type,fn){listeners.set(type,(listeners.get(type)||[]).filter(v=>v.fn!==fn))},dashboardPointer:{subscribe(fn){nativeCallback=fn;return()=>{unsubscribed++;nativeCallback=null}}}};
const ctx={window,document:{getElementById:()=>canvas,documentElement:{}},performance:{now:()=>now},requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId},cancelAnimationFrame:id=>frames.delete(id),console};
let source=fs.readFileSync(path.join(root,'live2d-controller.js'),'utf8').replace(/^import .*;$/m,'').replace('export class','class');
vm.runInNewContext(source+'\nglobalThis.Controller=PiChanLive2D;',ctx);
const c=new ctx.Controller('canvas');c.viewer=viewer;c.bindGlobalPointerTracking();c.startKinematicsLoop();
function move(x,y){listeners.get('pointermove')[0].fn({clientX:x,clientY:y})}
function tick(count=50){for(let i=0;i<count;i++){now+=16;const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(now)}}
assert.equal(listeners.get('pointermove')[0].capture,true);
const results=[];
for(const mood of ['neutral','thinking','analytical','smug','happy']){
 c.setMood(mood);move(10,40);tick();const left={...viewer.values};move(990,740);tick();const right={...viewer.values};
 assert.ok(right.ParamEyeBallX-left.ParamEyeBallX>0.8,mood+' gaze X');assert.ok(right.ParamAngleX-left.ParamAngleX>20,mood+' head X');assert.ok(left.ParamEyeBallY-right.ParamEyeBallY>0.6,mood+' gaze Y');assert.ok(left.ParamAngleY-right.ParamAngleY>15,mood+' head Y');results.push({mood,eyeDelta:right.ParamEyeBallX-left.ParamEyeBallX,headDelta:right.ParamAngleX-left.ParamAngleX});
}
c.isSpeaking=true;c.setMood('thinking');move(990,40);tick();const speakingX=viewer.values.ParamAngleX;move(10,740);tick();assert.ok(speakingX-viewer.values.ParamAngleX>20,'speech does not lock tracking');
const gaze=c.targetParams.ParamEyeBallX;c.setMood('thinking');assert.equal(c.targetParams.ParamEyeBallX,gaze,'repeated Jev mood keeps pointer pose');assert.ok(c.moodTracking.ParamAngleZ>0,'thinking tilt retained');
nativeCallback({cursorX:900,cursorY:120,winX:0,winY:0,zoom:1});tick();assert.ok(viewer.values.ParamEyeBallX>0,'native tracking also works');
c.bindGlobalPointerTracking();assert.equal(listeners.get('pointermove').length,1);assert.equal(unsubscribed,1);
// Soullink must not stomp tracking axes, but can still apply its brows/expression.
source=fs.readFileSync(path.join(root,'emotion-bridge.js'),'utf8').replace(/^import[\s\S]*?from .*?;\s*/,'').replace(/export (const|function|class)/g,'$1').replace(/^export \{.*\};/m,'');
vm.runInNewContext(source+'\nglobalThis.Bridge=SoullinkEmotionBridge;',ctx);const b=new ctx.Bridge({controller:c});const prior=viewer.values.ParamEyeBallX;b.applySnapshot({live2dParams:{ParamEyeBallX:-0.99,ParamAngleX:-29,ParamMouthOpenY:1,ParamBrowLY:0.6},vad:{current:{valence:0,arousal:0,dominance:0}}},1);assert.equal(viewer.values.ParamEyeBallX,prior);assert.equal(viewer.values.ParamBrowLY,0.6);
c.destroy();assert.equal(unsubscribed,2);assert.equal(listeners.get('pointermove').length,0);assert.equal(listeners.get('pagehide').length,0);assert.equal(frames.size,0);assert.ok(viewer.destroyed);
fs.writeFileSync(path.join(root,'live2d-pointer-test-results.json'),JSON.stringify({passed:true,results,checks:['thinking gaze and head parameters move','speech tracking','capture-phase window pointer','native pointer','repeated mood composition','Soullink tracking ownership','rebinding and destruction cleanup']},null,2));console.log('PASS: pointer changes viewer parameters in all moods, including speech; competing emotion and cleanup verified');
