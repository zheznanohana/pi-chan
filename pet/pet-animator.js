// Real sprite in-betweens, timed independently of display refresh rate.
export class PetAnimator {
  constructor(now=0){this.frame=1;this.target='idle';this.queue=[];this.nextAt=now;this.nextBlink=now+2500;}
  setTarget(target,now){
    if(target===this.target)return;
    this.target=target;
    if(target==='idle')this.nextBlink=now+1800+Math.random()*2000;
    const row=Math.floor((this.frame-1)/6),pos=(this.frame-1)%6;
    const release=row>0 ? Array.from({length:pos},(_,i)=>row*6+pos-i) : [];
    const enter=target==='listening'?[7,8,9,10,11,12]:target==='thinking'?[13,14,15,16,17,18]:target==='happy'?[19,20,21,22,23,24]:target==='sleepy'?[1,2,3,4]:[1];
    this.queue=[...release,...enter];this.nextAt=now;
  }
  update(now,reduced=false){
    if(reduced){this.frame=({listening:12,thinking:18,happy:24,sleepy:4})[this.target]||1;this.queue=[];return this.frame;}
    if(this.target==='idle'&&!this.queue.length&&now>=this.nextBlink){this.queue=[2,3,4,5,6,1];this.nextAt=now;this.nextBlink=now+3000+Math.random()*4500;}
    // Advance by elapsed time, not callback count; cap catch-up after a hidden tab.
    let steps=0;while(this.queue.length&&now>=this.nextAt&&steps++<24){this.frame=this.queue.shift();this.nextAt+=this.target==='idle'?45:75;}
    return this.frame;
  }
}
