import argparse
import json
import os
import sys
import time
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "models" / "gpt-sovits" / "runtime"
ROLE_ROOT = ROOT / "models" / "gpt-sovits" / "klee-zh" / "v4" / "可莉_ZH"
ROLE_GPT = ROLE_ROOT / "可莉_ZH-e10.ckpt"
ROLE_SOVITS = ROLE_ROOT / "可莉_ZH_e10_s530_l32.pth"
REFERENCE = ROLE_ROOT / "reference_audios" / "中文" / "emotions" / "【默认】玩得太开心，忘、忘在脑后了….wav"
PRETRAINED = RUNTIME / "GPT_SoVITS" / "pretrained_models"


def build_tts(cpu=False):
    os.chdir(RUNTIME)
    sys.path.insert(0, str(RUNTIME))
    sys.path.insert(0, str(RUNTIME / "GPT_SoVITS"))
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

    config = TTS_Config({
        "custom": {
            "device": "cpu" if cpu else "cuda",
            "is_half": not cpu,
            "version": "v4",
            "t2s_weights_path": str(ROLE_GPT),
            "vits_weights_path": str(ROLE_SOVITS),
            "bert_base_path": str(PRETRAINED / "chinese-roberta-wwm-ext-large"),
            "cnhuhbert_base_path": str(PRETRAINED / "chinese-hubert-base"),
        }
    })
    return TTS(config)


def synthesize(tts, text, output_path, speed=1.0):
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
        "seed": 42,
        "parallel_infer": True,
        "return_fragment": True,
        "fragment_interval": 0.0,
        "sample_steps": 8,
    }
    start = time.perf_counter()
    first_fragment_ms = None
    fragments = []
    sample_rate = None
    for sample_rate, audio in tts.run(inputs):
        if first_fragment_ms is None and np.asarray(audio).size:
            first_fragment_ms = (time.perf_counter() - start) * 1000
        audio = np.asarray(audio)
        if audio.size:
            fragments.append(audio.astype(np.float32) / 32768.0)
    elapsed_ms = (time.perf_counter() - start) * 1000
    if not fragments:
        raise RuntimeError("GPT-SoVITS returned no audio fragments")
    audio = np.concatenate(fragments)
    sf.write(output_path, audio, sample_rate, subtype="PCM_16")
    duration_s = len(audio) / sample_rate
    return {
        "output": str(output_path),
        "sampleRate": int(sample_rate),
        "durationSec": duration_s,
        "totalMs": elapsed_ms,
        "firstFragmentMs": first_fragment_ms,
        "rtf": (elapsed_ms / 1000.0) / duration_s,
        "samples": len(audio),
    }


def acoustic_metrics(path):
    audio, sample_rate = librosa.load(path, sr=None, mono=True)
    audio = audio.astype(np.float32)
    if not len(audio):
        raise RuntimeError(f"Empty audio: {path}")
    frame_length = min(2048, len(audio))
    hop_length = max(256, frame_length // 4)
    voiced, voiced_flag, _ = librosa.pyin(
        audio,
        fmin=70,
        fmax=600,
        sr=sample_rate,
        frame_length=frame_length,
        hop_length=hop_length,
    )
    voiced_values = voiced[np.isfinite(voiced) & voiced_flag]
    stft = np.abs(librosa.stft(audio, n_fft=frame_length, hop_length=hop_length))
    freqs = librosa.fft_frequencies(sr=sample_rate, n_fft=frame_length)
    total_energy = float(np.sum(stft ** 2))
    high_energy = float(np.sum(stft[freqs >= 4000] ** 2))
    centroid = float(np.mean(librosa.feature.spectral_centroid(S=stft, sr=sample_rate)))
    return {
        "path": str(path),
        "sampleRate": int(sample_rate),
        "durationSec": len(audio) / sample_rate,
        "meanF0Hz": float(np.mean(voiced_values)) if len(voiced_values) else None,
        "high4kEnergyPct": (high_energy / total_energy * 100.0) if total_energy else 0.0,
        "spectralCentroidHz": centroid,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", default="你好！我是派酱，你的桌面 AI 伴侣，今天想和我聊点什么呢？")
    parser.add_argument("--output", default=str(ROOT / "tts-moe-klee.wav"))
    parser.add_argument("--metrics", default=str(ROOT / "tts-moe-metrics.json"))
    parser.add_argument("--compare", default=str(ROOT / "tts-clone.wav"))
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument("--skip-analysis", action="store_true")
    args = parser.parse_args()

    for path in [ROLE_GPT, ROLE_SOVITS, REFERENCE]:
        if not path.exists():
            raise FileNotFoundError(path)

    print(json.dumps({"event": "loading", "runtime": str(RUNTIME)}, ensure_ascii=False), flush=True)
    load_start = time.perf_counter()
    tts = build_tts(args.cpu)
    load_sec = time.perf_counter() - load_start
    print(json.dumps({"event": "ready", "device": str(tts.configs.device)}, ensure_ascii=False), flush=True)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    result = synthesize(tts, args.text, output, args.speed)
    metrics = {
        "duration_sec": result["durationSec"], "sample_rate": result["sampleRate"],
        "gen_sec": result["totalMs"] / 1000, "load_sec": load_sec,
        "first_packet_sec": result.get("firstPacketMs", result["totalMs"]) / 1000,
        "rtf": result.get("rtf", 0),
    }
    print("METRICS_JSON=" + json.dumps(metrics), flush=True)
    if not args.skip_analysis:
        result["acoustic"] = acoustic_metrics(output)
        if Path(args.compare).exists():
            result["compare"] = acoustic_metrics(Path(args.compare))
        Path(args.metrics).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
