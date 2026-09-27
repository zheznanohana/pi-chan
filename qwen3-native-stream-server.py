# -*- coding: utf-8 -*-
"""Windows-native progressive codec-frame Qwen3 TTS worker.
Uses MIT faster-qwen3-tts v0.3.2 CUDA graphs from external/, without pip changes.
Each chunk is decoded while generation is still running (not sentence slicing).
"""
import argparse, base64, contextlib, importlib.util, json, os, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent
FORK = ROOT / 'external' / 'faster-qwen3-tts'
PROTOCOL = sys.stdout

def emit(data):
    print(json.dumps(data, ensure_ascii=False), file=PROTOCOL, flush=True)

def main():
    if hasattr(PROTOCOL, 'reconfigure'):
        PROTOCOL.reconfigure(encoding='utf-8');sys.stdin.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser()
    parser.add_argument('--device', default=os.environ.get('QWEN_TTS_DEVICE','cuda:0'))
    args=parser.parse_args()
    if not (FORK/'faster_qwen3_tts').is_dir():
        emit({'event':'error','fatal':True,'error':'Pinned streaming source missing in external/faster-qwen3-tts'});return 1
    sys.path.insert(0,str(FORK))
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    spec=importlib.util.spec_from_file_location('pichan_resident_qwen',ROOT/'qwen3-server.py')
    resident=importlib.util.module_from_spec(spec);spec.loader.exec_module(resident)
    started=time.perf_counter();emit({'event':'loading','engine':'qwen3-native-stream'})
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import torch
            import numpy as np
            import faster_qwen3_tts
            from collections import OrderedDict
            from faster_qwen3_tts import FasterQwen3TTS
            torch.set_num_threads(4)
            torch.set_float32_matmul_precision('high')
            model_path=os.environ.get('QWEN_TTS_MODEL',str(resident.DEFAULT_MODEL))
            if not Path(model_path).is_dir():raise FileNotFoundError(model_path)
            fast=FasterQwen3TTS.from_pretrained(model_path,device=args.device,dtype=torch.bfloat16,attn_implementation='sdpa',max_seq_len=1024)
            worker=resident.ResidentQwen.__new__(resident.ResidentQwen)
            worker.torch=torch;worker.device=args.device;worker.model=fast.model
            worker.reference=resident.DEFAULT_REFERENCE;worker.ref_text='';worker.prompts=OrderedDict()
            emit({'event':'warming','engine':'qwen3-native-stream'})
            worker.get_prompt(worker.reference,'')
            fast.warmup()
        emit({'event':'ready','sampleRate':24000,'device':worker.device,'loadMs':(time.perf_counter()-started)*1000,'streamingMode':'codec-frames','implementation':str(Path(faster_qwen3_tts.__file__).resolve()),'torchVersion':worker.torch.__version__})
    except Exception as exc:
        emit({'event':'error','fatal':True,'error':str(exc)});return 1
    for line in sys.stdin:
        if not line.strip():continue
        request=None
        try:
            request=json.loads(line)
            if not isinstance(request,dict):raise ValueError('Request must be a JSON object')
            rid=request.get('id')
            if request.get('command')=='quit':emit({'id':rid,'event':'bye'});break
            if request.get('command')=='ping':emit({'id':rid,'event':'pong'});continue
            text=request.get('text','')
            if not isinstance(text,str) or not text.strip() or len(text)>2000:raise ValueError('text must contain 1..2000 characters')
            frames=int(request.get('maxTokens') or 256)
            if not 16<=frames<=1024:raise ValueError('maxTokens must be 16..1024')
            every=int(request.get('emitEveryFrames') or 4)
            if not 2<=every<=16:raise ValueError('emitEveryFrames must be 2..16')
            started=time.perf_counter();count=0;total_samples=0;first_ms=None;sr=24000;last_timing={}
            if worker.device.startswith('cuda'):worker.torch.cuda.reset_peak_memory_stats()
            with contextlib.redirect_stdout(sys.stderr),worker.torch.inference_mode():
                prompt,cached=worker.get_prompt(request.get('refAudio') or worker.reference,request.get('refText',worker.ref_text) or '')
                for audio,sr,timing in fast.generate_voice_clone_streaming(text=text.strip(),language=request.get('language') or 'Auto',voice_clone_prompt=prompt,chunk_size=every,max_new_tokens=frames,xvec_only=not bool(request.get('refText')),append_silence=False,non_streaming_mode=True,do_sample=False):
                    last_timing=timing
                    array=np.asarray(audio,dtype=np.float32).reshape(-1)
                    if not array.size:continue
                    if not np.isfinite(array).all():raise RuntimeError('Non-finite audio')
                    pcm=np.rint(np.clip(array,-1,1)*32767).astype('<i2').tobytes()
                    count+=1;total_samples+=array.size;elapsed=(time.perf_counter()-started)*1000
                    if first_ms is None:first_ms=elapsed
                    emit({'id':rid,'event':'chunk','sampleRate':int(sr),'pcm16Base64':base64.b64encode(pcm).decode('ascii'),'chunkIndex':count,'generationElapsedMs':elapsed,'codecSteps':timing.get('total_steps_so_far')})
                    if elapsed>180000:raise TimeoutError('Generation exceeded 180 seconds')
            if not count:raise RuntimeError('Streaming model returned no audio')
            metrics={'id':rid,'event':'end','sampleRate':int(sr),'totalMs':(time.perf_counter()-started)*1000,'firstChunkMs':first_ms,'sampleCount':int(total_samples),'durationSec':total_samples/sr,'chunks':count,'codecSteps':last_timing.get('total_steps_so_far'),'eosReached':last_timing.get('eos_reached'),'tokenLimitReached':last_timing.get('token_limit_reached'),'contextLimitReached':last_timing.get('context_limit_reached'),'promptCached':cached,'streamingMode':'codec-frames','peakCudaAllocatedMB':worker.torch.cuda.max_memory_allocated()/1048576 if worker.device.startswith('cuda') else None,'peakCudaReservedMB':worker.torch.cuda.max_memory_reserved()/1048576 if worker.device.startswith('cuda') else None}
            if metrics['eosReached'] is not True or metrics['tokenLimitReached'] or metrics['contextLimitReached']:
                emit({'id':rid,'event':'error','error':'Generation stopped without natural EOS; emitted audio is incomplete','metrics':metrics})
            else:
                emit(metrics)
        except Exception as exc:
            emit({'id':request.get('id') if isinstance(request,dict) else None,'event':'error','error':str(exc)})
    return 0
if __name__=='__main__':raise SystemExit(main())
