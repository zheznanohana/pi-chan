# -*- coding: utf-8 -*-
"""Resident Qwen3-TTS sentence worker. JSONL stdout; diagnostics stderr.

One generated sentence is returned as PCM16; this is NOT token-level audio
streaming. Abort an in-flight generation by terminating this worker, or discard
its request id in the caller. Loading and clone-prompt construction are cached.
"""
import argparse
import base64
import contextlib
import json
import os
from pathlib import Path
import sys
import time
from collections import OrderedDict

ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = Path(r'C:\Users\YOUR_USER\.cache\modelscope\models\Qwen--Qwen3-TTS-12Hz-0.6B-Base\snapshots\master')
DEFAULT_REFERENCE = ROOT / 'speaker-eval' / 'pick-sid-51.wav'


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


class ResidentQwen:
    def __init__(self, model_path, reference, device=None, ref_text=''):
        # Restrict loading to already downloaded artifacts.
        os.environ.setdefault('HF_HUB_OFFLINE', '1')
        os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
        import torch
        from qwen_tts import Qwen3TTSModel
        self.torch = torch
        self.device = device or ('cuda:0' if torch.cuda.is_available() else 'cpu')
        self.reference = Path(reference).resolve()
        self.ref_text = ref_text
        if not Path(model_path).is_dir():
            raise FileNotFoundError(f'Local Qwen model directory missing: {model_path}')
        if not self.reference.is_file():
            raise FileNotFoundError(f'Reference audio missing: {self.reference}')
        torch.set_num_threads(max(1, int(os.environ.get('QWEN_TTS_CPU_THREADS', '4'))))
        gpu = self.device.startswith('cuda')
        self.model = Qwen3TTSModel.from_pretrained(
            str(model_path), device_map=self.device,
            dtype=torch.bfloat16 if gpu else torch.float32,
            attn_implementation='sdpa' if gpu else 'eager',
            local_files_only=True,
        )
        self.prompts = OrderedDict()
        self.get_prompt(self.reference, self.ref_text)

    def get_prompt(self, reference, ref_text):
        reference = Path(reference).resolve()
        stat = reference.stat()
        key = (str(reference), stat.st_mtime_ns, stat.st_size, ref_text)
        if key in self.prompts:
            self.prompts.move_to_end(key)
            return self.prompts[key], True
        with self.torch.inference_mode():
            prompt = self.model.create_voice_clone_prompt(
                ref_audio=str(reference), ref_text=ref_text or None,
                x_vector_only_mode=not bool(ref_text),
            )
        self.prompts[key] = prompt
        while len(self.prompts) > 8:
            self.prompts.popitem(last=False)
        return prompt, False

    def generate(self, request):
        import numpy as np
        text = request.get('text', '')
        if not isinstance(text, str) or not text.strip():
            raise ValueError('text must be a non-empty string')
        if len(text) > 2000:
            raise ValueError('Sentence exceeds 2000 characters; split it in the caller')
        language = request.get('language') or 'Auto'
        if not isinstance(language, str):
            raise ValueError('language must be a string')
        max_tokens = int(request.get('maxTokens') or 256)
        if not 16 <= max_tokens <= 1024:
            raise ValueError('maxTokens must be between 16 and 1024')
        reference = request.get('refAudio') or self.reference
        ref_text = request.get('refText', self.ref_text) or ''
        started = time.perf_counter()
        prompt, cached = self.get_prompt(reference, ref_text)
        with self.torch.inference_mode():
            wavs, sample_rate = self.model.generate_voice_clone(
                text=text.strip(), language=language, voice_clone_prompt=prompt,
                max_new_tokens=max_tokens,
            )
        if self.device.startswith('cuda'):
            self.torch.cuda.synchronize()
        audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
        if not audio.size or not np.isfinite(audio).all():
            raise RuntimeError('Qwen returned empty or non-finite audio')
        pcm = np.rint(np.clip(audio, -1.0, 1.0) * 32767.0).astype('<i2').tobytes()
        total_ms = (time.perf_counter() - started) * 1000
        return pcm, int(sample_rate), total_ms, cached


def serve(worker, lines):
    for line in lines:
        if not line.strip():
            continue
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError('Request must be a JSON object')
            request_id = request.get('id')
            if request.get('command') == 'quit':
                emit({'id': request_id, 'event': 'bye'})
                break
            if request.get('command') == 'ping':
                emit({'id': request_id, 'event': 'pong', 'device': worker.device})
                continue
            with contextlib.redirect_stdout(sys.stderr):
                pcm, sr, total_ms, cached = worker.generate(request)
            emit({'id': request_id, 'event': 'chunk', 'sampleRate': sr,
                  'pcm16Base64': base64.b64encode(pcm).decode('ascii'), 'chunkIndex': 1})
            emit({'id': request_id, 'event': 'end', 'sampleRate': sr,
                  'totalMs': total_ms, 'firstChunkMs': total_ms,
                  'sampleCount': len(pcm) // 2, 'durationSec': len(pcm) / 2 / sr,
                  'promptCached': cached, 'streamingMode': 'sentence'})
        except Exception as exc:
            emit({'id': request.get('id') if isinstance(request, dict) else None,
                  'event': 'error', 'error': str(exc)})


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
        sys.stdin.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default=os.environ.get('QWEN_TTS_MODEL', str(DEFAULT_MODEL)))
    parser.add_argument('--ref_audio', default=str(DEFAULT_REFERENCE))
    parser.add_argument('--ref_text', default='')
    parser.add_argument('--device', default=os.environ.get('QWEN_TTS_DEVICE'))
    args = parser.parse_args()
    started = time.perf_counter()
    emit({'event': 'loading', 'engine': 'qwen3-clone'})
    try:
        with contextlib.redirect_stdout(sys.stderr):
            worker = ResidentQwen(args.model, args.ref_audio, args.device, args.ref_text)
        emit({'event': 'ready', 'sampleRate': 24000, 'device': worker.device,
              'loadMs': (time.perf_counter() - started) * 1000,
              'streamingMode': 'sentence', 'promptCached': True})
        serve(worker, sys.stdin)
        return 0
    except Exception as exc:
        emit({'event': 'error', 'fatal': True, 'error': str(exc)})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
