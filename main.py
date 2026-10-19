"""
Plantorum — Backend v4.11 (estabilización y medición de tiempos)
- Gemini (principal) + Qwen (respaldo) + modelo local (último recurso).
- Pl@ntNet priorizado para identificación.
- Logs mejorados para depurar fallos.
Ejecutar:
    python main.py
"""

import base64
import io
import json
import os
import re
import time
from pathlib import Path

import numpy as np
import requests
from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageOps


def _post_medido(etiqueta, *args, **kwargs):
    """Ejecuta requests.post y registra el tiempo real de cada intento HTTP."""
    inicio = time.perf_counter()
    try:
        respuesta = requests.post(*args, **kwargs)
        segundos = time.perf_counter() - inicio
        print(f"⏱️ [HTTP {etiqueta}] HTTP {respuesta.status_code} en {segundos:.2f} s")
        return respuesta
    except Exception as exc:
        segundos = time.perf_counter() - inicio
        print(f"⏱️ [HTTP {etiqueta}] {type(exc).__name__} tras {segundos:.2f} s")
        raise


try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    print("✅ Soporte HEIC activado")
except Exception:
    pass


# ============================================================
# CONFIG
# ============================================================

load_dotenv()

BASE = Path(__file__).parent
MODELO_DIR = BASE / "modelo"

PLANTNET_KEY = os.getenv("PLANTNET_API_KEY", "").strip()
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "").strip()
QWEN_KEY = os.getenv("QWEN_API_KEY", "").strip()
QWEN_BASE = os.getenv("QWEN_BASE_URL", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").rstrip("/")
# DashScope usa IDs sin el prefijo "qwen/". Un valor manual en .env tiene prioridad.
QWEN_MODELOS = [m.strip() for m in os.getenv("QWEN_MODELOS", "qwen2.5-vl-72b-instruct").split(",") if m.strip()]
if "dashscope" in QWEN_BASE.lower():
    QWEN_MODELOS = [m.removeprefix("qwen/") for m in QWEN_MODELOS]

# ============================================================
# EJECUTOR GLOBAL DE HILOS (Optimización de CPU en Render)
# ============================================================
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

EXECUTOR = ThreadPoolExecutor(max_workers=4)

MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(10 * 1024 * 1024)))  # 10 MB
STATS_TOKEN = os.getenv("STATS_TOKEN", "").strip()

app = FastAPI(title="Plantorum API", version="4.12")



# PLANTORUM: CUOTA DE COSTE EN EL SERVIDOR
# SQLite en almacenamiento persistente, cookie de dispositivo firmada y huella de IP.
# No se aceptan planes Pro declarados por el navegador.
import sqlite3
import hashlib
import hmac
import secrets
import uuid
import datetime
from zoneinfo import ZoneInfo
from fastapi import Request
from fastapi.responses import JSONResponse
from http.cookies import SimpleCookie
from threading import RLock

QUOTA_DAILY_LIMIT = int(os.getenv("QUOTA_DAILY_LIMIT", "100"))
# Cortafuegos de gasto compartido por todas las IP y dispositivos.
# El límite es de consultas INICIADAS por día; no sustituye registro o CAPTCHA.
QUOTA_GLOBAL_DAILY_LIMIT = int(os.getenv("QUOTA_GLOBAL_DAILY_LIMIT", "300"))
# Límite por IP independiente y más alto: varias personas comparten IP (wifi, datos móviles) y no deben bloquearse entre sí.
QUOTA_IP_LIMIT = max(QUOTA_DAILY_LIMIT, int(os.getenv("QUOTA_IP_LIMIT", "30")))
QUOTA_DB_PATH = Path(os.getenv("QUOTA_DB_PATH", str(BASE / "plantorum_cuotas.sqlite3")))
QUOTA_SECRET_PATH = QUOTA_DB_PATH.with_suffix(".secret")
QUOTA_LOCK = RLock()
QUOTA_COOKIE = "plantorum_device"
QUOTA_TIMEZONE = ZoneInfo(os.getenv("QUOTA_TIMEZONE", "Europe/Madrid"))

def _quota_secret():
    # El secreto se conserva entre reinicios; la carpeta DEBE ser persistente.
    QUOTA_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = os.getenv("QUOTA_SECRET", "").encode()
    if key:
        if len(key) < 32:
            raise RuntimeError("QUOTA_SECRET debe tener al menos 32 caracteres")
        return key
    if QUOTA_SECRET_PATH.exists():
        return QUOTA_SECRET_PATH.read_bytes()
    key = secrets.token_bytes(32)
    try:
        with QUOTA_SECRET_PATH.open("xb") as f:
            f.write(key)
    except FileExistsError:
        key = QUOTA_SECRET_PATH.read_bytes()
    return key

QUOTA_SECRET_KEY = _quota_secret()

def _quota_hash(value):
    return hmac.new(QUOTA_SECRET_KEY, value.encode(), hashlib.sha256).hexdigest()

def _quota_device_cookie():
    device_id = uuid.uuid4().hex
    sig = _quota_hash("device:" + device_id)
    return device_id + "." + sig

def _quota_device_id(raw):
    if not raw or "." not in raw:
        return None
    ident, sig = raw.split(".", 1)
    if len(ident) != 32 or any(c not in "0123456789abcdef" for c in ident):
        return None
    if not hmac.compare_digest(_quota_hash("device:" + ident), sig):
        return None
    return ident

def _quota_init():
    with sqlite3.connect(QUOTA_DB_PATH, timeout=15) as conn:
        conn.execute("PRAGMA busy_timeout=15000")
        conn.execute("CREATE TABLE IF NOT EXISTS daily_quota (day TEXT NOT NULL, kind TEXT NOT NULL, key_hash TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,kind,key_hash))")
        conn.commit()

_quota_init()

def _quota_ip(request):
    # No confiar en X-Forwarded-For sin configurar correctamente el proxy.
    # Configurar --proxy-headers y --forwarded-allow-ips solo para proxies de confianza.
    return request.client.host if request.client else "unknown"

def _quota_reserve(ip, device_id):
    day = datetime.datetime.now(QUOTA_TIMEZONE).strftime("%Y-%m-%d")
    keys = [("ip", _quota_hash("ip:" + ip)), ("device", _quota_hash("device-quota:" + device_id))]
    limites = {"ip": QUOTA_IP_LIMIT, "device": QUOTA_DAILY_LIMIT}
    if QUOTA_GLOBAL_DAILY_LIMIT > 0:
        keys.append(("global", _quota_hash("global:all-users")))
        limites["global"] = QUOTA_GLOBAL_DAILY_LIMIT
    with QUOTA_LOCK:
        with sqlite3.connect(QUOTA_DB_PATH, timeout=15, isolation_level=None) as conn:
            conn.execute("PRAGMA busy_timeout=15000")
            conn.execute("BEGIN IMMEDIATE")
            try:
                counts = []
                for kind, key in keys:
                    row = conn.execute("SELECT used FROM daily_quota WHERE day=? AND kind=? AND key_hash=?", (day, kind, key)).fetchone()
                    counts.append(row[0] if row else 0)
                if any(n >= limites[k] for n, (k, _) in zip(counts, keys)):
                    conn.execute("ROLLBACK")
                    return False, 0
                for kind, key in keys:
                    conn.execute("INSERT INTO daily_quota(day,kind,key_hash,used) VALUES(?,?,?,1) ON CONFLICT(day,kind,key_hash) DO UPDATE SET used=used+1", (day,kind,key))
                conn.execute("COMMIT")
                return True, max(0, min(limites[k] - n for n, (k, _) in zip(counts, keys)) - 1)
            except Exception:
                conn.execute("ROLLBACK")
                raise

def _quota_refund(ip, device_id):
    """Devuelve la consulta cuando la petición falló (422/503...): el usuario no recibió resultado."""
    day = datetime.datetime.now(QUOTA_TIMEZONE).strftime("%Y-%m-%d")
    keys = [("ip", _quota_hash("ip:" + ip)), ("device", _quota_hash("device-quota:" + device_id))]
    # No devolver la cuota global: incluso una respuesta 503 puede haber
    # invocado una API de pago antes de fallar. Es un cortafuegos, no una cuota del usuario.
    try:
        with QUOTA_LOCK:
            with sqlite3.connect(QUOTA_DB_PATH, timeout=15) as conn:
                for kind, key in keys:
                    conn.execute("UPDATE daily_quota SET used=MAX(0,used-1) WHERE day=? AND kind=? AND key_hash=?", (day, kind, key))
                conn.commit()
    except Exception as exc:
        print(f"⚠️ No se pudo devolver la cuota: {type(exc).__name__}")


def _quota_continue_token(img_bytes, ip, device):
    expiry = int(time.time()) + 900
    digest = hashlib.sha256(img_bytes).hexdigest()
    payload = f"{expiry}:{digest}:{_quota_hash('ip:' + ip)}:{_quota_hash('device-quota:' + device)}"
    sig = hmac.new(QUOTA_SECRET_KEY, payload.encode(), hashlib.sha256).hexdigest()
    return f"{expiry}.{digest}.{sig}"

def _quota_redeem(token, img_bytes, ip, device):
    try:
        expiry, digest, sig = token.split('.')
        if int(expiry) < time.time() or int(expiry) > time.time() + 901:
            return False
        if not hmac.compare_digest(digest, hashlib.sha256(img_bytes).hexdigest()):
            return False
        payload = f"{expiry}:{digest}:{_quota_hash('ip:' + ip)}:{_quota_hash('device-quota:' + device)}"
        expected = hmac.new(QUOTA_SECRET_KEY, payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        with QUOTA_LOCK:
            with sqlite3.connect(QUOTA_DB_PATH, timeout=15, isolation_level=None) as conn:
                conn.execute('BEGIN IMMEDIATE')
                conn.execute('CREATE TABLE IF NOT EXISTS used_continuations (signature TEXT PRIMARY KEY, expiry INTEGER NOT NULL)')
                conn.execute('DELETE FROM used_continuations WHERE expiry < ?', (int(time.time()),))
                try:
                    conn.execute('INSERT INTO used_continuations(signature,expiry) VALUES(?,?)', (sig, int(expiry)))
                    conn.execute('COMMIT')
                    return True
                except sqlite3.IntegrityError:
                    conn.execute('ROLLBACK')
                    return False
    except Exception:
        return False

@app.middleware("http")
async def proteger_cuotas(request: Request, call_next):
    if request.method != "POST" or request.url.path not in ("/identificar", "/analizar", "/informe"):
        return await call_next(request)
    raw = request.cookies.get(QUOTA_COOKIE)
    ident = _quota_device_id(raw)
    fresh = not ident
    if fresh:
        raw = _quota_device_cookie()
        ident = raw.split(".", 1)[0]
    request.state.quota_device_id = ident
    # La continuación se verifica DENTRO de /analizar, con el UploadFile ya leído.
    # No se toca request.body()/request.form() en el middleware: evita agotar streams.
    # Una cabecera falsa recibe un 403 sin invocar APIs ni gastar cuota.
    if request.url.path == "/analizar" and request.headers.get("X-Plantorum-Continuation"):
        response = await call_next(request)
        if fresh:
            response.set_cookie(QUOTA_COOKIE, raw, max_age=365*86400, httponly=True,
                                secure=request.url.scheme == "https", samesite="lax", path="/")
        return response
    try:
        permitido, restantes = _quota_reserve(_quota_ip(request), ident)
    except Exception as exc:
        # Registrar el error real en la consola sin revelar datos privados al navegador.
        import traceback
        print(f"❌ [CUOTAS SQLITE] {type(exc).__name__}: {exc}", flush=True)
        print(f"📁 [CUOTAS SQLITE] Base de datos: {QUOTA_DB_PATH}", flush=True)
        traceback.print_exc()
        # Fail closed: nunca permitir consultas costosas sin registrar la cuota.
        return JSONResponse(status_code=503, content={"detail":"El control de consultas no está disponible. Revisa la consola del servidor."})
    if not permitido:
        response = JSONResponse(status_code=429, content={"detail":f"Has alcanzado el límite de {QUOTA_DAILY_LIMIT} consultas gratuitas de hoy. Vuelve mañana."})
    else:
        response = await call_next(request)
        if response.status_code >= 400:
            _quota_refund(_quota_ip(request), ident)
            restantes += 1
    response.headers["X-Plantorum-Quota-Remaining"] = str(restantes)
    if fresh:
        response.set_cookie(QUOTA_COOKIE, raw, max_age=365*86400, httponly=True, secure=request.url.scheme=="https", samesite="lax", path="/")
    return response

@app.middleware("http")
async def cabeceras_seguridad(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), payment=()"
    # CSP estricta pendiente: el HTML actual tiene muchos onclick e imágenes data:.
    return response

@app.middleware("http")
async def medir_tiempo_peticion(request, call_next):
    """Mide duración total de cada petición HTTP, especialmente /analizar."""
    inicio = time.perf_counter()
    try:
        return await call_next(request)
    finally:
        segundos = time.perf_counter() - inicio
        if request.url.path == "/analizar":
            print(f"⏱️ [Plantorum TOTAL] {request.method} {request.url.path} en {segundos:.2f} s")
        elif request.url.path not in ("/", "/favicon.ico"):
            print(f"⏱️ [HTTP TOTAL] {request.method} {request.url.path} en {segundos:.2f} s")

# La interfaz se sirve desde el mismo backend. Si se necesita CORS externo,
# definir CORS_ALLOWED_ORIGINS como una lista separada por comas.
CORS_ALLOWED_ORIGINS = [x.strip() for x in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if x.strip()]
if CORS_ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ALLOWED_ORIGINS,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-Stats-Token"],
    )


# ============================================================
# CONOCIMIENTO: NOMBRES COMUNES
# ============================================================

NOMBRES_COMUNES = {
    "plectranthus verticillatus": "Planta del dinero",
    "epipremnum aureum": "Potos / Pothos",
    "monstera deliciosa": "Monstera",
    "monstera adansonii": "Monstera adansonii",
    "rhaphidophora tetrasperma": "Mini monstera",
    "ficus benjamina": "Ficus benjamina",
    "ficus lyrata": "Higuera hoja de violín",
    "dracaena trifasciata": "Lengua de suegra",
    "sansevieria trifasciata": "Lengua de suegra",
    "spathiphyllum wallisii": "Espatifilo / Cuna de Moisés",
    "aloe vera": "Aloe vera",
    "lavandula angustifolia": "Lavanda",
    "lavandula": "Lavanda",
    "olea europaea": "Olivo",
    "vitis vinifera": "Vid",
    "citrus sinensis": "Naranjo dulce",
    "citrus limon": "Limonero",
    "citrus × aurantium": "Naranjo amargo",
    "citrus aurantium": "Naranjo amargo",
    "prunus dulcis": "Almendro",
    "nerium oleander": "Adelfa",
    "solanum lycopersicum": "Tomate",
    "solanum tuberosum": "Patata",
    "fragaria": "Fresa",
    "persea americana": "Aguacate",
    "coffea arabica": "Cafeto",
    "musa": "Platanera",
    "rosa": "Rosal",
    "dionaea muscipula": "Venus atrapamoscas",
    "trachelospermum jasminoides": "Falso jazmín / Jazmín estrella",
    "jasminum": "Jazmín",
    "chassalia corallioides": "Arbusto coral",
    "quercus suber": "Alcornoque",
    "quercus ilex": "Encina",
    "quercus robur": "Roble",
    "pinus": "Pino",
    "arbutus unedo": "Madroño",
    "laurus nobilis": "Laurel",
}


def normalizar_nombre_cientifico(nombre):
    if not nombre:
        return ""
    n = nombre.lower().strip().split(" (")[0].strip()
    partes = n.split()
    if len(partes) >= 3 and partes[1] == "×":
        return " ".join(partes[:3])
    if len(partes) >= 2:
        return " ".join(partes[:2])
    return n


def nombre_comun_es(cientifico):
    if not cientifico:
        return None
    base = normalizar_nombre_cientifico(cientifico)
    if base in NOMBRES_COMUNES:
        return NOMBRES_COMUNES[base]
    genero = base.split()[0] if base else ""
    return NOMBRES_COMUNES.get(genero)


# ============================================================
# CONOCIMIENTO: CULTIVOS
# ============================================================

CULTIVOS = {
    "solanum lycopersicum": "tomate", "solanum tuberosum": "patata",
    "malus": "manzano", "vitis": "vid", "fragaria": "fresa", "citrus": "citricos",
}

PREFIJO_CULTIVO = {
    "Tomato": "tomate", "Potato": "patata", "Apple": "manzano",
    "Grape": "vid", "Strawberry": "fresa", "Orange": "citricos",
}

CLASE_LOCAL_A_CULTIVO = {
    "tomate": "tomate", "vid": "vid", "fresa": "fresa",
    "naranjo": "citricos", "limonero": "citricos",
}


# ============================================================
# CONOCIMIENTO: FICHAS DE CUIDADO
# ============================================================

PERFILES_CUIDADO = [
    {
        "claves": ("lavandula", "lavanda", "rosmarinus", "romero", "thymus", "tomillo", "salvia"),
        "grupo": "Aromática mediterránea",
        "riego": "Escaso: deja secar el sustrato entre riegos",
        "luz": "Pleno sol",
        "tipico": "Exceso de riego y humedad en raíces",
        "consejo_sintomas": "En aromáticas mediterráneas, muchas manchas o decaimiento vienen de exceso de riego o mal drenaje.",
    },
    {
        "claves": (
            "monstera", "epipremnum", "pothos", "potos", "philodendron",
            "spathiphyllum", "espatifilo", "ficus", "syngonium",
            "chlorophytum", "cinta", "plectranthus",
        ),
        "grupo": "Tropical de interior",
        "riego": "Moderado: riega cuando los primeros 2-3 cm del sustrato estén secos",
        "luz": "Luz brillante indirecta",
        "tipico": "Puntas marrones por aire seco, riego irregular o exceso de agua",
        "consejo_sintomas": "En tropicales, revisa riego, humedad ambiental, corrientes de aire y limpia el polvo de las hojas.",
    },
    {
        "claves": ("trachelospermum", "jasminoides", "jasminum", "jazmin", "jazmín"),
        "grupo": "Jazmín / enredadera ornamental",
        "riego": "Moderado, evitando encharcar",
        "luz": "Sol suave o semisombra luminosa",
        "tipico": "Hongos foliares, cochinilla, araña roja y estrés por riego",
        "consejo_sintomas": "En jazmines, las manchas suelen relacionarse con hongos o estrés. Retira hojas afectadas.",
    },
    {
        "claves": (
            "sansevieria", "trifasciata", "dracaena trifasciata",
            "lengua de suegra", "aloe", "crassula", "echeveria",
            "sedum", "opuntia", "cact", "zamioculcas",
        ),
        "grupo": "Suculenta / cactácea",
        "riego": "Muy escaso: solo cuando el sustrato esté totalmente seco",
        "luz": "Mucha luz, incluso sol directo progresivo",
        "tipico": "Pudrición por exceso de riego",
        "consejo_sintomas": "En suculentas, hojas blandas o translúcidas suelen indicar exceso de agua.",
    },
    {
        "claves": ("citrus", "naranjo", "limonero", "aurantium", "sinensis", "limon"),
        "grupo": "Cítrico",
        "riego": "Regular sin encharcar",
        "luz": "Pleno sol",
        "tipico": "Clorosis férrica, cochinilla, minador y hongos foliares",
        "consejo_sintomas": "En cítricos, el amarilleo suele ser carencia o riego irregular.",
    },
    {
        "claves": ("olea", "olivo"),
        "grupo": "Olivo", "riego": "Escaso una vez establecido", "luz": "Pleno sol",
        "tipico": "Repilo y problemas por humedad excesiva",
        "consejo_sintomas": "En olivo, manchas circulares o plateadas pueden ser repilo.",
    },
    {
        "claves": ("vitis", "vid"),
        "grupo": "Vid", "riego": "Escaso; sensible al encharcamiento", "luz": "Pleno sol",
        "tipico": "Mildiu, oídio y botritis",
        "consejo_sintomas": "En vid, revisa el envés: mildiu suele dar vellosidad blanca.",
    },
    {
        "claves": ("rosa", "rosal"),
        "grupo": "Rosal", "riego": "Regular al pie, sin mojar hojas",
        "luz": "Pleno sol con buena ventilación",
        "tipico": "Mancha negra, oídio, roya y pulgón",
        "consejo_sintomas": "En rosales, manchas negras y amarilleo suelen indicar mancha negra.",
    },
    {
        "claves": ("quercus", "alcornoque", "encina", "roble", "castanea", "castaño", "fagus", "haya"),
        "grupo": "Fagácea / árbol mediterráneo",
        "riego": "Normalmente no necesita riego una vez establecido",
        "luz": "Pleno sol o semisombra",
        "tipico": "Estrés hídrico, suelo compactado, hongos de raíz",
        "consejo_sintomas": "En quercus, vigila sequía prolongada o encharcamiento.",
    },
    {
        "claves": ("pinus", "pino", "abies", "abeto", "cedrus", "cedro", "picea"),
        "grupo": "Conífera", "riego": "Escaso una vez establecida", "luz": "Pleno sol",
        "tipico": "Procesionaria, hongos y estrés por sequía",
        "consejo_sintomas": "En coníferas, revisa acículas marrones o bolsones blancos.",
    },
    {
        "claves": ("arbutus", "madroño", "erica", "brezo", "calluna", "azalea", "rhododendron"),
        "grupo": "Acidófila / ericácea",
        "riego": "Moderado, con suelo ácido y drenante", "luz": "Semisombra a sol suave",
        "tipico": "Clorosis por agua o suelo calizo",
        "consejo_sintomas": "En acidófilas, hojas amarillas con nervios verdes suelen indicar pH alto.",
    },
    {
        "claves": ("laurus", "laurel", "persea", "aguacate"),
        "grupo": "Laurácea", "riego": "Moderado sin encharcar", "luz": "Sol suave o luz brillante",
        "tipico": "Pudrición de raíz por exceso de agua",
        "consejo_sintomas": "En lauráceas, hojas mustias con sustrato húmedo pueden indicar raíces dañadas.",
    },
    {
        "claves": ("prunus", "almendro", "cerezo", "ciruelo", "melocotonero", "durazno"),
        "grupo": "Rosácea / frutal de hueso",
        "riego": "Moderado, sin encharcar", "luz": "Pleno sol",
        "tipico": "Cribado, monilia, pulgón y hongos foliares",
        "consejo_sintomas": "En prunus, agujeros o manchas rojizas pueden ser cribado.",
    },
    {
        "claves": ("nerium", "adelfa"),
        "grupo": "Apocinácea / arbusto ornamental",
        "riego": "Moderado, tolera sequía una vez establecida",
        "luz": "Pleno sol",
        "tipico": "Cochinilla, pulgón y hongos foliares",
        "consejo_sintomas": "En adelfas, revisa el envés por cochinilla y evita mojar las hojas al regar.",
    },
]


def perfil_de(textos):
    for t in textos:
        if not t: continue
        tx = t.lower()
        for p in PERFILES_CUIDADO:
            if any(k in tx for k in p["claves"]):
                return p
    return None


# ============================================================
# CARGA DE MODELOS ONNX
# ============================================================

def cargar_onnx(nombre):
    try:
        import onnxruntime as ort
        sesion = ort.InferenceSession(str(MODELO_DIR / nombre))
        print(f"✅ Cargado {nombre}")
        return sesion
    except Exception as e:
        print(f"⚠️ No se cargó {nombre} ({type(e).__name__}: {e})")
        return None


SESION_LOCAL = cargar_onnx("modelo_florascan.onnx")
SESION_SALUD = cargar_onnx("modelo_salud.onnx")
SESION_ANOMALIA = cargar_onnx("modelo_anomalia_v2.onnx")

MAPEO_LOCAL = {}
try:
    m = json.loads((MODELO_DIR / "mapeo_clases.json").read_text(encoding="utf-8"))
    MAPEO_LOCAL = {v: k for k, v in m.items()}
    print("✅ Cargado mapeo_clases.json")
except Exception as e:
    print(f"⚠️ No se cargó mapeo_clases.json: {e}")

MAPEO_SALUD = {}
try:
    MAPEO_SALUD = json.loads((MODELO_DIR / "mapeo_salud.json").read_text(encoding="utf-8"))
    print("✅ Cargado mapeo_salud.json")
except Exception as e:
    print(f"⚠️ No se cargó mapeo_salud.json: {e}")


def preproceso_onnx(img):
    arr = np.asarray(img.convert("RGB").resize((224, 224)), dtype=np.float32) / 255.0
    return np.expand_dims(arr, axis=0)


def correr(sesion, img):
    if sesion is None: return None
    entrada = sesion.get_inputs()[0].name
    return sesion.run(None, {entrada: preproceso_onnx(img)})[0][0]


def identificar_local(img, top_k=3):
    probs = correr(SESION_LOCAL, img)
    if probs is None: return []
    idx = np.argsort(probs)[::-1][:top_k]
    return [{"clase": MAPEO_LOCAL.get(int(i), "?"), "confianza": round(float(probs[i]), 3)} for i in idx]


# ============================================================
# PL@NTNET
# ============================================================

def identificar_plantnet(img_bytes):
    if not PLANTNET_KEY:
        print("⚠️ [PLANTNET V103] sin clave configurada: se activará respaldo")
        return []
    try:
        r = _post_medido("Pl@ntNet identificación",
            "https://my-api.plantnet.org/v2/identify/all",
            params={"api-key": PLANTNET_KEY, "lang": "es"},
            files={"images": ("foto.jpg", img_bytes, "image/jpeg")},
            timeout=float(os.getenv("PLANTNET_TIMEOUT", "8")),
        )
        r.raise_for_status()
        out = []
        for res in r.json().get("results", [])[:3]:
            sp = res.get("species", {}) or {}
            sci = (sp.get("scientificName") or "").strip() or None
            comun = (sp.get("commonName") or nombre_comun_es(sci) or "").strip() or None
            # No aceptar resultados sin nombre de especie, aunque tengan score.
            if not sci and not comun:
                continue
            out.append({
                "nombre_cientifico": sci,
                "nombre_comun": comun,
                "confianza": round(float(res.get("score", 0)), 3),
            })
        if out:
            print(f"🌿 [PLANTNET V103] especie={out[0]['nombre_cientifico']!r} | común={out[0]['nombre_comun']!r} | confianza={out[0]['confianza']:.3f} | candidatos={len(out)}")
        else:
            print("🌿 [PLANTNET V103] sin especies válidas en la respuesta")
        return out
    except Exception as e:
        print(f"⚠️ [PLANTNET V103] fallo={type(e).__name__}: {e}")
        return []


def elegir_especie(plantnet, local):
    """
    Prioriza Pl@ntNet si tiene confianza >= 0.40.
    Si no, usa modelo local solo si tiene confianza >= 0.60.
    """
    textos = []
    
    # Pl@ntNet con alta confianza manda
    if plantnet and plantnet[0].get("confianza", 0) >= 0.40:
        textos.append(plantnet[0].get("nombre_cientifico"))
        textos.append(plantnet[0].get("nombre_comun"))
        print(f"✅ Especie elegida: Pl@ntNet ({plantnet[0]['nombre_comun']})")
        return "plantnet", textos
    
    # Modelo local solo si tiene alta confianza
    if local and local[0].get("confianza", 0) >= 0.60:
        textos.append(local[0].get("clase"))
        print(f"✅ Especie elegida: Local ({local[0]['clase']})")
        return "local", textos
    
    # Si no hay confianza suficiente, no presentar una especie como segura.
    if plantnet and (plantnet[0].get("nombre_cientifico") or plantnet[0].get("nombre_comun")):
        textos.extend(x for x in (plantnet[0].get("nombre_cientifico"), plantnet[0].get("nombre_comun")) if x)
        print(f"⚠️ Especie candidata de Pl@ntNet con baja confianza: {plantnet[0].get('nombre_comun') or plantnet[0].get('nombre_cientifico')}")
        return "plantnet_baja_confianza", textos
    
    # No usar la predicción local de baja confianza como identificación definitiva.
    if local:
        print(f"⚠️ Modelo local sin confianza suficiente ({local[0].get('clase')})")
    
    print("⚠️ No se pudo identificar especie")
    return "ninguna", textos


def detectar_cultivo(plantnet, local):
    if plantnet:
        sci = (plantnet[0].get("nombre_cientifico") or "").lower()
        for clave, cultivo in CULTIVOS.items():
            if clave in sci: return cultivo
    if local:
        return CLASE_LOCAL_A_CULTIVO.get(local[0].get("clase"))
    return None


# ============================================================
# UTILIDADES COMPARTIDAS
# ============================================================

def imagen_a_jpeg_bytes(img, max_px=1280):
    im = img.convert("RGB")
    w, h = im.size
    escala = min(1.0, max_px / max(w, h))
    if escala < 1.0:
        im = im.resize((int(w * escala), int(h * escala)))
    bio = io.BytesIO()
    im.save(bio, format="JPEG", quality=88)
    return bio.getvalue()


def extraer_json(texto):
    texto = texto.strip().replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(texto)
    except Exception:
        pass
    match = re.search(r"\{.*\}", texto, re.DOTALL)
    base = match.group(0) if match else texto
    sufijos = ["", "}", "]}", "\"}", "\"]}", "\"}]}", "]}}", "\"]}}", "\",\"tratamiento\":[],\"prevencion\":[]}"]
    for suf in sufijos:
        try:
            return json.loads(base + suf)
        except Exception:
            continue
    raise ValueError("No se encontró JSON válido en la respuesta")


def normalizar_estado(estado):
    e = (estado or "").lower().strip()
    if e in ("saludable", "sano", "sana", "ok"): return "saludable"
    if e in ("critico", "crítico", "grave", "severo"): return "critico"
    if e in ("atencion", "atención", "moderado", "leve", "enfermo", "enferma"): return "atencion"
    return "atencion"

MODO_PRUEBA_QWEN = False   # ⚠️ Ponla en False cuando termines de probar


PROMPT_DIAGNOSTICO = """Actúa como fitopatólogo experto pero escribe como un divulgador: lenguaje cotidiano que entienda cualquier persona sin conocimientos de jardinería
- Evita palabras técnicas; si una es imprescindible, explícala entre paréntesis con palabras simples (ejemplo: "sustrato (la tierra de la maceta)", "acaricida (producto contra las arañas rojas)", "necrosis (tejido muerto y seco)")
- Frases cortas, claras y cercanas, como se lo explicarías a un amigo: di qué hacer, con qué y cada cuánto.{contexto}

Devuelve exactamente:
{{
  "especie": "nombre común o 'no identificada'",
  "estado": "saludable" | "atencion" | "critico",
  "confianza": 0.0,
  "patogeno": "plaga o patógeno detectado o null",
  "sintomas": ["máximo 3 síntomas visibles"],
  "diagnostico": "qué le pasa en 1 frase",
  "tratamiento": ["máximo 3 pasos concretos"],
  "prevencion": ["1 medida preventiva"],
  "luz": "necesidad de luz de la especie en 3-6 palabras",
  "riego": "frecuencia de riego de la especie en 3-8 palabras",
  "guia": {{
    "diagnostico_detallado": "párrafo de 3-4 frases: qué le pasa, causa probable, gravedad",
    "aislamiento": "instrucciones de aislamiento respecto a otras plantas",
    "pasos": ["5 a 7 pasos concretos y accionables para curar la planta, en orden"],
    "productos": ["productos o remedios caseros con dosis y frecuencia de aplicación"],
    "riego": "cómo ajustar el riego durante la recuperación",
    "luz_sustrato": "ajustes de luz, sustrato y abonado durante la recuperación",
    "plazo": "semanas estimadas de recuperación y señales de mejoría a vigilar",
    "prevencion": "cómo evitar que el problema reaparezca"
  }}
}}

Reglas:
- Si NO ves síntomas: estado="saludable", sintomas=[], tratamiento=[], guia limitada a rutina de cuidados y prevención en 3 líneas
- Si ves manchas, amarilleo, polvo blanco o necrosis: NO digas saludable, desarrolla la guía completa de recuperación
- Usa "posible / compatible con" si no hay certeza
- "luz" y "riego" SIEMPRE rellenos según la especie identificada
- Actúa como fitopatólogo y jardinero experto: la guía debe ser un plan de recuperación real, paso a paso, en español, con cantidades, frecuencias y productos concretos
- Español, conciso, sin markdown"""


def construir_resultado(resultado, especie_contexto, modelo_nombre):
    estado = normalizar_estado(resultado.get("estado"))
    sintomas = resultado.get("sintomas") or []
    tratamiento = resultado.get("tratamiento") or []
    prevencion = resultado.get("prevencion") or []
    if not isinstance(sintomas, list): sintomas = [str(sintomas)]
    if not isinstance(tratamiento, list): tratamiento = [str(tratamiento)]
    if not isinstance(prevencion, list): prevencion = [str(prevencion)]
    try:
        confianza = max(0.0, min(1.0, float(resultado.get("confianza", 0.7))))
    except Exception:
        confianza = 0.7
    return {
        "especie": resultado.get("especie") or especie_contexto or "no identificada",
        "estado": estado, "confianza": confianza,
        "patogeno": resultado.get("patogeno") or "",
        "sintomas": sintomas,
        "diagnostico": resultado.get("diagnostico") or "",
        "tratamiento": tratamiento, "prevencion": prevencion,
        "guia": resultado.get("guia") or {},
        "modelo": modelo_nombre,
    }


def texto_libre_como_respaldo(texto, especie_contexto, modelo_nombre):
    """Si no hay JSON, usa el texto crudo como diagnóstico."""
    if not texto or len(texto) < 30:
        return None
    if texto.lstrip().startswith("{"):
        return None
    return {
        "especie": especie_contexto or "no identificada",
        "estado": "atencion", "confianza": 0.5,
        "patogeno": "",
        "sintomas": [],
        "diagnostico": texto,
        "tratamiento": [], "prevencion": [],
        "guia": {},
        "modelo": modelo_nombre,
    }


# ============================================================
# GEMINI (principal)
# ============================================================

# Gemini 3.8 y 3.6 están documentados y ya han respondido en esta app.
# 3.5 se ha retirado como nombre de endpoint; no reintroducirlo como fallback.
MODELOS_GEMINI = [m.strip() for m in os.getenv("GEMINI_MODELOS", "gemini-3.8-flash,gemini-3.6-flash").split(",") if m.strip()]


def _texto_de_respuesta_gemini(r):
    data = r.json()
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts).strip()


def _registrar_uso_gemini(r, modelo, tipo):
    """Registra tokens de entrada/salida devueltos por la API, sin otra llamada."""
    try:
        data = r.json()
        uso = data.get("usageMetadata") or data.get("usage_metadata") or {}
        entrada = uso.get("promptTokenCount", uso.get("prompt_token_count"))
        salida = uso.get("candidatesTokenCount", uso.get("candidates_token_count"))
        pensamiento = uso.get("thoughtsTokenCount", uso.get("thoughts_token_count", 0)) or 0
        total = uso.get("totalTokenCount", uso.get("total_token_count"))
        if entrada is None and salida is None:
            print(f"💰 [TOKENS {tipo}] modelo={modelo}: la respuesta no incluye usageMetadata")
            return

        # Precios estándar de la API, USD por millón de tokens. Para Gemini 3.8/3.6
        # se aplica el precio introductorio vigente hasta el 31-12-2026.
        # Los tokens de pensamiento se suman a la salida facturable.
        if modelo in ("gemini-3.8-flash", "gemini-3.6-flash"):
            precio_entrada, precio_salida = 0.75, 3.75
        elif modelo == "gemini-3.5-flash":
            precio_entrada, precio_salida = 1.50, 9.00
        else:
            precio_entrada = precio_salida = None

        coste = None
        if precio_entrada is not None:
            coste = ((entrada or 0) * precio_entrada + ((salida or 0) + pensamiento) * precio_salida) / 1_000_000

        linea = (
            f"💰 [TOKENS {tipo}] modelo={modelo} | entrada={entrada or 0} | "
            f"salida={salida or 0} | pensamiento={pensamiento} | "
            f"total={total if total is not None else (entrada or 0) + (salida or 0) + pensamiento}"
        )
        if coste is not None:
            linea += f" | coste_estimado=${coste:.8f} USD (tarifa API de pago, sin descuentos)"
        else:
            linea += " | coste_estimado=no configurado para este modelo"
        print(linea)
    except Exception as exc:
        print(f"⚠️ No se pudieron leer tokens de Gemini ({tipo}, {modelo}): {type(exc).__name__}")


def _pedir_texto_gemini(modelo, prompt, img_b64, forzar_json, tipo="Gemini"):

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"
    partes = [
        {"text": prompt},
        {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}},
    ]
    cfg = {"temperature": 0.2, "topP": 0.8, "maxOutputTokens": 4096}
    if forzar_json:
        cfg["response_mime_type"] = "application/json"
    try:
        r = _post_medido(f"Gemini {modelo} intento 1",
            url, headers={"x-goog-api-key": GEMINI_KEY},
            json={"contents": [{"parts": partes}], "generationConfig": cfg},
            timeout=20,
        )
        if r.status_code == 404:
            print(f"⚠️ Gemini modelo no disponible: {modelo}")
            return "no_modelo"
        if r.status_code in (429, 503):
            print(f"⚠️ Gemini ({modelo}): {r.status_code} — reintentando en 2 s")
            time.sleep(2)
            r = _post_medido(f"Gemini {modelo} reintento",
                url, headers={"x-goog-api-key": GEMINI_KEY},
                json={"contents": [{"parts": partes}], "generationConfig": cfg},
                timeout=20,
            )
        r.raise_for_status()
        _registrar_uso_gemini(r, modelo, tipo)
        return _texto_de_respuesta_gemini(r)
    except requests.HTTPError as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        print(f"⚠️ Gemini ({modelo}): HTTP {code}")
        return None
    except Exception as e:
        print(f"⚠️ Gemini ({modelo}): {type(e).__name__}: {e}")
        return None


def diagnostico_gemini(img, especie_contexto=None):
    if not GEMINI_KEY:
        print("⚠️ GEMINI_API_KEY no configurada")
        return None
    contexto = f"\nIdentificación botánica probable: {especie_contexto}." if especie_contexto else ""
    prompt = PROMPT_DIAGNOSTICO.format(contexto=contexto)
    img_bytes = imagen_a_jpeg_bytes(img)
    img_b64 = base64.b64encode(img_bytes).decode("utf-8")

    for modelo in MODELOS_GEMINI:
        texto = _pedir_texto_gemini(modelo, prompt, img_b64, forzar_json=True, tipo="DIAGNOSTICO")
        if texto == "no_modelo" or texto is None:
            continue
        resultado = None
        try:
            resultado = extraer_json(texto)
        except ValueError:
            print(f"⚠️ Gemini ({modelo}): JSON inválido. Texto: {texto[:150]!r}")
            texto2 = _pedir_texto_gemini(modelo, prompt, img_b64, forzar_json=False, tipo="DIAGNOSTICO_REINTENTO")
            if texto2 and texto2 != "no_modelo":
                try:
                    resultado = extraer_json(texto2)
                except ValueError:
                    resp = texto_libre_como_respaldo(texto2, especie_contexto, modelo)
                    if resp:
                        print(f"✅ Gemini ({modelo}): usando texto libre")
                        return resp
        if resultado is None:
            continue
        print(f"✅ Gemini respondió con {modelo}")
        return construir_resultado(resultado, especie_contexto, modelo)

    print("⚠️ Ningún modelo de Gemini funcionó")
    return None


def diagnostico_gemini_unificado(img, limite=None):
    """Una petición Gemini por modelo: validación estricta + diagnóstico.

    Devuelve ("ok", diagnóstico), ("no_planta", None) o
    ("indeterminado", None). Nunca interpreta errores como plantas.
    """
    if not GEMINI_KEY:
        return "error", None

    prompt = PROMPT_DIAGNOSTICO.format(contexto="") + """

CONTROL BOTÁNICO OBLIGATORIO, EN ESTA MISMA RESPUESTA:
Añade al JSON los campos:
"es_planta": true o false,
"confianza_planta": número entre 0 y 1,
"sujeto_principal": "planta", "persona", "vehículo", "animal", "objeto" u "otro",
"evidencia_vegetal": "hojas/tallos/flores reales visibles" o "ninguna".

Antes de diagnosticar comprueba visualmente el sujeto principal.
- Si NO es una planta REAL como sujeto principal, devuelve SOLAMENTE:
  {"es_planta":false,"confianza_planta":1.0,"sujeto_principal":"objeto",
   "evidencia_vegetal":"ninguna"}. Adapta sujeto_principal al objeto real.
- Si no puedes determinarlo con seguridad, devuelve:
  {"es_planta":false,"confianza_planta":0.0,"sujeto_principal":"otro",
   "evidencia_vegetal":"ninguna"}.
- Si es una planta real como sujeto principal, devuelve es_planta=true,
  sujeto_principal="planta", confianza_planta >= 0.70 cuando estés razonablemente seguro,
  evidencia_vegetal describiendo estructuras realmente visibles,
  y TODOS los campos de diagnóstico y guía indicados anteriormente.
- No confundas personas, coches, animales, ilustraciones, plantas artificiales
  ni vegetación secundaria de fondo con una planta real como sujeto principal.
- No inventes evidencia ni síntomas. Devuelve SOLO un objeto JSON válido.
"""
    img_b64 = base64.b64encode(imagen_a_jpeg_bytes(img, max_px=1024)).decode("utf-8")
    for modelo in MODELOS_GEMINI:
        if limite is not None and time.monotonic() > limite:
            print("⏱️ [V105] Plazo agotado: no se prueban más modelos")
            break
        texto = _pedir_texto_gemini(modelo, prompt, img_b64, forzar_json=True, tipo="DIAGNOSTICO_UNIFICADO_V105")
        if not texto or texto == "no_modelo":
            continue
        try:
            data = extraer_json(texto)
            if not isinstance(data, dict) or type(data.get("es_planta")) is not bool:
                print("⚠️ [V105] Respuesta sin es_planta booleano; no se autoriza diagnóstico")
                continue
            sujeto = str(data.get("sujeto_principal") or "").strip().lower()
            evidencia = str(data.get("evidencia_vegetal") or "").strip().lower()
            confianza = float(data.get("confianza_planta", 0))
            if data["es_planta"] is False:
                if confianza >= 0.85 and sujeto in {"persona", "vehículo", "vehiculo", "animal", "objeto", "otro"}:
                    print(f"🚫 [V105] Imagen rechazada: sujeto={sujeto}")
                    return "no_planta", None
                print("⚠️ [V105] Imagen ambigua: no se autoriza diagnóstico")
                return "indeterminado", None
            evidencia_valida = bool(evidencia) and evidencia not in {
                "ninguna", "no hay", "ninguna visible", "no se observa", "no hay evidencia"
            }
            campos_validos = (
                str(data.get("estado") or "").lower() in {"saludable", "atencion", "atención", "critico", "crítico"}
                and bool(str(data.get("diagnostico") or "").strip())
                and isinstance(data.get("guia"), dict)
            )
            if not (sujeto == "planta" and confianza >= 0.70 and evidencia_valida and campos_validos):
                print(f"⚠️ [V105] Evidencia o diagnóstico insuficiente: sujeto={sujeto}, confianza={confianza}")
                return "indeterminado", None
            print(f"✅ [V105] Validación y diagnóstico en una consulta con {modelo}")
            return "ok", construir_resultado(data, None, modelo)
        except (ValueError, TypeError, AttributeError) as exc:
            print(f"⚠️ [V105] Respuesta inválida: {type(exc).__name__}: {exc}")
    return "error", None      # ningún modelo dio una respuesta utilizable (caída, cuota, JSON roto)


# ============================================================
# QWEN (RESPALDO)
# ============================================================

def diagnostico_qwen(img, especie_contexto=None):
    """Se ejecuta solo si Gemini falla."""
    if not QWEN_KEY:
        print("⚠️ QWEN_API_KEY no configurada (respaldo desactivado)")
        return None
    if not QWEN_MODELOS:
        print("⚠️ No hay modelos Qwen configurados")
        return None

    print(f"🔄 Intentando Qwen como respaldo...")
    contexto = f"\nIdentificación botánica probable: {especie_contexto}." if especie_contexto else ""
    prompt = PROMPT_DIAGNOSTICO.format(contexto=contexto)
    img_bytes = imagen_a_jpeg_bytes(img)
    img_b64 = base64.b64encode(img_bytes).decode("utf-8")
    data_uri = f"data:image/jpeg;base64,{img_b64}"

    for modelo in QWEN_MODELOS:
        try:
            print(f"🔄 Llamando a Qwen ({modelo})...")
            r = _post_medido(f"Qwen {modelo} intento 1",
                f"{QWEN_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {QWEN_KEY}", "Content-Type": "application/json"},
                json={
                    "model": modelo,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": data_uri}},
                        ],
                    }],
                    "temperature": 0.2,
                    "max_tokens": 2048,
                },
                timeout=10,
            )

            print(f"📡 Qwen ({modelo}): Status {r.status_code}")

            if r.status_code == 404:
                print(f"⚠️ Qwen modelo no disponible: {modelo}")
                continue
            if r.status_code in (429, 503):
                print(f"⚠️ Qwen ({modelo}): {r.status_code} — reintentando en 2 s")
                time.sleep(2)
                r = _post_medido(f"Qwen {modelo} reintento",
                    f"{QWEN_BASE}/chat/completions",
                    headers={"Authorization": f"Bearer {QWEN_KEY}", "Content-Type": "application/json"},
                    json={
                        "model": modelo,
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": data_uri}},
                            ],
                        }],
                        "temperature": 0.2,
                        "max_tokens": 2048,
                    },
                    timeout=15,
                )
                print(f"📡 Qwen ({modelo}) retry: Status {r.status_code}")
            
            r.raise_for_status()

            data = r.json()
            contenido = data["choices"][0]["message"]["content"]
            if isinstance(contenido, list):
                texto = "".join(p.get("text", "") for p in contenido).strip()
            else:
                texto = str(contenido).strip()

            print(f"📝 Qwen ({modelo}): Respuesta recibida ({len(texto)} chars)")

            try:
                resultado = extraer_json(texto)
                print(f"✅ Qwen respondió con {modelo}")
                return construir_resultado(resultado, especie_contexto, modelo)
            except ValueError as e:
                print(f"⚠️ Qwen ({modelo}): JSON inválido - {e}. Texto: {texto[:150]!r}")
                resp = texto_libre_como_respaldo(texto, especie_contexto, modelo)
                if resp:
                    print(f"✅ Qwen ({modelo}): usando texto libre")
                    return resp

        except requests.HTTPError as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            response_text = getattr(getattr(e, "response", None), "text", "")
            print(f"⚠️ Qwen ({modelo}): HTTP {code} - {response_text[:200]}")
            continue
        except Exception as e:
            print(f"⚠️ Qwen ({modelo}): {type(e).__name__}: {e}")
            continue

    print("⚠️ Ningún modelo de Qwen funcionó")
    return None


# ============================================================
# FALLBACK LOCAL DE SALUD
# ============================================================

def analizar_salud_local(img, cultivo=None, perfil=None):
    hsv = np.asarray(img.convert("HSV"), dtype=np.int32)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    vegetacion = (S > 40) & (V > 40) & (H >= 12) & (H <= 105)
    total = vegetacion.sum() or 1
    verde = ((H >= 45) & (H <= 105) & vegetacion).sum() / total
    amarillo = ((H >= 30) & (H < 45) & vegetacion).sum() / total
    marron = ((H >= 12) & (H < 30) & vegetacion).sum() / total

    sintomas = []
    recs = []
    score = 100
    if amarillo > 0.45:
        score -= 20
        sintomas.append("Amarilleo visible en parte importante de la planta")
        recs.append("Revisa exceso o falta de riego y considera aporte de nutrientes si procede.")
    if marron > 0.35:
        score -= 20
        sintomas.append("Zonas marrones o secas visibles")
        recs.append("Retira partes muy dañadas y revisa estrés hídrico, sol directo o raíces.")
    if verde < 0.35:
        score -= 10
        sintomas.append("Vigor verde bajo")
        recs.append("Revisa luz, riego y estado general del sustrato.")

    p_bin = correr(SESION_ANOMALIA, img)
    p_enfermo = float(p_bin[0]) if p_bin is not None else None
    if p_enfermo is not None and p_enfermo > 0.85:
        score = min(score, 70)
        sintomas.append(f"El modelo local detecta posible anomalía foliar ({p_enfermo*100:.0f}% prob.)")
        recs.append("Inspecciona de cerca el envés de las hojas y compara evolución en varios días.")

    p_dis = correr(SESION_SALUD, img)
    enfermedad = None
    if p_dis is not None and MAPEO_SALUD and cultivo:
        idx = int(np.argmax(p_dis))
        conf = float(p_dis[idx])
        info = MAPEO_SALUD.get(str(idx))
        if info:
            cultivo_pred = PREFIJO_CULTIVO.get(info["id"].split("___")[0])
            if cultivo_pred == cultivo and not info["id"].endswith("healthy") and conf > 0.70:
                enfermedad = (info, conf)
    if enfermedad:
        info, conf = enfermedad
        score = min(score, max(15, int(100 - conf * 75)))
        sintomas.insert(0, f"Enfermedad compatible: {info.get('nombre_es', info.get('id'))} ({conf*100:.0f}%)")
        recs.insert(0, info.get("consejo", "Consulta tratamiento específico para esta enfermedad."))

    if sintomas and perfil:
        recs.append(perfil["consejo_sintomas"])
    if not sintomas:
        sintomas = ["Sin síntomas claros detectados por el respaldo local"]
        recs = ["Si observas manchas o plagas, haz una foto cercana de la hoja afectada y vuelve a analizar."]

    score = max(5, min(100, int(score)))
    estado = "saludable" if score >= 80 else ("atencion" if score >= 55 else "critico")

    return {
        "puntuacion": score, "estado": estado,
        "sintomas": sintomas, "recomendaciones": recs,
        "diagnostico": "Diagnóstico local limitado. Para mayor precisión se recomienda conexión con IA.",
        "fuente": "local",
        "detalle": {
            "verde": round(float(verde), 3),
            "amarillo": round(float(amarillo), 3),
            "marron": round(float(marron), 3),
        },
        "modelos": {
            "prob_sintomas": round(p_enfermo, 3) if p_enfermo is not None else None,
            "cultivo_detectado": cultivo,
            "enfermedad": (
                {"nombre": enfermedad[0].get("nombre_es"), "confianza": round(enfermedad[1], 3)}
                if enfermedad else None
            ),
        },
    }


def score_desde_estado(estado, confianza=0.7):
    confianza = max(0.0, min(1.0, confianza))
    if estado == "saludable": return 100
    if estado == "atencion": return int(78 - confianza * 25)
    if estado == "critico": return int(50 - confianza * 30)
    return 70


# ============================================================
# VALIDACIÓN DE ENTRADAS
# ============================================================

# Límites simultáneos en bytes y píxeles: protege también imágenes muy comprimidas.
MAX_IMAGE_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", "20000000"))
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

async def leer_imagen_validada(upload: UploadFile) -> Image.Image:
    """Lee una imagen con límite de tamaño y valida que Pillow pueda decodificarla."""
    contenido = await upload.read(MAX_IMAGE_BYTES + 1)
    if not contenido:
        raise HTTPException(status_code=400, detail="La imagen está vacía.")
    if len(contenido) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"La imagen supera el límite de {MAX_IMAGE_BYTES // (1024 * 1024)} MB."
        )
    try:
        imagen = Image.open(io.BytesIO(contenido))
        if imagen.width * imagen.height > MAX_IMAGE_PIXELS:
            raise HTTPException(413, "La fotografía tiene demasiados píxeles. Reduce su resolución.")
        imagen = ImageOps.exif_transpose(imagen)
        imagen.load()
        if imagen.mode not in ("RGB", "RGBA"):
            imagen = imagen.convert("RGB")
        return imagen
    except HTTPException:
        raise
    except Image.DecompressionBombError:
        raise HTTPException(413, "La fotografía tiene demasiados píxeles.")
    except Exception:
        raise HTTPException(status_code=400, detail="No se pudo leer la imagen. Usa JPG, PNG o WEBP.")


# ============================================================
# ENDPOINTS
# ============================================================
import asyncio
from fastapi import File, UploadFile
from fastapi.responses import JSONResponse

def detectar_si_es_planta(img):
    """
    Valida que el sujeto principal sea una planta real.
    Si la respuesta es ambigua o incompleta, no autoriza el diagnóstico.
    """
    if not GEMINI_KEY:
        print("⚠️ Sin GEMINI_API_KEY: no se puede validar la planta")
        return None

    img_b64 = base64.b64encode(
        imagen_a_jpeg_bytes(img, max_px=768)
    ).decode("utf-8")

    prompt = """
Analiza visualmente la imagen antes de permitir un diagnóstico botánico.

Devuelve exclusivamente un JSON válido con estos campos:
{
  "es_planta": false,
  "confianza": 0.0,
  "sujeto_principal": "persona, vehículo, objeto, planta u otro",
  "evidencia_vegetal": "descripción concreta de hojas, tallo,
  flores u otras estructuras vegetales visibles",
  "motivo": "explicación breve"
}

REGLAS OBLIGATORIAS:
1. es_planta solo puede ser true si una planta REAL es claramente
   visible y constituye el sujeto principal de la fotografía.
2. Si el sujeto principal es una persona, un rostro, un animal,
   un coche, un edificio u otro objeto, devuelve false.
3. No confundas ropa, cabello, piel, fondos verdes, dibujos ni
   objetos decorativos con estructuras vegetales.
4. No deduzcas que hay una planta solo porque podría estar fuera
   del encuadre o en el fondo.
5. Si no puedes distinguir estructuras vegetales reales, devuelve
   false.
6. Si la imagen muestra una persona sosteniendo una planta, solo
   devuelve true si la planta es claramente visible y es el sujeto
   principal.
7. No inventes hojas, tallos ni flores que no se vean.
8. La confianza debe reflejar la seguridad de que el sujeto
   principal es realmente una planta.

Responde solo con el JSON.
"""

    for modelo in MODELOS_GEMINI:
        texto = _pedir_texto_gemini(
            modelo, prompt, img_b64, forzar_json=True, tipo="VALIDACION_PLANTA"
        )

        if not texto or texto == "no_modelo":
            continue

        try:
            data = extraer_json(texto)

            es_planta = data.get("es_planta")
            confianza = float(data.get("confianza", 0))
            sujeto = str(
                data.get("sujeto_principal", "")
            ).strip().lower()
            evidencia = str(
                data.get("evidencia_vegetal", "")
            ).strip().lower()

            sujeto_valido = (
                sujeto == "planta"
                or sujeto.startswith("planta ")
            )

            evidencia_valida = (
                bool(evidencia)
                and evidencia not in {
                    "ninguna", "ninguna visible",
                    "no se observa", "no hay"
                }
            )

            aceptada = (
                es_planta is True
                and confianza >= 0.85
                and sujeto_valido
                and evidencia_valida
            )

            print(
                "🔎 Validación estricta:",
                f"aceptada={aceptada},",
                f"confianza={confianza:.2f},",
                f"sujeto={sujeto!r},",
                f"evidencia={evidencia[:120]!r}"
            )

            # Una respuesta JSON válida pero ambigua no autoriza
            # a generar un diagnóstico de salud.
            return aceptada

        except (ValueError, TypeError, AttributeError) as e:
            print(f"⚠️ Respuesta inválida del preclasificador: {e}")

    print("⚠️ No se pudo confirmar visualmente la presencia de una planta")
    return None


# Identificación botánica independiente: no ejecuta diagnóstico de salud.
def _identificar_solo_gemini(img):
    if not GEMINI_KEY:
        return None
    foto=base64.b64encode(imagen_a_jpeg_bytes(img,max_px=1024)).decode("utf-8")
    prompt=("Identifica exclusivamente la especie vegetal visible en la imagen. "
            "No diagnostiques salud, enfermedades ni tratamientos. "
            "Responde SOLO con JSON válido: "
            "{\"nombre_comun\":\"...\",\"nombre_cientifico\":\"...\",\"confianza\":0.0}. "
            "Confianza entre 0 y 1; si no puedes identificar, usa confianza 0 y nombres vacíos.")
    for modelo in MODELOS_GEMINI:
        texto=_pedir_texto_gemini(modelo,prompt,foto,forzar_json=True,tipo="SOLO_IDENTIFICACION")
        if not texto or texto=="no_modelo":continue
        try:
            d=extraer_json(texto)
            if not isinstance(d,dict):continue
            confianza=max(0.,min(1.,float(d.get("confianza",0))))
            if confianza<0.55 or not d.get("nombre_cientifico"):return None
            return {"nombre_comun":str(d.get("nombre_comun") or "Planta"),"nombre_cientifico":str(d["nombre_cientifico"]),"confianza":confianza}
        except (ValueError,TypeError,KeyError):continue
    return None

@app.post("/identificar")
async def identificar_solo(request: Request, imagen: UploadFile = File(...)):
    img = await leer_imagen_validada(imagen)
    await imagen.seek(0)
    photo_bytes = await imagen.read()
    await imagen.seek(0)
    loop = asyncio.get_running_loop()
    inicio_identificacion = time.perf_counter()
    tiempos = {}
    # El navegador ya comprime las fotos a JPEG <= 1024 px. Evitamos volver
    # a codificarlas con Pillow cuando ya tienen ese formato y tamaño.
    inicio_preparacion = time.perf_counter()
    if (img.format == "JPEG" and max(img.size) <= 1024
            and photo_bytes[:3] == b"\xff\xd8\xff"):
        jpeg = photo_bytes
    else:
        jpeg = imagen_a_jpeg_bytes(img, max_px=1024)
    tiempos["preparacion"] = time.perf_counter() - inicio_preparacion
    # Pl@ntNet primero: una petición y sin llamadas a Gemini si hay confianza.
    inicio_plantnet = time.perf_counter()
    try:
        candidatos = await asyncio.wait_for(loop.run_in_executor(EXECUTOR, identificar_plantnet, jpeg), timeout=float(os.getenv("PLANTNET_TIMEOUT", "8")) + 2)
    except Exception as exc:
        print(f"⚠️ Pl@ntNet identificación: {type(exc).__name__}: {exc}")
        candidatos = []
    tiempos["plantnet"] = time.perf_counter() - inicio_plantnet
    resultado = None
    if candidatos and candidatos[0].get('confianza', 0) >= 0.40 and candidatos[0].get('nombre_cientifico'):
        resultado = candidatos[0]
    # Auditoría: registrar por qué se descarta Pl@ntNet sin alterar el umbral.
    if resultado is not None:
        print(f"🎯 [PLANTNET V103] decisión=aceptado | confianza={resultado['confianza']:.3f} | umbral=0.400 | tiempo={tiempos['plantnet']:.2f}s")
    else:
        if not candidatos:
            motivo = "sin candidatos válidos (o petición fallida; revisar línea anterior)"
        elif not candidatos[0].get('nombre_cientifico'):
            motivo = "sin nombre científico"
        else:
            motivo = "confianza inferior al umbral"
        confianza_pn = candidatos[0].get('confianza', 0) if candidatos else 0
        print(f"🔄 [PLANTNET V103] decisión=respaldo | motivo={motivo} | confianza={confianza_pn:.3f} | umbral=0.400 | tiempo={tiempos['plantnet']:.2f}s")
    if resultado is None:
        inicio_respaldo = time.perf_counter()
        # Gemini se usa solo cuando Pl@ntNet no ofrece un resultado suficientemente fiable.
        try:
            validacion = await asyncio.wait_for(loop.run_in_executor(EXECUTOR, detectar_si_es_planta, img), timeout=30.0)
        except Exception:
            validacion = None
        if validacion is False:
            raise HTTPException(422, "No hemos detectado una planta con suficiente seguridad.")
        if validacion is None:
            raise HTTPException(503, "No podemos verificar la fotografía ahora mismo.")
        try:
            resultado = await asyncio.wait_for(loop.run_in_executor(EXECUTOR, _identificar_solo_gemini, img), timeout=35.0)
        except Exception:
            resultado = None
        tiempos["respaldo"] = time.perf_counter() - inicio_respaldo
    if not resultado:
        print(f"⏱️ [IDENTIFICACIÓN] sin resultado; fases={tiempos}; total={time.perf_counter()-inicio_identificacion:.2f}s")
        raise HTTPException(503, "No se ha podido identificar la especie con suficiente confianza.")
    # Si Pl@ntNet no conoce el nombre común, sigue habiendo identificación
    # científica. Nunca presentar una especie identificada como desconocida.
    resultado = dict(resultado)
    resultado['nombre_comun'] = (resultado.get('nombre_comun')
                                or nombre_comun_es(resultado.get('nombre_cientifico'))
                                or resultado.get('nombre_cientifico') or 'Planta')
    # El token es de un solo uso y está ligado a foto, IP y dispositivo.
    resultado['continuacion_salud'] = _quota_continue_token(photo_bytes, _quota_ip(request), _quota_device_id(request.cookies.get(QUOTA_COOKIE)) or getattr(request.state, 'quota_device_id', ''))
    total = time.perf_counter() - inicio_identificacion
    print(f"⏱️ [IDENTIFICACIÓN V102] fuente={'Pl@ntNet' if 'respaldo' not in tiempos else 'respaldo'} | preparación={tiempos['preparacion']:.3f}s | Pl@ntNet={tiempos['plantnet']:.2f}s | respaldo={tiempos.get('respaldo', 0):.2f}s | total={total:.2f}s")
    return resultado

@app.post("/analizar")
async def analizar(request: Request, imagen: UploadFile = File(...)):
    # El token solo se puede canjear por la misma imagen, IP y dispositivo.
    # Se consume exactamente una vez. No leer el cuerpo en middleware.
    token = request.headers.get("X-Plantorum-Continuation", "").strip()
    if token:
        foto = await imagen.read(MAX_IMAGE_BYTES + 1)
        if not foto or len(foto) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Fotografía demasiado grande o vacía.")
        device = getattr(request.state, 'quota_device_id', '')
        if not _quota_redeem(token, foto, _quota_ip(request), device):
            raise HTTPException(403, "La continuación ya no es válida. Realiza una nueva identificación.")
        request.state.plantorum_prevalidated = True
        await imagen.seek(0)
    img = await leer_imagen_validada(imagen)
    # V105: si hay continuación validada, mantener la ruta anterior.
    # Si es acceso directo, la validación se hace DENTRO de la petición
    # de diagnóstico, evitando una segunda consulta a Gemini.
    prevalidada = bool(getattr(request.state, 'plantorum_prevalidated', False))
    loop = asyncio.get_running_loop()
    ia_gemini = None
    sin_validar = False       # Gemini no respondió: hay que confirmar con Pl@ntNet/local que es una planta
    if not prevalidada:
        inicio_unificado = time.perf_counter()
        try:
            estado_unificado, ia_gemini = await asyncio.wait_for(
                loop.run_in_executor(EXECUTOR, diagnostico_gemini_unificado, img, time.monotonic() + 30.0),
                timeout=35.0
            )
        except asyncio.TimeoutError:
            print("⚠️ [V105] Diagnóstico unificado agotó 35s")
            estado_unificado = "error"
        except Exception as exc:
            print(f"⚠️ [V105] Fallo en diagnóstico unificado: {type(exc).__name__}: {exc}")
            estado_unificado = "error"
        finally:
            print(f"⏱️ [V105 DIAGNÓSTICO UNIFICADO] {time.perf_counter()-inicio_unificado:.2f}s")
        if estado_unificado == "no_planta":
            raise HTTPException(status_code=422, detail="No hemos detectado una planta real como sujeto principal. Haz una foto de una planta, sus hojas o sus flores.")
        if estado_unificado == "error":
            sin_validar = True          # → Plan B (Qwen) / Plan C (local), tras confirmar que es una planta
            ia_gemini = None
        elif estado_unificado != "ok" or not ia_gemini:
            raise HTTPException(status_code=503, detail="No hemos podido comprobar con suficiente seguridad que la foto sea una planta. Haz otra foto más cercana de las hojas e inténtalo de nuevo.")
    # Contamos solo peticiones con imagen válida, no cargas malformadas.
    _stats_contar("escaneos")
    img_bytes_jpeg = imagen_a_jpeg_bytes(img, max_px=1024)
    loop = asyncio.get_running_loop()

    # Plan A para continuación ya validada; el acceso directo
    # reutiliza el diagnóstico obtenido en la única llamada anterior.
    if prevalidada:
        inicio_plan_a = time.perf_counter()
        try:
            print("Plan A: Consultando a Gemini (imagen ya validada)...")
            ia_gemini = await asyncio.wait_for(
                loop.run_in_executor(EXECUTOR, diagnostico_gemini, img, None),
                timeout=35.0
            )
        except asyncio.TimeoutError:
            print("⏱️ Gemini superó el tiempo límite (35s). Pasando al Plan B...")
        except Exception as e:
            print(f"⚠️ Error consultando Gemini: {e}. Pasando al Plan B...")
        finally:
            print(f"⏱️ [Plan A Gemini] {time.perf_counter()-inicio_plan_a:.2f} s (tiempo observado por el endpoint)")

    if ia_gemini and not MODO_PRUEBA_QWEN:
        fuente_ia = "gemini"
        ia = ia_gemini
        # Para la especie, lanzamos una identificación rápida si es posible o usamos lo de la IA
        local = await loop.run_in_executor(EXECUTOR, identificar_local, img)
        especie_contexto = ia.get("especie")
        cuidados = {
            "grupo": "Planta",
            "riego": ia.get("riego") or "Según necesidad",
            "luz": ia.get("luz") or "Luz indirecta",
            "tipico": "Observar respuesta y ajustar"
        }
        
        estado = normalizar_estado(ia.get("estado"))
        confianza = float(ia.get("confianza", 0.7))
        puntuacion = score_desde_estado(estado, confianza)
        recomendaciones = list(ia.get("tratamiento") or [])
        prevencion = ia.get("prevencion") or []
        if prevencion:
            recomendaciones.append("Prevención: " + " ".join(prevencion))
        if not recomendaciones and estado == "saludable":
            recomendaciones = ["Mantén los cuidados habituales y revisa periódicamente hojas y envés."]

        salud = {
            "puntuacion": puntuacion, "estado": estado,
            "sintomas": ia.get("sintomas") or [],
            "recomendaciones": recomendaciones,
            "diagnostico": ia.get("diagnostico") or "",
            "patogeno": ia.get("patogeno") or "",
            "guia": ia.get("guia") or {},
            "fuente": fuente_ia,
            "confianza": round(confianza, 2),
            "modelo": ia.get("modelo"),
        }
        return {
            "especie": {
                "fuente": fuente_ia,
                "plantnet": [], "local": local,
                "nombre_comun": especie_contexto or "Planta sin identificar",
            },
            "salud": salud,
            "cuidados": cuidados,
            "aviso": "Diagnóstico asistido por IA. Es orientativo; en casos graves consulta a un experto o vivero.",
        }

    # -------------------------------------------------------------
    # 2. PLAN B: Si Gemini falla, usar Pl@ntNet + Qwen / Modelo local
    # -------------------------------------------------------------
    print("Plan B: Identificando especie con Pl@ntNet y local...")
    try:
        task_plantnet = loop.run_in_executor(EXECUTOR, identificar_plantnet, img_bytes_jpeg)
        task_local = loop.run_in_executor(EXECUTOR, identificar_local, img)
        plantnet, local = await asyncio.gather(task_plantnet, task_local, return_exceptions=True)
        plantnet = plantnet if not isinstance(plantnet, Exception) else []
        local = local if not isinstance(local, Exception) else []
    except Exception as e:
        print(f"Error en identificación Plan B: {e}")
        plantnet, local = [], []

    if sin_validar:
        # Sin Gemini no hay validación fiable: exigimos una identificación mínima antes de diagnosticar.
        pn_ok = bool(plantnet and plantnet[0].get("confianza", 0) >= 0.20)
        lo_ok = bool(local and local[0].get("confianza", 0) >= 0.60)
        if not (pn_ok or lo_ok):
            raise HTTPException(status_code=503, detail="Ahora mismo no podemos analizar la foto. Inténtalo de nuevo en unos minutos.")

    fuente_usada, textos_perfil = elegir_especie(plantnet, local)
    cultivo = detectar_cultivo(plantnet, local)
    perfil = perfil_de(textos_perfil)

    especie_contexto = None
    if plantnet:
        pn0 = plantnet[0]
        especie_contexto = pn0.get("nombre_comun") or pn0.get("nombre_cientifico")
    elif local:
        especie_contexto = local[0].get("clase")

    cuidados = None
    if perfil:
        cuidados = {"grupo": perfil["grupo"], "riego": perfil["riego"],
                    "luz": perfil["luz"], "tipico": perfil["tipico"]}

    # Intentar Qwen como respaldo de la IA si Gemini falló
    ia = None
    inicio_qwen = time.perf_counter()
    try:
        ia = await asyncio.wait_for(
            loop.run_in_executor(EXECUTOR, diagnostico_qwen, img, especie_contexto),
            timeout=30.0
        )
    except asyncio.TimeoutError:
        print("⏱️ Qwen superó el límite de 30s; se continúa con el Plan C local.")
    except Exception as e:
        print(f"Qwen de respaldo falló o no está configurado: {e}")
    finally:
        print(f"⏱️ [Plan Qwen] {time.perf_counter() - inicio_qwen:.2f} s (tiempo observado por el endpoint)")

    if ia:
        fuente_ia = "qwen"
        if not cuidados and ia.get("luz") and ia.get("riego"):
            cuidados = {
                "grupo": "Planta",
                "riego": ia.get("riego"),
                "luz": ia.get("luz"),
                "tipico": "Observar respuesta y ajustar"
            }

        estado = normalizar_estado(ia.get("estado"))
        confianza = float(ia.get("confianza", 0.7))
        puntuacion = score_desde_estado(estado, confianza)
        recomendaciones = list(ia.get("tratamiento") or [])
        prevencion = ia.get("prevencion") or []
        if prevencion:
            recomendaciones.append("Prevención: " + " ".join(prevencion))
        if not recomendaciones and estado == "saludable":
            recomendaciones = ["Mantén los cuidados habituales y revisa periódicamente hojas y envés."]

        salud = {
            "puntuacion": puntuacion, "estado": estado,
            "sintomas": ia.get("sintomas") or [],
            "recomendaciones": recomendaciones,
            "diagnostico": ia.get("diagnostico") or "",
            "patogeno": ia.get("patogeno") or "",
            "guia": ia.get("guia") or {},
            "fuente": fuente_ia,
            "confianza": round(confianza, 2),
            "modelo": ia.get("modelo"),
        }
        return {
            "especie": {
                "fuente": fuente_ia,
                "plantnet": plantnet, "local": local,
                "nombre_comun": especie_contexto or "Planta sin identificar",
            },
            "salud": salud,
            "cuidados": cuidados,
            "aviso": "Diagnóstico asistido por IA (Qwen). Es orientativo.",
        }

    # -------------------------------------------------------------
    # 3. PLAN C: Fallback local completo de emergencia
    # -------------------------------------------------------------
    print("Plan C: Usando modelo local de emergencia...")
    salud = analizar_salud_local(img, cultivo=cultivo, perfil=perfil)
    if isinstance(salud, dict) and salud.get("estado") == "saludable":
        # Sin IA no se puede afirmar que la planta esté sana.
        salud["estado"] = "atencion"
        salud["diagnostico"] = "Resultado no concluyente (análisis básico sin IA). " + (salud.get("diagnostico") or "")
        if isinstance(salud.get("puntuacion"), (int, float)):
            salud["puntuacion"] = min(int(salud["puntuacion"]), 75)
    return {
        "especie": {"fuente": fuente_usada, "plantnet": plantnet, "local": local},
        "salud": salud,
        "cuidados": cuidados,
        "aviso": "Análisis local orientativo. Las APIs externas no respondieron.",
    }

# ============================================================
# INFORME DETALLADO (PDF) — 0,50 € / incluido en Pro
# ============================================================

import uuid
import datetime

# SQLite permite recuperar informes tras reinicios y entre varios workers.
# Mantener QUOTA_DB_PATH en almacenamiento persistente en Render.
INFORME_TTL_SEGUNDOS = 3600
INFORMES_ENABLED = os.getenv("INFORMES_ENABLED", "0") == "1"

def _informe_init():
    with sqlite3.connect(QUOTA_DB_PATH, timeout=15) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS informes_pdf (token TEXT PRIMARY KEY, pdf BLOB NOT NULL, expiry INTEGER NOT NULL)")

def _informe_guardar(token, pdf):
    with sqlite3.connect(QUOTA_DB_PATH, timeout=15) as conn:
        conn.execute("DELETE FROM informes_pdf WHERE expiry < ?", (int(time.time()),))
        conn.execute("INSERT INTO informes_pdf(token, pdf, expiry) VALUES (?,?,?)",
                     (token, pdf, int(time.time())+INFORME_TTL_SEGUNDOS))

def _informe_obtener(token):
    with sqlite3.connect(QUOTA_DB_PATH, timeout=15) as conn:
        conn.execute("DELETE FROM informes_pdf WHERE expiry < ?", (int(time.time()),))
        row = conn.execute("SELECT pdf FROM informes_pdf WHERE token=? AND expiry>=?", (token, int(time.time()))).fetchone()
    return row[0] if row else None

_informe_init()

PROMPT_INFORME = """Eres un botánico experto. Redacta un informe COMPLETO en español sobre la planta de la imagen.
Devuelve SOLO JSON válido:
{{
 "especie": "nombre común (nombre científico)",
 "descripcion": "2-3 frases describiendo la planta",
 "luz": "necesidades de luz detalladas",
 "riego": "pauta completa: frecuencia verano/invierno, cantidad y señales de exceso/falta",
 "sustrato": "tipo de sustrato y drenaje",
 "abono": "pauta de fertilización",
 "poda": "cuándo y cómo podar",
 "temperatura": "rango ideal y resistencia a heladas",
 "plagas": ["plaga: síntoma y tratamiento"],
 "enfermedades": ["enfermedad: síntoma y tratamiento"],
 "calendario": ["Primavera: acciones", "Verano: acciones", "Otoño: acciones", "Invierno: acciones"],
 "consejo_experto": "consejo final personalizado según lo que veas en la imagen"
}}
Máximo 2 frases por campo, 3 plagas, 3 enfermedades. Sin markdown."""


def generar_informe_pdf(d):
    from fpdf import FPDF
    pdf = FPDF()
    # No se distribuyen fuentes. Si el equipo tiene una TTF, se incrusta al
    # generar el PDF; sin ella, Latin-1 conserva tildes y ñ, reemplaza emoji.
    ttf = os.getenv("PDF_FONT_TTF", "")
    if not ttf:
        for candidato in (r"C:\Windows\Fonts\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
            if Path(candidato).is_file():
                ttf = candidato
                break
    use_ttf = bool(ttf and Path(ttf).is_file())
    if use_ttf:
        pdf.add_font("Plantorum", "", ttf)
        ttf_bold = os.getenv("PDF_FONT_BOLD_TTF", "")
        if not ttf_bold:
            ttf_bold = str(Path(ttf).with_name("DejaVuSans-Bold.ttf" if "DejaVu" in Path(ttf).name else "arialbd.ttf"))
        if Path(ttf_bold).is_file():
            pdf.add_font("Plantorum", "B", ttf_bold)
        else:
            pdf.add_font("Plantorum", "B", ttf)
        pdf.add_font("Plantorum", "I", ttf)
    fuente = "Plantorum" if use_ttf else "Helvetica"
    def seguro(x):
        s = str(x or "-")
        return s if use_ttf else s.encode("latin-1", "replace").decode("latin-1")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()
    pdf.set_font(fuente, "B", 20)
    pdf.set_text_color(18, 59, 44)
    pdf.cell(0, 12, "Plantorum - Informe detallado", ln=True, align="C")
    pdf.set_font(fuente, "", 10)
    pdf.set_text_color(110, 118, 110)
    pdf.cell(0, 8, datetime.date.today().strftime("%d/%m/%Y"), ln=True, align="C")
    pdf.ln(4)

    def seccion(t):
        pdf.set_font(fuente, "B", 13)
        pdf.set_text_color(30, 158, 99)
        pdf.ln(3)
        pdf.cell(0, 9, seguro(t), ln=True)
        pdf.set_font(fuente, "", 11)
        pdf.set_text_color(40, 48, 40)

    def parr(t):
        pdf.multi_cell(0, 6, seguro(t))
        pdf.ln(1)

    pdf.set_font(fuente, "B", 15)
    pdf.set_text_color(18, 59, 44)
    pdf.multi_cell(0, 9, seguro(d.get("especie", "Planta")), align="C")
    pdf.ln(2)
    seccion("Descripcion"); parr(d.get("descripcion"))
    seccion("Luz"); parr(d.get("luz"))
    seccion("Riego"); parr(d.get("riego"))
    seccion("Sustrato"); parr(d.get("sustrato"))
    seccion("Abono"); parr(d.get("abono"))
    seccion("Poda"); parr(d.get("poda"))
    seccion("Temperatura"); parr(d.get("temperatura"))
    seccion("Plagas frecuentes")
    for x in d.get("plagas", []): parr("- " + x)
    seccion("Enfermedades frecuentes")
    for x in d.get("enfermedades", []): parr("- " + x)
    seccion("Calendario anual")
    for x in d.get("calendario", []): parr("- " + x)
    seccion("Consejo del experto"); parr(d.get("consejo_experto"))
    pdf.ln(4)
    pdf.set_font(fuente, "I", 9)
    pdf.set_text_color(140, 148, 140)
    pdf.multi_cell(0, 5, "Informe orientativo generado por IA. No sustituye el diagnostico de un profesional.")
    return pdf.output()


def informe_detallado_gemini(img):
    if not GEMINI_KEY:
        return None
    img_b64 = base64.b64encode(imagen_a_jpeg_bytes(img, max_px=1024)).decode()
    for modelo in MODELOS_GEMINI:
        texto = _pedir_texto_gemini(modelo, PROMPT_INFORME, img_b64, forzar_json=True, tipo="INFORME_DETALLADO")
        if texto in (None, "no_modelo"):
            continue
        try:
            return extraer_json(texto)
        except ValueError:
            continue
    return None


def informe_detallado_qwen(img):
    if not QWEN_KEY:
        return None
    img_b64 = base64.b64encode(imagen_a_jpeg_bytes(img, max_px=1024)).decode()
    for modelo in QWEN_MODELOS:
        try:
            r = _post_medido(f"Qwen informe {modelo}",
                f"{QWEN_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {QWEN_KEY}", "Content-Type": "application/json"},
                json={"model": modelo, "messages": [{"role": "user", "content": [
                    {"type": "text", "text": PROMPT_INFORME},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}}]}],
                    "temperature": 0.2, "max_tokens": 3000},
                timeout=90,
            )
            r.raise_for_status()
            contenido = r.json()["choices"][0]["message"]["content"]
            if isinstance(contenido, list):
                contenido = "".join(p.get("text", "") for p in contenido)
            return extraer_json(contenido)
        except Exception:
            continue
    return None


@app.post("/informe")
async def informe(imagen: UploadFile = File(...)):
    # Desactivado hasta tener cobro/autorización real; antes se podía gastar
    # dinero en IA con un diálogo de pago que solo era una simulación.
    if not INFORMES_ENABLED:
        raise HTTPException(503, "Informes PDF temporalmente no disponibles.")
    img = await leer_imagen_validada(imagen)
    loop = asyncio.get_running_loop()
    datos = await loop.run_in_executor(EXECUTOR, informe_detallado_gemini, img)
    if not datos:
        datos = await loop.run_in_executor(EXECUTOR, informe_detallado_qwen, img)
    if not datos:
        raise HTTPException(503, "La IA no está disponible ahora mismo. Inténtalo en unos minutos.")
    pdf = bytes(await loop.run_in_executor(EXECUTOR, generar_informe_pdf, datos))
    token = uuid.uuid4().hex
    _informe_guardar(token, pdf)
    _stats_contar("informes")
    return {"token": token, "url": f"/informe_pdf/{token}"}

@app.get("/informe_pdf/{token}")
def informe_pdf(token: str):
    from fastapi.responses import Response
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise HTTPException(404, "Informe no encontrado")
    pdf = _informe_obtener(token)
    if not pdf:
        raise HTTPException(404, "El informe ha caducado. Vuelve a generarlo.")
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="informe_plantorum.pdf"',
                             "Cache-Control":"no-store"})

# ============================================================
# CONTADOR DE USO Y COSTES
# ============================================================
import json as _json
STATS_FILE = BASE / "stats.json"
_STATS_LOCK = Lock()

def _stats_leer():
    try: return _json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except Exception: return {"escaneos":0,"informes":0,"por_dia":{}}

def _stats_contar(tipo):
    # Protege incrementos simultáneos dentro de un mismo proceso.
    with _STATS_LOCK:
        s = _stats_leer()
        s[tipo] = s.get(tipo, 0) + 1
        dia = datetime.date.today().isoformat()
        por_dia = s.setdefault("por_dia", {})
        por_dia.setdefault(dia, {"escaneos": 0, "informes": 0})
        por_dia[dia][tipo] = por_dia[dia].get(tipo, 0) + 1
        temporal = STATS_FILE.with_suffix(".tmp")
        temporal.write_text(_json.dumps(s, ensure_ascii=False), encoding="utf-8")
        temporal.replace(STATS_FILE)

@app.get("/stats")
def stats(x_stats_token: str = Header(default="", alias="X-Stats-Token")):
    # Este endpoint revela métricas internas. Debe configurarse STATS_TOKEN.
    if not STATS_TOKEN:
        raise HTTPException(status_code=404, detail="Endpoint no disponible.")
    if not hmac.compare_digest(x_stats_token, STATS_TOKEN):
        raise HTTPException(status_code=403, detail="No autorizado.")
    s = _stats_leer()
    coste = s.get("escaneos", 0) * 0.002 + s.get("informes", 0) * 0.004
    return {
        **s,
        "coste_estimado_eur": round(coste, 4),
        "nota": "Estimación orientativa fija; no equivale a facturación real de proveedores."
    }



@app.get("/assets/{asset_name}")
def asset_webp(asset_name: str):
    import re
    if not re.fullmatch(r"plantorum-(?:png|jpeg)-[1-9][0-9]*\.webp", asset_name):
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    path = BASE / "assets" / asset_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control":"public, max-age=31536000, immutable"})

@app.get("/app")
def interfaz():
    return FileResponse(BASE / "app.html")

@app.get("/styles.css")
def estilos():
    return FileResponse(BASE / "styles.css", media_type="text/css")

@app.get("/logo.png")
def logo():
    path = BASE / "logo.png"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Logo no incluido en esta distribución.")
    return FileResponse(path, media_type="image/png")

@app.get("/fondo-paywall.png")
def fondo_paywall():
    path = BASE / "fondo-paywall.png"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Fondo de pago no incluido en esta distribución.")
    return FileResponse(path, media_type="image/png")

@app.get("/app.js")
def script():
    return FileResponse(BASE / "app.js", media_type="text/javascript")


@app.get("/")
def raiz():
    return {
        "estado": "Plantorum API activa 🌿",
        "version": app.version,
        "app": "/app",
    }


if __name__ == "__main__":
    import uvicorn
    # Detrás de un proxy (Render, Heroku, Nginx) la IP real llega en X-Forwarded-For; sin esto todos los usuarios
    # compartirían la IP del proxy y el límite por IP los bloquearía a la vez.
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=False,
                proxy_headers=True, forwarded_allow_ips=os.getenv("FORWARDED_ALLOW_IPS", "127.0.0.1"))