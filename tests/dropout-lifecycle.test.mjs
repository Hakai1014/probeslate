import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {StabilityAnalyzer} from '../audio/microphone-dropout-test/analyzer.js';
const app = readFileSync(new URL('../audio/microphone-dropout-test/app.js',import.meta.url),'utf8').replaceAll('import.meta.url', '"https://probeslate.com/audio/microphone-dropout-test/app.js"');
function harness({pending=false, denied=false}={}) {
  const elements = new Map();
  function element() { return {value:'',checked:true,hidden:false,disabled:false,textContent:'',dataset:{},style:{},options:[],children:[],listeners:{},
    addEventListener(k,fn){this.listeners[k]=fn;},replaceChildren(...v){this.children=v;this.options=v;},append(v){this.children.push(v);},add(v){this.options.push(v);},focus(){this.focused=true;},scrollIntoView(options){this.scrollOptions=options;}}; }
  const document={hidden:false,listeners:{},querySelector:()=>({getBoundingClientRect:()=>({height:100})}),getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,addEventListener(k,fn){this.listeners[k]=fn;}};
  const track={readyState:'live',label:'Test mic',stops:0,stop(){this.stops++;this.readyState='ended';},getSettings(){return {sampleRate:48000,deviceId:'test',echoCancellation:false,noiseSuppression:false,autoGainControl:false};}};
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  let calls=0,resolvePermission;
  const permission = pending ? new Promise(resolve=>{resolvePermission=resolve;}) : Promise.resolve(stream);
  const timers = new Map(); let timerId=0, now=0; const contexts=[],nodes=[];
  class Context {
    state='running';destination={};audioWorklet={addModule:async()=>{}};
    constructor(){contexts.push(this);}resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
  }
  class Worklet {constructor(){this.sent=[];this.port={onmessage:null,postMessage:m=>this.sent.push(m),close(){}};nodes.push(this);}connect(){}disconnect(){}}
  const sandbox={document,window:{isSecureContext:true,AudioContext:Context,addEventListener(){}},
    navigator:{mediaDevices:{getUserMedia(){calls++;if(denied)return Promise.reject(Object.assign(new Error('denied'),{name:'NotAllowedError'}));return permission;},enumerateDevices:async()=>[],addEventListener(){}}},
    AudioWorkletNode:Worklet,Option:function(label,value){return {label,value};},URL,
    performance:{now:()=>now},setTimeout(fn,ms){timers.set(++timerId,{fn,ms,at:now+ms});return timerId;},clearTimeout(id){timers.delete(id);}};
  vm.createContext(sandbox); vm.runInContext(app,sandbox);
  const run=code=>vm.runInContext(code,sandbox);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  async function advance(ms) {
    await flush();
    const end=now+ms;
    for (;;) {
      const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next) break;
      now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();
    }
    now=end;await flush();
  }
  async function start(kind='before') {const task=run(`start(${JSON.stringify(kind)})`);await advance(3000);await task;}
  return {run,start,advance,flush,track,stream,contexts,nodes,elements,timers,document,get calls(){return calls;},resolve(){resolvePermission(stream);}};
}
test('permission is requested only on start, rapid clicks do not create two captures',async()=>{
  const h=harness({pending:true});assert.equal(h.calls,0);
  const first=h.run('start("before")');await h.run('start("before")');assert.equal(h.calls,1);
  h.run('cancel("cancelled")');h.resolve();await first;assert.equal(h.track.stops,1);assert.equal(h.contexts.length,0);
});
test('permission denial recovers controls with useful feedback',async()=>{
  const h=harness({denied:true});await h.run('start("before")');assert.match(h.elements.get('status').textContent,/denied/);assert.equal(h.elements.get('start').disabled,false);
});
test('hiding an active page releases capture and discards the run',async()=>{
  const h=harness();await h.start();h.document.hidden=true;h.document.listeners.visibilitychange();
  assert.equal(h.track.stops,1);assert.equal(h.contexts[0].state,'closed');assert.equal(h.run('run'),null);assert.equal(h.run('before'),null);
});
test('track ending cancels an active measurement',async()=>{
  const h=harness();await h.start();h.track.onended();assert.match(h.elements.get('status').textContent,/disconnected/);assert.equal(h.run('run'),null);
});
test('processor failure releases resources',async()=>{
  const h=harness();await h.start();h.nodes[0].onprocessorerror();assert.equal(h.track.stops,1);assert.equal(h.elements.get('start').disabled,false);
});
test('retained connection supports A/B; idle timeout releases it',async()=>{
  const h=harness();await h.start();
  const result={version:'test',duration:25,sampleRate:48000,activeFraction:1,adequate:true,gaps:[],quiet:[],impulses:[],clippedFraction:0,longestGap:0};
  h.nodes[0].port.onmessage({data:{type:'result',result}});
  assert.equal(h.track.stops,0);assert.equal(h.elements.get('results').hidden,false);
  await h.start('after');assert.equal(h.calls,1);
  h.nodes[0].port.onmessage({data:{type:'result',result}});
  assert.match(h.elements.get('comparison-note').textContent,/Same microphone connection retained/);
  const idle=[...h.timers.values()].find(t=>t.ms===60000);assert.ok(idle);idle.fn();assert.equal(h.track.stops,1);
});
test('unchecked retain option releases capture after completion',async()=>{
  const h=harness();h.elements.get('keep').checked=false;await h.start();
  h.nodes[0].port.onmessage({data:{type:'result',result:{version:'test',duration:25,sampleRate:48000,activeFraction:0,adequate:false,gaps:[],quiet:[],impulses:[],clippedFraction:0,longestGap:0}}});
  assert.equal(h.track.stops,1);assert.match(h.elements.get('verdict').textContent,/inconclusive/);
});
test('scroll and full 3-2-1 countdown precede every measurement',async()=>{
  const h=harness();const task=h.run('start("before")');await h.flush();
  assert.equal(h.elements.get('live-panel').focused,true);
  assert.equal(h.elements.get('live-panel').scrollOptions.block,'start');
  assert.equal(h.elements.get('live-panel').style.scrollMarginTop,'116px');
  assert.equal(h.elements.get('countdown').textContent,3);
  assert.equal(h.nodes[0].sent.length,0);assert.equal(h.run('run'),null);
  await h.advance(1000);assert.equal(h.elements.get('countdown').textContent,2);
  await h.advance(1000);assert.equal(h.elements.get('countdown').textContent,1);
  await h.advance(999);assert.equal(h.nodes[0].sent.length,0);
  await h.advance(1);await task;
  assert.equal(h.nodes[0].sent.length,1);assert.equal(h.nodes[0].sent[0].seconds,25);
  assert.equal(h.run('run.start'),3000);assert.equal(h.elements.get('countdown').hidden,true);
});
test('cancel during countdown resolves preparation and never starts later',async()=>{
  const h=harness();const task=h.run('start("before")');await h.advance(1000);
  h.elements.get('stop-live').listeners.click();await task;await h.advance(5000);
  assert.equal(h.nodes[0].sent.length,0);assert.equal(h.track.stops,1);
  assert.equal(h.run('busy'),false);assert.equal(h.elements.get('countdown').hidden,true);
});
test('hiding page or losing audio context during preparation cancels safely',async()=>{
  for(const action of ['hidden','context']) {
    const h=harness();const task=h.run('start("before")');await h.advance(1000);
    if(action==='hidden'){h.document.hidden=true;h.document.listeners.visibilitychange();}
    else {h.contexts[0].state='suspended';h.contexts[0].onstatechange();}
    await task;await h.advance(5000);assert.equal(h.nodes[0].sent.length,0);assert.equal(h.track.stops,1);
  }
});
test('countdown is excluded from wall duration and After countdown preserves Before',async()=>{
  const h=harness();await h.start();await h.advance(25000);
  const result={version:'test',duration:25,sampleRate:48000,activeFraction:1,adequate:true,gaps:[],quiet:[],impulses:[],clippedFraction:0,longestGap:0};
  h.nodes[0].port.onmessage({data:{type:'result',result}});
  assert.equal(h.run('before.wallDuration'),25);assert.equal(h.run('before.timingIrregular'),false);
  const saved=h.run('before');const task=h.run('start("after")');await h.advance(2000);
  assert.equal(h.nodes[0].sent.length,1);assert.equal(h.elements.get('countdown').textContent,1);
  h.run('cancel("cancelled")');await task;
  assert.equal(h.run('before'),saved);assert.equal(h.run('after'),null);
});
test('worklet counts only received samples, supports variable blocks, emits exact duration and can restart',()=>{
  let Processor;const messages=[];
  class Base {port={postMessage:m=>messages.push(m)};}
  const scope={StabilityAnalyzer,sampleRate:48000,AudioWorkletProcessor:Base,registerProcessor:(name,cls)=>{Processor=cls;}};
  vm.createContext(scope);vm.runInContext(readFileSync(new URL('../audio/microphone-dropout-test/processor.js',import.meta.url),'utf8').replace(/^import .*;\n/,''),scope);
  const p=new Processor();p.port.onmessage({data:{type:'start',seconds:.1}});
  for(let i=0;i<10;i++)p.process([[]]);assert.equal(messages.length,0);
  for(let i=0;i<20;i++)p.process([[new Float32Array(257).fill(.1)]]);
  assert.equal(messages.filter(m=>m.type==='result').length,1);assert.equal(messages.at(-1).result.duration,.1);
  p.port.onmessage({data:{type:'start',seconds:.01}});p.process([[new Float32Array(1024).fill(.1)]]);
  assert.equal(messages.filter(m=>m.type==='result').length,2);
});
