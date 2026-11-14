"""Monta public/index/index.json com imagens livres (CC0, CC BY e domínio público).

Fontes: Open Images (Google, CC BY 2.0 com autor e link por imagem), Openverse (fotos e desenhos),
Wikimedia Commons e os acervos abertos do Met, National Gallery of Art, SMK, Wellcome Collection e
Rijksmuseum. Cada imagem ganha a "impressão" de semelhança geral (CLIP) e,
se tiver pessoa, os ângulos do rosto e os pontos do corpo e da mão.

Uso:
  npm run index                      # até 12 mil imagens (algumas horas; pode parar e rodar de novo que continua)
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
import onnxruntime as ort
import requests
from mediapipe.tasks.python import BaseOptions, vision
from PIL import Image

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
    # CLIP ViT-B/32 (OpenAI, licença MIT): entende o assunto da imagem, não só cores e formas.
    "embed": "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_q4f16.onnx",
}
# Muda junto com EMBED em src/lib/detect.ts: imagens indexadas com outra versão são refeitas.
EMBED_VERSION = "clip-b32"
CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)
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
# Acervos de museus (desenhos, gravuras, esculturas e fotos antigas). As de pessoa só entram com pessoa detectada.
MUSEUM_PEOPLE = [
    "hand study", "hands", "portrait", "head study", "figure study", "nude", "dancer", "seated figure",
    "standing figure", "muybridge",
]
MUSEUM_QUERIES = MUSEUM_PEOPLE + ["horse", "dog", "cat", "skull", "drapery"]
CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/"
# Escultura e foto vão para "Fotos"; o resto do acervo (desenho, gravura, pintura) para "Desenhos".
PHOTO_WORDS = re.compile(r"photograph|sculpture|statue|fotografi|skulptur", re.I)
# Acervos médicos (Wellcome) trazem doença, cirurgia e dissecação: ficam fora do índice.
MEDICAL_WORDS = re.compile(
    r"diseas|syphil|wound|surg|tumou?r|dissect|corpse|lepros|smallpox|ulcer|deform|amputat|cadaver|patholog|"
    r"operation|lesion|scabies|acromegaly|spinal curvature|patient", re.I)

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


def fix_commons_kinds(entries):
    """Na Wikimedia o tipo vem só do nome do arquivo, e pintura sem "painting" no nome virava foto.
    Corrige pelo voto das 15 imagens mais parecidas das outras fontes, só quando 80% concordam."""
    def bits(e):
        return np.unpackbits(np.frombuffer(base64.b64decode(e["emb"]), np.uint8)).astype(np.float32) * 2 - 1

    trusted = [e for e in entries if e.get("_from") != "commons"]
    commons = [e for e in entries if e.get("_from") == "commons"]
    if len(trusted) < 15 or not commons:
        return 0
    t = np.array([bits(e) for e in trusted])
    drawing = np.array([e["kind"] == "drawing" for e in trusted])
    top = np.argsort(-(np.array([bits(e) for e in commons]) @ t.T), axis=1)[:, :15]
    changed = 0
    for e, vote in zip(commons, drawing[top].mean(1)):
        kind = "drawing" if vote >= 0.8 else "photo" if vote <= 0.2 else e["kind"]
        changed += kind != e["kind"]
        e["kind"] = kind
    return changed


def selftest():
    def fake(kind, source, on):
        emb = base64.b64encode(np.packbits(np.arange(64) < 32 if on else np.arange(64) >= 32).tobytes()).decode()
        return {"kind": kind, "_from": source, "emb": emb}

    sample = [fake("drawing", "met", True)] * 15 + [fake("photo", "openimages", False)] * 15
    wrong = [fake("photo", "commons", True), fake("drawing", "commons", False)]
    assert fix_commons_kinds(sample + wrong) == 2 and [e["kind"] for e in wrong] == ["drawing", "photo"]

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

def get(url, headers=HEADERS, **kw):
    for _ in range(4):
        try:
            r = requests.get(url, headers=headers, timeout=30, **kw)
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
    return cached_file(f"{OI}/{OI_FILES[key]}", CACHE / "openimages" / OI_FILES[key].replace("/", "_"))


def cached_file(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"baixando {url}...")
        with requests.get(url, headers=HEADERS, stream=True, timeout=60) as r:
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


def met(q):
    """Metropolitan Museum: só obras em domínio público (CC0). O /v1/search foi aposentado em 2026."""
    r = get("https://collectionapi.metmuseum.org/public/collection/v1.1/search", params={"q": q, "hasImages": "true"})
    if not r or r.status_code != 200:
        print(f"  Met {r.status_code if r else 'sem resposta'} em '{q}', pulando", file=sys.stderr)
        return
    for object_id in r.json().get("objectIDs") or []:
        time.sleep(1)  # o Met bloqueia por um tempo quem faz muitos pedidos seguidos
        o = get(f"https://collectionapi.metmuseum.org/public/collection/v1/objects/{object_id}")
        if not o or o.status_code != 200:
            continue
        o = o.json()
        if not o.get("isPublicDomain") or not o.get("primaryImageSmall"):
            continue
        yield {
            "id": f"met:{object_id}",
            "title": (o.get("title") or "Sem título")[:120],
            "creator": o.get("artistDisplayName") or "Autor desconhecido",
            "license": "CC0",
            "licenseUrl": CC0_URL,
            "source": "met",
            "url": o["objectURL"],
            "image": o["primaryImageSmall"],
            "original": o.get("primaryImage") or o["primaryImageSmall"],
            "kind": "photo" if PHOTO_WORDS.search(o.get("classification") or "") else "drawing",
            "tags": [t["term"].lower() for t in o.get("tags") or [] if t.get("term")][:15],
        }


_nga = None


def nga_data():
    """National Gallery of Art: o acervo aberto (CC0) vem em CSV no GitHub; a busca é feita aqui."""
    global _nga
    if _nga:
        return _nga
    base = "https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data"
    csv.field_size_limit(10**8)
    images = {}
    with cached_file(f"{base}/published_images.csv", CACHE / "nga" / "published_images.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["openaccess"] == "1" and row["viewtype"] == "primary":
                images[row["depictstmsobjectid"]] = row
    objects = []
    with cached_file(f"{base}/objects.csv", CACHE / "nga" / "objects.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["objectid"] in images:
                img = images[row["objectid"]]
                # A descrição da imagem (assistivetext) ajuda a achar "mão", "dançarina" etc. além do título.
                objects.append((f"{row['title']} {img['assistivetext']}".lower(), row, img))
    print(f"National Gallery: {len(objects)} obras abertas com imagem")
    _nga = objects
    return _nga


def nga(q):
    words = q.lower().split()
    for text, row, img in nga_data():
        if not all(re.search(rf"\b{re.escape(w)}", text) for w in words):
            continue
        yield {
            "id": f"nga:{row['objectid']}",
            "title": (row["title"] or "Sem título")[:120],
            "creator": row["attribution"] or "Autor desconhecido",
            "license": "CC0",
            "licenseUrl": CC0_URL,
            "source": "nga",
            "url": f"https://www.nga.gov/collection/art-object-page.{row['objectid']}.html",
            "image": f"{img['iiifurl']}/full/!600,600/0/default.jpg",
            "original": img["iiifthumburl"],
            "kind": "photo" if PHOTO_WORDS.search(row["classification"]) else "drawing",
            "tags": [],
        }


def smk(q):
    """Statens Museum for Kunst (Dinamarca): só domínio público com imagem."""
    offset, found = 0, 1
    while offset < found:
        r = get("https://api.smk.dk/api/v1/art/search/", params={
            "keys": q, "filters": "[public_domain:true],[has_image:true]", "offset": offset, "rows": 100,
        })
        if not r or r.status_code != 200:
            print(f"  SMK {r.status_code if r else 'sem resposta'} em '{q}', pulando", file=sys.stderr)
            return
        data = r.json()
        found = data.get("found", 0)
        for o in data.get("items") or []:
            thumb = o.get("image_thumbnail")
            if not thumb or not o.get("public_domain"):
                continue
            kinds = " ".join(n.get("name", "") for n in o.get("object_names") or [])
            yield {
                "id": f"smk:{o['object_number']}",
                "title": ((o.get("titles") or [{}])[0].get("title") or "Sem título")[:120],
                "creator": ((o.get("production") or [{}])[0].get("creator")) or "Autor desconhecido",
                "license": "Domínio público",
                "licenseUrl": o.get("rights") or "https://creativecommons.org/publicdomain/mark/1.0/",
                "source": "smk",
                "url": o["frontend_url"],
                "image": thumb.replace("/full/!1024,/", "/full/!600,/"),
                "original": thumb,
                "kind": "photo" if PHOTO_WORDS.search(kinds) else "drawing",
                "tags": [],
            }
        offset += 100
        time.sleep(1)


WELLCOME_LICENSES = {"cc-0": "CC0", "cc-by": "CC BY 4.0", "pdm": "Domínio público"}


def wellcome(q):
    """Wellcome Collection: o filtro de licença deixa de fora as CC BY-NC do acervo."""
    url = "https://api.wellcomecollection.org/catalogue/v2/images"
    params = {"query": q, "locations.license": ",".join(WELLCOME_LICENSES), "pageSize": 100, "include": "source.contributors"}
    while url:
        r = get(url, params=params)
        if not r or r.status_code != 200:
            print(f"  Wellcome {r.status_code if r else 'sem resposta'} em '{q}', pulando", file=sys.stderr)
            return
        data = r.json()
        for o in data.get("results") or []:
            loc = (o.get("locations") or [{}])[0]
            lic = (loc.get("license") or {}).get("id")
            if lic not in WELLCOME_LICENSES or not loc.get("url", "").endswith("/info.json"):
                continue
            src = o.get("source") or {}
            people = [c.get("agent", {}).get("label") for c in src.get("contributors") or []]
            title = src.get("title") or "Sem título"
            yield {
                "id": f"wellcome:{o['id']}",
                "title": title[:120],
                "creator": next((p for p in people if p), "Wellcome Collection"),
                "license": WELLCOME_LICENSES[lic],
                "licenseUrl": loc["license"].get("url") or "",
                "source": "wellcome",
                "url": f"https://wellcomecollection.org/works/{src.get('id')}",
                "image": loc["url"].replace("/info.json", "/full/500,/0/default.jpg"),
                "original": loc["url"].replace("/info.json", "/full/full/0/default.jpg"),
                "kind": "photo" if PHOTO_WORDS.search(title) else "drawing",
                "tags": [],
            }
        url, params = data.get("nextPage"), None
        time.sleep(1)


def rijks_license(obj):
    """Licença da imagem no Linked Art do Rijksmuseum: aceita domínio público e CC BY, nunca BY-SA."""
    for s in obj.get("subject_of") or []:
        for d in s.get("digitally_carried_by") or []:
            image = next((a["id"] for a in d.get("access_point") or [] if "/full/" in a.get("id", "")), None)
            for ref in d.get("referred_to_by") or []:
                lic = ref.get("content") or ""
                if image and ("/publicdomain/" in lic or ("/licenses/by/" in lic)):
                    return image, lic, ref.get("_label") or ("Domínio público" if "/publicdomain/" in lic else "CC BY")
    return None


def rijks(q):
    """Rijksmuseum: a busca devolve só os ids dos desenhos; cada obra é lida à parte."""
    url = "https://data.rijksmuseum.nl/search/collection"
    params = {"description": q, "type": "drawing", "imageAvailable": "true"}
    while url:
        r = get(url, params=params)
        if not r or r.status_code != 200:
            print(f"  Rijksmuseum {r.status_code if r else 'sem resposta'} em '{q}', pulando", file=sys.stderr)
            return
        data = r.json()
        for item in data.get("orderedItems") or []:
            o = requests_ld(item["id"])
            if not o or not (lic := rijks_license(o)):
                continue
            image, lic_url, lic_label = lic
            names = [n for n in o.get("identified_by") or [] if n.get("type") == "Name"]
            number = next((n["content"] for n in o.get("identified_by") or []
                           if n.get("type") == "Identifier" and any("300312355" in c.get("id", "") for c in n.get("classified_as") or [])), None)
            people = [p for part in (o.get("produced_by") or {}).get("part") or [] for p in part.get("carried_out_by") or []]
            creator = next((n["@value"] for p in people for n in p.get("notation") or [] if n.get("@language") == "en"), None)
            if not number:
                continue
            yield {
                "id": f"rijks:{number}",
                "title": ((names[0]["content"] if names else None) or "Sem título")[:120],
                "creator": creator or "Autor desconhecido",
                "license": "Domínio público" if "/publicdomain/" in lic_url else lic_label,
                "licenseUrl": lic_url,
                "source": "rijksmuseum",
                "url": f"https://www.rijksmuseum.nl/en/collection/{number}",
                "image": image.replace("/full/max/", "/full/!600,600/"),
                "original": image,
                "kind": "drawing",
                "tags": [],
            }
            time.sleep(0.3)
        url, params = (data.get("next") or {}).get("id"), None


def requests_ld(url):
    r = get(url, headers={**HEADERS, "Accept": "application/ld+json"})
    return r.json() if r and r.status_code == 200 else None


FETCH = {
    "openverse": lambda q: openverse(q, "photograph"),
    "openverse-art": lambda q: openverse(q, "illustration,digitized_artwork"),
    "commons": commons,
    "openimages": openimages,
    "met": met,
    "nga": nga,
    "smk": smk,
    "wellcome": wellcome,
    "rijks": rijks,
}
# Museus primeiro: as fontes antigas já foram esgotadas no índice atual e só voltam a ser consultadas depois.
JOBS = (
    [(museum, q) for museum in ("met", "nga", "smk", "wellcome", "rijks") for q in MUSEUM_QUERIES]
    + [("openimages", label) for label in OI_LABELS]
    + [("openverse", q) for q in QUERIES + OTHER_QUERIES]
    + [("openverse-art", q) for q in ART_QUERIES]
    + [("commons", q) for q in QUERIES + ART_QUERIES + OTHER_QUERIES]
)


# ---------- principal ----------

def model_path(name):
    path = MODELS / (f"{EMBED_VERSION}.onnx" if name == "embed" else f"{name}.task")
    if not path.exists():
        MODELS.mkdir(parents=True, exist_ok=True)
        print(f"baixando modelo {name}...")
        path.write_bytes(get(MODEL_URLS[name]).content)
    return str(path)


def model(name):
    return BaseOptions(model_asset_path=model_path(name))


def load_rgb(url):
    r = get(url)
    if not r or r.status_code != 200:
        return None
    bgr = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    if bgr is None or min(bgr.shape[:2]) < 64:  # imagem quebrada ou ícone de "foto removida"
        return None
    return np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


def embed(session, rgb):
    """Impressão de semelhança geral. O preparo da imagem espelha clipInput() em src/lib/detect.ts."""
    h, w = rgb.shape[:2]
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    img = Image.fromarray(rgb[top:top + side, left:left + side]).resize((224, 224), Image.BICUBIC)
    x = (np.asarray(img, np.float32) / 255 - CLIP_MEAN) / CLIP_STD
    return session.run(["image_embeds"], {"pixel_values": x.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]


def reembed(entries, embedder):
    """Refaz a impressão das imagens indexadas com um modelo antigo. Salva de tempos em tempos para poder retomar."""
    todo = [e for e in entries if e.get("_emb") != EMBED_VERSION]

    def save():
        tmp = DONE.with_suffix(".part")
        tmp.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries), encoding="utf-8")
        tmp.replace(DONE)

    for n, e in enumerate(todo, 1):
        rgb = load_rgb(e["image"])
        if rgb is not None:
            e.update({"emb": embedding_bits(embed(embedder, rgb)), "_emb": EMBED_VERSION})
        if n % 200 == 0 or n == len(todo):
            save()
            print(f"impressões refeitas: {n}/{len(todo)}", flush=True)


def describe(item, detectors):
    """Baixa a imagem e devolve a entrada do índice com a impressão de semelhança e, se tiver pessoa, os ângulos."""
    face, pose, hand, embedder = detectors
    image = item.pop("image")
    original = item.pop("original")
    rgb = load_rgb(image)
    if rgb is None and image != original:
        image = original
        rgb = load_rgb(image)
    if rgb is None:
        return None
    h, w = rgb.shape[:2]
    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

    feats = {"emb": embedding_bits(embed(embedder, rgb)), "_emb": EMBED_VERSION}
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
    ap.add_argument("--limit", type=int, default=12000)
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
        ort.InferenceSession(model_path("embed"), providers=["CPUExecutionProvider"]),
    )
    reembed(entries, detectors[3])

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
                if (term in QUERIES or term in MUSEUM_PEOPLE) and source != "openimages" and not any(k in entry for k in ("face", "body", "hand")):
                    continue
                entry.update({"_from": source, "_q": term})
                entries.append(entry)
                done.write(json.dumps(entry, ensure_ascii=False) + "\n")
                done.flush()
                found[(source, term)] += 1
                kinds = "+".join(k for k in ("face", "body", "hand") if k in entry) or "geral"
                print(f"[{len(entries)}/{args.limit}] {source} {term}: {entry['kind']} {kinds}  {entry['title'][:50]}")
            seen_file.flush()

    # Fica de fora quem ainda está com a impressão de um modelo antigo (imagem que não baixou; rodar de novo tenta outra vez).
    entries = [e for e in entries if e.get("_emb") == EMBED_VERSION and not MEDICAL_WORDS.search(e["title"])]
    print(f"tipo corrigido em {fix_commons_kinds(entries)} imagens da Wikimedia")
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
