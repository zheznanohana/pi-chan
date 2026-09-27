# -*- coding: utf-8 -*-
"""
Qwen3-TTS Zero-Shot Voice Clone Bridge for Pi-chan Dashboard
"""
import sys
import os
import time
import argparse
import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel

MODEL_DIR = r"C:\Users\YOUR_USER\.cache\modelscope\models\Qwen--Qwen3-TTS-12Hz-0.6B-Base\snapshots\master"

def main():
    parser = argparse.ArgumentParser(description="Qwen3-TTS Voice Clone Bridge")
    parser.add_argument("--text", type=str, required=True, help="Text to synthesize")
    parser.add_argument("--ref_audio", type=str, required=True, help="Path to reference audio")
    parser.add_argument("--ref_text", type=str, default="", help="Optional transcript of reference audio")
    parser.add_argument("--output", type=str, required=True, help="Output wav path")
    parser.add_argument("--device", type=str, default="cuda:0" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--max_tokens", type=int, default=128)
    args = parser.parse_args()

    if not os.path.exists(MODEL_DIR):
        print(f"ERROR: Model directory not found: {MODEL_DIR}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.ref_audio):
        print(f"ERROR: Reference audio not found: {args.ref_audio}", file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    dtype = torch.bfloat16 if args.device.startswith("cuda") else torch.float32
    attn = "sdpa" if args.device.startswith("cuda") else "eager"

    tts = Qwen3TTSModel.from_pretrained(
        MODEL_DIR,
        device_map=args.device,
        dtype=dtype,
        attn_implementation=attn,
    )
    load_time = time.time() - t0

    t1 = time.time()
    if args.device.startswith("cuda"):
        torch.cuda.synchronize()

    use_xvec = True if not args.ref_text else False
    wavs, sr = tts.generate_voice_clone(
        text=args.text,
        language="Chinese",
        ref_audio=args.ref_audio,
        ref_text=args.ref_text if args.ref_text else None,
        x_vector_only_mode=use_xvec,
        max_new_tokens=args.max_tokens,
    )
    if args.device.startswith("cuda"):
        torch.cuda.synchronize()

    gen_time = time.time() - t1
    audio = wavs[0]
    duration = len(audio) / sr
    rtf = gen_time / duration if duration > 0 else 0

    sf.write(args.output, audio, sr)

    print(f"SUCCESS: output={args.output}, sr={sr}, duration={duration:.2f}s, load_time={load_time:.2f}s, gen_time={gen_time:.2f}s, rtf={rtf:.3f}")

if __name__ == "__main__":
    main()
