import base64
import contextlib
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "models" / "gpt-sovits" / "runtime"
ROLE_ROOT = ROOT / "models" / "gpt-sovits" / "klee-zh" / "v4" / "可莉_ZH"
ROLE_GPT = ROLE_ROOT / "可莉_ZH-e10.ckpt"
ROLE_SOVITS = ROLE_ROOT / "可莉_ZH_e10_s530_l32.pth"
REFERENCE = ROLE_ROOT / "reference_audios" / "中文" / "emotions" / "【默认】玩得太开心，忘、忘在脑后了….wav"
PRETRAINED = RUNTIME / "GPT_SoVITS" / "pretrained_models"


def build_tts():
    os.chdir(RUNTIME)
    sys.path.insert(0, str(RUNTIME))
    sys.path.insert(0, str(RUNTIME / "GPT_SoVITS"))
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    config = TTS_Config({
        "custom": {
            "device": "cuda",
            "is_half": True,
            "version": "v4",
            "t2s_weights_path": str(ROLE_GPT),
            "vits_weights_path": str(ROLE_SOVITS),
            "bert_base_path": str(PRETRAINED / "chinese-roberta-wwm-ext-large"),
            "cnhuhbert_base_path": str(PRETRAINED / "chinese-hubert-base"),
        }
    })
    return TTS(config)


def synthesize(tts, text, speed):
    inputs = {
        "text": text,
        "text_lang": "all_zh",
        "ref_audio_path": str(REFERENCE),
        "prompt_text": "玩得太开心，忘、忘在脑后了……",
        "prompt_lang": "all_zh",
        "top_k": 15,
        "top_p": 0.6,
        "temperature": 0.6,
        "text_split_method": "cut5",
        "speed_factor": speed,
        "seed": -1,
        "parallel_infer": True,
        "return_fragment": True,
        "fragment_interval": 0.0,
        "sample_steps": 8,
    }
    fragments = []
    sample_rate = None
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        for sample_rate, audio in tts.run(inputs):
            audio = np.asarray(audio)
            if audio.size:
                fragments.append(audio.astype(np.float32) / 32768.0)
    if not fragments:
        raise RuntimeError("GPT-SoVITS returned no audio")
    audio = np.concatenate(fragments)
    duration = len(audio) / sample_rate
    out = io.BytesIO()
    sf.write(out, audio, sample_rate, subtype="PCM_16", format="WAV")
    pcm = audio.clip(-1, 1).astype("<f4").tobytes()
    return {
        "sampleRate": int(sample_rate),
        "durationSec": duration,
        "totalMs": (time.perf_counter() - started) * 1000,
        "wavBase64": base64.b64encode(out.getvalue()).decode("ascii"),
        "pcmFloat32Base64": base64.b64encode(pcm).decode("ascii"),
        "sampleCount": len(audio),
    }


def main():
    print(json.dumps({"event": "loading"}), flush=True)
    with contextlib.redirect_stdout(sys.stderr):
        tts = build_tts()
    print(json.dumps({"event": "ready", "sampleRate": 48000}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if request.get("command") == "quit":
                break
            result = synthesize(tts, request.get("text", ""), float(request.get("speed", 1.0)))
            result["id"] = request.get("id")
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"id": request.get("id") if "request" in locals() else None, "error": str(exc)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
