// ==========================================
// GESTOR INDEXEDDB (Para evitar QuotaExceededError)
// ==========================================
const DB = {
  dbName: 'PlantorumDB',
  dbVersion: 2,
  storeName: 'fotos',

  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      request.onerror = () => reject('Error abriendo IndexedDB');
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
        // v107: almacén independiente. No toca las fotos de Mi Jardín.
        if (!db.objectStoreNames.contains('historial')) {
          db.createObjectStore('historial', {keyPath:'id'});
        }
      };
    });
  },

  async guardarFoto(id, base64) {
    try {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(base64, id.toString());
        req.onsuccess = () => resolve();
        req.onerror = () => reject('Error guardando foto en DB');
      });
    } catch (e) {
      console.error(e);
    }
  },

  async obtenerFoto(id) {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(id.toString());
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  },

  async eliminarFoto(id) {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.delete(id.toString());
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    } catch (e) {}
  },

  async borrarTodo() {
    try {
      const db = await this.open();
      return new Promise((resolve) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    } catch (e) {}
  }
};
// ==========================================
// PLANTORUM V107 — HISTORIAL LOCAL (IndexedDB)
// ==========================================
// Los registros incluyen la foto JPEG ya comprimida y la respuesta real de
// identificación/diagnóstico. Leerlos jamás llama a /identificar o /analizar.
const PT_HIST={
  async transaccion(tipo,trabajo){
    const db=await DB.open();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction('historial',tipo);
        const store=tx.objectStore('historial');
        let resultado;
        try{resultado=trabajo(store,tx);}catch(e){reject(e);return;}
        tx.oncomplete=()=>resolve(resultado);
        tx.onerror=()=>reject(tx.error||new Error('Error al acceder al historial'));
        tx.onabort=()=>reject(tx.error||new Error('Operación cancelada'));
      });
    }finally{db.close();}
  },
  async listar(){return this.transaccion('readonly',store=>{
    const req=store.getAll();
    const out={resultado:[]};
    req.onsuccess=()=>{out.resultado=req.result||[];};
    // La transacción terminará después de la lectura.
    return out;
  }).then(o=>o.resultado);},
  async obtener(id){return this.transaccion('readonly',store=>{
    const out={resultado:null};
    const req=store.get(id);req.onsuccess=()=>{out.resultado=req.result||null;};
    return out;
  }).then(o=>o.resultado);},
  async guardar(obj){return this.transaccion('readwrite',store=>{store.put(obj);return true;});},
  async eliminar(id){return this.transaccion('readwrite',store=>{store.delete(id);return true;});},
  async vaciar(){return this.transaccion('readwrite',store=>{store.clear();return true;});}
};
let ptHistorialDetalleActivo=null;
let ptHistorialImagenUrl=null;
let ptHistorialMiniaturas=[];
function ptHistId(){return 'scan_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);}
function ptHistLiberarMiniaturas(){ptHistorialMiniaturas.forEach(u=>URL.revokeObjectURL(u));ptHistorialMiniaturas=[];}
function ptHistLiberarDetalle(){if(ptHistorialImagenUrl){URL.revokeObjectURL(ptHistorialImagenUrl);ptHistorialImagenUrl=null;}}
async function ptHistGuardarIdentificacion(blob,d){
  try{
    const id=ptHistId(),ahora=Date.now();
    await PT_HIST.guardar({id,fecha:ahora,actualizado:ahora,imagen:blob,
      identificacion:{nombre:ptNombreIdentificado(d),cientifico:d.nombre_cientifico||'',confianza:typeof d.confianza==='number'?d.confianza:null},
      diagnostico:null});
    return id;
  }catch(e){console.warn('[Plantorum historial] No se pudo guardar identificación:',e);mostrarToast('Aviso: no se pudo guardar esta identificación en el historial.');return null;}
}
async function ptHistGuardarSalud(blob,d,id=null,identificacion=null){
  try{
    const anterior=id?await PT_HIST.obtener(id):null;
    const ahora=Date.now();
    // La identificación de Pl@ntNet prevalece como etiqueta de la ficha
    // cuando la consulta de salud completa el mismo escaneo.
    const especie=datosEspecie(d);
    const ident=anterior?.identificacion||identificacion||{nombre:especie.nom,cientifico:especie.cient,confianza:null};
    const registro={id:anterior?.id||id||ptHistId(),fecha:anterior?.fecha||ahora,
      actualizado:ahora,imagen:anterior?.imagen||blob,
      identificacion:ident,diagnostico:d};
    await PT_HIST.guardar(registro);
    return registro.id;
  }catch(e){console.warn('[Plantorum historial] No se pudo guardar diagnóstico:',e);mostrarToast('Aviso: el diagnóstico se ve, pero no se ha podido guardar en el historial.');return null;}
}
async function ptHistPintar(){
  const lista=$('ptHistLista');if(!lista)return;
  ptHistLiberarMiniaturas();lista.replaceChildren();
  try{
    const registros=(await PT_HIST.listar()).sort((a,b)=>b.actualizado-a.actualizado);
    if($('ptHistNumero'))$('ptHistNumero').textContent=registros.length+' '+(registros.length===1?'escaneo guardado':'escaneos guardados');
    if(!registros.length){
      const vacio=document.createElement('div');vacio.className='pt-hist-vacio';
      vacio.textContent='Todavía no hay escaneos. Identifica una planta o analiza su salud y aparecerá aquí automáticamente.';
      lista.append(vacio);return;
    }
    for(const r of registros){
      const card=document.createElement('article');card.className='pt-hist-card';
      const abrir=document.createElement('button');abrir.type='button';abrir.className='pt-hist-abrir';
      abrir.setAttribute('aria-label','Ver escaneo de '+(r.identificacion?.nombre||'planta'));
      abrir.addEventListener('click',()=>ptHistAbrir(r.id));
      const foto=document.createElement('div');foto.className='pt-hist-thumb';
      if(r.imagen instanceof Blob){const img=document.createElement('img');const url=URL.createObjectURL(r.imagen);ptHistorialMiniaturas.push(url);img.src=url;img.alt='Fotografía de '+(r.identificacion?.nombre||'planta');img.loading='lazy';foto.append(img);}
      else foto.textContent='🌿';
      const cuerpo=document.createElement('div');cuerpo.className='pt-hist-card-copy';
      const titulo=document.createElement('strong');titulo.textContent=r.identificacion?.nombre||'Planta identificada';
      const cient=document.createElement('small');cient.textContent=r.identificacion?.cientifico||'';
      const tipo=document.createElement('span');tipo.className='pt-hist-tipo';
      const salud=r.diagnostico?.salud;
      tipo.textContent=salud?'Identificación + salud · '+(salud.estado==='saludable'?'Saludable':salud.estado==='atencion'?'Atención':'Revisar diagnóstico'):'Solo identificación · Sin análisis de salud';
      const fecha=document.createElement('time');fecha.dateTime=new Date(r.fecha).toISOString();
      fecha.textContent=new Date(r.fecha).toLocaleString('es-ES',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
      cuerpo.append(titulo,cient,tipo,fecha);abrir.append(foto,cuerpo);
      const borrar=document.createElement('button');borrar.type='button';borrar.className='pt-hist-borrar';borrar.textContent='Eliminar';
      borrar.setAttribute('aria-label','Eliminar escaneo de '+(r.identificacion?.nombre||'planta'));
      borrar.addEventListener('click',()=>ptHistEliminar(r.id));
      card.append(abrir,borrar);lista.append(card);
    }
  }catch(e){console.error('[Plantorum historial] Error leyendo:',e);lista.textContent='No se pudo abrir el historial de este dispositivo.';}
}
async function ptHistAbrir(id){
  try{
    const r=await PT_HIST.obtener(id);if(!r)return mostrarToast('Este escaneo ya no está disponible.');
    ptHistLiberarDetalle();ptHistorialDetalleActivo=r.id;
    if(r.imagen instanceof Blob)ptHistorialImagenUrl=URL.createObjectURL(r.imagen);
    if(r.diagnostico){
      ultimoBlob=r.imagen;
      bloqueoActivo=false;
      show('resultado');
      $('resFoto').src=ptHistorialImagenUrl||'';
      pintar(r.diagnostico);
      // Respeta el nombre obtenido al identificar, si es el mismo escaneo.
      if(r.identificacion?.nombre)$('resNombre').textContent=r.identificacion.nombre;
      if(r.identificacion?.cientifico)$('resComun').textContent=r.identificacion.cientifico;
      const boton=$('btnAddJardin');if(boton)boton.style.display='none';
      const volverBoton=document.querySelector('#s-resultado .btn-back');if(volverBoton)volverBoton.textContent='← Historial';
    }else{
      show('historial-detalle');
      $('ptHistDetalleFoto').src=ptHistorialImagenUrl||'';
      $('ptHistDetalleNombre').textContent=r.identificacion?.nombre||'Planta identificada';
      $('ptHistDetalleCientifico').textContent=r.identificacion?.cientifico||'';
      $('ptHistDetalleConfianza').textContent=typeof r.identificacion?.confianza==='number'?'Confianza estimada: '+Math.round(r.identificacion.confianza*100)+' %':'';
      $('ptHistDetalleFecha').textContent=new Date(r.fecha).toLocaleString('es-ES');
    }
  }catch(e){console.error('[Plantorum historial] No se pudo abrir:',e);mostrarToast('No se pudo abrir este escaneo guardado.');}
}
async function ptHistEliminar(id){
  if(!await ptConfirmar('¿Eliminar este escaneo del historial? No afectará a Mi Jardín.'))return;
  try{await PT_HIST.eliminar(id);await ptHistPintar();}catch(e){mostrarToast('No se pudo eliminar este escaneo.');}
}
async function ptHistVaciar(){
  if(!await ptConfirmar('¿Eliminar todo el historial? Las plantas de Mi Jardín no se borrarán.'))return;
  try{await PT_HIST.vaciar();await ptHistPintar();}catch(e){mostrarToast('No se pudo vaciar el historial.');}
}
let spTimer=null,spIntentos=0;
const LS={get(k,d){try{const v=JSON.parse(localStorage.getItem('fs_'+k));return v==null?d:v}catch(e){return d}},set(k,v){localStorage.setItem('fs_'+k,JSON.stringify(v))}};
let stream=null,volverA='jardin',zoomTrack=null,ultimoBlob=null,tabActual='cuidados',datosActuales=null,planElegido='anual';
let idPlantaActual = null
const video=document.getElementById('video');
const $=id=>document.getElementById(id);

// Estado de los diálogos: Android Atrás cierra el diálogo antes de abandonar la app.
const PT_OVERLAYS={cam:()=>cerrarCamara(),ptIdentificacion:()=>cerrarIdentificacion(),ptRiegoModal:()=>cerrarConfiguracionRiego(),ptGuiaModal:()=>ptCerrarModalGuia(),modalConsejos:()=>cerrarConsejos(),modalLegal:()=>cerrarLegal(),paywall:()=>cerrarPaywall(),ptConfirmOverlay:()=>ptConfirmCancelar()};
let ptOverlayClosingFromHistory=false;
function ptOverlayOpen(id){
  if(ptOverlayClosingFromHistory)return;
  if(history.state?.ptOverlay===id)return;
  history.pushState({...(history.state||{}),ptOverlay:id},'',location.href);
}
function ptOverlayClose(id){
  if(!ptOverlayClosingFromHistory && history.state?.ptOverlay===id)history.back();
}
function ptCerrarOverlayDesdeHistorial(id){
  const fn=PT_OVERLAYS[id];if(!fn)return;
  ptOverlayClosingFromHistory=true;
  try{fn();}finally{ptOverlayClosingFromHistory=false;}
}
// Variable para evitar bucles entre eventos del historial
let navegandoHistorial = false;

// Modificamos show() para integrar history.pushState
function show(n, guardarHistorial = true) {
  document.querySelectorAll('.sc').forEach(s => s.classList.remove('on'));
  const seccion = $('s-' + n);
  if (seccion) seccion.classList.add('on');

  // Actualizar estado activo en el menú de navegación
  [['n-jardin','jardin'], ['n-guia','guia'], ['n-ajustes','ajustes']].forEach(p => {
    const b = $(p[0]);
    if (b) b.classList.toggle('sel', p[1] === n);
  });

  // Mostrar o ocultar la barra inferior según la sección
  const navBar = document.querySelector('nav');
  if (navBar) {
    navBar.style.display = (n === 'resultado' || n === 'evolucion') ? 'none' : 'flex';
  }

  // Refrescar contenido según la vista
  if (n === 'jardin') { pintarJardin(); setTimeout(comprobarAvisosRiego, 350); }
  if (n === 'guia') pintarGuias();
  if (n === 'historial') void ptHistPintar();
  window.scrollTo(0, 0);

  // Integración con el historial del navegador/Android
  if (guardarHistorial && !navegandoHistorial) {
    const estadoActual = history.state;
    // Solo añadimos entrada al historial si cambiamos a una pantalla distinta
    if (!estadoActual || estadoActual.seccion !== n) {
      history.pushState({ seccion: n }, '', '#' + n);
    }
  }
}

function tier(){return LS.get('tier','free')}
function actualizarTier(){$('estadoTier').textContent='Suscripción Estado: '+(tier()==='free'?'Gratis':(tier()==='pro'?'Pro (prueba)':'De por vida'))}

// Paywall único definido en la sección de suscripciones.
// Menú de planes antiguo retirado: ya no existen planAnual/pwCta/pwLinea.
function activarPro(){mostrarToast('Los pagos todavía no están habilitados. No se ha activado ninguna suscripción.');}
function restaurar(){mostrarToast(tier()==='free'?'No hay compras anteriores.':'✅ Membresía restaurada: '+tier())}
async function limpiarCache(){if(await ptConfirmar('¿Borrar la caché de fotos de la guía?')){Object.keys(localStorage).filter(k=>k.startsWith('fs_wg_')).forEach(k=>localStorage.removeItem(k));location.reload();}}
// BORRAR TODO (Ajustes)
async function borrarTodo() {
  if (await ptConfirmar('¿Eliminar TODOS tus datos (jardín, historial, suscripción y ajustes)? Esta acción no se puede deshacer.')) {
    Object.keys(localStorage).filter(k => k.startsWith('fs_')).forEach(k => localStorage.removeItem(k));
    await DB.borrarTodo(); // Limpiar la base de datos de fotos completa
    await PT_HIST.vaciar(); // Eliminar también las consultas del historial
    location.reload();
  }
}
function limpiarInterno(o){if(Array.isArray(o)){o.forEach(limpiarInterno);return o}if(o&&typeof o==='object'){['modelo','fuente','plantnet','local'].forEach(k=>delete o[k]);Object.values(o).forEach(limpiarInterno)}return o}
function exportarJardin(){const p=LS.get('plantas',[]);if(!p.length){mostrarToast('Tu jardín está vacío todavía.');return}
const copia=limpiarInterno(JSON.parse(JSON.stringify(p)));
const b=new Blob([JSON.stringify(copia,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='plantorum_jardin.json';document.body.appendChild(a);a.click();document.body.removeChild(a);}
function abrirLegal(t){$('legalTitulo').textContent=t==='priv'?'Política de privacidad':'Términos de uso';$('legalTexto').innerHTML=t==='priv'?LEGAL_PRIV:LEGAL_TERMS;$('modalLegal').classList.add('on');ptOverlayOpen('modalLegal');}
function cerrarLegal(){$('modalLegal').classList.remove('on');ptOverlayClose('modalLegal');}
const LEGAL_PRIV='<p>Al identificar o analizar una planta, su fotografía puede enviarse a proveedores externos para procesarla: Pl@ntNet (identificación), Google/Gemini (análisis) y Alibaba Cloud/Qwen (respaldo cuando proceda). Estas transferencias dependen del servicio utilizado y de las condiciones del proveedor.</p><p>Mi Jardín, el historial, el perfil y los recordatorios se guardan localmente en el dispositivo. Si se habilita el informe PDF, el servidor conserva temporalmente el documento generado, protegido mediante un enlace aleatorio, con acceso durante una hora; los documentos caducados se borran durante posteriores operaciones del servidor.</p><p>Los registros técnicos del servidor pueden contener información de diagnóstico sobre las consultas, pero no registran las fotografías completas en los mensajes habituales. Antes de publicar Plantorum se debe completar una política de privacidad con titular responsable, contacto, base jurídica, plazos de conservación, transferencias internacionales y ejercicio de derechos RGPD.</p>';
const LEGAL_TERMS='<p>Plantorum ofrece información orientativa sobre identificación y cuidados de plantas. No sustituye el asesoramiento de un profesional de la jardinería o la fitosanidad.</p><p>Los planes Premium mostrados son una demostración de diseño. No se realizan cobros reales desde esta versión.</p><p>El uso de la app implica la aceptación de estas condiciones y de la política de privacidad.</p>';
function claveUsoDiario(){
  const ahora = new Date();
  return 'usado_' + ahora.getFullYear() + '-' +
    String(ahora.getMonth() + 1).padStart(2, '0') + '-' +
    String(ahora.getDate()).padStart(2, '0');
}
function escaneosUsadosHoy(){
  const n = Number(LS.get(claveUsoDiario(), 0));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
function consumirEscaneo(){
  if(tier()!=='free') return true;
  if(escaneosUsadosHoy() >= 3){
    mostrarToast('Has utilizado tus 3 escaneos gratuitos de hoy. Vuelve mañana o consulta los planes de Plantorum.');
    abrirPaywall();
    return false;
  }
  return true;
}
function registrarEscaneoExitoso(){
  if(tier()!=='free') return;
  LS.set(claveUsoDiario(), escaneosUsadosHoy() + 1);
}

let ptZoomDigital=1,ptZoomNativo=false,ptModoFoto='diagnostico';
async function abrirCamara(modo='diagnostico'){
  ptModoFoto=modo;const cam=$('cam');cam.classList.add('on');ptOverlayOpen('cam');
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Cámara no disponible. Usa HTTPS o localhost.');
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    video.srcObject=stream;await video.play();zoomTrack=stream.getVideoTracks()[0];
    const cap=zoomTrack.getCapabilities?.();const z=cap?.zoom;const slider=$('zoom');
    ptZoomNativo=!!(z&&Number.isFinite(z.min)&&Number.isFinite(z.max));
    slider.min=ptZoomNativo?z.min:1;slider.max=ptZoomNativo?z.max:3;
    slider.step=ptZoomNativo?(z.step||0.1):0.1;slider.value=ptZoomNativo?Math.max(z.min,Math.min(1,z.max)):1;
    ptZoomDigital=1;video.style.transform='';
  }catch(e){cerrarCamara();mostrarToast(e?.name==='NotAllowedError'?'Permiso de cámara denegado. Actívalo en los ajustes del navegador.':'No se pudo abrir la cámara: '+(e.message||e));}
}
function cerrarCamara(paraProcesarFoto=false){
  if(stream)stream.getTracks().forEach(t=>t.stop());
  stream=null;zoomTrack=null;video.srcObject=null;video.style.transform='';
  $('cam').classList.remove('on');
  if(paraProcesarFoto){
    // Al pasar de la cámara al resultado NO hacer history.back():
    // un popstate pendiente cerraba el diálogo recién abierto.
    // Sustituimos la entrada de cámara por una entrada normal, sin modal.
    if(history.state?.ptOverlay==='cam'){
      const estado={...history.state};
      delete estado.ptOverlay;
      history.replaceState(estado,'',location.href);
    }
  }else{
    ptOverlayClose('cam');
  }
}
async function aplicarZoom(v){const n=Number(v);if(ptZoomNativo&&zoomTrack){try{await zoomTrack.applyConstraints({advanced:[{zoom:n}]});return}catch(e){ptZoomNativo=false;}}ptZoomDigital=n;video.style.transform='scale('+n+')';video.style.transformOrigin='center'}
function ptFotoCanvas(){const c=document.createElement('canvas');const w=video.videoWidth,h=video.videoHeight;if(!w||!h)throw Error('La cámara todavía no está lista');c.width=w;c.height=h;const ctx=c.getContext('2d');if(!ptZoomNativo&&ptZoomDigital>1){const sw=w/ptZoomDigital,sh=h/ptZoomDigital;ctx.drawImage(video,(w-sw)/2,(h-sh)/2,sw,sh,0,0,w,h)}else ctx.drawImage(video,0,0);return c;}
function capturar(){try{const c=ptFotoCanvas();const modo=ptModoFoto;cerrarCamara(true);c.toBlob(b=>{if(b)(modo==='identificar'?identificarSolamente(b):analizar(b));},'image/jpeg',0.85)}catch(e){mostrarToast(e.message)}}
async function subir(ev){const f=ev.target.files?.[0];const modo=ptModoFoto;ev.target.value='';if(f){cerrarCamara(true);await (modo==='identificar'?identificarSolamente(f):analizar(f));}}
function iniciarModoIdentificacion(){return abrirCamara('identificar')}
function abrirConsejos(){$('modalConsejos').classList.add('on');ptOverlayOpen('modalConsejos')}
function cerrarConsejos(){$('modalConsejos').classList.remove('on');ptOverlayClose('modalConsejos')}

// PASO 1: COMPRESIÓN AGRESIVA DE IMAGEN EN EL MÓVIL
async function prepararBlob(b) {
  try {
    const bmp = await createImageBitmap(b);
    // Reducimos la dimensión máxima a 1024px (suficiente para identificar la planta)
    const maxPx = 1024;
    const escala = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * escala);
    c.height = Math.round(bmp.height * escala);
    
    const ctx = c.getContext('2d');
    // Desactivamos el suavizado complejo para acelerar el procesamiento en procesadores móviles
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    
    // Comprimimos la calidad JPEG al 75% (reduce el peso de varios MBs a ~150KB)
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
  } catch (e) {
    console.warn("Fallback de compresión:", e);
    return b;
  }
}

// v110.1 — Progreso visual durante el diagnóstico, sin peticiones adicionales.
// Estos mensajes describen la espera, NO porcentajes ni fases reales del servidor.
let ptSaludTemporizador=null;
const PT_SALUD_MENSAJES=[
  ['Estamos comprobando la salud de su planta', 'Observando los detalles de la fotografía…'],
  ['Estamos preparando el informe', 'Organizando la información y los cuidados…'],
  ['Revisando las recomendaciones', 'Unos instantes más, por favor…']
];
function ptSaludProgresoMensaje(titulo,subtitulo){
  const t=$('ptSaludProgresoTitulo'), s=$('ptSaludProgresoSubtitulo');
  if(t)t.textContent=titulo;
  if(s)s.textContent=subtitulo;
}
function ptSaludProgresoDetener(){
  if(ptSaludTemporizador!==null){clearInterval(ptSaludTemporizador);ptSaludTemporizador=null;}
  const wrap=$('resFotoWrap');
  if(wrap)wrap.classList.remove('scanning','pt-salud-completado');
  $('s-resultado')?.classList.remove('pt-salud-en-proceso');
}
function ptSaludProgresoIniciar(){
  ptSaludProgresoDetener();
  const wrap=$('resFotoWrap');
  if(!wrap)return;
  wrap.classList.add('scanning');
  $('s-resultado')?.classList.add('pt-salud-en-proceso');
  let paso=0;
  ptSaludProgresoMensaje(...PT_SALUD_MENSAJES[0]);
  ptSaludTemporizador=setInterval(()=>{
    if(!wrap.classList.contains('scanning'))return ptSaludProgresoDetener();
    paso=(paso+1)%PT_SALUD_MENSAJES.length;
    ptSaludProgresoMensaje(...PT_SALUD_MENSAJES[paso]);
  },3500);
}
async function ptSaludProgresoCompletar(){
  if(ptSaludTemporizador!==null){clearInterval(ptSaludTemporizador);ptSaludTemporizador=null;}
  const wrap=$('resFotoWrap');
  if(!wrap)return;
  wrap.classList.add('pt-salud-completado');
  ptSaludProgresoMensaje('Escaneo completo', 'Ya tenemos el resultado de salud.');
  await new Promise(resolve=>setTimeout(resolve,950));
}

async function analizar(blobO,continuacion=null,historialId=null,identificacionOriginal=null){
  if(!blobO) return;
  // La cuota se verifica en FastAPI, antes de consultar servicios externos.
  if(analisisEnCurso) return;
  analisisEnCurso = true;
  ptHistorialDetalleActivo=null;ptHistLiberarDetalle();
  const volverBoton=document.querySelector('#s-resultado .btn-back');if(volverBoton)volverBoton.textContent='← Volver';
  const botonGuardar=$('btnAddJardin');if(botonGuardar)botonGuardar.style.display='';
  bloqueoActivo = false;
  const blob=continuacion?blobO:await prepararBlob(blobO);
  ultimoBlob=blob;
  
  // Mostrar pantalla de resultado con estado de carga
  show('resultado');
  $('resFoto').src=URL.createObjectURL(blob);
  ptSaludProgresoIniciar();
  $('resNombre').textContent='Analizando...';
  $('resComun').textContent='';
  $('resAlerta').innerHTML='<span class="icon">⏳</span>Procesando imagen';
  $('resPatogeno').style.display='none';
  $('resDiagnostico').style.display='none';
  $('resRecomendaciones').innerHTML='<p style="color:#757575">Espera un momento...</p>';
  
  const fd=new FormData();
  fd.append('imagen',blob,'foto.jpg');
  
  try{
    const r=await fetch('/analizar',{method:'POST',body:fd,headers:continuacion?{'X-Plantorum-Continuation':continuacion}:{}});
    if(!r.ok){
      let mensaje='Error del servidor ('+r.status+')';
      try {
        const errorData=await r.json();
        if(errorData && errorData.detail) mensaje=errorData.detail;
      } catch(e) {}
      throw new Error(mensaje);
    }
    const d=await r.json();
    // Solo mostramos «Escaneo completo» después de recibir un diagnóstico válido.
    await ptSaludProgresoCompletar();
    ptSaludProgresoDetener();
    // Cuota contabilizada en el servidor.
    pintar(d);
    await ptHistGuardarSalud(blob,d,historialId,identificacionOriginal);
  }catch(e){
    ptSaludProgresoDetener();
    $('resNombre').textContent='❌ Error';
    $('resComun').textContent=e.message;
    $('resAlerta').innerHTML='<span class="icon">❌</span>Error al analizar';
    $('resRecomendaciones').innerHTML='<p style="color:#F44336">No se pudo completar el análisis. Intenta de nuevo.</p>';
  }finally{
    ptSaludProgresoDetener();
    analisisEnCurso = false;
  }
}

// Evita registrar dos veces la MISMA fotografía de la MISMA especie.
// No fusiona plantas distintas por compartir nombre (por ejemplo, dos lavandas).
async function ptBuscarPlantaConMismaFoto(dataUrl, nombre) {
  const objetivo=String(nombre||'').trim().toLocaleLowerCase('es');
  for(const planta of LS.get('plantas',[])) {
    if(String(planta.data?.especie?.nombre_comun||'').trim().toLocaleLowerCase('es')!==objetivo)continue;
    const guardada=planta.img||await DB.obtenerFoto(planta.id);
    if(guardada && guardada===dataUrl)return planta;
  }
  return null;
}

// GUARDAR PLANTA (Foto a IndexedDB, datos a localStorage)
function guardarJardin(blob, d) {
  const r = new FileReader();
  r.onload = async () => {
    const idPlanta = Date.now();
    const base64Img = r.result;

    // No duplicar el mismo escaneo si se guarda desde dos pantallas.
    if(await ptBuscarPlantaConMismaFoto(base64Img,d?.especie?.nombre_comun)) {
      mostrarToast('Esta fotografía ya está guardada en Mi Jardín.');
      return;
    }
    // 1. Guardar la imagen pesada en IndexedDB
    await DB.guardarFoto(idPlanta, base64Img);

    // 2. Guardar en localStorage solo los metadatos livianos
    const p = LS.get('plantas', []);
    if (!d.recordatorio) d.recordatorio={frecuencia:7,ultimaVez:null,proxima:null};
    p.unshift({
      id: idPlanta,
      data: d,
      fecha: idPlanta,
      locked: bloqueoActivo
    });

    if (p.length > 30) {
      const eliminada = p.pop();
      if (eliminada) DB.eliminarFoto(eliminada.id); // Limpiar foto sobrante
    }

    LS.set('plantas', p);
    pintarJardin();
    comprobarAvisosRiego();
  };
  r.readAsDataURL(blob);
}

// RENDERIZAR JARDÍN (Carga asíncrona de imágenes desde IndexedDB)
async function pintarJardin() {
  const p = LS.get('plantas', []).filter(x => Number.isSafeInteger(x.id) && x.id >= 0);
  const vacioEl = $('jardinVacio');
  if (vacioEl) vacioEl.style.display = p.length ? 'none' : 'block';

  p.sort((a, b) => {
    const nextA = a.data.recordatorio?.proxima || 0;
    const nextB = b.data.recordatorio?.proxima || 0;
    return nextA - nextB;
  });

  const contenedor = $('jardin');
  if (!contenedor) return;

  // Generar HTML base con marcadores de posición para las imágenes
  contenedor.innerHTML = p.map(x => {
    const s = x.data.salud || {};
    const colorEstado = s.estado === 'saludable' ? '#22c55e' : (s.estado === 'atencion' ? '#f59e0b' : '#ef4444');
    const nom = x.data.especie?.nombre_comun || 'Planta';
    const safeNom = ptSafeText(nom);

    const rec = x.data.recordatorio || { frecuencia: 7, ultimaVez: Date.now(), proxima: Date.now() + 7*86400000 };
    const hoy = Date.now();
    const diffDias = Math.ceil((rec.proxima - hoy) / 86400000);

    let textoRiego = `💧 ${diffDias}d`;
    let colorRiego = '#374151';

    if (diffDias <= 0) {
      textoRiego = diffDias === 0 ? '💧 ¡Hoy!' : '💧 Atrasado';
      colorRiego = '#dc2626';
    } else if (diffDias === 1) {
      textoRiego = '💧 Mañana';
      colorRiego = '#d97706';
    }

    return `
      <div class="planta" onclick="verDetalle(${x.id})">
        <button class="borrar" onclick="event.stopPropagation();eliminarPlanta(${x.id})">✕</button>
        
        <button class="pt-evo-link" onclick="event.stopPropagation();abrirEvolucion(${x.id})" title="Ver evolución fotográfica">📷 Evolución</button>
        <button class="pt-config-riego" onclick="event.stopPropagation();abrirConfiguracionRiego(${x.id})" title="Configurar aviso de riego">⚙️ Riego</button>
        <button class="badge-riego-glass" onclick="event.stopPropagation();regarPlanta(${x.id})" style="color:${colorRiego}" title="Marcar como regada">
          ${textoRiego}
        </button>

        <img id="img-planta-${x.id}" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' fill='%23e5e7eb'><rect width='100%' height='100%'/></svg>" alt="${safeNom}">
        
        <div class="txt-gradiente">
          <div class="planta-nombre">
            <span class="punto" style="background:${colorEstado}"></span>
            <span class="nombre-texto">${safeNom}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  await pintarRecientesPlantorum(p);

  // Lecturas independientes en paralelo: evita esperas secuenciales.
  await Promise.all(p.map(async x => {
    const foto=x.img || await DB.obtenerFoto(x.id);
    const imgEl=$(`img-planta-${x.id}`);
    if(foto && imgEl)imgEl.src=foto;
  }));
}


// Tarjetas recientes: mismas plantas e imágenes que Mi Jardín, sin datos de ejemplo.
async function pintarRecientesPlantorum(plantas) {
  const seccion=document.getElementById('ptRecent');
  const rejilla=document.getElementById('ptRecentGrid');
  if(!seccion||!rejilla)return;
  // El listado reciente no muestra dos veces una fotografía idéntica.
  // No se borran registros antiguos ni se confunden dos plantas diferentes.
  const ordenadas=[...plantas].sort((a,b)=>(b.id||0)-(a.id||0));
  const vistas=new Set();
  const recientes=[];
  for(const p of ordenadas){
    const img=p.img||await DB.obtenerFoto(p.id);
    const nombre=String(p.data?.especie?.nombre_comun||'Planta').trim().toLocaleLowerCase('es');
    const clave=img?nombre+'|'+img:null;
    if(clave && vistas.has(clave))continue;
    if(clave)vistas.add(clave);
    recientes.push({p,img});
    if(recientes.length===3)break;
  }
  seccion.hidden=recientes.length===0;
  rejilla.replaceChildren();
  for(const {p,img} of recientes){
    const card=document.createElement('button');card.type='button';card.className='pt-recent-card';
    card.addEventListener('click',()=>verDetalle(p.id));
    const foto=document.createElement('img');foto.alt='Fotografía de la planta';foto.loading='lazy';
    if(img)foto.src=img;else foto.style.display='none';
    const name=document.createElement('strong');name.textContent=p.data?.especie?.nombre_comun||'Planta';
    const state=document.createElement('small');
    const estado=p.data?.salud?.estado;
    state.textContent=estado==='saludable'?'● Saludable':estado==='atencion'?'● Requiere atención':estado==='critico'?'● Estado crítico':'● Sin clasificar';
    state.className='pt-state-'+(estado||'unknown');
    card.append(foto,name,state);rejilla.append(card);
  }
}

// ELIMINAR PLANTA
async function eliminarPlanta(id) {
  const p=LS.get('plantas',[]).find(x=>x.id===id);
  if(!p)return;
  if(!await ptConfirmar('¿Eliminar esta planta y todas sus fotografías de evolución?'))return;
  LS.set('plantas',LS.get('plantas',[]).filter(x=>x.id!==id));
  await DB.eliminarFoto(id);
  for(const foto of p.evolucion||[])await DB.eliminarFoto(foto.id);
  await pintarJardin();comprobarAvisosRiego();
}

function regarPlanta(id) {
  const plantas = LS.get('plantas', []);
  const idx = plantas.findIndex(x => x.id === id);
  if (idx !== -1) {
    const p = plantas[idx];
    // Si no tiene recordatorio, lo creamos (frecuencia 7 días)
    if (!p.data.recordatorio) {
      p.data.recordatorio = {frecuencia: 7};
    }
    // Actualizamos: última vez = ahora, próxima = ahora + frecuencia
    const ahora = Date.now();
    p.data.recordatorio.ultimaVez = ahora;
    p.data.recordatorio.proxima = ahora + (p.data.recordatorio.frecuencia * 86400000);
    
    LS.set('plantas', plantas);
    pintarJardin(); // Refrescar vista
    mostrarToast("💧 Riego registrado. Próximo aviso actualizado.");
  }
}
function cambiarFrecuencia(delta) {
  if (!idPlantaActual) return;
  const plantas = LS.get('plantas', []);
  const idx = plantas.findIndex(x => x.id === idPlantaActual);
  if (idx !== -1) {
    const p = plantas[idx];
    if (!p.data.recordatorio) p.data.recordatorio = {frecuencia: 7, ultimaVez: Date.now() - 86400000*7, proxima: Date.now()};
    
    let nuevaFreq = p.data.recordatorio.frecuencia + delta;
    if (nuevaFreq < 1) nuevaFreq = 1;
    if (nuevaFreq > 30) nuevaFreq = 30;
    
    p.data.recordatorio.frecuencia = nuevaFreq;
    // Recalcular próxima fecha desde la última vez que se regó
    if (p.data.recordatorio.ultimaVez) {
      p.data.recordatorio.proxima = p.data.recordatorio.ultimaVez + (nuevaFreq * 86400000);
    }
    
    LS.set('plantas', plantas);
    const el = document.getElementById('freqValor');
    if (el) el.textContent = nuevaFreq + (nuevaFreq === 1 ? ' día' : ' días');
  }
}
function timeAgo(timestamp) {
  const segundos = Math.floor((Date.now() - timestamp) / 1000);
  const dias = Math.floor(segundos / 86400);
  if (dias === 0) return 'Hoy';
  if (dias === 1) return 'Ayer';
  if (dias < 30) return `Hace ${dias} días`;
  return `Hace ${Math.floor(dias/30)} meses`;
}

function setFrecuencia(dias) {
  if (!idPlantaActual) return;
  const plantas = LS.get('plantas', []);
  const idx = plantas.findIndex(x => x.id === idPlantaActual);
  if (idx !== -1) {
    const p = plantas[idx];
    if (!p.data.recordatorio) p.data.recordatorio = {frecuencia: 7, ultimaVez: Date.now() - 86400000*7, proxima: Date.now()};
    p.data.recordatorio.frecuencia = parseInt(dias);
    if (p.data.recordatorio.ultimaVez) {
      p.data.recordatorio.proxima = p.data.recordatorio.ultimaVez + (parseInt(dias) * 86400000);
    }
    LS.set('plantas', plantas);
    // No redibujamos toda la pestaña, solo actualizamos el valor en el jardín si volvemos
  }
}
// VER DETALLE
async function verDetalle(id) {
  const p = LS.get('plantas', []).find(x => x.id === id);
  if (p) {
    if(p.data?.solo_identificacion){
      const foto=p.img||await DB.obtenerFoto(id);
      ptIdentificacionActual=null;
      $('ptIdNombre').textContent=p.data.especie?.nombre_comun||'Planta';
      $('ptIdCientifico').textContent=p.data.especie?.nombre_cientifico||'';
      $('ptIdConfianza').textContent=typeof p.data.confianza_identificacion==='number'?'Confianza estimada: '+Math.round(p.data.confianza_identificacion*100)+' %':'';
      $('ptIdError').textContent='Identificación guardada · salud no analizada';
      $('ptIdFoto').src=foto||'';
      $('ptIdGuardar').disabled=true;$('ptIdGuardar').textContent='✓ Guardada en Mi Jardín';
      $('ptIdSalud').disabled=!foto;
      if(foto){const res=await fetch(foto);ptIdentificacionActual={blob:await res.blob(),guardada:true};}
      const modal=$('ptIdentificacion');modal.hidden=false;modal.style.setProperty('display','flex','important');modal.style.setProperty('visibility','visible','important');ptOverlayOpen('ptIdentificacion');return;
    }
    bloqueoActivo = (tier() === 'free' && !!p.locked);
    volverA = 'jardin';
    idPlantaActual = id;

    // Obtener la foto desde DB o fallback previo
    const foto = p.img || await DB.obtenerFoto(id);
    if (foto) {
      $('resFoto').src = foto;
      fetch(foto).then(r => r.blob()).then(b => ultimoBlob = b);
    }

    modoJardin = 'view';
    pintar(p.data);
    show('resultado');
  }
  modoJardin = 'view';
  const b2 = $('btnAddJardin');
  if (b2) b2.textContent = '🌿 Ver en Mi Jardín';
}

async function pedirInforme(){if(!ultimoBlob){mostrarToast('Primero escanea una planta.');return}if(tier()!=='pro'){mostrarToast('Los informes PDF estarán disponibles cuando se habiliten los pagos.');return;}mostrarToast('Generando informe...');const fd=new FormData();fd.append('imagen',ultimoBlob,'foto.jpg');try{const r=await fetch('/informe',{method:'POST',body:fd});if(!r.ok)throw new Error('Error '+r.status);const d=await r.json();const a=document.createElement('a');a.href=d.url;a.download='informe_plantorum.pdf';document.body.appendChild(a);a.click();document.body.removeChild(a);mostrarToast('✅ Informe descargado')}catch(e){mostrarToast('Error informe: '+e.message)}}

const GUIAS=[
{g:'De interior',n:'Potos',r:'Riega cuando esté seco arriba',l:'Luz indirecta',w:'Epipremnum aureum'},
{g:'De interior',n:'Monstera',r:'Sustrato húmedo, sin charcos',l:'Luz brillante',w:'Monstera deliciosa'},
{g:'De interior',n:'Lengua de suegra',r:'Muy escaso',l:'Poca luz',w:'Sansevieria trifasciata'},
{g:'De interior',n:'Aloe vera',r:'Sustrato seco',l:'Pleno sol',w:'Aloe vera'},
{g:'De interior',n:'Orquídea',r:'Inmersión semanal, sin charcos',l:'Luz indirecta',w:'Phalaenopsis'},
{g:'De interior',n:'Helecho',r:'Frecuente, sustrato húmedo',l:'Sombra o semisombra',w:'Nephrolepis exaltata'},
{g:'De exterior',n:'Olivo',r:'Escaso',l:'Pleno sol',w:'Olea europaea'},
{g:'De exterior',n:'Lavanda',r:'Escaso',l:'Pleno sol',w:'Lavandula'},
{g:'De exterior',n:'Romero',r:'Escaso',l:'Pleno sol',w:'Salvia rosmarinus'},
{g:'De exterior',n:'Geranio',r:'Moderado, sin charcos',l:'Pleno sol',w:'Pelargonium'},
{g:'De exterior',n:'Rosal',r:'Regular, al pie',l:'Pleno sol',w:'Rosa'},
{g:'De exterior',n:'Adelfa',r:'Moderado',l:'Pleno sol',w:'Nerium oleander'},
{g:'De exterior',n:'Buganvilla',r:'Escaso',l:'Pleno sol',w:'Bougainvillea'},
{g:'De exterior',n:'Limonero',r:'Regular',l:'Pleno sol',w:'Citrus × limon'},
{g:'De exterior',n:'Almendro',r:'Escaso',l:'Pleno sol',w:'Prunus dulcis'},
{g:'De exterior',n:'Higuera',r:'Moderado',l:'Pleno sol',w:'Ficus carica'},
{g:'De exterior',n:'Hortensia',r:'Abundante',l:'Semisombra',w:'Hydrangea'},
{g:'De exterior',n:'Cactus',r:'Muy escaso',l:'Pleno sol',w:'Cactaceae'}
];
// Plantorum v89: biblioteca botánica local, con contenidos locales.
const PT_GUIA_DETALLES={
'Potos':['Fácil','Interior','Evita el sol directo fuerte. Deja secar la capa superior del sustrato antes de regar.','Tóxica para perros y gatos.'],
'Monstera':['Fácil','Interior','Necesita luz indirecta abundante, tutor si trepa y sustrato aireado.','Tóxica para perros y gatos.'],
'Lengua de suegra':['Fácil','Interior','Deja secar bien el sustrato entre riegos. El exceso de agua pudre las raíces.','Tóxica para perros y gatos.'],
'Aloe vera':['Fácil','Interior / exterior','Sustrato muy drenante y abundante luz; aclimata gradualmente al sol intenso.','Puede ser tóxica para perros y gatos si la ingieren.'],
'Orquídea':['Media','Interior','Riega según el estado de raíces y sustrato, no por calendario rígido. Evita agua estancada.','Las Phalaenopsis se consideran generalmente no tóxicas para perros y gatos.'],
'Helecho':['Media','Interior','Agradece humedad ambiental y sustrato ligeramente húmedo sin encharcar.','El helecho de Boston se considera generalmente no tóxico para perros y gatos.'],
'Olivo':['Fácil','Exterior','Necesita sol directo y buen drenaje. En maceta vigila más el secado del sustrato.','Sin toxicidad habitual relevante, pero no permitas ingerir tratamientos agrícolas.'],
'Lavanda':['Media','Exterior','Sol directo, sustrato drenante y riego moderado a escaso. Evita el exceso de humedad.','Puede causar molestias digestivas a mascotas si la ingieren.'],
'Romero':['Fácil','Exterior','Sol directo y tierra drenante. Tolera mejor la sequía que el encharcamiento.','Generalmente no tóxico para perros y gatos.'],
'Geranio':['Fácil','Exterior','Mucho sol y riego cuando la superficie empiece a secarse. Retira flores marchitas.','Pelargonium es tóxico para perros y gatos.'],
'Rosal':['Media','Exterior','Sol, ventilación y riego al pie. Revisa pulgones y manchas en las hojas.','Las espinas pueden causar heridas.'],
'Adelfa':['Media','Exterior','Pleno sol y riego adaptado al calor. Usa guantes al podar.','MUY TÓXICA para personas y mascotas en todas sus partes.'],
'Buganvilla':['Media','Exterior','Sol directo, drenaje y riego sin exceso. Protege de heladas fuertes.','Las espinas pueden causar heridas.'],
'Limonero':['Media','Exterior','Sol, abonado específico en temporada y riego profundo sin charcos.','Algunas partes y aceites cítricos pueden ser problemáticos para mascotas.'],
'Almendro':['Media','Exterior','Necesita sol, suelo drenante y cuidados adaptados a edad y clima.','No consumas almendras amargas ni partes no comestibles.'],
'Higuera':['Fácil','Exterior','Sol y riego moderado, especialmente durante el crecimiento en maceta.','La savia puede irritar piel y mucosas; precaución con mascotas.'],
'Hortensia':['Media','Exterior','Prefiere luz suave, humedad constante sin charcos y protección del sol fuerte.','Tóxica para perros y gatos.'],
'Cactus':['Fácil','Interior / exterior','Necesita sustrato mineral drenante y secado completo entre riegos.','Las espinas pueden causar heridas; toxicidad según especie.']
};
const PT_GUIA_ARTICULOS=[
['💧','Cómo regar correctamente','Comprueba la humedad introduciendo un dedo unos centímetros en el sustrato. Riega a fondo cuando la especie lo necesite y deja escurrir el exceso. No existe un intervalo universal.'],
['☀️','Cómo elegir la luz','Observa si la planta necesita sol directo o luz filtrada. Los cambios bruscos de exposición pueden quemar las hojas. Aclimata poco a poco.'],
['🪴','Cuándo trasplantar','Revisa si las raíces salen por los agujeros, el sustrato se compacta o el crecimiento se detiene. Usa una maceta solo ligeramente mayor y buen drenaje.'],
['🌱','Sustrato y drenaje','La mezcla adecuada depende de la especie: aireada para tropicales, mineral para suculentas y retenedora de humedad para plantas exigentes en agua.'],
['✂️','Poda y mantenimiento','Retira hojas dañadas con herramientas limpias. La poda intensa debe ajustarse a la especie y estación; no podes una planta debilitada sin conocer la causa.'],
['🧪','Abonado responsable','Abona principalmente durante el crecimiento activo y siguiendo la dosis del fabricante. No abones en exceso una planta estresada o con raíces dañadas.']
];
const PT_GUIA_SINTOMAS=[
['Hojas amarillas','Puede deberse a exceso o falta de agua, envejecimiento natural o problemas de luz. Comprueba primero humedad, drenaje y raíces.'],
['Puntas marrones','Puede relacionarse con sequedad ambiental, riego irregular, acumulación de sales o sol excesivo. Revisa el contexto antes de actuar.'],
['Hojas caídas','Comprueba si el sustrato está demasiado seco o empapado; observa tallos y raíces. También puede ocurrir tras cambios bruscos.'],
['Manchas en hojas','Aísla si sospechas plaga o enfermedad. Revisa ambas caras de la hoja, humedad, ventilación y evolución de las manchas.'],
['Bichitos o telarañas','Inspecciona envés, brotes y tallos; podrían ser ácaros, pulgones o cochinillas. Evita aplicar tratamientos sin identificar el problema.'],
['No crece','Valora estación, luz, raíces, tamaño de maceta, nutrientes y temperatura. Muchas plantas reducen su crecimiento en invierno.']
];
let ptGuiaFiltro='Todas',ptGuiaBusqueda='';
function ptEsc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function ptGuiaImagen(i){const key='wg_'+i,cache=LS.get(key,'');return cache?`<img class="pt-g-img" data-key="${key}" src="${ptEsc(cache)}" alt="${ptEsc(GUIAS[i].n)}" loading="lazy">`:`<div class="pt-g-img pt-g-placeholder" data-key="${key}">🌿</div>`;}
function ptActualizarBusquedaGuia(campo){
 const inicio=campo.selectionStart,fin=campo.selectionEnd;
 ptGuiaBusqueda=campo.value;
 pintarGuias();
 const nuevo=document.getElementById('ptGuiaBuscar');
 if(nuevo){nuevo.focus();try{nuevo.setSelectionRange(inicio,fin)}catch(e){}}
}
function pintarGuias(){
 const root=$('guias');if(!root)return;
 const count=GUIAS.filter(p=>(ptGuiaFiltro==='Todas'||p.g===ptGuiaFiltro)&&(`${p.n} ${p.w}`.toLocaleLowerCase('es').includes(ptGuiaBusqueda.toLocaleLowerCase('es')))).length;
 root.innerHTML=`<div class="pt-guide-hero"><span class="pt-guide-eyebrow">BIBLIOTECA BOTÁNICA</span><h2>Aprende a cuidar cada hoja</h2><p>Especies, cuidados y soluciones sencillas para cada planta.</p><div class="pt-guide-search">🔎 <input id="ptGuiaBuscar" type="search" placeholder="Buscar por nombre o especie..." value="${ptEsc(ptGuiaBusqueda)}" oninput="ptActualizarBusquedaGuia(this)"></div></div>
 <div class="pt-guide-tabs">${['Todas','De interior','De exterior'].map(v=>`<button class="${ptGuiaFiltro===v?'active':''}" onclick="ptGuiaFiltro='${v}';pintarGuias()">${v}</button>`).join('')}</div>
 <div class="pt-guide-section-title"><h3>Explora las plantas</h3><small>${count} especies</small></div>
 <div class="pt-guide-grid">${GUIAS.map((p,i)=>({p,i})).filter(({p})=>(ptGuiaFiltro==='Todas'||p.g===ptGuiaFiltro)&&(`${p.n} ${p.w}`.toLocaleLowerCase('es').includes(ptGuiaBusqueda.toLocaleLowerCase('es')))).map(({p,i})=>`<button class="pt-guide-card" onclick="ptAbrirFicha(${i})">${ptGuiaImagen(i)}<span class="pt-guide-card-body"><b>${ptEsc(p.n)}</b><em>${ptEsc(p.w)}</em><small>☀️ ${ptEsc(p.l)}</small></span><span class="pt-guide-arrow">↗</span></button>`).join('')||'<p class="pt-guide-empty">No encontramos plantas con ese nombre.</p>'}</div>
 <div class="pt-guide-section-title"><h3>Aprende paso a paso</h3><small>6 consejos</small></div><div class="pt-guide-articles">${PT_GUIA_ARTICULOS.map((a,i)=>`<button class="pt-guide-article" onclick="ptAbrirArticulo(${i})"><span>${a[0]}</span><b>${a[1]}</b><span>→</span></button>`).join('')}</div>
 <div class="pt-guide-section-title"><h3>¿Qué le pasa a mi planta?</h3></div><p class="pt-guide-intro">Selecciona lo que observas para conocer posibles causas. No sustituye un diagnóstico.</p><div class="pt-guide-symptoms">${PT_GUIA_SINTOMAS.map((x,i)=>`<button onclick="ptAbrirSintoma(${i})">${ptEsc(x[0])} ↗</button>`).join('')}</div>
 <div class="pt-guide-season"><b>🍂 Consejos de ${new Date().toLocaleDateString('es-ES',{month:'long'})}</b><p>${ptConsejoEstacion()}</p></div>
 <div class="pt-guide-section-title"><h3>En tu jardín</h3></div><div class="pt-guide-garden">${ptGuiasJardin()}</div>`;
 GUIAS.forEach((p,i)=>fotoGuia(p.w,'wg_'+i));
}
function ptConsejoEstacion(){const m=new Date().getMonth();return m>=8&&m<=10?'En otoño, revisa la humedad antes de regar y protege las especies sensibles cuando bajen las temperaturas.':m>=11||m<=1?'En invierno, muchas especies necesitan menos agua. Vigila heladas, calefacción y falta de luz.':m<=4?'En primavera, revisa raíces, plagas y necesidades de abonado durante el crecimiento activo.':'En verano, comprueba la humedad con más frecuencia y protege del sol intenso las plantas sensibles.';}
function ptGuiasJardin(){const ps=LS.get('plantas',[]);if(!ps.length)return '<p>Aún no tienes plantas guardadas. Identifica una y añádela a Mi Jardín para consultar sus cuidados aquí.</p>';return ps.map(x=>{const e=x.data?.especie||{},n=e.nombre_comun||'Mi planta',c=e.nombre_cientifico||'';let i=GUIAS.findIndex(p=>p.w.toLowerCase()===c.toLowerCase()||p.n.toLowerCase()===n.toLowerCase());return `<div class="pt-guide-garden-row"><span>🌿 ${ptEsc(n)}</span>${i>=0?`<button onclick="ptAbrirFicha(${i})">Ver ficha →</button>`:'<small>Sin ficha local todavía</small>'}</div>`}).join('');}
function ptAbrirFicha(i){const p=GUIAS[i],d=PT_GUIA_DETALLES[p.n]||['Variable',p.g,'Consulta los cuidados según la especie concreta.','Comprueba la toxicidad de la especie concreta.'];ptAbrirModalGuia(`<div class="pt-guide-detail-image">${ptGuiaImagen(i)}</div><span class="pt-guide-eyebrow">${ptEsc(p.g)} · ${ptEsc(d[0])}</span><h2>${ptEsc(p.n)}</h2><i>${ptEsc(p.w)}</i><div class="pt-guide-facts"><div><b>☀️ Luz</b><p>${ptEsc(p.l)}</p></div><div><b>💧 Riego</b><p>${ptEsc(p.r)}</p></div></div><h3>Cómo cuidarla</h3><p>${ptEsc(d[2])}</p><h3>🐾 Mascotas y precauciones</h3><p>${ptEsc(d[3])}</p><p class="pt-guide-disclaimer">Orientaciones generales: adapta el riego al clima, la maceta y la humedad real del sustrato.</p>`);}
function ptAbrirArticulo(i){const a=PT_GUIA_ARTICULOS[i];ptAbrirModalGuia(`<span class="pt-guide-eyebrow">GUÍA PRÁCTICA</span><h2>${a[0]} ${ptEsc(a[1])}</h2><p>${ptEsc(a[2])}</p><p class="pt-guide-disclaimer">Observa siempre las necesidades de la especie antes de aplicar un consejo general.</p>`);}
function ptAbrirSintoma(i){const a=PT_GUIA_SINTOMAS[i];ptAbrirModalGuia(`<span class="pt-guide-eyebrow">ORIENTADOR DE SÍNTOMAS</span><h2>${ptEsc(a[0])}</h2><p>${ptEsc(a[1])}</p><p class="pt-guide-disclaimer">Estas son posibilidades, no un diagnóstico. Para evaluar una fotografía utiliza la función Analizar de Plantorum.</p>`);}
function ptAbrirModalGuia(html){let el=$('ptGuiaModal');if(!el){el=document.createElement('div');el.id='ptGuiaModal';el.className='pt-guide-overlay';el.innerHTML='<section class="pt-guide-dialog" role="dialog" aria-modal="true" aria-label="Información de la guía"><button class="pt-guide-close" onclick="ptCerrarModalGuia()" aria-label="Cerrar">✕</button><div id="ptGuiaContenido"></div></section>';document.body.appendChild(el);el.addEventListener('click',e=>{if(e.target===el)ptCerrarModalGuia()});} $('ptGuiaContenido').innerHTML=html;el.hidden=false;document.body.style.overflow='hidden';ptOverlayOpen('ptGuiaModal');}
function ptCerrarModalGuia(){const el=$('ptGuiaModal');if(el)el.hidden=true;document.body.style.overflow='';ptOverlayClose('ptGuiaModal');}
const ptGuiaPendientes=new Set();
const ptGuiaIntentados=new Set();
async function fotoGuia(w,key){
  if(LS.get(key,'')||ptGuiaPendientes.has(key)||ptGuiaIntentados.has(key))return;
  ptGuiaPendientes.add(key);ptGuiaIntentados.add(key);
  try{const r=await fetch('https://es.wikipedia.org/api/rest_v1/page/summary/'+encodeURIComponent(w));if(!r.ok)return;const d=await r.json();const url=d.thumbnail&&d.thumbnail.source;if(!url)return;LS.set(key,url);const el=document.querySelector('[data-key="'+key+'"]');if(el){const img=new Image();img.className='pt-g-img';img.setAttribute('data-key',key);img.src=url;el.replaceWith(img);}}catch(e){}finally{ptGuiaPendientes.delete(key);}}
function datosEspecie(d){const e=d.especie||{};const pn=(e.plantnet&&e.plantnet[0])?e.plantnet[0]:null;const lo=(e.local&&e.local[0])?e.local[0]:null;
let nom=e.nombre_comun||(pn?pn.nombre_comun:'');let cient=e.nombre_cientifico||(pn?pn.nombre_cientifico:'');
if(!nom&&lo)nom=lo.clase;if(!nom||nom.toLowerCase()==='no identificada')nom='Planta';
const genero=cient?cient.split(' ')[0]:(e.genero||'');return{nom,cient,genero}}

const ptSafeText=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const item=(ico,t,desc,sub)=>'<div class="info-item"><div class="icon">'+ico+'</div><div class="content"><div class="title">'+ptSafeText(t)+'</div>'+(desc?'<div class="desc">'+ptSafeText(desc)+'</div>':'')+(sub?'<div class="sub">'+ptSafeText(sub)+'</div>':'')+'</div></div>';
const card=(h,inner)=>'<div class="card-section"><h3>'+h+'</h3><div class="info-card">'+inner+'</div></div>';

function cambiarTab(tab,el){tabActual=tab;document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));if(el)el.classList.add('active');if(datosActuales)renderTabContent(datosActuales)}

function renderTabContent(d){
  const c=$('tabContent'),s=d.salud||{},cu=d.cuidados||{},e=datosEspecie(d);
  let h='';
  
  if(tabActual==='cuidados'){
    h+='<div class="card-section"><h3>Estado de salud</h3><div class="health-alert '+(['saludable','atencion','malo'].includes(s.estado)?s.estado:'saludable')+'"><div class="health-header"><span class="health-badge '+(['saludable','atencion','malo'].includes(s.estado)?s.estado:'saludable')+'">'+(s.estado==='saludable'?'Saludable':(s.estado==='atencion'?'Atención':'Malo'))+'</span><span class="health-title">'+ptSafeText(s.puntuacion||0)+'% salud</span></div><p class="health-desc">'+ptSafeText(s.diagnostico||'Sin problemas detectados')+'</p></div></div>';
    h+=card('Tratamiento recomendado',(s.recomendaciones||[]).length?s.recomendaciones.map(r=>item('💡','',r)).join(''):item('✅','','Mantén los cuidados habituales'));
    const icoRegadera='<svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 14h12l4-4V8H7l-4 4v2z" fill="#60A5FA"/><path d="M15 14v4a2 2 0 01-2 2H7a2 2 0 01-2-2v-4" fill="#3B82F6"/><path d="M19 8l2-2" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="18" r="1" fill="#60A5FA"/><circle cx="13" cy="19" r="1" fill="#60A5FA"/><circle cx="16" cy="18" r="1" fill="#60A5FA"/></svg>';
    const icoSolGafas='<svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="12" r="5" fill="#FCD34D"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="#FCD34D" stroke-width="2" stroke-linecap="round"/><rect x="8" y="10" width="3" height="2" rx="1" fill="#1F2937"/><rect x="13" y="10" width="3" height="2" rx="1" fill="#1F2937"/><path d="M11 11h2" stroke="#1F2937" stroke-width="1.5"/></svg>';
    h+=card('Cuidados básicos',item(icoRegadera,'Riego',cu.riego||'Moderado: riega al secarse la capa superior')+item(icoSolGafas,'Luz',cu.luz||'Luz brillante sin sol directo')+item('⚠️','Punto débil',cu.tipico||'Ninguno'));
    const freq=(datosActuales&&datosActuales.recordatorio)?datosActuales.recordatorio.frecuencia:7;
    const ultRiego=(datosActuales&&datosActuales.recordatorio&&datosActuales.recordatorio.ultimaVez)?timeAgo(datosActuales.recordatorio.ultimaVez):'Nunca';
    const icoCalendarioGota='<svg viewBox="0 0 24 24" width="28" height="28"><rect x="4" y="5" width="16" height="16" rx="2" fill="#EAF3EC" stroke="#2F7A4D" stroke-width="1.5"/><path d="M8 3v4M16 3v4M4 10h16" stroke="#2F7A4D" stroke-width="1.5" stroke-linecap="round"/><path d="M12 13c-1.5 1.5-2.5 3-2.5 4.5a2.5 2.5 0 005 0c0-1.5-1-3-2.5-4.5z" fill="#3B82F6"/></svg>';
    h+='<div class="card-section"><h3>Frecuencia de riego</h3><div class="info-card"><div class="info-item"><div class="icon">'+icoCalendarioGota+'</div><div class="content" style="flex:1"><div class="title" id="freqTitulo">Cada '+ptSafeText(freq)+' '+(freq===1?'día':'días')+'</div><div class="desc">Último riego: '+ptSafeText(ultRiego)+'</div><input type="range" min="1" max="30" value="'+freq+'" class="freq-slider" oninput="document.getElementById(\'freqTitulo\').textContent=\'Cada \'+this.value+\' \'+(this.value==1?\'día\':\'días\')" onchange="setFrecuencia(this.value)" style="width:100%;margin-top:12px"></div></div></div></div>';
  }else if(tabActual==='lugar'){
    h+=card('Luz',item('☀️',cu.luz||'Luz brillante sin sol directo','','Luz preferida')+item('🌞','Tolerancias','Se adapta a sol suave o semisombra','Ajusta la exposición según el clima de tu zona'));
    h+=card('Tierra',item('🪴','Sustrato con buen drenaje'));
    h+=card('Temperatura',item('🌡️','Rango ideal','15-25 °C, evita heladas fuertes'));
  }else if(tabActual==='caracteristicas'){
    h+=card('Nombre',item('📖',e.cient||'-','','Nombre científico')+item('🏷️',e.nom,'','Nombre común')+item('',e.genero||'-','','Género'));
    h+=card('Tipo',item('',cu.grupo||'Planta','','Tipo de planta'));
    h+=card('Hojas',item('🍃','Perenne','','Tipo de follaje'));
  }else{
    const pr=(s.sintomas||['Luz insuficiente','Manchas','Cicatrices']).slice(0,4);
    h+='<div class="card-section"><h3>Problemas comunes</h3><div class="scroll-horizontal">'+pr.map((p,i)=>'<div class="problem-card" style="height:120px;background:linear-gradient(135deg,'+['#D8F3DC','#FDE68A','#FECACA','#E9D5FF'][i%4]+',#fff)"><div class="label" style="color:#1F2937;background:none">'+ptSafeText(p)+'</div></div>').join('')+'</div></div>';
    h+=card('Herramienta de diagnóstico',item('🏥','Autodiagnóstico','Analiza una nueva foto para comprobar su salud')+'<button class="btn btn-verde" style="margin-top:12px" onclick="abrirCamara()">📷 Autodiagnóstico</button>');
  }
  c.innerHTML=h;
}

function pintar(d){
  $('resFotoWrap').classList.remove('scanning');
  datosActuales=d;
  const plantas=LS.get('plantas',[]);
  const ultima=plantas.find(p=>p.data===d)||(plantas[0]&&plantas[0].data.especie.nombre_comun===datosEspecie(d).nom?plantas[0]:null);
  if(ultima)idPlantaActual=ultima.id;
  modoJardin='add';
const b=$('btnAddJardin');
if(b)b.textContent='[+] Añadir a "Mi Jardín"';
  
  const s=d.salud||{},e=datosEspecie(d),cu=d.cuidados||{};
  
  // La foto ya está puesta en analizar(), no la tocamos
  
  // Nombres
  $('resNombre').textContent=e.nom||'Planta desconocida';
  $('resComun').textContent=e.cient||'';
  
  // Estado de salud
  const estado=s.estado||'saludable';
  const iconoEstado=estado==='saludable'?'✅':(estado==='atencion'?'⚠️':'❌');
  const textoEstado=estado==='saludable'?'Saludable':(estado==='atencion'?'Alerta Moderada':'Alerta Crítica');
  $('resAlerta').innerHTML=`<span class="icon">${iconoEstado}</span>${textoEstado}`;
  $('resAlerta').className='res-alerta '+estado;
  
  // Patógeno y diagnóstico
  const escribirDetalle=(id,icono,titulo,valor)=>{
    const el=$(id);el.replaceChildren();el.style.display=valor?'flex':'none';
    if(!valor)return;
    const ico=document.createElement('span');ico.className='icon';ico.textContent=icono;
    const contenido=document.createElement('span');
    const etiqueta=document.createElement('strong');etiqueta.textContent=titulo+' ';
    contenido.append(etiqueta,document.createTextNode(String(valor)));
    el.append(ico,contenido);
  };
  escribirDetalle('resPatogeno','♧','Patógeno:',s.patogeno);
  escribirDetalle('resDiagnostico','✦','Diagnóstico:',s.diagnostico);
  const careTitle=$('ptCareTitle');
  if(careTitle)careTitle.textContent=estado==='saludable'?'GUÍA DE CUIDADO Y MANTENIMIENTO':'GUÍA DE TRATAMIENTO Y RECUPERACIÓN';
  
  // Recomendaciones
  $('resRecomendaciones').innerHTML=pintarGuia(s);
  function pintarGuia(s){
  const esc=(v)=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const g=s.guia||{};const recs=s.recomendaciones||[];
  let h='';
  if(g.diagnostico_detallado)h+='<p class="gt-parrafo"><b>🔍 Diagnóstico detallado:</b> '+esc(g.diagnostico_detallado)+'</p>';
  if(g.aislamiento&&estado!=='saludable')h+='<div class="gt-bloque aviso"><b>🚨 Aislamiento inmediato</b><p>'+esc(g.aislamiento)+'</p></div>';
  else if(g.aislamiento)h+='<div class="gt-bloque ok"><b>🌿 Prevención</b><p>'+esc(g.aislamiento)+'</p></div>';
  if(g.pasos&&g.pasos.length){h+='<h4 class="gt-h">🛠️ Plan de acción paso a paso</h4><ol class="gt-pasos">'+g.pasos.map(p=>'<li>'+esc(p)+'</li>').join('')+'</ol>';}
  if(g.productos&&g.productos.length){h+='<h4 class="gt-h">💊 Productos y remedios</h4><ul class="gt-lista">'+g.productos.map(p=>'<li>'+esc(p)+'</li>').join('')+'</ul>';}
  if(g.riego)h+='<div class="gt-bloque"><b>💧 Riego durante la recuperación</b><p>'+esc(g.riego)+'</p></div>';
  if(g.luz_sustrato)h+='<div class="gt-bloque"><b>☀️ Luz, sustrato y abonado</b><p>'+esc(g.luz_sustrato)+'</p></div>';
  if(g.plazo)h+='<div class="gt-bloque ok"><b>⏳ Recuperación esperada</b><p>'+esc(g.plazo)+'</p></div>';
  if(g.prevencion)h+='<div class="gt-bloque"><b>🛡️ Prevención futura</b><p>'+esc(g.prevencion)+'</p></div>';
  if(!h&&recs.length)h='<ul class="gt-lista">'+recs.map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul>';
  if(!h)h='<p class="gt-parrafo">Mantén los cuidados habituales de la especie y vigila su evolución los próximos 7 días.</p>';
  return h;
}
  
  // Verificar si debe bloquear
  verificarBloqueo();
}

let bloqueoActivo=false;
let analisisEnCurso=false;

function verificarBloqueo(){
  const lock=$('resLock');
  const recs=$('resRecomendaciones');
  if(bloqueoActivo){
    lock.classList.add('active');
    recs.classList.add('locked');
  }else{
    lock.classList.remove('active');
    recs.classList.remove('locked');
  }
}

// Rescate definido junto al paywall actual.
async function compartirResultado() {
  const nombre = $('resNombre').textContent || 'esta planta';
  const texto = `¡Mira la planta que he identificado con Plantorum! 🌿 (${nombre})`;
  const url = window.location.href;

  // Option 1: Usar Web Share API nativa si está disponible (Móviles / HTTPS)
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Plantorum 🌿',
        text: texto,
        url: url
      });
      return;
    } catch (err) {
      // Si el usuario cancela el menú de compartir, no hacemos nada
      if (err.name === 'AbortError') return;
    }
  }

  // Option 2: Fallback para navegadores sin soporte (Copiar al portapapeles)
  try {
    const textoACompartir = `${texto} - ${url}`;
    await navigator.clipboard.writeText(textoACompartir);
    mostrarToast('📋 ¡Enlace e información copiados al portapapeles!');
  } catch (err) {
    // Fallback final antiguo por si falla el portapapeles moderno
    mostrarToast(`Copia este texto para compartir:\n\n${texto}`);
  }
}

// Función para volver atrás explícitamente al pulsar el botón "← Volver"
function volver() {
  if(ptHistorialDetalleActivo){ptHistorialDetalleActivo=null;ptHistLiberarDetalle();show('historial');return;}
  if (window.history.length > 1 && history.state && history.state.seccion === 'resultado') {
    history.back(); // Dispara el evento popstate de forma natural
  } else {
    show('jardin'); // Fallback directo a Mi Jardín
  }
}

// Escuchador del gesto / botón físico de ATRÁS de Android o navegador
window.addEventListener('popstate', (ev) => {
  const abierto=Object.keys(PT_OVERLAYS).find(id=>{const e=$(id);return e&&(id==='cam'||id==='modalConsejos'||id==='modalLegal'||id==='paywall'?e.classList.contains('on'):!e.hidden);});
  if(abierto && ev.state?.ptOverlay!==abierto){ptCerrarOverlayDesdeHistorial(abierto);return;}
  navegandoHistorial = true;
  if (ev.state && ev.state.seccion) {
    show(ev.state.seccion, false);
  } else {
    // Si no hay estado en la pila, volvemos a la vista principal por defecto
    show('jardin', false);
  }
  navegandoHistorial = false;
});

// Inicialización del estado base del historial al cargar la app
window.addEventListener('DOMContentLoaded', () => {
  if(!history.state?.seccion)history.replaceState({ seccion: 'jardin' }, '', '#jardin');
});
let splashTimer=null,splashSeg=5;
const tg=$('tgAvisos');if(tg)tg.checked=LS.get('avisosRiego',true);
const ts=$('tgSonido');if(ts)ts.checked=LS.get('sonidoScan',false);
function saltarSplash(dest){clearInterval(splashTimer);const sp=$('splash');if(sp)sp.classList.add('off');if(dest==='scan'){abrirCamara();}else{show('jardin');}}
show('jardin');actualizarTier();iniciarCuenta();
// Plantorum v91 — pantallas de suscripción, sin cobros simulados.
let ptSubPantalla='planes';
let ptSubMetodoElegido='tarjeta';
const ptSubPlanesInfo={anual:{nombre:'Plan anual',duracion:'12 meses',precio:'49,99 €'},mensual:{nombre:'Plan mensual',duracion:'1 mes',precio:'5,99 €'},lifetime:{nombre:'De por vida',duracion:'Pago único',precio:'99,99 €'}};
function ptSubPlan(plan){
 if(!ptSubPlanesInfo[plan])return;
 planElegido=plan;
 document.querySelectorAll('.pt-sub-plan').forEach(x=>x.classList.toggle('selected',x.dataset.plan===plan));
}
function selPlan(plan){ptSubPlan(plan);}
function ptSubMetodo(metodo){
 ptSubMetodoElegido=metodo;
 document.querySelectorAll('.pt-sub-method').forEach(x=>x.classList.toggle('selected',x.dataset.method===metodo));
}
function ptSubIr(pantalla){
 const mapa={planes:'ptSubPlanes',metodos:'ptSubMetodos',tarjeta:'ptSubTarjeta',pendiente:'ptSubPendiente',beneficios:'ptSubBeneficios'};
 if(!mapa[pantalla])return;
 ptSubPantalla=pantalla;
 document.querySelectorAll('.pt-sub-screen').forEach(x=>x.classList.toggle('active',x.id===mapa[pantalla]));
 const titulos={planes:'Planes y precios',metodos:'Método de pago',tarjeta:'Datos de la tarjeta',pendiente:'Suscripción',beneficios:'Funciones premium'};
 $('ptSubCabecera').textContent=titulos[pantalla];
 const info=ptSubPlanesInfo[planElegido]||ptSubPlanesInfo.anual;
 if($('ptSubPlanResumen'))$('ptSubPlanResumen').textContent=info.nombre;
 if($('ptSubPlanDuracion'))$('ptSubPlanDuracion').textContent=info.duracion;
 if($('ptSubPrecioResumen'))$('ptSubPrecioResumen').textContent=info.precio;
 if($('ptSubPendientePlan'))$('ptSubPendientePlan').textContent=info.nombre;
 if($('ptSubPendientePrecio'))$('ptSubPendientePrecio').textContent=info.precio;
 $('paywall').scrollTop=0;
}
function ptSubVolver(){
 const prev={planes:null,metodos:'planes',tarjeta:'metodos',pendiente:ptSubMetodoElegido==='tarjeta'?'tarjeta':'metodos',beneficios:'pendiente'};
 if(!prev[ptSubPantalla])cerrarPaywall();else ptSubIr(prev[ptSubPantalla]);
}
function ptSubContinuarMetodo(){
 if(ptSubMetodoElegido==='tarjeta')ptSubIr('tarjeta');
 else ptSubIr('pendiente');
}
function comprarAhora(){abrirPaywall();}
function abrirPaywall(){ptSubPlan('anual');ptSubIr('planes');$('paywall').classList.add('on');ptOverlayOpen('paywall');}
function cerrarPaywall(){$('paywall').classList.remove('on');ptOverlayClose('paywall');}
function abrirPaywallRescate(){
 abrirPaywall();
 // Mantener el acceso al rescate en el producto, sin activar compras ficticias.
 mostrarToast('El plan de rescate estará disponible cuando se habiliten los pagos.');
}
let modoJardin='add';
function accionJardin(){
  if(modoJardin==='view'){show('jardin');pintarJardin();return;}
  if(!datosActuales||!ultimoBlob){mostrarToast('Nada que guardar todavía.');return;}
  guardarJardin(ultimoBlob,datosActuales);
  modoJardin='view';
  const b=$('btnAddJardin');
  if(b)b.textContent='✅ Guardada · Toca para ver tu jardín';
}

function iniciarCuenta(){
  const num=$('spNum');
  if(!num){
    if(spIntentos++>20){console.error('El splash nuevo no existe en el HTML');return;}
    setTimeout(iniciarCuenta,300);return;
  }
  let t=5;
  num.textContent=t;
  clearInterval(spTimer);
  spTimer=setInterval(()=>{
    const s=$('splash');
    if(!s||s.style.display==='none'||s.classList.contains('off')){clearInterval(spTimer);spTimer=null;return;}
    t--;
    if(t<=0){clearInterval(spTimer);spTimer=null;saltarSplash('jardin');return;}
    num.textContent=t;
  },1000);
}
const _saltarOrig=saltarSplash;
saltarSplash=function(d){if(spTimer){clearInterval(spTimer);spTimer=null;}_saltarOrig(d);};

// === Plantorum v85: recordatorios, identificación independiente y evolución ===

let ptEvoId = null;

// Plantorum v88: riego personalizado por planta, sin consultas externas.
let ptRiegoEditandoId=null;
function ptFechaLocal(ms){
  const d=new Date(ms);
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
function ptFechaDesdeInput(valor){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(valor))return NaN;
  const [y,m,d]=valor.split('-').map(Number);
  const fecha=new Date(y,m-1,d,9,0,0,0);
  return fecha.getFullYear()===y&&fecha.getMonth()===m-1&&fecha.getDate()===d?fecha.getTime():NaN;
}
function abrirConfiguracionRiego(id){
  const p=LS.get('plantas',[]).find(x=>x.id===id);
  if(!p)return;
  ptRiegoEditandoId=id;
  const rec=p.data?.recordatorio||{};
  const frecuencia=Math.max(1,Math.min(60,Number(rec.frecuencia)||7));
  $('ptRiegoNombre').textContent=p.data?.especie?.nombre_comun||'Tu planta';
  $('ptRiegoSlider').value=frecuencia;
  ptActualizarTextoFrecuencia(frecuencia);
  const proxima=Number(rec.proxima);
  $('ptRiegoFecha').value=ptFechaLocal(Number.isFinite(proxima)&&proxima>0?proxima:Date.now()+frecuencia*86400000);
  $('ptRiegoFecha').min=ptFechaLocal(Date.now());
  $('ptRiegoModal').hidden=false;ptOverlayOpen('ptRiegoModal');
}
function ptActualizarTextoFrecuencia(v){
  $('ptRiegoIntervalo').textContent='Cada '+v+(Number(v)===1?' día':' días');
}
function cerrarConfiguracionRiego(){
  $('ptRiegoModal').hidden=true;ptOverlayClose('ptRiegoModal');
  ptRiegoEditandoId=null;
}
function guardarConfiguracionRiego(){
  const id=ptRiegoEditandoId;
  const plantas=LS.get('plantas',[]);
  const p=plantas.find(x=>x.id===id);
  if(!p)return;
  const dias=Number($('ptRiegoSlider').value);
  const proxima=ptFechaDesdeInput($('ptRiegoFecha').value);
  if(!Number.isInteger(dias)||dias<1||dias>60||!Number.isFinite(proxima)){
    mostrarToast('Revisa el intervalo y la fecha elegida.');return;
  }
  if(ptFechaLocal(proxima)<ptFechaLocal(Date.now())){
    mostrarToast('Elige hoy o una fecha futura.');return;
  }
  if(!p.data.recordatorio)p.data.recordatorio={};
  p.data.recordatorio.frecuencia=dias;
  p.data.recordatorio.proxima=proxima;
  // No cambiar ultimaVez: programar un aviso no significa haber regado.
  LS.set('plantas',plantas);
  cerrarConfiguracionRiego();
  pintarJardin();
  comprobarAvisosRiego();
  mostrarToast('💧 Aviso programado para el '+new Date(proxima).toLocaleDateString('es-ES')+'.');
}
function mostrarToast(mensaje) {
  const el=$('ptToast'); if(!el)return;
  el.textContent=mensaje;el.hidden=false;
  clearTimeout(mostrarToast.timer);
  mostrarToast.timer=setTimeout(()=>{el.hidden=true;},5500);
}
function comprobarAvisosRiego(){
  const caja=$('ptAvisosRiego'); if(!caja)return;
  if(LS.get('avisosRiego',true)===false){caja.hidden=true;return;}
  const hoy=Date.now(), plantas=LS.get('plantas',[]);
  const pendientes=plantas.filter(p=>p.data?.recordatorio?.proxima && Number(p.data.recordatorio.proxima)<=hoy);
  caja.replaceChildren(); caja.hidden=!pendientes.length;
  if(!pendientes.length)return;
  const titulo=document.createElement('h3');titulo.textContent='💧 Recordatorios de riego';caja.append(titulo);
  pendientes.forEach(p=>{
    const linea=document.createElement('div');linea.className='pt-aviso-fila';
    const nombre=document.createElement('span');nombre.textContent=p.data.especie?.nombre_comun||'Tu planta';
    const boton=document.createElement('button');boton.textContent='Ya la he regado';boton.addEventListener('click',()=>{regarPlanta(p.id);comprobarAvisosRiego();});
    linea.append(nombre,boton);caja.append(linea);
  });
  const firma=pendientes.map(p=>p.id+':'+p.data.recordatorio.proxima).join('|');
  if(sessionStorage.getItem('pt_riego_popup')!==firma){sessionStorage.setItem('pt_riego_popup',firma);mostrarToast('💧 Tienes '+pendientes.length+' planta(s) pendientes de revisar para el riego.');}
}
function cerrarIdentificacion(){const m=$('ptIdentificacion');m.hidden=true;m.style.setProperty('display','none','important');ptOverlayClose('ptIdentificacion');}
let ptIdentificacionActual=null;
// Mostrar el nombre cientifico cuando un proveedor no disponga del nombre comun.
// La especie sigue estando identificada aunque falte el nombre popular.
function ptNombreIdentificado(d){
  const comun=typeof d?.nombre_comun==='string'?d.nombre_comun.trim():'';
  if(comun && comun!=='Planta sin identificar' && comun!=='Planta')return comun;
  const cientifico=typeof d?.nombre_cientifico==='string'?d.nombre_cientifico.trim():'';
  if(/^Dionaea\s+muscipula\b/i.test(cientifico))return 'Venus atrapamoscas';
  return cientifico || comun || 'Planta sin identificar';
}
async function identificarSolamente(archivo){
  if(!archivo)return;
  // La cuota se verifica en FastAPI, antes de consultar servicios externos.
  ptIdentificacionActual=null;
  $('ptIdGuardar').disabled=true;$('ptIdGuardar').textContent='🌱 Guardar en Mi Jardín';$('ptIdSalud').disabled=true;
  const modal=$('ptIdentificacion');modal.hidden=false;modal.style.setProperty('display','flex','important');modal.style.setProperty('visibility','visible','important');ptOverlayOpen('ptIdentificacion');
  $('ptIdNombre').textContent='Identificando...';$('ptIdCientifico').textContent='';$('ptIdConfianza').textContent='';$('ptIdError').textContent='';
  const inicioCliente=performance.now();
  const comprimida=await prepararBlob(archivo);
  const msPreparacion=Math.round(performance.now()-inicioCliente);
  const url=URL.createObjectURL(comprimida);$('ptIdFoto').src=url;
  const fd=new FormData();fd.append('imagen',comprimida,'planta.jpg');
  try{
    const inicioRed=performance.now();
    const r=await fetch('/identificar',{method:'POST',body:fd});
    console.info('[Plantorum rendimiento] foto='+Math.round(comprimida.size/1024)+' KB, preparación='+msPreparacion+' ms, servidor/red='+Math.round(performance.now()-inicioRed)+' ms');
    let d;try{d=await r.json();}catch(e){throw Error('El servidor no ha devuelto una respuesta válida (HTTP '+r.status+').');}
    if(!r.ok)throw Error(typeof d.detail==='string'?d.detail:'No se pudo identificar la planta (HTTP '+r.status+').');
    // Cuota contabilizada en el servidor.
    const nombrePresentado=ptNombreIdentificado(d);
    const historialId=await ptHistGuardarIdentificacion(comprimida,d);
    ptIdentificacionActual={blob:comprimida,nombre:nombrePresentado,cientifico:d.nombre_cientifico||'',confianza:typeof d.confianza==='number'?d.confianza:null,continuacion:d.continuacion_salud||null,guardada:false,historialId};
    $('ptIdGuardar').disabled=false;$('ptIdSalud').disabled=false;
    $('ptIdNombre').textContent=nombrePresentado;
    $('ptIdCientifico').textContent=d.nombre_cientifico||'';
    $('ptIdConfianza').textContent=typeof d.confianza==='number'?'Confianza estimada: '+Math.round(d.confianza*100)+' %':'';
  }catch(e){$('ptIdNombre').textContent='No se pudo identificar';$('ptIdError').textContent=e.message;}
  finally{ptModoFoto='diagnostico';setTimeout(()=>URL.revokeObjectURL(url),120000);}
}
async function abrirEvolucion(id){
  const p=LS.get('plantas',[]).find(x=>x.id===id);if(!p)return;
  ptEvoId=id;$('ptEvoTitulo').textContent='Evolución · '+(p.data?.especie?.nombre_comun||'Planta');
  show('evolucion');await pintarEvolucion();ptPintarTratamientos();
}
async function pintarEvolucion(){
  const p=LS.get('plantas',[]).find(x=>x.id===ptEvoId);if(!p)return;
  const lista=$('ptEvoLista');lista.replaceChildren();
  const fotos=[{id:p.id,fecha:p.fecha||p.id,original:true},...(p.evolucion||[])].sort((a,b)=>b.fecha-a.fecha);
  for(const foto of fotos){
    const src=await DB.obtenerFoto(foto.id)|| (foto.original?p.img:null);if(!src)continue;
    const tarjeta=document.createElement('article');tarjeta.className='pt-evo-card';
    const img=document.createElement('img');img.src=src;img.alt='Fotografía de seguimiento';img.loading='lazy';
    const pie=document.createElement('div');const fecha=document.createElement('strong');fecha.textContent=new Date(foto.fecha).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'});pie.append(fecha);
    if(!foto.original){const borrar=document.createElement('button');borrar.textContent='Eliminar';borrar.addEventListener('click',()=>eliminarFotoEvolucion(foto.id));pie.append(borrar);}
    tarjeta.append(img,pie);lista.append(tarjeta);
  }
  if(!lista.children.length)lista.textContent='Todavía no hay fotografías.';
}
async function guardarFotoEvolucion(ev){
  const archivo=ev.target.files?.[0];ev.target.value='';if(!archivo||!ptEvoId)return;
  const plantas=LS.get('plantas',[]);const p=plantas.find(x=>x.id===ptEvoId);if(!p)return;
  if((p.evolucion||[]).length>=20){mostrarToast('Límite de 20 fotografías por planta.');return;}
  const blob=await prepararBlob(archivo);
  const base64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(blob);});
  const id=Date.now()+Math.floor(Math.random()*1000);
  try{
    await DB.guardarFoto(id,base64);
    // Confirmar persistencia antes de registrar la entrada.
    if(!await DB.obtenerFoto(id))throw Error('No se pudo guardar la fotografía en este dispositivo.');
    p.evolucion=p.evolucion||[];p.evolucion.push({id,fecha:Date.now()});LS.set('plantas',plantas);
    mostrarToast('📷 Fotografía añadida al seguimiento.');await pintarEvolucion();
  }catch(e){mostrarToast('Error al guardar: '+e.message);}
}
async function eliminarFotoEvolucion(id){
  if(!await ptConfirmar('¿Eliminar esta fotografía del seguimiento?'))return;
  const plantas=LS.get('plantas',[]);const p=plantas.find(x=>x.id===ptEvoId);if(!p)return;
  p.evolucion=(p.evolucion||[]).filter(x=>x.id!==id);LS.set('plantas',plantas);await DB.eliminarFoto(id);await pintarEvolucion();
}
// Eliminación unificada en eliminarPlanta().
window.addEventListener('focus',comprobarAvisosRiego);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)comprobarAvisosRiego();});

// Plantorum v86: acciones posteriores a una identificación, sin inventar datos de salud.
async function guardarIdentificacionJardin(){
  const x=ptIdentificacionActual;
  if(!x||!x.blob||x.guardada)return;
  const id=Date.now();
  try{
    const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(x.blob);});
    if(await ptBuscarPlantaConMismaFoto(dataUrl,x.nombre)) {
      x.guardada=true;
      $('ptIdGuardar').disabled=true;
      $('ptIdGuardar').textContent='✓ Ya está en Mi Jardín';
      mostrarToast('Esta fotografía ya está guardada en Mi Jardín.');
      return;
    }
    await DB.guardarFoto(id,dataUrl);
    // Comprobación de lectura: evita guardar un registro sin fotografía.
    if(!await DB.obtenerFoto(id))throw new Error('No se pudo guardar la fotografía en este dispositivo.');
    const plantas=LS.get('plantas',[]);
    plantas.unshift({id,fecha:id,locked:false,data:{especie:{nombre_comun:x.nombre,nombre_cientifico:x.cientifico},solo_identificacion:true,confianza_identificacion:x.confianza,recordatorio:{frecuencia:7,ultimaVez:null,proxima:null}}});
    if(plantas.length>30){const extra=plantas.splice(30);for(const p of extra)await DB.eliminarFoto(p.id);}
    LS.set('plantas',plantas);
    x.guardada=true;$('ptIdGuardar').disabled=true;$('ptIdGuardar').textContent='✓ Guardada en Mi Jardín';
    pintarJardin();mostrarToast('🌿 Planta guardada. Ya puedes añadir fotos de evolución.');
  }catch(e){mostrarToast('No se pudo guardar: '+(e.message||e));}
}
function analizarSaludIdentificada(){
  const x=ptIdentificacionActual;
  if(!x?.blob)return;
  // Transición atómica: no llamar a cerrarIdentificacion(), que ejecuta
  // history.back() y puede devolver la app a Mi Jardín durante el diagnóstico.
  const modal=$('ptIdentificacion');
  modal.hidden=true;
  modal.style.setProperty('display','none','important');
  // Quitar la marca del modal sin disparar popstate; analizar() navegará a resultado.
  if(history.state?.ptOverlay==='ptIdentificacion'){
    const estado={...history.state};delete estado.ptOverlay;
    history.replaceState(estado,'',location.href);
  }
  ptModoFoto='diagnostico';
  analizar(x.blob,x.continuacion,x.historialId,{nombre:x.nombre,cientifico:x.cientifico,confianza:x.confianza});
}

// Plantorum v97: personalización local sin registro ni datos enviados al servidor.
(function configurarPerfilPlantorum(){
  const KEY='plantorum_perfil_nombre_v1', SEEN='plantorum_perfil_bienvenida_v1';
  const el=id=>document.getElementById(id);
  const nombreValido=v=>String(v||'').trim().replace(/\s+/g,' ').slice(0,40);
  function actualizar(){
    const nombre=nombreValido(localStorage.getItem(KEY));
    const hora=new Date().getHours();
    const saludo=hora<12?'Buenos días':hora<20?'Buenas tardes':'Buenas noches';
    const titulo=el('ptSaludoPersonalizado');
    if(titulo){titulo.replaceChildren(document.createTextNode(nombre?`¡${saludo}, ${nombre}! `:`Hola, amante de las plantas `));const flor=document.createElement('span');flor.textContent='✿';titulo.appendChild(flor);}
    if(el('ptPerfilNombre'))el('ptPerfilNombre').value=nombre;
    if(el('ptPerfilResumen'))el('ptPerfilResumen').textContent=nombre?`Hola, ${nombre}. Aquí puedes cambiar tu nombre.`:'Personaliza cómo te saludamos.';
  }
  function guardar(v){const nombre=nombreValido(v);if(nombre)localStorage.setItem(KEY,nombre);else localStorage.removeItem(KEY);localStorage.setItem(SEEN,'1');el('ptBienvenidaPerfil').hidden=true;actualizar();}
  document.addEventListener('DOMContentLoaded',()=>{
    actualizar();
    el('ptPerfilGuardar')?.addEventListener('click',()=>{guardar(el('ptPerfilNombre').value);if(typeof mostrarToast==='function')mostrarToast('Perfil actualizado');});
    el('ptBienvenidaForm')?.addEventListener('submit',e=>{e.preventDefault();guardar(el('ptBienvenidaNombre').value);});
    el('ptBienvenidaOmitir')?.addEventListener('click',()=>guardar(''));
    if(!localStorage.getItem(SEEN))el('ptBienvenidaPerfil').hidden=false;
  });
  window.addEventListener('focus',actualizar);
})();

// Plantorum v100 — seguimiento manual, privado y sin llamadas a servicios externos.
const PT_ESTADOS={sin_cambios:'Sin cambios',mejorando:'Mejorando',empeorando:'Empeorando',recuperada:'Recuperada'};
function ptPintarTratamientos(){
 const cont=$('ptTratamientoHistorial');if(!cont)return;cont.replaceChildren();
 const p=LS.get('plantas',[]).find(x=>x.id===ptEvoId);
 if(!p)return;
 const entradas=(p.tratamientos||[]).slice().sort((a,b)=>b.fecha-a.fecha);
 if(!entradas.length){cont.textContent='Todavía no hay cuidados registrados.';return;}
 for(const t of entradas){
  const item=document.createElement('article');item.className='pt-tratamiento-item';
  const title=document.createElement('strong');title.textContent=PT_ESTADOS[t.estado]||'Revisión';
  const fecha=document.createElement('small');fecha.textContent=new Date(t.fecha).toLocaleString('es-ES');
  const accion=document.createElement('p');accion.textContent=t.accion;
  item.append(title,fecha,accion);
  if(t.proxima){const proxima=document.createElement('small');proxima.textContent='Próxima revisión: '+t.proxima.split('-').reverse().join('/');item.append(proxima);}
  cont.append(item);
 }
}
$('ptTratamientoForm')?.addEventListener('submit',e=>{
 e.preventDefault();if(!ptEvoId)return;
 const accion=$('ptTratamientoAccion').value.trim().slice(0,500);
 if(!accion){mostrarToast('Describe el cuidado realizado.');return;}
 const estado=$('ptTratamientoEstado').value;
 if(!Object.hasOwn(PT_ESTADOS,estado))return;
 const proxima=$('ptTratamientoProxima').value;
 if(proxima&&!/^\d{4}-\d{2}-\d{2}$/.test(proxima))return;
 const plantas=LS.get('plantas',[]),p=plantas.find(x=>x.id===ptEvoId);if(!p)return;
 p.tratamientos=p.tratamientos||[];p.tratamientos.push({fecha:Date.now(),accion,estado,proxima});
 LS.set('plantas',plantas);$('ptTratamientoForm').reset();ptPintarTratamientos();mostrarToast('Seguimiento guardado en este dispositivo.');
});
// Confirmación dentro de la aplicación, compatible con el botón Atrás.
let ptConfirmResolve=null;
function ptConfirmar(texto){
 if(ptConfirmResolve)return Promise.resolve(false);
 $('ptConfirmTexto').textContent=texto;
 $('ptConfirmOverlay').hidden=false;ptOverlayOpen('ptConfirmOverlay');
 $('ptConfirmNo').focus();
 return new Promise(resolve=>{ptConfirmResolve=resolve;});
}
function ptConfirmCerrar(ok){
 $('ptConfirmOverlay').hidden=true;ptOverlayClose('ptConfirmOverlay');
 const resolver=ptConfirmResolve;ptConfirmResolve=null;if(resolver)resolver(ok);
}
function ptConfirmCancelar(){ptConfirmCerrar(false);}
$('ptConfirmNo')?.addEventListener('click',()=>ptConfirmCerrar(false));
$('ptConfirmSi')?.addEventListener('click',()=>ptConfirmCerrar(true));

// Plantorum 109 — accesibilidad de las tarjetas que aún usan onclick en HTML.
document.addEventListener('DOMContentLoaded',()=>{
 document.querySelectorAll('.pt-sub-plan[onclick],.pt-sub-method[onclick],.info-item[onclick]').forEach(el=>{
   el.setAttribute('role','button');el.tabIndex=0;
   el.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();el.click();}});
 });
});
