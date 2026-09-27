const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const context=vm.createContext({console,clearTimeout,clearInterval,setTimeout,setInterval,WebSocket:{OPEN:1},document:{getElementById:()=>null},window:{}});
vm.runInContext(fs.readFileSync('settings-panel.js','utf8').replace(/export /g,'')+'\nglobalThis.Panel=VoiceSettingsPanel;',context);
const panel=Object.create(context.Panel.prototype);let stops=0;const sent=[];
panel.voiceUI={currentVoiceKey:'vits-aishell3',currentSid:51,stopTtsPlayback(){stops++},initTtsAudioContext(){},ttsAudioCtx:{},ws:{readyState:1,send:s=>sent.push(JSON.parse(s))}};
panel.updateAuditionButtonState=()=>{};panel.settings={voiceKey:'vits-aishell3',cloneVoiceKey:'gpt-sovits-klee',speakerId:51,outputDeviceId:'default'};
panel.stopAudition();assert.equal(stops,0,'closing idle settings must not cancel conversation');
(async()=>{await panel.playAudition(true);assert.equal(sent[0].voice,'gpt-sovits-klee');assert.equal(panel.voiceUI.currentVoiceKey,'vits-aishell3');assert.equal(panel.voiceUI.currentSid,51);panel.stopAudition();assert.equal(stops,2);console.log('PASS clone audition isolated; idle settings close preserves live audio');})().catch(e=>{console.error(e);process.exitCode=1});
