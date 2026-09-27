"""Persistent GPT-SoVITS v4 sentence-fragment JSONL worker.

stdin: {id,text,speed?,textLang?,sampleSteps?}; {command:"quit"} exits.
stdout: loading / ready, then chunk* / end or error; model logs use stderr.
V4 exposes sentence fragments, not semantic-token streaming. The caller must
terminate this worker for immediate cancellation during blocking GPU inference.
"""
import base64
import contextlib
import importlib.util
import json
import math
import re
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
OUTPUT = sys.stdout


def emit(message):
    OUTPUT.write(json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n")
    OUTPUT.flush()


def pcm16(audio):
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    audio = np.asarray(audio)
    if audio.ndim != 1:
        raise ValueError("Expected one-dimensional mono audio")
    if np.issubdtype(audio.dtype, np.floating):
        # Normalized float samples: preserve volume, clip +1 without wrapping.
        scaled = np.nan_to_num(audio.astype(np.float64), nan=0.0, posinf=1.0, neginf=-1.0)
        return np.rint(np.clip(scaled, -1, 1) * 32768).clip(-32768, 32767).astype("<i2")
    if audio.dtype.kind == "i" and audio.dtype.itemsize == 2:
        # Runtime audio_postprocess already returns PCM16; never scale it twice.
        return audio.astype("<i2", copy=False)
    raise ValueError(f"Unsupported audio dtype: {audio.dtype}; expected float or int16")


def text_language(text):
    # Runtime zh means Chinese + English, all_zh forces Chinese interpretation.
    return "zh" if re.search(r"[\u3400-\u9fff]", text) else "en"


def load_existing_bridge():
    spec = importlib.util.spec_from_file_location("pichan_gpt_sovits_offline", ROOT / "gpt-sovits-server.py")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


def synthesize(tts, bridge, request):
    request_id = request.get("id")
    text = request.get("text", "")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text must be a nonempty string")
    speed = float(request.get("speed", 1.0))
    if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
        raise ValueError("speed must be between 0.5 and 2.0")
    language = request.get("textLang") or text_language(text)
    if language not in tts.configs.languages:
        raise ValueError(f"Unsupported textLang: {language}")
    steps = int(request.get("sampleSteps", 8))
    if steps not in (4, 8, 16, 32):
        raise ValueError("sampleSteps must be 4, 8, 16, or 32")
    inputs = {
        "text": text, "text_lang": language,
        "ref_audio_path": str(bridge.REFERENCE),
        "prompt_text": "玩得太开心，忘、忘在脑后了……", "prompt_lang": "all_zh",
        "top_k": 15, "top_p": 0.6, "temperature": 0.6,
        "text_split_method": "cut5", "speed_factor": speed,
        "seed": -1, "parallel_infer": True, "batch_size": 1,
        "split_bucket": False, "return_fragment": True, "streaming_mode": False,
        "fragment_interval": 0.0, "sample_steps": steps,
    }
    started = time.perf_counter()
    count = samples = 0
    first_ms = None
    duration = 0.0
    with contextlib.redirect_stdout(sys.stderr):
        for sample_rate, audio in tts.run(inputs):
            chunk = pcm16(audio)
            if not chunk.size:
                continue
            sample_rate = int(sample_rate)
            # Runtime's exception path emits a fake silent 16k chunk before raising.
            # Do not publish it as valid V4 (48kHz) synthesized speech.
            if sample_rate == 16000 and not np.any(chunk):
                continue
            if sample_rate <= 0:
                raise ValueError("Invalid sample rate")
            elapsed = (time.perf_counter() - started) * 1000
            if first_ms is None:
                first_ms = elapsed
            emit({"id": request_id, "event": "chunk", "sampleRate": sample_rate,
                  "pcm16Base64": base64.b64encode(chunk.tobytes()).decode("ascii"),
                  "index": count, "elapsedMs": elapsed})
            count += 1
            samples += int(chunk.size)
            duration += chunk.size / sample_rate
    if not count:
        raise RuntimeError("GPT-SoVITS returned no audio")
    emit({"id": request_id, "event": "end", "totalMs": (time.perf_counter() - started) * 1000,
          "firstChunkMs": first_ms, "chunkCount": count, "sampleCount": samples,
          "durationSec": duration, "textLang": language, "mode": "sentence-fragments"})


def self_test():
    assert pcm16(np.array([-32768, 0, 32767], dtype=np.int16)).tolist() == [-32768, 0, 32767]
    assert pcm16(np.array([-1, -0.5, 0, 0.5, 1], dtype=np.float32)).tolist() == [-32768, -16384, 0, 16384, 32767]
    assert pcm16(np.array([float("nan"), float("inf")])).tolist() == [0, 32767]
    assert text_language("你好，hello") == "zh"
    assert text_language("Hello world") == "en"
    emit({"event": "self-test", "passed": True})


def main():
    if "--self-test" in sys.argv:
        self_test()
        return
    loaded = time.perf_counter()
    emit({"event": "loading", "mode": "sentence-fragments"})
    try:
        with contextlib.redirect_stdout(sys.stderr):
            bridge = load_existing_bridge()
            tts = bridge.build_tts()
    except Exception as error:
        emit({"event": "error", "id": None, "error": str(error), "stage": "loading"})
        return
    emit({"event": "ready", "sampleRate": 48000, "mode": "sentence-fragments",
          "loadMs": (time.perf_counter() - loaded) * 1000,
          "languages": list(tts.configs.languages)})
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("request must be an object")
                if request.get("command") == "quit":
                    break
                synthesize(tts, bridge, request)
            except Exception as error:
                emit({"id": request.get("id") if isinstance(request, dict) else None,
                      "event": "error", "error": str(error)})
    finally:
        del tts
        with contextlib.redirect_stdout(sys.stderr):
            import gc
            import torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
