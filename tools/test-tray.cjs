const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert/strict');
let saved=null,tray,handlers={};class Tray{constructor(image){this.image=image;this.handlers={};tray=this;}on(k,f){this.handlers[k]=f;}setToolTip(v){this.tip=v;}setImage(v){this.image=v;}setContextMenu(v){this.menu=v;}}
const electron={app:{setName(){},getPath(){return '/fixture';}},ipcMain:{handle(k,f){handlers[k]=f;},on(){}},protocol:{registerSchemesAsPrivileged(){}},Tray,nativeImage:{createFromPath:p=>p},Menu:{buildFromTemplate:x=>x}};
const mockfs={existsSync:()=>!!saved,readFileSync:()=>saved,writeFileSync:(p,s)=>saved=s};
const source=fs.readFileSync('pet/main.js','utf8').split('const gotSingleLock =')[0];
const context=vm.createContext({console,URL,__dirname:path.resolve('pet'),setTimeout,clearTimeout,setInterval,clearInterval,require(name){if(name==='electron')return electron;if(name==='fs')return mockfs;if(name==='./wake-engine')return {};if(name.startsWith('./'))return require(path.resolve('pet',name));return require(name);}});
vm.runInContext(source+'\ncreateTray();globalThis.sharedState=shared;',context);
assert.match(tray.tip,/唤醒待命/);assert.ok(tray.handlers.click);assert.ok(tray.handlers['double-click']);
const listening=tray.menu.find(x=>x.label?.startsWith('唤醒监听'));listening.click({checked:false});assert.match(tray.tip,/麦克风关闭/);assert.equal(JSON.parse(saved).voiceSettings.asrEnabled,false);
handlers['shared-update'](null,{voiceSettings:{ttsEnabled:true},speaking:true});assert.match(tray.tip,/正在说话/);assert.equal(JSON.parse(saved).voiceSettings.asrEnabled,false);
assert.ok(tray.menu.some(x=>x.label?.includes('退出')));console.log('PASS mocked native tray lifecycle, status, menu and persisted microphone toggle');
