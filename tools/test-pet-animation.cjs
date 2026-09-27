const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
let now=0,tick,events;const callbacks={},nodes={};
function node(){return {style:{setProperty(){}},dataset:{},classList:{add(){},remove(){},toggle(){}},setAttribute(k,v){this[k]=v},addEventListener(k,v){this[k]=v},setPointerCapture(){},textContent:''};}
const body=node(),window={petAPI:{onGlobalMousePos:f=>callbacks.mouse=f,onWakeEvent:f=>callbacks.wake=f,onAsrEvent:f=>callbacks.asr=f,onStateChange:f=>callbacks.state=f},addEventListener(){}};
class Voice {constructor(){this.isTtsPlaying=false;}init(){}speakAgentReply(){}beginAgentSpeech(){}onAgentTextDelta(){}onAgentResponse(){}stopTtsPlayback(){}}
const context=vm.createContext({console,window,document:{body,getElementById:id=>nodes[id]??=node()},navigator:{},VoiceUIController:Voice,performance:{now:()=>now},matchMedia:()=>({matches:false}),requestAnimationFrame:fn=>(tick=fn,1),cancelAnimationFrame(){},Image:class{},EventSource:class{constructor(){events=this;}close(){}},Date:{now:()=>now},Math,URLSearchParams,location:{search:''},setTimeout:()=>1,clearTimeout(){},setInterval:fn=>(tick=fn,1),clearInterval(){},innerWidth:300});
vm.runInContext(fs.readFileSync('pet/pet-animator.js','utf8').replace('export class','class'),context);
const code=fs.readFileSync('pet/chibi.js','utf8').replace(/^import .*;\r?$/gm,'');vm.runInContext(code,context);
function step(ms=0){now+=ms;tick(now);}
function check(expected){step();assert.ok(nodes.sprite.src.endsWith(`frame_${String(expected).padStart(3,'0')}.png`),nodes.sprite.src);}
check(1);step(2600);check(2);step(45);check(3);step(45);check(4);step(150);check(1);
callbacks.wake({});step();check(7);step(75);check(8);step(300);check(12);
events.onmessage({data:JSON.stringify({type:'pi_event',payload:{type:'agent_start',source:'pet-wake'}})});
step();check(11);step(750);check(18);
vm.runInContext('voice.isTtsPlaying=true; mouth=.8;',context);step();step(600);assert.ok(Number(nodes.mouthShape.ry)>1);
vm.runInContext('voice.isTtsPlaying=false;pet();',context);step();step(450);check(24);
step(1700);step(600);check(1);step(46000);step(300);check(4);
callbacks.mouse({cursorX:900,winX:0,winW:300});step();step(300);check(1);
callbacks.asr({type:'error',text:'测试错误'});assert.equal(nodes.bubbleText.textContent,'测试错误');
fs.writeFileSync('pet-animation-test-results.json',JSON.stringify({at:new Date().toISOString(),passed:['idle','random-blink','listening','thinking','audio-mouth-wide','audio-mouth-small','tap-happy','return-idle','sleepy','mouse-wake','error-bubble']},null,2));
console.log('PASS sprite in-betweens, release/enter transitions, blink, audio mouth, idle, input events');

