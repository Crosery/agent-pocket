#!/usr/bin/env python3
"""Batch image generation over a JSON job list.

Backends (pipeline.json generator.backend, overridable with --backend):
  aigw     OpenAI-compatible image gateway /v1/images/generations, or /v1/images/edits when the job has
           reference images (key from env or local secrets file)
  crosery  local generator `crosery-ct call crosery_image_generate`

Each job {id, kind, prompt, variant, quality} renders to assets_src/raw/<kind>/<id>.png with a sidecar
<id>.json (prompt + generator result). Existing outputs are skipped (idempotent) unless forced.
A failed job is retried once; failures are appended to assets_src/raw/_failures.jsonl.

Usage:
  python3 tools/gen_images.py [--jobs assets_src/prompts/jobs.json] [--kind character --kind portrait]
                              [--only id1,id2] [--force id1,id2 | --force-all] [--concurrency 6] [--dry-run]
                              [--backend aigw|crosery]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from assetlib import JOBS_PATH, RAW_DIR, ROOT, load_jobs, pipeline_cfg, raw_path

LOCK = threading.Lock()


def log(msg: str) -> None:
    with LOCK:
        print(msg, flush=True)


def aigw_key(cfg: dict) -> str:
    """Env var first, else the KEY=value line in the local secrets file; never logged."""
    name = cfg["apiKeyEnv"]
    if os.environ.get(name):
        return os.environ[name]
    path = Path(cfg.get("secretsFile") or os.environ.get("AIGW_SECRETS_FILE", "")).expanduser()
    if str(path) not in ("", ".") and path.is_file():
        for line in path.read_text().splitlines():
            k, sep, v = line.partition("=")
            if sep and k.strip().removeprefix("export ").strip() == name:
                return v.strip().strip("'\"")
    raise RuntimeError(f"{name} not set (env, or secretsFile in assets_src/pipeline.local.json)")


def multipart(fields: dict, files: list[tuple[str, Path]]) -> tuple[bytes, str]:
    boundary = f"----genimg{uuid.uuid4().hex}"
    out = bytearray()
    for name, value in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    for name, path in files:
        out += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode()
        out += path.read_bytes() + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def aigw_render(job: dict, gen: dict, tmp: str) -> tuple[str, dict]:
    """OpenAI-compatible image API on the company AIGW gateway (b64 PNG, one image per call).
    Jobs with reference images go to /v1/images/edits, the rest to /v1/images/generations."""
    cfg = gen["aigw"]
    fields = {
        "model": cfg["model"],
        "prompt": job["prompt"],
        "size": cfg["sizes"][job["variant"]],
        "quality": job["quality"],
        "n": 1,
    }
    auth = {"Authorization": f"Bearer {aigw_key(cfg)}"}
    base = (cfg.get("baseUrl") or os.environ.get("AIGW_BASE_URL", "")).rstrip("/")
    if not base:
        raise RuntimeError("gateway base URL not set (env AIGW_BASE_URL or generator.aigw.baseUrl in assets_src/pipeline.local.json)")
    if job.get("images"):
        body, ctype = multipart(fields, [("image[]", ROOT / p) for p in job["images"]])
        req = urllib.request.Request(
            base + "/v1/images/edits",
            data=body,
            headers={**auth, "Content-Type": ctype},
        )
    else:
        req = urllib.request.Request(
            base + "/v1/images/generations",
            data=json.dumps(fields).encode(),
            headers={**auth, "Content-Type": "application/json"},
        )
    try:
        with urllib.request.urlopen(req, timeout=gen["timeoutSeconds"]) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read()[:400]!r}") from e
    except TimeoutError as e:
        raise subprocess.TimeoutExpired("aigw", gen["timeoutSeconds"]) from e
    item = (data.get("data") or [{}])[0]
    if not item.get("b64_json"):
        raise RuntimeError(f"no image in response: {json.dumps(data)[:400]}")
    out = Path(tmp) / "aigw.png"
    out.write_bytes(base64.b64decode(item["b64_json"]))
    meta = {k: v for k, v in data.items() if k != "data"}
    return str(out), {
        "backend": "aigw",
        "model": item.get("model", cfg["model"]),
        **meta,
    }


def run_once(job: dict, gen: dict) -> str:
    with tempfile.TemporaryDirectory(prefix="genimg-") as tmp:
        if gen.get("backend", "crosery") == "aigw":
            src, result = aigw_render(job, gen, tmp)
        else:
            src, result = crosery_render(job, gen, tmp)
        dest = raw_path(job)
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_suffix(".part.png")
        shutil.move(src, part)
        part.replace(dest)
        meta = {
            "id": job["id"],
            "kind": job["kind"],
            "prompt": job["prompt"],
            "variant": job["variant"],
            "quality": job["quality"],
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "result": result,
        }
        dest.with_suffix(".json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
        )
        return str(dest)


def crosery_render(job: dict, gen: dict, tmp: str) -> tuple[str, dict]:
    args = {
        "prompt": job["prompt"],
        "variant": job["variant"],
        "quality": job["quality"],
        "timeout_seconds": gen["timeoutSeconds"],
    }
    if job.get("images"):
        args["images"] = [str(ROOT / p) for p in job["images"]]
    proc = subprocess.run(
        [
            gen["command"],
            "call",
            gen["tool"],
            "--json-args",
            json.dumps(args, ensure_ascii=False),
            "--out-dir",
            tmp,
        ],
        capture_output=True,
        check=False,
        text=True,
        timeout=gen["timeoutSeconds"] + 120,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"exit {proc.returncode}: {proc.stderr.strip()[-600:]}")
    result = json.loads(proc.stdout)
    art = result.get("artifact") or (result.get("artifacts") or [None])[0]
    if not art or not art.get("absolute"):
        raise RuntimeError(f"no artifact in result: {proc.stdout[:400]}")
    return art["absolute"], {
        "backend": "crosery",
        **{k: v for k, v in result.items() if k not in ("artifact", "artifacts")},
    }


def run_job(job: dict, gen: dict) -> tuple[dict, str | None, str | None]:
    err = None
    for attempt in range(1 + gen["retries"]):
        t0 = time.time()
        try:
            path = run_once(job, gen)
            log(f"[ok]   {job['kind']}/{job['id']}  {time.time() - t0:.0f}s")
            return job, path, None
        except subprocess.TimeoutExpired:
            # The remote job may still be running: never resubmit it automatically.
            err = "local timeout; the generation may still be running remotely - check before re-running"
            log(f"[fail] {job['kind']}/{job['id']}: {err}")
            break
        except Exception as e:  # noqa: BLE001 - every failure is logged and retried
            err = str(e)
            log(f"[fail] {job['kind']}/{job['id']} attempt {attempt + 1}: {err[:300]}")
    with LOCK:
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        with (RAW_DIR / "_failures.jsonl").open("a") as f:
            f.write(
                json.dumps(
                    {
                        "id": job["id"],
                        "kind": job["kind"],
                        "error": err,
                        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return job, None, err


def select(
    jobs: list[dict], kinds: list[str], only: set[str], force: set[str], force_all: bool
) -> list[dict]:
    out = []
    for j in jobs:
        if kinds and j["kind"] not in kinds:
            continue
        if only and j["id"] not in only and f"{j['kind']}/{j['id']}" not in only:
            continue
        forced = force_all or j["id"] in force or f"{j['kind']}/{j['id']}" in force
        if raw_path(j).exists() and not forced:
            continue
        out.append(j)
    return out


def main() -> int:
    gen = pipeline_cfg()["generator"]
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--jobs", default=str(JOBS_PATH))
    ap.add_argument("--kind", action="append", default=[])
    ap.add_argument("--only", default="", help="comma list of ids or kind/id")
    ap.add_argument(
        "--force", default="", help="comma list of ids or kind/id to regenerate"
    )
    ap.add_argument("--force-all", action="store_true")
    ap.add_argument("--concurrency", type=int, default=gen["concurrency"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--backend",
        choices=["aigw", "crosery"],
        default=gen.get("backend", "crosery"),
    )
    a = ap.parse_args()
    gen = {**gen, "backend": a.backend}
    split = lambda s: {x.strip() for x in s.split(",") if x.strip()}
    todo = select(load_jobs(a.jobs), a.kind, split(a.only), split(a.force), a.force_all)
    log(
        f"{len(todo)} job(s) to run, concurrency {min(a.concurrency, gen['maxConcurrency'])}"
    )
    if a.dry_run:
        for j in todo:
            log(f"  {j['kind']}/{j['id']}")
        return 0
    failed = 0
    with ThreadPoolExecutor(
        max_workers=max(1, min(a.concurrency, gen["maxConcurrency"]))
    ) as pool:
        for fut in as_completed([pool.submit(run_job, j, gen) for j in todo]):
            _, _, err = fut.result()
            failed += err is not None
    log(f"done: {len(todo) - failed} ok, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
