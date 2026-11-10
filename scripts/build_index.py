"""Monta public/index/index.json com imagens livres (CC0, CC BY e domínio público).

Fontes: Open Images (Google, CC BY 2.0 com autor e link por imagem), Openverse (fotos e desenhos)
e Wikimedia Commons. Cada imagem ganha a "impressão" de semelhança geral (Image Embedder) e,
se tiver pessoa, os ângulos do rosto e os pontos do corpo e da mão.

Uso:
  npm run index                      # cerca de 8 mil imagens (algumas horas; pode parar e rodar de novo que continua)
  npm run index -- --limit 200       # amostra pequena
  npm run index -- --fresh           # apaga o progresso salvo e começa do zero
  npm run index -- --selftest        # confere se as contas batem com src/lib/features.ts e src/lib/similar.ts

As funções de características espelham src/lib/features.ts e src/lib/similar.ts. Mudou uma, mude a outra.
"""

import argparse
import base64
import csv
import json
import math
import pathlib
import re
import sys
import time
from collections import defaultdict

import cv2
import mediapipe as mp
import numpy as np
import requests
from mediapipe.tasks.python import BaseOptions, vision

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "index" / "index.json"
MODELS = ROOT / "scripts" / ".models"
FIXTURE = ROOT / "tests" / "fixtures" / "features.json"
CACHE = ROOT / "scripts" / ".cache"
DONE = CACHE / "entries.jsonl"  # imagens já indexadas
SEEN = CACHE / "seen.txt"  # ids já analisados, entrando ou não
# Os mesmos modelos que o site usa no navegador (src/lib/detect.ts).
MODEL_URLS = {
    "face": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    "body": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    "hand": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "embed": "https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/latest/mobilenet_v3_small.tflite",
}
HEADERS = {"User-Agent": "BiRefsIndexer/0.3 (+https://github.com/ppdrada/BiRefs)"}

QUERIES = [
    # rosto
    "portrait face", "profile portrait", "three quarter portrait", "looking up", "looking down", "head tilt",
    "close-up face", "elderly portrait", "child portrait", "smiling face", "face shadow", "side view head",
    # mão
    "hands", "hand gesture", "fist", "pointing finger", "holding hands", "hands holding", "open palm",
    "hand on face", "praying hands", "hands playing piano",
    # corpo
    "dancer", "ballet", "yoga pose", "figure model", "athlete", "running person", "sitting person",
    "standing person", "jumping person", "martial arts", "gymnast", "person lying down", "crouching",
    "walking person", "climbing", "swimmer", "boxer", "skateboarder",
]
# Desenhos de referência (Openverse ilustração/arte digitalizada e Wikimedia).
ART_QUERIES = [
    "figure drawing", "gesture drawing", "portrait drawing", "hand drawing", "anatomy drawing", "sketch",
    "pencil sketch", "charcoal drawing", "ink drawing", "etching portrait", "engraving figure", "life drawing",
]
# Sem pessoa: entram pela semelhança geral.
OTHER_QUERIES = ["cat", "dog", "horse", "bird", "skull", "still life", "drapery", "tree", "animal sketch"]

OI = "https://storage.googleapis.com/openimages"
OI_FILES = {
    "meta_val": "2018_04/validation/validation-images-with-rotation.csv",
    "meta_test": "2018_04/test/test-images-with-rotation.csv",
    "labels_val": "v7/oidv7-val-annotations-human-imagelabels.csv",
    "labels_test": "v7/oidv7-test-annotations-human-imagelabels.csv",
    "classes": "v7/oidv7-class-descriptions.csv",
}
OI_LABELS = [
    "Human face", "Human hand", "Person", "Man", "Woman", "Boy", "Girl", "Human body", "Dance",
    "Drawing", "Sketch", "Illustration", "Painting", "Cartoon", "Cat", "Dog", "Horse", "Bird", "Skull",
]
DRAWING_LABELS = {"Drawing", "Sketch", "Illustration", "Painting", "Cartoon", "Art", "Visual arts"}
DRAWING_WORDS = re.compile(
    r"\b(drawing|sketch|painting|engraving|etching|lithograph|illustration|woodcut|watercolou?r|charcoal|study of|cartoon)\b", re.I)


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


# Espelho de src/lib/similar.ts: guarda só o sinal de cada número (1 bit), do mais significativo para o menos.
def embedding_bits(values):
    return base64.b64encode(np.packbits(np.asarray(values) > 0).tobytes()).decode()


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
    got = embedding_bits(fx["embedding"]["values"])
    assert got == fx["embedding"]["expected"], got
    print("selftest ok: as contas batem com a fixture compartilhada")


# ---------- fontes ----------

def get(url, **kw):
    for _ in range(4):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30, **kw)
        except requests.RequestException:
            time.sleep(10)
            continue
        if r.status_code != 429:
            return r
        wait = min(int(r.headers.get("Retry-After", "60")), 900)
        print(f"  limite do servidor, esperando {wait}s", file=sys.stderr)
        time.sleep(wait)
    return None


def smaller_image(url):
    # Pede a versão menor ao próprio servidor de origem: 640 px no Flickr, 500 px na Wikimedia.
    if "staticflickr.com" in url:
        return re.sub(r"_[a-z]\.(jpg|png)$", r"_z.\1", url)
    m = re.match(r"(https://upload\.wikimedia\.org/wikipedia/commons)/(\w/\w\w)/([^/]+)$", url)
    if m:
        return f"{m[1]}/thumb/{m[2]}/{m[3]}/500px-{m[3]}"
    return url


def openverse(q, category):
    page, pages = 1, 1
    while page <= pages:
        r = get("https://api.openverse.org/v1/images/", params={
            "q": q, "license": "cc0,by", "category": category, "page_size": 20, "page": page,
        })
        if not r or r.status_code != 200:
            print(f"  Openverse {r.status_code if r else 'sem resposta'} em '{q}' p{page}, pulando", file=sys.stderr)
            return
        data = r.json()
        pages = data.get("page_count", 1)
        for item in data["results"]:
            if item.get("mature"):
                continue
            license = {"cc0": "CC0", "by": "CC BY"}.get(item["license"], item["license"].upper())
            yield {
                "id": item["id"],
                "title": item.get("title") or "Sem título",
                "creator": item.get("creator") or "Autor desconhecido",
                "license": f"{license} {item.get('license_version') or ''}".strip(),
                "licenseUrl": item.get("license_url") or "",
                "source": item.get("source") or "openverse",
                "url": item["foreign_landing_url"],
                "image": smaller_image(item["url"]),
                "original": item["url"],
                "kind": "photo" if item.get("category") == "photograph" else "drawing",
                # Tags do Openverse (em inglês) para a palavra-chave; até 15, sem repetir.
                "tags": list(dict.fromkeys(t["name"].lower() for t in item.get("tags") or [] if t.get("name")))[:15],
            }
        page += 1
        time.sleep(3)  # anônimo no Openverse: poucas requisições por minuto


def plain_text(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


def commons_license(meta):
    """CC0, CC BY e domínio público; fora CC BY-SA, que obriga a mesma licença em obras derivadas."""
    code = (meta.get("License", {}).get("value") or "").lower()
    if code in ("cc0", "pd") or (code.startswith("cc-by-") and not code.startswith("cc-by-sa")):
        return meta.get("LicenseShortName", {}).get("value") or code.upper()
    return None


def commons(q):
    params = {
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
        "gsrsearch": f"{q} filetype:bitmap", "gsrlimit": 50, "prop": "imageinfo",
        "iiprop": "url|extmetadata", "iiurlwidth": 500,
        "iiextmetadatafilter": "License|LicenseShortName|LicenseUrl|Artist",
    }
    while True:
        r = get("https://commons.wikimedia.org/w/api.php", params=params)
        if not r or r.status_code != 200:
            print(f"  Commons {r.status_code if r else 'sem resposta'} em '{q}', pulando", file=sys.stderr)
            return
        data = r.json()
        pages = sorted(data.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 0))
        for p in pages:
            info = (p.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata") or {}
            license = commons_license(meta)
            if not license or not info.get("thumburl"):
                continue
            name = p["title"].removeprefix("File:").rsplit(".", 1)[0].replace("_", " ")
            yield {
                "id": f"commons:{p['pageid']}",
                "title": name[:120],  # o ObjectName costuma vir em várias línguas; o nome do arquivo é mais limpo
                "creator": plain_text(meta.get("Artist", {}).get("value"))[:80] or "Autor desconhecido",
                "license": license,
                "licenseUrl": meta.get("LicenseUrl", {}).get("value") or info["descriptionurl"],
                "source": "wikimedia",
                "url": info["descriptionurl"],
                "image": info["thumburl"].split("?")[0],
                "original": info["url"],
                "kind": "drawing" if DRAWING_WORDS.search(name) else "photo",
                "tags": [],
            }
        if "continue" not in data:
            return
        params.update(data["continue"])
        time.sleep(1)


def oi_file(key):
    path = CACHE / "openimages" / OI_FILES[key].replace("/", "_")
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"baixando Open Images {OI_FILES[key]}...")
        with requests.get(f"{OI}/{OI_FILES[key]}", headers=HEADERS, stream=True, timeout=60) as r:
            r.raise_for_status()
            tmp = path.with_suffix(".part")
            with tmp.open("wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            tmp.replace(path)
    return path


_openimages = None


def openimages_data():
    """Etiquetas verificadas por pessoas (confiança 1) e créditos dos conjuntos de validação e teste."""
    global _openimages
    if _openimages:
        return _openimages
    wanted = set(OI_LABELS) | DRAWING_LABELS
    with oi_file("classes").open(encoding="utf-8") as f:
        names = {mid: name for mid, name in csv.reader(f) if name in wanted}
    labels = defaultdict(set)
    for key in ("labels_val", "labels_test"):
        with oi_file(key).open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row["Confidence"] == "1" and row["LabelName"] in names:
                    labels[row["ImageID"]].add(names[row["LabelName"]])
    meta = {}
    for key in ("meta_val", "meta_test"):
        with oi_file(key).open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row["ImageID"] in labels and "/licenses/by/" in row["License"] and row["Thumbnail300KURL"]:
                    meta[row["ImageID"]] = row
    print(f"Open Images: {len(meta)} imagens com crédito e etiquetas úteis")
    _openimages = (labels, meta)
    return _openimages


def openimages(label):
    labels, meta = openimages_data()
    for image_id in sorted(meta):
        names = labels[image_id]
        if label not in names:
            continue
        m = meta[image_id]
        title = m["Title"].strip()
        yield {
            "id": f"oi:{image_id}",
            # Muitos títulos são o nome do arquivo da câmera ("IMG_2034"); nesse caso usa as etiquetas.
            "title": title if re.search(r"[A-Za-z]{3,}\s+[A-Za-z]", title) else ", ".join(sorted(names)),
            "creator": m["Author"] or "Autor desconhecido",
            "license": "CC BY 2.0",
            "licenseUrl": m["License"],
            "source": "flickr",
            "url": m["OriginalLandingURL"],
            "image": m["Thumbnail300KURL"],
            "original": m["Thumbnail300KURL"],  # a original (_o) é enorme; se a menor sumiu, a imagem saiu do Flickr
            "kind": "drawing" if names & DRAWING_LABELS else "photo",
            "tags": sorted(n.lower() for n in names),
        }


FETCH = {
    "openverse": lambda q: openverse(q, "photograph"),
    "openverse-art": lambda q: openverse(q, "illustration,digitized_artwork"),
    "commons": commons,
    "openimages": openimages,
}
JOBS = (
    [("openimages", label) for label in OI_LABELS]
    + [("openverse", q) for q in QUERIES + OTHER_QUERIES]
    + [("openverse-art", q) for q in ART_QUERIES]
    + [("commons", q) for q in QUERIES + ART_QUERIES + OTHER_QUERIES]
)


# ---------- principal ----------

def model(name):
    ext = ".tflite" if name == "embed" else ".task"
    path = MODELS / f"{name}{ext}"
    if not path.exists():
        MODELS.mkdir(parents=True, exist_ok=True)
        print(f"baixando modelo {name}...")
        path.write_bytes(get(MODEL_URLS[name]).content)
    return BaseOptions(model_asset_path=str(path))


def describe(item, detectors):
    """Baixa a imagem e devolve a entrada do índice com a impressão de semelhança e, se tiver pessoa, os ângulos."""
    face, pose, hand, embedder = detectors
    image = item.pop("image")
    original = item.pop("original")
    r = get(image)
    if (not r or r.status_code != 200) and image != original:
        image = original
        r = get(image)
    if not r or r.status_code != 200:
        return None
    bgr = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    if bgr is None or min(bgr.shape[:2]) < 64:  # imagem quebrada ou ícone de "foto removida"
        return None
    rgb = np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    h, w = rgb.shape[:2]
    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

    feats = {"emb": embedding_bits(embedder.embed(img).embeddings[0].embedding)}
    f = face.detect(img).face_landmarks
    if f:
        feats["face"] = face_angles(f[0], w, h)
    p = pose.detect(img).pose_world_landmarks
    if p and (b := body_vector(p[0])):
        feats["body"] = b
    hd = hand.detect(img).hand_world_landmarks
    if hd:
        feats["hand"] = hand_vector(hd[0])
    return {**item, "image": image, **feats}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=8000)
    ap.add_argument("--fresh", action="store_true", help="apaga o progresso salvo e começa do zero")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    # O console do Windows (cp1252) quebra com títulos em outros alfabetos.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.selftest:
        return selftest()

    # Progresso salvo a cada imagem: se cair no meio, rodar de novo continua de onde parou.
    CACHE.mkdir(parents=True, exist_ok=True)
    if args.fresh:
        for f in (DONE, SEEN):
            f.unlink(missing_ok=True)
    entries = [json.loads(l) for l in DONE.read_text(encoding="utf-8").splitlines()] if DONE.exists() else []
    seen = set(SEEN.read_text(encoding="utf-8").split()) if SEEN.exists() else set()
    if entries:
        print(f"retomando: {len(entries)} imagens já indexadas, {len(seen)} já vistas")
    found = defaultdict(int)  # (fonte, termo) -> quantas entraram
    for e in entries:
        found[(e.get("_from"), e.get("_q"))] += 1

    detectors = (
        vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=model("face"), num_faces=1)),
        vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=model("body"), num_poses=1)),
        vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(base_options=model("hand"), num_hands=1)),
        vision.ImageEmbedder.create_from_options(vision.ImageEmbedderOptions(base_options=model("embed"), l2_normalize=True)),
    )

    # Divide as vagas entre fontes e termos para o índice ter de tudo um pouco.
    per_job = math.ceil(args.limit / len(JOBS))
    with DONE.open("a", encoding="utf-8") as done, SEEN.open("a", encoding="utf-8") as seen_file:
        for source, term in JOBS:
            if found[(source, term)] >= per_job:
                continue
            for item in FETCH[source](term):
                if found[(source, term)] >= per_job or len(entries) >= args.limit:
                    break
                if item["id"] in seen:
                    continue
                seen.add(item["id"])
                seen_file.write(item["id"] + "\n")
                entry = describe(item, detectors)
                if not entry:
                    continue
                # Busca de pessoa por texto traz lixo ("looking up" → galáxia): ali só entra quem tem pessoa detectada.
                # Desenhos, animais/objetos e as etiquetas verificadas do Open Images entram também só pela semelhança geral.
                if term in QUERIES and source != "openimages" and not any(k in entry for k in ("face", "body", "hand")):
                    continue
                entry.update({"_from": source, "_q": term})
                entries.append(entry)
                done.write(json.dumps(entry, ensure_ascii=False) + "\n")
                done.flush()
                found[(source, term)] += 1
                kinds = "+".join(k for k in ("face", "body", "hand") if k in entry) or "geral"
                print(f"[{len(entries)}/{args.limit}] {source} {term}: {entry['kind']} {kinds}  {entry['title'][:50]}")
            seen_file.flush()

    public = [{k: v for k, v in e.items() if not k.startswith("_")} for e in entries]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Uma entrada por linha, para o diff no git ficar legível.
    OUT.write_text("[\n" + ",\n".join(json.dumps(e, ensure_ascii=False) for e in public) + "\n]\n", encoding="utf-8")
    counts = {k: sum(k in e for e in public) for k in ("face", "body", "hand")}
    kinds = {k: sum(e["kind"] == k for e in public) for k in ("photo", "drawing")}
    by_source = defaultdict(int)
    for e in entries:
        by_source[e.get("_from")] += 1
    size = OUT.stat().st_size / 1e6
    print(f"gravado {OUT.relative_to(ROOT)}: {len(public)} imagens, {size:.1f} MB {counts} {kinds} {dict(by_source)}")


if __name__ == "__main__":
    main()
