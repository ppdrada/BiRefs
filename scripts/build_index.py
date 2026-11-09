"""Fase 0: monta public/index/index.json com imagens CC0/CC-BY do Openverse.

Uso:
  npm run index                      # cerca de 500 imagens (demora alguns minutos)
  npm run index -- --limit 40        # amostra pequena
  npm run index -- --selftest        # confere se as contas batem com src/lib/features.ts

As funções de características espelham src/lib/features.ts. Mudou uma, mude a outra.
"""

import argparse
import json
import math
import pathlib
import re
import sys
import time

import cv2
import mediapipe as mp
import numpy as np
import requests
from mediapipe.tasks.python import BaseOptions, vision

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "index" / "index.json"
MODELS = ROOT / "scripts" / ".models"
FIXTURE = ROOT / "tests" / "fixtures" / "features.json"
# Os mesmos modelos que src/lib/detect.ts usa no navegador.
MODEL_URLS = {
    "face": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    "body": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    "hand": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
}
HEADERS = {"User-Agent": "BiRefsIndexer/0.1 (+https://github.com/ppdrada/BiRefs)"}
QUERIES = [
    "portrait face", "profile portrait", "three quarter portrait", "looking up", "looking down",
    "head tilt", "hands", "hand gesture", "fist", "pointing finger", "holding hands",
    "dancer", "ballet", "yoga pose", "figure model", "athlete", "running person", "sitting person",
]
LICENSE_NAMES = {"cc0": "CC0", "by": "CC BY"}


# ---------- características (espelho de src/lib/features.ts) ----------

def js_round(v, places):
    f = 10 ** places
    return math.floor(v * f + 0.5) / f


def face_angles(lm, width, height):
    def p(i):
        return (lm[i].x * width, lm[i].y * height, lm[i].z * width)

    l, r, top, chin = p(234), p(454), p(10), p(152)
    right = [r[k] - l[k] for k in range(3)]
    up = [top[k] - chin[k] for k in range(3)]
    fwd = [
        right[1] * up[2] - right[2] * up[1],
        right[2] * up[0] - right[0] * up[2],
        right[0] * up[1] - right[1] * up[0],
    ]
    yaw = math.atan2(fwd[0], -fwd[2])
    pitch = math.atan2(fwd[1], math.hypot(fwd[0], fwd[2]))
    roll = math.atan2(right[1], right[0])
    return [js_round(math.degrees(a), 1) for a in (yaw, pitch, roll)]


BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
TORSO = [11, 12, 23, 24]


def vis(p):
    return 1 if getattr(p, "visibility", None) is None else p.visibility


def body_vector(world):
    if any(vis(world[i]) < 0.5 for i in TORSO):
        return None
    sh = [(getattr(world[11], a) + getattr(world[12], a)) / 2 for a in "xyz"]
    hip = [(getattr(world[23], a) + getattr(world[24], a)) / 2 for a in "xyz"]
    scale = math.dist(sh, hip) or 1
    return [js_round((getattr(world[i], a) - hip[k]) / scale, 3) for i in BODY for k, a in enumerate("xyz")]


def hand_vector(world):
    w = world[0]
    scale = math.dist((world[9].x, world[9].y, world[9].z), (w.x, w.y, w.z)) or 1
    return [js_round((getattr(p, a) - getattr(w, a)) / scale, 3) for p in world for a in "xyz"]


def selftest():
    class P:
        def __init__(self, x=0, y=0, z=0, visibility=1):
            self.x, self.y, self.z, self.visibility = x, y, z, visibility

    def points(sparse, n):
        return [P(*sparse[str(i)]) if str(i) in sparse else P() for i in range(n)]

    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for case in fx["face"]:
        got = face_angles(points(case["points"], 478), case["width"], case["height"])
        assert all(abs(g - e) < 1e-9 for g, e in zip(got, case["expected"])), (got, case["expected"])
    got = body_vector(points(fx["body"]["points"], 33))
    assert all(abs(g - e) < 1e-9 for g, e in zip(got, fx["body"]["expected"])), got
    got = hand_vector(points(fx["hand"]["points"], 21))
    assert all(abs(g - e) < 1e-9 for g, e in zip(got[27:30], fx["hand"]["expectedPoint9"])), got[27:30]
    print("selftest ok: as contas batem com a fixture compartilhada")


# ---------- Openverse ----------

def get(url, **kw):
    for _ in range(4):
        r = requests.get(url, headers=HEADERS, timeout=30, **kw)
        if r.status_code != 429:
            return r
        wait = int(r.headers.get("Retry-After", "60"))
        print(f"  limite do servidor, esperando {wait}s", file=sys.stderr)
        time.sleep(wait)
    return r


def candidates(q, seen):
    page, pages = 1, 1
    while page <= pages:
        r = get("https://api.openverse.org/v1/images/", params={
            "q": q, "license": "cc0,by", "category": "photograph", "page_size": 20, "page": page,
        })
        if r.status_code != 200:
            print(f"  Openverse {r.status_code} em '{q}' p{page}, pulando", file=sys.stderr)
            return
        data = r.json()
        pages = data.get("page_count", 1)
        for item in data["results"]:
            if item["id"] not in seen and not item.get("mature"):
                seen.add(item["id"])
                yield item
        page += 1
        time.sleep(3)  # anônimo no Openverse: poucas requisições por minuto


def smaller_image(url):
    # Pede a versão menor ao próprio servidor de origem: 640 px no Flickr, 500 px na Wikimedia.
    if "staticflickr.com" in url:
        return re.sub(r"_[a-z]\.(jpg|png)$", r"_z.\1", url)
    m = re.match(r"(https://upload\.wikimedia\.org/wikipedia/commons)/(\w/\w\w)/([^/]+)$", url)
    if m:
        return f"{m[1]}/thumb/{m[2]}/{m[3]}/500px-{m[3]}"
    return url


# ---------- principal ----------

def model(name):
    path = MODELS / f"{name}.task"
    if not path.exists():
        MODELS.mkdir(parents=True, exist_ok=True)
        print(f"baixando modelo {name}...")
        path.write_bytes(get(MODEL_URLS[name]).content)
    return BaseOptions(model_asset_path=str(path))


def describe(item, detectors):
    """Baixa a imagem e devolve a entrada do índice, ou None se não achar rosto, corpo nem mão."""
    face, pose, hand = detectors
    image = smaller_image(item["url"])
    try:
        r = get(image)
        if r.status_code != 200 and image != item["url"]:
            image = item["url"]
            r = get(image)
        if r.status_code != 200:
            return None
        bgr = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    except requests.RequestException:
        return None
    if bgr is None:
        return None
    rgb = np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    h, w = rgb.shape[:2]
    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

    feats = {}
    f = face.detect(img).face_landmarks
    if f:
        feats["face"] = face_angles(f[0], w, h)
    p = pose.detect(img).pose_world_landmarks
    if p and (b := body_vector(p[0])):
        feats["body"] = b
    hd = hand.detect(img).hand_world_landmarks
    if hd:
        feats["hand"] = hand_vector(hd[0])
    if not feats:
        return None

    license = LICENSE_NAMES.get(item["license"], item["license"].upper())
    return {
        "id": item["id"],
        "title": item.get("title") or "Sem título",
        "creator": item.get("creator") or "Autor desconhecido",
        "license": f"{license} {item.get('license_version') or ''}".strip(),
        "licenseUrl": item.get("license_url") or "",
        "source": item.get("source") or "",
        "url": item["foreign_landing_url"],
        "image": image,
        **feats,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    # O console do Windows (cp1252) quebra com títulos em outros alfabetos.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.selftest:
        return selftest()

    detectors = (
        vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=model("face"), num_faces=1)),
        vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=model("body"), num_poses=1)),
        vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(base_options=model("hand"), num_hands=1)),
    )

    entries, seen = [], set()
    # Divide as vagas entre os termos para o índice ter rosto, corpo e mão, não só retratos.
    per_query = math.ceil(args.limit / len(QUERIES))
    for q in QUERIES:
        found = 0
        for item in candidates(q, seen):
            if found >= per_query or len(entries) >= args.limit:
                break
            entry = describe(item, detectors)
            if entry:
                entries.append(entry)
                found += 1
                kinds = "+".join(k for k in ("face", "body", "hand") if k in entry)
                print(f"[{len(entries)}/{args.limit}] {q}: {kinds}  {entry['title'][:50]}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Uma entrada por linha, para o diff no git ficar legível.
    OUT.write_text("[\n" + ",\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n]\n", encoding="utf-8")
    counts = {k: sum(k in e for e in entries) for k in ("face", "body", "hand")}
    print(f"gravado {OUT.relative_to(ROOT)}: {len(entries)} imagens {counts}")


if __name__ == "__main__":
    main()
