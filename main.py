"""
FloraScan — Backend v4.9
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
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

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
QWEN_MODELOS = [m.strip() for m in os.getenv("QWEN_MODELOS", "qwen/qwen2.5-vl-72b-instruct").split(",") if m.strip()]

app = FastAPI(title="FloraScan API", version="4.9")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
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
        print("⚠️ PLANTNET_API_KEY no configurada")
        return []
    try:
        r = requests.post(
            "https://my-api.plantnet.org/v2/identify/all",
            params={"api-key": PLANTNET_KEY, "lang": "es"},
            files={"images": ("foto.jpg", img_bytes, "image/jpeg")},
            timeout=30,
        )
        r.raise_for_status()
        out = []
        for res in r.json().get("results", [])[:3]:
            sp = res.get("species", {})
            sci = sp.get("scientificName")
            out.append({
                "nombre_cientifico": sci,
                "nombre_comun": sp.get("commonName") or nombre_comun_es(sci),
                "confianza": round(float(res.get("score", 0)), 3),
            })
        print(f"🌿 Pl@ntNet: {out[0]['nombre_comun'] if out else 'sin resultados'} ({out[0]['confianza'] if out else 0})")
        return out
    except Exception as e:
        print(f"⚠️ Pl@ntNet: {e}")
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
    
    # Si ninguno tiene buena confianza, usa Pl@ntNet si existe
    if plantnet:
        textos.append(plantnet[0].get("nombre_cientifico"))
        textos.append(plantnet[0].get("nombre_comun"))
        print(f"⚠️ Especie elegida: Pl@ntNet con baja confianza ({plantnet[0]['nombre_comun']})")
        return "plantnet", textos
    
    # Último recurso: modelo local
    if local:
        textos.append(local[0].get("clase"))
        print(f"⚠️ Especie elegida: Local con baja confianza ({local[0]['clase']})")
        return "local", textos
    
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


PROMPT_DIAGNOSTICO = """Eres un experto en jardinería y fitopatología.
Analiza la imagen y responde SOLO en JSON válido.{contexto}

Devuelve exactamente:
{{
  "especie": "nombre común o 'no identificada'",
  "estado": "saludable" | "atencion" | "critico",
  "confianza": 0.0,
  "sintomas": ["máximo 3 síntomas visibles"],
  "diagnostico": "qué le pasa en 1 frase",
  "tratamiento": ["máximo 3 pasos concretos"],
  "prevencion": ["1 medida preventiva"]
}}

Reglas:
- Si NO ves síntomas: estado="saludable", sintomas=[], tratamiento=[]
- Si ves manchas, amarilleo, polvo blanco o necrosis: NO digas saludable
- Usa "posible / compatible con" si no hay certeza
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
        "sintomas": sintomas,
        "diagnostico": resultado.get("diagnostico") or "",
        "tratamiento": tratamiento, "prevencion": prevencion,
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
        "sintomas": [],
        "diagnostico": texto,
        "tratamiento": [], "prevencion": [],
        "modelo": modelo_nombre,
    }


# ============================================================
# GEMINI (principal)
# ============================================================

MODELOS_GEMINI = ["gemini-3.6-flash", "gemini-3.5-flash"]


def _texto_de_respuesta_gemini(r):
    data = r.json()
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(p.get("text", "") for p in parts).strip()


def _pedir_texto_gemini(modelo, prompt, img_b64, forzar_json):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent"
    partes = [
        {"text": prompt},
        {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}},
    ]
    cfg = {"temperature": 0.2, "topP": 0.8, "maxOutputTokens": 4096}
    if forzar_json:
        cfg["response_mime_type"] = "application/json"
    try:
        r = requests.post(
            url, params={"key": GEMINI_KEY},
            json={"contents": [{"parts": partes}], "generationConfig": cfg},
            timeout=60,
        )
        if r.status_code == 404:
            print(f"⚠️ Gemini modelo no disponible: {modelo}")
            return "no_modelo"
        if r.status_code in (429, 503):
            print(f"⚠️ Gemini ({modelo}): {r.status_code} — reintentando en 2 s")
            time.sleep(2)
            r = requests.post(
                url, params={"key": GEMINI_KEY},
                json={"contents": [{"parts": partes}], "generationConfig": cfg},
                timeout=60,
            )
        r.raise_for_status()
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
        texto = _pedir_texto_gemini(modelo, prompt, img_b64, forzar_json=True)
        if texto == "no_modelo" or texto is None:
            continue
        resultado = None
        try:
            resultado = extraer_json(texto)
        except ValueError:
            print(f"⚠️ Gemini ({modelo}): JSON inválido. Texto: {texto[:150]!r}")
            texto2 = _pedir_texto_gemini(modelo, prompt, img_b64, forzar_json=False)
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
            r = requests.post(
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
                timeout=90,
            )

            print(f"📡 Qwen ({modelo}): Status {r.status_code}")

            if r.status_code == 404:
                print(f"⚠️ Qwen modelo no disponible: {modelo}")
                continue
            if r.status_code in (429, 503):
                print(f"⚠️ Qwen ({modelo}): {r.status_code} — reintentando en 2 s")
                time.sleep(2)
                r = requests.post(
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
                    timeout=90,
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
# ENDPOINTS
# ============================================================

@app.post("/analizar")
async def analizar(imagen: UploadFile = File(...)):
    img_bytes_original = await imagen.read()
    try:
        img = Image.open(io.BytesIO(img_bytes_original))
        img = ImageOps.exif_transpose(img)
        img.load()
    except Exception:
        raise HTTPException(status_code=400, detail="No se pudo leer la imagen.")

    img_bytes_jpeg = imagen_a_jpeg_bytes(img, max_px=1024)  # ← BAJAR de 1280 a 1024

    # ⚡ PARALELIZAR: lanzar Pl@ntNet + identificación local + diagnóstico al mismo tiempo
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    
    executor = ThreadPoolExecutor(max_workers=3)
    loop = asyncio.get_event_loop()
    
    # Lanzar todas las tareas en paralelo
    task_plantnet = loop.run_in_executor(executor, identificar_plantnet, img_bytes_jpeg)
    task_local = loop.run_in_executor(executor, identificar_local, img)
    task_gemini = loop.run_in_executor(executor, diagnostico_gemini, img, None)  # Sin especie_contexto todavía
    
    # Esperar resultados
    plantnet, local, ia_gemini = await asyncio.gather(task_plantnet, task_local, task_gemini, return_exceptions=True)
    
    # Si alguna falló, convertir a None
    plantnet = plantnet if not isinstance(plantnet, Exception) else []
    local = local if not isinstance(local, Exception) else []
    ia_gemini = ia_gemini if not isinstance(ia_gemini, Exception) else None
    
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

    # Si Gemini ya respondió, usarlo
    if ia_gemini:
        fuente_ia = "gemini"
        ia = ia_gemini
    else:
        # Probar Qwen como respaldo
        ia = diagnostico_qwen(img, especie_contexto=especie_contexto)
        fuente_ia = "qwen" if ia else None

    if ia:
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
            "fuente": fuente_ia,
            "confianza": round(confianza, 2),
            "modelo": ia.get("modelo"),
        }
        
        return {
            "especie": {
                "fuente": fuente_ia,
                "plantnet": plantnet, "local": local,
                "nombre_comun": ia.get("especie") or especie_contexto or "No identificada",
            },
            "salud": salud,
            "cuidados": cuidados,
            "aviso": "Diagnóstico asistido por IA. Es orientativo; en casos graves consulta a un experto o vivero.",
        }

    # Fallback local
    salud = analizar_salud_local(img, cultivo=cultivo, perfil=perfil)
    return {
        "especie": {"fuente": fuente_usada, "plantnet": plantnet, "local": local},
        "salud": salud,
        "cuidados": cuidados,
        "aviso": "Análisis local orientativo. Las APIs externas no respondieron.",
    }


@app.get("/app")
def interfaz():
    return FileResponse(BASE / "app.html")

@app.get("/styles.css")
def estilos():
    return FileResponse(BASE / "styles.css", media_type="text/css")

@app.get("/app.js")
def script():
    return FileResponse(BASE / "app.js", media_type="text/javascript")


@app.get("/")
def raiz():
    return {
        "estado": "FloraScan API activa 🌿",
        "version": "4.9",
        "app": "/app", "docs": "/docs",
        "gemini_configurado": bool(GEMINI_KEY),
        "qwen_configurado": bool(QWEN_KEY),
        "plantnet_configurado": bool(PLANTNET_KEY),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
