const LS={get(k,d){try{const v=JSON.parse(localStorage.getItem('fs_'+k));return v==null?d:v}catch(e){return d}},set(k,v){localStorage.setItem('fs_'+k,JSON.stringify(v))}};
let stream=null,volverA='jardin',zoomTrack=null,ultimoBlob=null,tabActual='cuidados',datosActuales=null,planElegido='anual';
let idPlantaActual = null
const video=document.getElementById('video');
const $=id=>document.getElementById(id);

function show(n){document.querySelectorAll('.sc').forEach(s=>s.classList.remove('on'));$('s-'+n).classList.add('on');
[['n-jardin','jardin'],['n-guia','guia'],['n-ajustes','ajustes']].forEach(p=>{const b=$(p[0]);if(b)b.classList.toggle('sel',p[1]===n)});
document.querySelector('nav').style.display=(n==='resultado')?'none':'flex';
if(n==='jardin')pintarJardin();if(n==='guia')pintarGuias();window.scrollTo(0,0)}

function tier(){return LS.get('tier','free')}
function actualizarTier(){$('estadoTier').textContent='Suscripción Estado: '+(tier()==='free'?'Gratis':(tier()==='pro'?'Pro (prueba)':'De por vida'))}
function abrirPaywall(){$('paywall').classList.add('on')}
function cerrarPaywall(){$('paywall').classList.remove('on')}
function elegirPlan(p){
  planElegido=p;
  const a=$('planAnual'),m=$('planMensual'),l=$('planLifetime'),r=$('planRescate');
  if(a)a.classList.toggle('sel',p==='anual');
  if(m)m.classList.toggle('sel',p==='mensual');
  if(l)l.classList.toggle('sel',p==='lifetime');
  if(r)r.classList.toggle('sel',p==='rescate');
  
  if(p==='rescate'){
    $('pwCta').textContent='Desbloquear por 0,99 € →';
    $('pwLinea').textContent='Un diagnóstico completo para salvar tu planta ahora mismo.';
  }else if(p==='anual'){
    $('pwCta').textContent='Prueba Gratis →';
    $('pwLinea').textContent='7 días gratis. Luego, 18,99 €/año (~1,58 €/mes)';
  }else if(p==='mensual'){
    $('pwCta').textContent='Continuar →';
    $('pwLinea').textContent='1 mes por 1,99 €. Renovación mensual, cancela cuando quieras.';
  }else{
    $('pwCta').textContent='Comprar de por vida →';
    $('pwLinea').textContent='Pago único de 35,99 €. Acceso Pro para siempre, sin renovaciones.';
  }
}
function activarPro(){LS.set('tier','pro');LS.set('plan',planElegido);if(planElegido==='lifetime'){LS.set('lifetime',true);LS.set('trialFin',0);}else{LS.set('lifetime',false);LS.set('trialFin',Date.now()+7*864e5);}actualizarTier();cerrarPaywall();alert(planElegido==='lifetime'?'✅ Acceso Pro de por vida activado (simulación).':(planElegido==='mensual'?'✅ Pro mensual activado (simulación).':'✅ Prueba Pro de 7 días activada (simulación).'));show('jardin')}
function restaurar(){alert(tier()==='free'?'No hay compras anteriores.':'✅ Membresía restaurada: '+tier())}
function limpiarCache(){if(confirm('¿Borrar la caché de fotos de la guía?')){Object.keys(localStorage).filter(k=>k.startsWith('fs_wg_')).forEach(k=>localStorage.removeItem(k));location.reload();}}
function borrarTodo(){if(confirm('¿Eliminar TODOS tus datos (jardín, suscripción y ajustes)? Esta acción no se puede deshacer.')){Object.keys(localStorage).filter(k=>k.startsWith('fs_')).forEach(k=>localStorage.removeItem(k));location.reload();}}
function limpiarInterno(o){if(Array.isArray(o)){o.forEach(limpiarInterno);return o}if(o&&typeof o==='object'){['modelo','fuente','plantnet','local'].forEach(k=>delete o[k]);Object.values(o).forEach(limpiarInterno)}return o}
function exportarJardin(){const p=LS.get('plantas',[]);if(!p.length){alert('Tu jardín está vacío todavía.');return}
const copia=limpiarInterno(JSON.parse(JSON.stringify(p)));
const b=new Blob([JSON.stringify(copia,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='florascan_jardin.json';document.body.appendChild(a);a.click();document.body.removeChild(a);}
function abrirLegal(t){$('legalTitulo').textContent=t==='priv'?'Política de privacidad':'Términos de uso';$('legalTexto').innerHTML=t==='priv'?LEGAL_PRIV:LEGAL_TERMS;$('modalLegal').classList.add('on');}
function cerrarLegal(){$('modalLegal').classList.remove('on');}
const LEGAL_PRIV='<p>FloraScan procesa las fotos que subes únicamente para identificar la especie y generar el diagnóstico. Las imágenes se envían a los servicios de identificación (Google Gemini, OpenRouter y Pl@ntNet) solo durante el análisis y no se almacenan en nuestros servidores.</p><p>Tu jardín, recordatorios y ajustes se guardan localmente en tu dispositivo. Puedes exportarlos o eliminarlos definitivamente desde Ajustes en cualquier momento (derechos RGPD).</p><p>No compartimos datos personales con terceros ni los usamos con fines publicitarios.</p>';
const LEGAL_TERMS='<p>FloraScan ofrece información orientativa sobre identificación y cuidados de plantas. No sustituye el asesoramiento de un profesional de la jardinería o la fitosanidad.</p><p>Las suscripciones Pro se gestionan a través de Google Play y se renuevan automáticamente hasta que las canceles con al menos 24 horas de antelación.</p><p>El uso de la app implica la aceptación de estas condiciones y de la política de privacidad.</p>';
function consumirEscaneo(){
  if(tier()!=='free')return true;
  const hoy=new Date().toDateString();
  const u=LS.get('usado_'+hoy,0);
  LS.set('usado_'+hoy,u+1);
  return true; // Siempre permite analizar, el bloqueo se hace en verificarBloqueo()
}

async function abrirCamara(){$('cam').classList.add('on');try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});video.srcObject=stream;await video.play();try{zoomTrack=stream.getVideoTracks()[0];if(zoomTrack.getCapabilities().zoom)$('zoom').max=zoomTrack.getCapabilities().zoom}catch(e){}}catch(e){alert('Error cámara: '+e);cerrarCamara()}}
function cerrarCamara(){if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;$('cam').classList.remove('on')}
function aplicarZoom(v){if(zoomTrack){try{if(zoomTrack.getCapabilities().zoom){zoomTrack.applyConstraints({advanced:[{zoom:+v}]});return}}catch(e){}}video.style.transform='scale('+v+')';video.style.transformOrigin='center'}
function capturar(){const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);cerrarCamara();c.toBlob(analizar,'image/jpeg',0.9)}
async function subir(ev){const f=ev.target.files[0];if(f){cerrarCamara();await analizar(f)}}
function abrirConsejos(){$('modalConsejos').classList.add('on')}
function cerrarConsejos(){$('modalConsejos').classList.remove('on')}

async function prepararBlob(b){try{const bmp=await createImageBitmap(b);const m=1600,e=Math.min(1,m/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*e);c.height=Math.round(bmp.height*e);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(r,'image/jpeg',0.92))}catch(e){return b}}

async function analizar(blobO){
  if(!consumirEscaneo())return;
  const hoy=new Date().toDateString();
bloqueoActivo=(tier()==='free'&&LS.get('usado_'+hoy,0)>3);
  const blob=await prepararBlob(blobO);
  ultimoBlob=blob;
  
  // Mostrar pantalla de resultado con estado de carga
  show('resultado');
  $('resFoto').src=URL.createObjectURL(blob);
  $('resFotoWrap').classList.add('scanning');
  $('resNombre').textContent='Analizando...';
  $('resComun').textContent='';
  $('resAlerta').innerHTML='<span class="icon">⏳</span>Procesando imagen';
  $('resPatogeno').style.display='none';
  $('resDiagnostico').style.display='none';
  $('resRecomendaciones').innerHTML='<p style="color:#757575">Espera un momento...</p>';
  
  const fd=new FormData();
  fd.append('imagen',blob,'foto.jpg');
  
  try{
    const r=await fetch('/analizar',{method:'POST',body:fd});
    if(!r.ok)throw new Error('Servidor '+r.status);
    const d=await r.json();
    pintar(d);
  }catch(e){
    $('resFotoWrap').classList.remove('scanning');
    $('resNombre').textContent='❌ Error';
    $('resComun').textContent=e.message;
    $('resAlerta').innerHTML='<span class="icon">❌</span>Error al analizar';
    $('resRecomendaciones').innerHTML='<p style="color:#F44336">No se pudo completar el análisis. Intenta de nuevo.</p>';
  }
}

function guardarJardin(blob,d){const r=new FileReader();r.onload=()=>{const p=LS.get('plantas',[]);p.unshift({id:Date.now(),img:r.result,data:d,fecha:Date.now(),locked:bloqueoActivo});if(p.length>30)p.length=30;LS.set('plantas',p)};r.readAsDataURL(blob)}

function pintarJardin(){
  const p = LS.get('plantas', []);
  $('jardinVacio').style.display = p.length ? 'none' : 'block';
  
  // Ordenar: primero las que necesitan riego urgente
  p.sort((a, b) => {
    const nextA = a.data.recordatorio?.proxima || 0;
    const nextB = b.data.recordatorio?.proxima || 0;
    return nextA - nextB;
  });

  $('jardin').innerHTML = p.map(x => {
    const s = x.data.salud;
    const colorEstado = s.estado === 'saludable' ? '#2F7A4D' : (s.estado === 'atencion' ? '#D97706' : '#DC2626');
    const nom = x.data.especie.nombre_comun || 'Planta';
    
    // Lógica de Riego
    const rec = x.data.recordatorio || {frecuencia: 7, ultimaVez: Date.now() - 86400000*7, proxima: Date.now()};
    const hoy = Date.now();
    const diffDias = Math.ceil((rec.proxima - hoy) / 86400000);
    
    let textoRiego = `💧 ${diffDias}d`;
    let colorRiego = '#9CA3AF'; // Gris
    
    if (diffDias <= 0) {
      textoRiego = diffDias === 0 ? '💧 ¡Hoy!' : '💧 Atrasado';
      colorRiego = '#DC2626'; // Rojo si urge
    } else if (diffDias === 1) {
      textoRiego = '💧 Mañana';
      colorRiego = '#D97706'; // Naranja aviso
    }

    return `
      <div class="planta" onclick="verDetalle(${x.id})">
        <button class="borrar" onclick="event.stopPropagation();eliminarPlanta(${x.id})">✕</button>
        <img src="${x.img}">
        <div class="txt">
          <span class="punto" style="background:${colorEstado}"></span>${nom}
          <div style="font-size:11px;color:${colorRiego};font-weight:600;margin-top:4px;display:flex;justify-content:space-between;align-items:center">
            ${textoRiego}
            <button class="btn-mini-regar" onclick="event.stopPropagation();regarPlanta(${x.id})" style="background:${colorRiego};color:#fff;border:none;border-radius:10px;padding:2px 6px;font-size:10px;cursor:pointer">Regar</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function eliminarPlanta(id){if(confirm('¿Eliminar planta?')){LS.set('plantas',LS.get('plantas',[]).filter(x=>x.id!==id));pintarJardin()}}
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
function verDetalle(id){
  const p=LS.get('plantas',[]).find(x=>x.id===id);
  bloqueoActivo=(tier()==='free'&&!!(p&&p.locked));
  if(p){volverA='jardin';idPlantaActual=id;$('resFoto').src=p.img;fetch(p.img).then(r=>r.blob()).then(b=>ultimoBlob=b);pintar(p.data);show('resultado')}
  modoJardin='view';
const b2=$('btnAddJardin');
if(b2)b2.textContent='🌿 Ver en Mi Jardín';
}

async function pedirInforme(){if(!ultimoBlob){alert('Primero escanea una planta.');return}if(tier()!=='pro'){if(!confirm('Informe detallado: 0,50 € (simulación). ¿Continuar?'))return}$('estado').textContent='Generando informe...';const fd=new FormData();fd.append('imagen',ultimoBlob,'foto.jpg');try{const r=await fetch('/informe',{method:'POST',body:fd});if(!r.ok)throw new Error('Error '+r.status);const d=await r.json();const a=document.createElement('a');a.href=d.url;a.download='informe_florascan.pdf';document.body.appendChild(a);a.click();document.body.removeChild(a);$('estado').textContent='✅ Informe descargado'}catch(e){alert('Error informe: '+e.message)}}

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
function pintarGuias(){let h='',grupo='';
GUIAS.forEach((p,i)=>{if(p.g!==grupo){grupo=p.g;h+='<h3 class="guia-grupo">'+grupo+'</h3>';}
const key='wg_'+i;const cache=LS.get(key,'');
h+='<div class="guia-card">'+(cache?'<img class="guia-img" data-key="'+key+'" src="'+cache+'" alt="">':'<div class="guia-img guia-ph" data-key="'+key+'">🌿</div>')+'<div class="guia-txt"><b>'+p.n+'</b><p>💧 '+p.r+' · ☀️ '+p.l+'</p></div></div>';});
$('guias').innerHTML=h;
GUIAS.forEach((p,i)=>fotoGuia(p.w,'wg_'+i));}
async function fotoGuia(w,key){if(LS.get(key,''))return;try{const r=await fetch('https://es.wikipedia.org/api/rest_v1/page/summary/'+encodeURIComponent(w));if(!r.ok)return;const d=await r.json();const url=d.thumbnail&&d.thumbnail.source;if(!url)return;LS.set(key,url);const el=document.querySelector('[data-key="'+key+'"]');if(el){const img=new Image();img.className='guia-img';img.setAttribute('data-key',key);img.src=url;el.replaceWith(img);}}catch(e){}}
function datosEspecie(d){const e=d.especie||{};const pn=(e.plantnet&&e.plantnet[0])?e.plantnet[0]:null;const lo=(e.local&&e.local[0])?e.local[0]:null;
let nom=e.nombre_comun||(pn?pn.nombre_comun:'');let cient=e.nombre_cientifico||(pn?pn.nombre_cientifico:'');
if(!nom&&lo)nom=lo.clase;if(!nom||nom.toLowerCase()==='no identificada')nom='Planta';
const genero=cient?cient.split(' ')[0]:(e.genero||'');return{nom,cient,genero}}

const item=(ico,t,desc,sub)=>'<div class="info-item"><div class="icon">'+ico+'</div><div class="content"><div class="title">'+t+'</div>'+(desc?'<div class="desc">'+desc+'</div>':'')+(sub?'<div class="sub">'+sub+'</div>':'')+'</div></div>';
const card=(h,inner)=>'<div class="card-section"><h3>'+h+'</h3><div class="info-card">'+inner+'</div></div>';

function cambiarTab(tab,el){tabActual=tab;document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));if(el)el.classList.add('active');if(datosActuales)renderTabContent(datosActuales)}

function renderTabContent(d){
  const c=$('tabContent'),s=d.salud||{},cu=d.cuidados||{},e=datosEspecie(d);
  let h='';
  
  if(tabActual==='cuidados'){
    h+='<div class="card-section"><h3>Estado de salud</h3><div class="health-alert '+(s.estado||'saludable')+'"><div class="health-header"><span class="health-badge '+(s.estado||'saludable')+'">'+(s.estado==='saludable'?'Saludable':(s.estado==='atencion'?'Atención':'Malo'))+'</span><span class="health-title">'+(s.puntuacion||0)+'% salud</span></div><p class="health-desc">'+(s.diagnostico||'Sin problemas detectados')+'</p></div></div>';
    h+=card('Tratamiento recomendado',(s.recomendaciones||[]).length?s.recomendaciones.map(r=>item('💡','',r)).join(''):item('✅','','Mantén los cuidados habituales'));
    const icoRegadera='<svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 14h12l4-4V8H7l-4 4v2z" fill="#60A5FA"/><path d="M15 14v4a2 2 0 01-2 2H7a2 2 0 01-2-2v-4" fill="#3B82F6"/><path d="M19 8l2-2" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="18" r="1" fill="#60A5FA"/><circle cx="13" cy="19" r="1" fill="#60A5FA"/><circle cx="16" cy="18" r="1" fill="#60A5FA"/></svg>';
    const icoSolGafas='<svg viewBox="0 0 24 24" width="28" height="28"><circle cx="12" cy="12" r="5" fill="#FCD34D"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="#FCD34D" stroke-width="2" stroke-linecap="round"/><rect x="8" y="10" width="3" height="2" rx="1" fill="#1F2937"/><rect x="13" y="10" width="3" height="2" rx="1" fill="#1F2937"/><path d="M11 11h2" stroke="#1F2937" stroke-width="1.5"/></svg>';
    h+=card('Cuidados básicos',item(icoRegadera,'Riego',cu.riego||'Moderado: riega al secarse la capa superior')+item(icoSolGafas,'Luz',cu.luz||'Luz brillante sin sol directo')+item('⚠️','Punto débil',cu.tipico||'Ninguno'));
    const freq=(datosActuales&&datosActuales.recordatorio)?datosActuales.recordatorio.frecuencia:7;
    const ultRiego=(datosActuales&&datosActuales.recordatorio&&datosActuales.recordatorio.ultimaVez)?timeAgo(datosActuales.recordatorio.ultimaVez):'Nunca';
    const icoCalendarioGota='<svg viewBox="0 0 24 24" width="28" height="28"><rect x="4" y="5" width="16" height="16" rx="2" fill="#EAF3EC" stroke="#2F7A4D" stroke-width="1.5"/><path d="M8 3v4M16 3v4M4 10h16" stroke="#2F7A4D" stroke-width="1.5" stroke-linecap="round"/><path d="M12 13c-1.5 1.5-2.5 3-2.5 4.5a2.5 2.5 0 005 0c0-1.5-1-3-2.5-4.5z" fill="#3B82F6"/></svg>';
    h+='<div class="card-section"><h3>Frecuencia de riego</h3><div class="info-card"><div class="info-item"><div class="icon">'+icoCalendarioGota+'</div><div class="content" style="flex:1"><div class="title" id="freqTitulo">Cada '+freq+' '+(freq===1?'día':'días')+'</div><div class="desc">Último riego: '+ultRiego+'</div><input type="range" min="1" max="30" value="'+freq+'" class="freq-slider" oninput="document.getElementById(\'freqTitulo\').textContent=\'Cada \'+this.value+\' \'+(this.value==1?\'día\':\'días\')" onchange="setFrecuencia(this.value)" style="width:100%;margin-top:12px"></div></div></div></div>';
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
    h+='<div class="card-section"><h3>Problemas comunes</h3><div class="scroll-horizontal">'+pr.map((p,i)=>'<div class="problem-card" style="height:120px;background:linear-gradient(135deg,'+['#D8F3DC','#FDE68A','#FECACA','#E9D5FF'][i%4]+',#fff)"><div class="label" style="color:#1F2937;background:none">'+p+'</div></div>').join('')+'</div></div>';
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
  $('resPatogeno').innerHTML=s.patogeno?`<span class="icon">🦠</span><strong>Patógeno:</strong> ${s.patogeno}`:'';
  $('resPatogeno').style.display=s.patogeno?'flex':'none';
  $('resDiagnostico').innerHTML=s.diagnostico?`<span class="icon">❓</span><strong>Diagnóstico:</strong> ${s.diagnostico}`:'';
  $('resDiagnostico').style.display=s.diagnostico?'flex':'none';
  
  // Recomendaciones
  $('resRecomendaciones').innerHTML=pintarGuia(s);
  function pintarGuia(s){
  const g=s.guia||{};const recs=s.recomendaciones||[];
  let h='';
  if(g.diagnostico_detallado)h+='<p class="gt-parrafo"><b>🔍 Diagnóstico detallado:</b> '+g.diagnostico_detallado+'</p>';
  if(g.aislamiento)h+='<div class="gt-bloque aviso"><b>🚨 Aislamiento inmediato</b><p>'+g.aislamiento+'</p></div>';
  if(g.pasos&&g.pasos.length){h+='<h4 class="gt-h">🛠️ Plan de acción paso a paso</h4><ol class="gt-pasos">'+g.pasos.map(p=>'<li>'+p+'</li>').join('')+'</ol>';}
  if(g.productos&&g.productos.length){h+='<h4 class="gt-h">💊 Productos y remedios</h4><ul class="gt-lista">'+g.productos.map(p=>'<li>'+p+'</li>').join('')+'</ul>';}
  if(g.riego)h+='<div class="gt-bloque"><b>💧 Riego durante la recuperación</b><p>'+g.riego+'</p></div>';
  if(g.luz_sustrato)h+='<div class="gt-bloque"><b>☀️ Luz, sustrato y abonado</b><p>'+g.luz_sustrato+'</p></div>';
  if(g.plazo)h+='<div class="gt-bloque ok"><b>⏳ Recuperación esperada</b><p>'+g.plazo+'</p></div>';
  if(g.prevencion)h+='<div class="gt-bloque"><b>🛡️ Prevención futura</b><p>'+g.prevencion+'</p></div>';
  if(!h&&recs.length)h='<ul class="gt-lista">'+recs.map(r=>'<li>'+r+'</li>').join('')+'</ul>';
  if(!h)h='<p class="gt-parrafo">Mantén los cuidados habituales de la especie y vigila su evolución los próximos 7 días.</p>';
  return h;
}
  
  // Verificar si debe bloquear
  verificarBloqueo();
}

let bloqueoActivo=false;

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

function abrirPaywallRescate(){
  planElegido='rescate';
  abrirPaywall();
}

function compartirResultado(){
  const nombre=$('resNombre').textContent;
  const texto=`Acabo de identificar ${nombre} con FloraScan 🌿`;
  if(navigator.share){
    navigator.share({title:'FloraScan',text:texto}).catch(()=>{});
  }else{
    alert('Compartir no disponible en este navegador');
  }
}

function volver(){
  show('jardin');
}

let splashTimer=null,splashSeg=5;
function iniciarSplash(){splashSeg=5;const el=$('splashSkip');if(el)el.textContent='Saltar en '+splashSeg+' s';clearInterval(splashTimer);splashTimer=setInterval(()=>{splashSeg--;if(splashSeg<=0){saltarSplash('jardin');}else if(el){el.textContent='Saltar en '+splashSeg+' s';}},1000);}
const tg=$('tgAvisos');if(tg)tg.checked=LS.get('avisosRiego',true);
const ts=$('tgSonido');if(ts)ts.checked=LS.get('sonidoScan',false);
function saltarSplash(dest){clearInterval(splashTimer);const sp=$('splash');if(sp)sp.classList.add('off');if(dest==='scan'){abrirCamara();}else{show('jardin');}}
show('jardin');actualizarTier();iniciarSplash();
function selPlan(p){planElegido=p;
const cards=document.querySelectorAll('.pw-card');
const map={anual:0,mensual:1,lifetime:2};
cards.forEach((c,i)=>c.classList.toggle('sel',i===map[p]));
const c=$('pwCta'),l=$('pwLinea');if(!c||!l)return;
if(p==='anual'){c.textContent='COMENZAR PRUEBA GRATIS Y SUSCRIBIRSE';l.textContent='Prueba gratuita de 7 días';}
else if(p==='mensual'){c.textContent='CONTINUAR CON PLAN MENSUAL';l.textContent='1,99 € al mes · cancela cuando quieras';}
else if(p==='lifetime'){c.textContent='COMPRAR ACCESO DE POR VIDA';l.textContent='Pago único de 35,99 € · sin renovaciones';}}
function comprarAhora(p){const plan=p||planElegido||'anual';
if(typeof activarPro==='function'){activarPro(plan);}else{LS.set('tier',plan==='lifetime'?'lifetime':'pro');}
cerrarPaywall();if(typeof actualizarTier==='function')actualizarTier();}
function abrirPaywall(){const b=$('pwRescate');if(b)b.style.display='none';selPlan('anual');$('paywall').classList.add('on');}
function cerrarPaywall(){$('paywall').classList.remove('on');}
function abrirPaywallRescate(){planElegido='rescate';abrirPaywall();const b=$('pwRescate');if(b)b.style.display='flex';}
let modoJardin='add';
function accionJardin(){
  if(modoJardin==='view'){show('jardin');pintarJardin();return;}
  if(!datosActuales||!ultimoBlob){alert('Nada que guardar todavía.');return;}
  guardarJardin(ultimoBlob,datosActuales);
  modoJardin='view';
  const b=$('btnAddJardin');
  if(b)b.textContent='✅ Guardada · Toca para ver tu jardín';
}