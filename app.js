const LS={get(k,d){try{const v=JSON.parse(localStorage.getItem('fs_'+k));return v==null?d:v}catch(e){return d}},set(k,v){localStorage.setItem('fs_'+k,JSON.stringify(v))}};
let stream=null,volverA='jardin',zoomTrack=null,ultimoBlob=null,tabActual='cuidados',datosActuales=null;
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
function activarPro(){LS.set('tier','pro');LS.set('trialFin',Date.now()+7*864e5);actualizarTier();cerrarPaywall();alert('✅ Prueba Pro de 7 días activada (simulación).');show('jardin')}
function restaurar(){alert(tier()==='free'?'No hay compras anteriores.':'✅ Membresía restaurada: '+tier())}
function limpiarCache(){if(confirm('¿Borrar datos?')){Object.keys(localStorage).filter(k=>k.startsWith('fs_')).forEach(k=>localStorage.removeItem(k));location.reload()}}
function consumirEscaneo(){if(tier()!=='free')return true;const hoy=new Date().toDateString();const u=LS.get('usado_'+hoy,0);if(u>=3){abrirPaywall();return false}LS.set('usado_'+hoy,u+1);return true}

async function abrirCamara(){$('cam').classList.add('on');try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});video.srcObject=stream;await video.play();try{zoomTrack=stream.getVideoTracks()[0];if(zoomTrack.getCapabilities().zoom)$('zoom').max=zoomTrack.getCapabilities().zoom}catch(e){}}catch(e){alert('Error cámara: '+e);cerrarCamara()}}
function cerrarCamara(){if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;$('cam').classList.remove('on')}
function aplicarZoom(v){if(zoomTrack){try{if(zoomTrack.getCapabilities().zoom){zoomTrack.applyConstraints({advanced:[{zoom:+v}]});return}}catch(e){}}video.style.transform='scale('+v+')';video.style.transformOrigin='center'}
function capturar(){const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);cerrarCamara();c.toBlob(analizar,'image/jpeg',0.9)}
async function subir(ev){const f=ev.target.files[0];if(f){cerrarCamara();await analizar(f)}}
function abrirConsejos(){$('modalConsejos').classList.add('on')}
function cerrarConsejos(){$('modalConsejos').classList.remove('on')}

async function prepararBlob(b){try{const bmp=await createImageBitmap(b);const m=1600,e=Math.min(1,m/Math.max(bmp.width,bmp.height));const c=document.createElement('canvas');c.width=Math.round(bmp.width*e);c.height=Math.round(bmp.height*e);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);return await new Promise(r=>c.toBlob(r,'image/jpeg',0.92))}catch(e){return b}}

async function analizar(blobO){if(!consumirEscaneo())return;const blob=await prepararBlob(blobO);ultimoBlob=blob;show('resultado');$('preview').src=URL.createObjectURL(blob);$('estado').textContent='Analizando imagen';document.querySelector('.result-header').classList.add('scanning');const fd=new FormData();fd.append('imagen',blob,'foto.jpg');try{const r=await fetch('/analizar',{method:'POST',body:fd});if(!r.ok)throw new Error('Servidor '+r.status);const d=await r.json();guardarJardin(blob,d);pintar(d)}catch(e){$('estado').textContent='❌ Error: '+e.message;document.querySelector('.result-header').classList.remove('scanning')}}

function guardarJardin(blob,d){const r=new FileReader();r.onload=()=>{const p=LS.get('plantas',[]);p.unshift({id:Date.now(),img:r.result,data:d,fecha:Date.now()});if(p.length>30)p.length=30;LS.set('plantas',p)};r.readAsDataURL(blob)}

function pintarJardin(){const p=LS.get('plantas',[]);$('jardinVacio').style.display=p.length?'none':'block';$('jardin').innerHTML=p.map(x=>{const s=x.data.salud,c=s.estado==='saludable'?'#2F7A4D':(s.estado==='atencion'?'#D97706':'#DC2626');const nom=x.data.especie.nombre_comun||'Planta';return '<div class="planta" onclick="verDetalle('+x.id+')"><button class="borrar" onclick="event.stopPropagation();eliminarPlanta('+x.id+')">✕</button><img src="'+x.img+'"><div class="txt"><span class="punto" style="background:'+c+'"></span>'+nom+'</div></div>'}).join('')}

function eliminarPlanta(id){if(confirm('¿Eliminar planta?')){LS.set('plantas',LS.get('plantas',[]).filter(x=>x.id!==id));pintarJardin()}}
function verDetalle(id){const p=LS.get('plantas',[]).find(x=>x.id===id);if(p){volverA='jardin';fetch(p.img).then(r=>r.blob()).then(b=>ultimoBlob=b);pintar(p.data);show('resultado')}}

async function pedirInforme(){if(!ultimoBlob){alert('Primero escanea una planta.');return}if(tier()!=='pro'){if(!confirm('Informe detallado: 0,50 € (simulación). ¿Continuar?'))return}$('estado').textContent='Generando informe...';const fd=new FormData();fd.append('imagen',ultimoBlob,'foto.jpg');try{const r=await fetch('/informe',{method:'POST',body:fd});if(!r.ok)throw new Error('Error '+r.status);const d=await r.json();const a=document.createElement('a');a.href=d.url;a.download='informe_florascan.pdf';document.body.appendChild(a);a.click();document.body.removeChild(a);$('estado').textContent='✅ Informe descargado'}catch(e){alert('Error informe: '+e.message)}}

const GUIAS=[['Potos','Riego cuando esté seco arriba','Luz indirecta'],['Monstera','Sustrato húmedo, sin charcos','Luz brillante'],['Lengua de suegra','Muy escaso','Poca luz'],['Aloe vera','Sustrato seco','Pleno sol'],['Lavanda','Escaso','Pleno sol'],['Olivo','Escaso','Pleno sol'],['Rosal','Regular al pie','Pleno sol'],['Adelfa','Moderado','Pleno sol']];
function pintarGuias(){$('guias').innerHTML=GUIAS.map(g=>'<div class="card"><b>'+g[0]+'</b><p style="font-size:14px;color:#6B7280;margin-top:4px">💧 '+g[1]+'</p><p style="font-size:14px;color:#6B7280">☀️ '+g[2]+'</p></div>').join('')}

function datosEspecie(d){const e=d.especie||{};const pn=(e.plantnet&&e.plantnet[0])?e.plantnet[0]:null;const lo=(e.local&&e.local[0])?e.local[0]:null;
let nom=e.nombre_comun||(pn?pn.nombre_comun:'');let cient=e.nombre_cientifico||(pn?pn.nombre_cientifico:'');
if(!nom&&lo)nom=lo.clase;if(!nom||nom.toLowerCase()==='no identificada')nom='Planta';
const genero=cient?cient.split(' ')[0]:(e.genero||'');return{nom,cient,genero}}

const item=(ico,t,desc,sub)=>'<div class="info-item"><div class="icon">'+ico+'</div><div class="content"><div class="title">'+t+'</div>'+(desc?'<div class="desc">'+desc+'</div>':'')+(sub?'<div class="sub">'+sub+'</div>':'')+'</div></div>';
const card=(h,inner)=>'<div class="card-section"><h3>'+h+'</h3><div class="info-card">'+inner+'</div></div>';

function cambiarTab(tab,el){tabActual=tab;document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));if(el)el.classList.add('active');if(datosActuales)renderTabContent(datosActuales)}

function renderTabContent(d){const c=$('tabContent');const s=d.salud||{};const cuid=d.cuidados||{};const e=datosEspecie(d);let h='';
if(tabActual==='cuidados'){
h+='<div class="card-section"><h3>Estado de salud</h3><div class="health-alert '+(s.estado||'saludable')+'"><div class="health-header"><span class="health-badge '+(s.estado||'saludable')+'">'+(s.estado==='saludable'?'Saludable':(s.estado==='atencion'?'Atención':'Malo'))+'</span><span class="health-title">'+(s.puntuacion||0)+'% salud</span></div><p class="health-desc">'+(s.diagnostico||'Sin problemas detectados')+'</p></div></div>';
h+=card('Tratamiento recomendado',(s.recomendaciones&&s.recomendaciones.length?s.recomendaciones.map(r=>item('💡','',r)).join(''):item('✅','','Mantén los cuidados habituales')));
h+=card('Cuidados básicos',item('💧','Riego',cuid.riego||'Moderado')+item('☀️','Luz',cuid.luz||'Indirecta')+item('⚠️','Punto débil',cuid.tipico||'Ninguno'));
}else if(tabActual==='lugar'){
h+=card('Luz',item('☀️',cuid.luz||'Sol parcial','','Luz preferida')+item('🌞','Tolerancias','A pleno sol o sombra parcial','También es adecuada para'));
h+=card('Tierra',item('🪴','Sustrato con buen drenaje','','Tipo de tierra recomendado'));
h+=card('Temperatura',item('🌡️','Rango ideal','15-25 °C, evita heladas fuertes'));
}else if(tabActual==='caracteristicas'){
h+=card('Nombre',item('📖',e.cient||'-','','Nombre científico')+item('🏷️',e.nom,'','Nombre común')+item('🌿',e.genero||'-','','Género'));
h+=card('Tipo',item('🍀',cuid.grupo||'Planta','','Tipo de planta'));
h+=card('Hojas',item('🍃','Perenne','','Tipo de follaje'));
}else{
const probs=(s.sintomas&&s.sintomas.length?s.sintomas:['Luz insuficiente','Manchas','Cicatrices']).slice(0,4);
h+='<div class="card-section"><h3>Problemas comunes</h3><div class="scroll-horizontal">'+probs.map((p,i)=>'<div class="problem-card" style="height:120px;background:linear-gradient(135deg,'+['#D8F3DC','#FDE68A','#FECACA','#E9D5FF'][i%4]+',#fff)"><div class="label" style="color:#1F2937;background:none">'+p+'</div></div>').join('')+'</div></div>';
h+=card('Herramienta de diagnóstico',item('🏥','Autodiagnóstico','Analiza una nueva foto para comprobar su salud')+'<button class="btn btn-verde" style="margin-top:12px" onclick="abrirCamara()">📷 Autodiagnóstico</button>');
h+=card('¿Buscas ayuda adicional?',item('💡','Informe detallado','Descarga el informe completo en PDF con todos los cuidados')+'<button class="btn btn-informe" style="margin-top:12px" onclick="pedirInforme()">📄 Descargar informe</button>');
}
c.innerHTML=h}

function pintar(d){datosActuales=d;document.querySelector('.result-header').classList.remove('scanning');const e=datosEspecie(d);$('estado').textContent='';
$('nombre').textContent=e.nom;
$('subtitulo').textContent='especie de '+(e.genero||'plantas')+' ('+(e.cient.split(' ')[0]||'-')+')';
$('nombreComun').textContent=e.nom;$('nombreBotanico').textContent=e.cient||'-';
const cuid=d.cuidados||{};$('textoLuz').textContent=cuid.luz||'No disponible';$('textoRiego').textContent=cuid.riego||'No disponible';
$('btnInforme').textContent=tier()==='pro'?'📄 Informe detallado (incluido en Pro)':'📄 Informe detallado (0,50 €)';
cambiarTab('cuidados',document.querySelector('.tab'))}

show('jardin');actualizarTier();