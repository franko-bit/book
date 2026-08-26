from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

VOICE_OPTIONS = {
    "en": {
        "lessac": {"medium", "high"},
        "ryan": {"medium", "high"},
        "amy": {"medium"},
    },
    "es": {"davefx": {"medium"}},
    "fr": {"siwis": {"medium"}},
    "de": {"thorsten": {"medium"}},
    "it": {"paola": {"medium"}},
    "pt": {"faber": {"medium"}},
    "ru": {"denis": {"medium"}},
    "zh": {"huayan": {"medium"}},
}
BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DOWNLOAD_DIR = BASE_DIR / "local_inference" / "voices" / "reader01"


def main() -> int:
    parser = argparse.ArgumentParser(description="Download a supported Piper language voice.")
    parser.add_argument("--language", choices=sorted(VOICE_OPTIONS), default="en")
    parser.add_argument("--voice")
    parser.add_argument("--quality", choices=("medium", "high"), default="medium")
    parser.add_argument("--download-dir", type=Path, default=DEFAULT_DOWNLOAD_DIR)
    args = parser.parse_args()

    voices = VOICE_OPTIONS[args.language]
    voice = args.voice or next(iter(voices))
    if voice not in voices:
        parser.error(f"{voice} is not available for {args.language}; choose from: {', '.join(sorted(voices))}")
    if args.quality not in voices[voice]:
        parser.error(f"{voice} is available only in: {', '.join(sorted(voices[voice]))}")

    language_prefixes = {
        "en": "en_US",
        "es": "es_ES",
        "fr": "fr_FR",
        "de": "de_DE",
        "it": "it_IT",
        "pt": "pt_BR",
        "ru": "ru_RU",
        "zh": "zh_CN",
    }
    voice_name = f"{language_prefixes[args.language]}-{voice}-{args.quality}"
    args.download_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "piper.download_voices",
        voice_name,
        "--download-dir",
        str(args.download_dir),
    ]
    print(f"Downloading {voice_name} to {args.download_dir}")
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
