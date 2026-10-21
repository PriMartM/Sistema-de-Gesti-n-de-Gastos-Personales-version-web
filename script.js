'use strict';

/* ============ Utilidades ============ */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad = n => String(n).padStart(2, '0');
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/* ============ Store: persistencia 100% local ============
   Equivale a los .dat de C. Un solo objeto JSON en localStorage.
   Nada sale del navegador: no hay fetch ni servidor. */
const KEY = 'gastos-app:v1';
const CATEGORIAS_BASE = ['Alimentación', 'Vivienda', 'Transporte', 'Servicios', 'Salud', 'Educación', 'Ocio', 'Otros'];
const MEDIOS = ['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'Otro'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fmtF = f => f.split('-').reverse().join('/');
const nombreMes = ym => { const [y, m] = ym.split('-'); return `${MESES[+m - 1]} ${y}`; };

const Store = {
  data: null,

  vacio() {
    return {
      v: 1,
      personas: [],
      categorias: CATEGORIAS_BASE.map(nombre => ({ id: uid(), nombre, activo: true })),
      gastos: [],
      ingresos: [],
      pagos: []
    };
  },

  load() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
      this.data = raw ? JSON.parse(raw) : this.vacio();
    } catch (e) {
      // Datos ilegibles: se conserva una copia en vez de pisarlos.
      try { localStorage.setItem(KEY + ':corrupto', raw); } catch (_) {}
      this.data = this.vacio();
    }
    return this.data;
  },

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); return true; }
    catch (e) { alert('No se pudo guardar. Revisá que el navegador permita almacenamiento y que no estés en modo privado.'); return false; }
  },

  exportar() {
    const blob = new Blob([JSON.stringify(this.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gastos-copia-${hoy()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  importar(texto) {
    const d = JSON.parse(texto);
    const ok = d && d.v === 1 && ['personas', 'categorias', 'gastos', 'ingresos', 'pagos'].every(k => Array.isArray(d[k]));
    if (!ok) throw new Error('Archivo no válido');
    this.data = d;
    this.save();
  },

  reset() { this.data = this.vacio(); this.save(); }
};

/* ============ Calc: lógica de negocio (sin DOM) ============
   Aquí se migran las funciones de funciones.h. Son puras:
   reciben los datos y devuelven resultados. */
const Calc = {
  activos: lista => lista.filter(i => i.activo !== false),
  enMes: (lista, ym) => lista.filter(i => i.activo !== false && i.fecha.startsWith(ym)),
  suma: lista => lista.reduce((a, i) => a + i.monto, 0),

  saldoMensual(d, ym) {
    const ingresos = this.suma(this.enMes(d.ingresos, ym));
    const gastos = this.suma(this.enMes(d.gastos, ym));
    return { ingresos, gastos, saldo: ingresos - gastos };
  },

  gastosPorCategoria(d, ym) {
    const acc = new Map();
    for (const g of this.enMes(d.gastos, ym)) acc.set(g.categoriaId, (acc.get(g.categoriaId) || 0) + g.monto);
    return [...acc].map(([categoriaId, total]) => ({ categoriaId, total })).sort((a, b) => b.total - a.total);
  },

  // Pagos de gastos que siguen activos
  pagosActivos: d => d.pagos.filter(p => d.gastos.some(g => g.id === p.gastoId && g.activo !== false)),
  totalPagado: (d, gastoId) => d.pagos.filter(p => p.gastoId === gastoId).reduce((a, p) => a + p.monto, 0),

  // En un gasto temporal el avance se mide por cuotas; en el resto, por la suma de pagos
  pagadoGasto(d, g) { return g.tipo === 'temporal' ? g.monto * g.cuotasPagadas / g.cuotasTotal : this.totalPagado(d, g.id); },
  saldoPendiente(d, g) { return Math.max(0, g.monto - this.pagadoGasto(d, g)); },
  estadoGasto(d, g) {
    if (this.pagadoGasto(d, g) <= 0.005) return 'Pendiente';
    return this.saldoPendiente(d, g) <= 0.005 ? 'Pagado' : 'Pagado parcialmente';
  },

  // 'AAAA-MM' desplazado n meses (n puede ser negativo)
  sumarMeses(ym, n) { const [y, m] = ym.split('-').map(Number); const f = new Date(y, m - 1 + n, 1); return `${f.getFullYear()}-${pad(f.getMonth() + 1)}`; },
  mesesAntes(ym, n) { return Array.from({ length: n }, (_, i) => this.sumarMeses(ym, -(i + 1))); },

  porMes(d) {
    const m = new Map();
    const t = ym => { if (!m.has(ym)) m.set(ym, { ym, ingresos: 0, gastos: 0 }); return m.get(ym); };
    for (const g of this.activos(d.gastos)) t(g.fecha.slice(0, 7)).gastos += g.monto;
    for (const i of this.activos(d.ingresos)) t(i.fecha.slice(0, 7)).ingresos += i.monto;
    return [...m.values()].sort((a, b) => a.ym.localeCompare(b.ym));
  },

  // Promedio de los 3 meses anteriores a ym (se divide siempre por 3)
  promedio3(d, ym) {
    let ingresos = 0, gastos = 0;
    for (const m of this.mesesAntes(ym, 3)) { const s = this.saldoMensual(d, m); ingresos += s.ingresos; gastos += s.gastos; }
    return { ingresos: ingresos / 3, gastos: gastos / 3 };
  },

  proyeccionAnual(d, ym) {
    const { ingresos, gastos } = this.promedio3(d, ym);
    let acum = 0;
    return Array.from({ length: 12 }, (_, i) => { acum += ingresos - gastos; return { ym: this.sumarMeses(ym, i + 1), saldo: ingresos - gastos, acum }; });
  },

  porPersona(d, ym) {
    const gs = this.enMes(d.gastos, ym), total = this.suma(gs), m = new Map();
    for (const g of gs) {
      const k = g.personaId || '', e = m.get(k) || { personaId: k, total: 0, cats: new Map() };
      e.total += g.monto; e.cats.set(g.categoriaId, (e.cats.get(g.categoriaId) || 0) + g.monto); m.set(k, e);
    }
    return [...m.values()].map(e => ({
      personaId: e.personaId, total: e.total, pct: total ? e.total / total * 100 : 0,
      rubro: [...e.cats].sort((a, b) => b[1] - a[1])[0][0]
    })).sort((a, b) => b.total - a.total);
  }
};

/* ============ Acciones: alteran los datos y guardan ============ */
const Acciones = {
  agregarPersona: nombre => { Store.data.personas.push({ id: uid(), nombre, activo: true }); Store.save(); },
  agregarCategoria: nombre => { Store.data.categorias.push({ id: uid(), nombre, activo: true }); Store.save(); },

  agregarGasto(f) {
    const temporal = f.tipo === 'temporal';
    const total = temporal ? Math.max(1, parseInt(f.cuotasTotal, 10) || 1) : 0;
    Store.data.gastos.push({
      id: uid(), descripcion: f.descripcion.trim(), monto: parseFloat(f.monto), fecha: f.fecha,
      categoriaId: f.categoriaId, personaId: f.personaId || null, tipo: f.tipo,
      cuotasTotal: total, cuotasPagadas: temporal ? Math.min(total, Math.max(0, parseInt(f.cuotasPagadas, 10) || 0)) : 0,
      activo: true
    });
    Store.save();
  },

  agregarIngreso(f) {
    Store.data.ingresos.push({ id: uid(), concepto: f.concepto.trim(), monto: parseFloat(f.monto), fecha: f.fecha, personaId: f.personaId, activo: true });
    Store.save();
  },

  // Devuelve un mensaje de error o null si se registró bien
  registrarPago(f) {
    const d = Store.data, g = d.gastos.find(x => x.id === f.gastoId);
    if (!g) return 'Elegí un gasto.';
    const monto = parseFloat(f.monto), pend = Calc.saldoPendiente(d, g);
    if (!(monto > 0)) return 'Ingresá un monto válido.';
    if (monto > pend + 0.005) return `El pago supera el saldo pendiente (${money(pend)}).`;
    d.pagos.push({ id: uid(), gastoId: g.id, monto, fecha: f.fecha, medio: f.medio });
    if (g.tipo === 'temporal') g.cuotasPagadas = Math.min(g.cuotasTotal, g.cuotasPagadas + 1); // cada pago = una cuota
    Store.save();
    return null;
  },

  // Baja lógica (el registro queda guardado con activo:false)
  baja(coleccion, id) {
    const item = Store.data[coleccion].find(i => i.id === id);
    if (item) { item.activo = false; Store.save(); }
  }
};

/* ============ UI ============ */
const nombreDe = (lista, id, vacio = 'Sin asignar') => (lista.find(i => i.id === id) || {}).nombre || vacio;
const opciones = lista => Calc.activos(lista).map(i => `<option value="${i.id}">${esc(i.nombre)}</option>`).join('');
const ymActual = () => $('#mes').value;

const UI = {
  render() {
    const d = Store.data, ym = ymActual();
    this.resumen(d, ym);
    this.gastos(d, ym);
    this.ingresos(d, ym);
    this.admin(d);
    this.pagos(d);
    this.consulta();
  },

  resumen(d, ym) {
    const { ingresos, gastos, saldo } = Calc.saldoMensual(d, ym);
    $('#saldo').innerHTML = `
      <div class="total"><small>Saldo del mes</small><strong class="${saldo < 0 ? 'neg' : 'pos'}">${money(saldo)}</strong></div>
      <div><small>Ingresos</small><strong>${money(ingresos)}</strong></div>
      <div><small>Gastos</small><strong>${money(gastos)}</strong></div>`;
    const cats = Calc.gastosPorCategoria(d, ym);
    $('#cats').innerHTML = cats.length
      ? cats.map(c => `<li><div class="fila"><span>${esc(nombreDe(d.categorias, c.categoriaId))}</span><span>${money(c.total)}</span></div>
          <div class="pista"><div class="relleno" style="width:${gastos ? (c.total / gastos * 100).toFixed(1) : 0}%"></div></div></li>`).join('')
      : '<li class="vacio">Todavía no hay gastos en este mes.</li>';
  },

  gastos(d, ym) {
    const sel = { cat: $('#s-cat').value, per: $('#s-per-g').value };
    $('#s-cat').innerHTML = opciones(d.categorias);
    $('#s-per-g').innerHTML = '<option value="">Sin asignar</option>' + opciones(d.personas);
    if (sel.cat) $('#s-cat').value = sel.cat;
    if (sel.per) $('#s-per-g').value = sel.per;

    const lista = Calc.enMes(d.gastos, ym).sort((a, b) => b.fecha.localeCompare(a.fecha));
    $('#l-gastos').innerHTML = lista.length ? lista.map(g => `
      <li><div><div>${esc(g.descripcion)}</div>
        <div class="detalle">${esc(nombreDe(d.categorias, g.categoriaId))} · ${esc(nombreDe(d.personas, g.personaId))} · ${g.fecha}
        ${g.tipo === 'temporal' ? ` · cuota ${g.cuotasPagadas}/${g.cuotasTotal}` : ''} · ${Calc.estadoGasto(d, g)}</div></div>
        <div><span class="monto">${money(g.monto)}</span> <button type="button" data-baja="gastos" data-id="${g.id}" aria-label="Eliminar ${esc(g.descripcion)}">Eliminar</button></div></li>`).join('')
      : '<li class="vacio">No hay gastos registrados en este mes.</li>';
  },

  ingresos(d, ym) {
    const prev = $('#s-per-i').value;
    $('#s-per-i').innerHTML = opciones(d.personas) || '<option value="">Primero agregá una persona</option>';
    if (prev) $('#s-per-i').value = prev;
    const lista = Calc.enMes(d.ingresos, ym).sort((a, b) => b.fecha.localeCompare(a.fecha));
    $('#l-ingresos').innerHTML = lista.length ? lista.map(i => `
      <li><div><div>${esc(i.concepto)}</div><div class="detalle">${esc(nombreDe(d.personas, i.personaId))} · ${i.fecha}</div></div>
        <div><span class="monto">${money(i.monto)}</span> <button type="button" data-baja="ingresos" data-id="${i.id}" aria-label="Eliminar ${esc(i.concepto)}">Eliminar</button></div></li>`).join('')
      : '<li class="vacio">No hay ingresos registrados en este mes.</li>';
  },

  admin(d) {
    const fila = (col, i) => `<li><span>${esc(i.nombre)}</span><button type="button" data-baja="${col}" data-id="${i.id}">Eliminar</button></li>`;
    const p = Calc.activos(d.personas), c = Calc.activos(d.categorias);
    $('#l-personas').innerHTML = p.length ? p.map(i => fila('personas', i)).join('') : '<li class="vacio">Agregá a las personas que registran movimientos.</li>';
    $('#l-categorias').innerHTML = c.map(i => fila('categorias', i)).join('');
  },

  pagos(d) {
    const prev = $('#s-gasto').value;
    const l = Calc.activos(d.gastos).filter(g => Calc.saldoPendiente(d, g) > 0.005);
    $('#s-gasto').innerHTML = l.length
      ? l.map(g => `<option value="${g.id}">${esc(g.descripcion)} (${fmtF(g.fecha)}) · pendiente ${money(Calc.saldoPendiente(d, g))}</option>`).join('')
      : '<option value="">No hay gastos pendientes de pago</option>';
    if (prev) $('#s-gasto').value = prev;
    if ($('#s-gasto').selectedIndex < 0) $('#s-gasto').selectedIndex = 0;
    if (!$('#s-medio').options.length) $('#s-medio').innerHTML = MEDIOS.map(m => `<option>${m}</option>`).join('');
  },

  consulta() {
    const d = Store.data, c = CONSULTAS[$('#q-tipo').value];
    if (!c) return;
    $('#q-param-l').hidden = !c.param;
    if (c.param) {
      const prev = $('#q-param').value;
      $('#q-param-t').textContent = c.param.titulo;
      $('#q-param').innerHTML = c.param.ops(d).map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
      if (prev) $('#q-param').value = prev;
      if ($('#q-param').selectedIndex < 0) $('#q-param').selectedIndex = 0;
    }
    $('#q-nota').textContent = c.nota || '';
    $('#q-out').innerHTML = c.param && !$('#q-param').value
      ? '<p class="vacio">Todavía no hay opciones para elegir.</p>'
      : c.run(d, ymActual(), $('#q-param').value);
  },

  mostrar(vista) {
    document.querySelectorAll('[data-view]').forEach(s => { s.hidden = s.dataset.view !== vista; });
    document.querySelectorAll('[data-tab]').forEach(b => { b.dataset.tab === vista ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'); });
  }
};

/* ============ Consultas ============
   Cada consulta devuelve HTML (tabla). Los textos del usuario pasan por esc(). */
const gastoNom = (d, id) => (d.gastos.find(g => g.id === id) || {}).descripcion || '—';
const tabla = (cab, filas) => filas.length
  ? `<div class="tabla"><table><thead><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${filas.map(f => `<tr>${f.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : '<p class="vacio">Sin resultados.</p>';
const conTotal = (filas, cols, v) => filas.length ? filas.concat([[...Array(cols - 2).fill(''), '<strong>Total</strong>', `<strong>${money(v)}</strong>`]]) : filas;
const negrita = (a, b) => [`<strong>${a}</strong>`, `<strong>${b}</strong>`];

const CONSULTAS = {
  categoria: {
    label: 'Gastos por categoría', nota: 'Incluye todos los meses.',
    param: { titulo: 'Categoría', ops: d => Calc.activos(d.categorias).map(c => [c.id, c.nombre]) },
    run: (d, ym, p) => { const l = Calc.activos(d.gastos).filter(g => g.categoriaId === p); return tabla(['Fecha', 'Descripción', 'Monto'], conTotal(l.map(g => [fmtF(g.fecha), esc(g.descripcion), money(g.monto)]), 3, Calc.suma(l))); }
  },
  gastosPersona: {
    label: 'Gastos por persona', nota: 'Del mes seleccionado.',
    param: { titulo: 'Persona', ops: d => Calc.activos(d.personas).map(p => [p.id, p.nombre]).concat([['__sin__', 'Sin asignar']]) },
    run: (d, ym, p) => {
      const l = Calc.enMes(d.gastos, ym).filter(g => p === '__sin__' ? !g.personaId : g.personaId === p).sort((a, b) => a.fecha.localeCompare(b.fecha));
      return tabla(['Fecha', 'Descripción', 'Categoría', 'Monto'], conTotal(l.map(g => [fmtF(g.fecha), esc(g.descripcion), esc(nombreDe(d.categorias, g.categoriaId)), money(g.monto)]), 4, Calc.suma(l)));
    }
  },
  ingresos: {
    label: 'Ingresos por persona', nota: 'Incluye todos los meses.',
    param: { titulo: 'Persona', ops: d => Calc.activos(d.personas).map(p => [p.id, p.nombre]) },
    run: (d, ym, p) => { const l = Calc.activos(d.ingresos).filter(i => i.personaId === p); return tabla(['Fecha', 'Concepto', 'Monto'], conTotal(l.map(i => [fmtF(i.fecha), esc(i.concepto), money(i.monto)]), 3, Calc.suma(l))); }
  },
  saldo: {
    label: 'Saldo mensual', nota: 'Del mes seleccionado: ingresos menos gastos.',
    run: (d, ym) => { const s = Calc.saldoMensual(d, ym); return tabla(['Concepto', 'Monto'], [['Ingresos', money(s.ingresos)], ['Gastos', money(s.gastos)], negrita('Saldo', money(s.saldo))]); }
  },
  cuotas: {
    label: 'Gastos con cuotas pendientes', nota: 'Compras temporales con cuotas todavía sin pagar.',
    run: d => { const l = Calc.activos(d.gastos).filter(g => g.tipo === 'temporal' && g.cuotasPagadas < g.cuotasTotal); return tabla(['Descripción', 'Pagadas', 'Restantes', 'Saldo'], l.map(g => [esc(g.descripcion), `${g.cuotasPagadas}/${g.cuotasTotal}`, g.cuotasTotal - g.cuotasPagadas, money(Calc.saldoPendiente(d, g))])); }
  },
  medio: {
    label: 'Pagos por medio de pago', nota: 'Incluye todos los meses.',
    param: { titulo: 'Medio de pago', ops: () => MEDIOS.map(m => [m, m]) },
    run: (d, ym, p) => { const l = Calc.pagosActivos(d).filter(x => x.medio === p); return tabla(['Fecha', 'Gasto', 'Monto'], conTotal(l.map(x => [fmtF(x.fecha), esc(gastoNom(d, x.gastoId)), money(x.monto)]), 3, Calc.suma(l))); }
  },
  incompleto: {
    label: 'Gastos con saldo incompleto', nota: 'Gastos con saldo por pagar, sin pagar o pagados en parte.',
    run: d => { const l = Calc.activos(d.gastos).filter(g => Calc.saldoPendiente(d, g) > 0.005); return tabla(['Descripción', 'Monto', 'Estado', 'Saldo'], l.map(g => [esc(g.descripcion), money(g.monto), Calc.estadoGasto(d, g), money(Calc.saldoPendiente(d, g))])); }
  },
  top3: {
    label: 'Top 3 categorías más costosas', nota: 'Del mes seleccionado.',
    run: (d, ym) => tabla(['Categoría', 'Total'], Calc.gastosPorCategoria(d, ym).slice(0, 3).map(c => [esc(nombreDe(d.categorias, c.categoriaId)), money(c.total)]))
  },
  proyMensual: {
    label: 'Proyección mensual de gastos', nota: 'Promedio de los 3 meses anteriores al mes seleccionado.',
    run: (d, ym) => tabla(['Mes', 'Gastos'], Calc.mesesAntes(ym, 3).map(m => [nombreMes(m), money(Calc.saldoMensual(d, m).gastos)]).concat([negrita('Proyección ' + nombreMes(ym), money(Calc.promedio3(d, ym).gastos))]))
  },
  resumen: {
    label: 'Resumen general histórico', nota: 'Todos los meses con movimientos.',
    run: d => {
      const m = Calc.porMes(d), ing = m.reduce((a, x) => a + x.ingresos, 0), gas = m.reduce((a, x) => a + x.gastos, 0), n = m.length || 1;
      return tabla(['Concepto', 'Valor'], [['Meses con movimientos', m.length], ['Total de ingresos', money(ing)], ['Total de gastos', money(gas)], ['Saldo acumulado', money(ing - gas)], ['Promedio mensual de ingresos', money(ing / n)], ['Promedio mensual de gastos', money(gas / n)]]);
    }
  },
  comparativo: {
    label: 'Comparativo intermensual', nota: 'Variación de gastos respecto del mes anterior con movimientos.',
    run: d => { const m = Calc.porMes(d); return tabla(['Mes', 'Gastos', 'Variación'], m.map((x, i) => { const p = m[i - 1], v = p && p.gastos ? (x.gastos - p.gastos) / p.gastos * 100 : null; return [nombreMes(x.ym), money(x.gastos), v === null ? '—' : `<span class="${v > 0 ? 'neg' : 'pos'}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`]; })); }
  },
  distribucion: {
    label: 'Categoría donde más gasta cada persona', nota: 'Del mes seleccionado.',
    run: (d, ym) => tabla(['Persona', 'Total', '%', 'Rubro principal'], Calc.porPersona(d, ym).map(x => [esc(nombreDe(d.personas, x.personaId)), money(x.total), x.pct.toFixed(1) + '%', esc(nombreDe(d.categorias, x.rubro))]))
  },
  proyAnual: {
    label: 'Proyección anual de saldo', nota: 'Próximos 12 meses, usando el promedio de ingresos y gastos de los 3 meses anteriores al mes seleccionado.',
    run: (d, ym) => tabla(['Mes', 'Saldo', 'Acumulado'], Calc.proyeccionAnual(d, ym).map(x => [nombreMes(x.ym), money(x.saldo), money(x.acum)]))
  },
  historial: {
    label: 'Historial de un gasto temporal', nota: 'Detalle de cuotas y pagos registrados.',
    param: { titulo: 'Gasto', ops: d => Calc.activos(d.gastos).filter(g => g.tipo === 'temporal').map(g => [g.id, g.descripcion]) },
    run: (d, ym, p) => {
      const g = d.gastos.find(x => x.id === p);
      if (!g) return '';
      const cuotas = Array.from({ length: g.cuotasTotal }, (_, i) => [i + 1, money(g.monto / g.cuotasTotal), i < g.cuotasPagadas ? 'Pagada' : 'Pendiente']);
      const pagos = d.pagos.filter(x => x.gastoId === g.id).map(x => [fmtF(x.fecha), money(x.monto), esc(x.medio)]);
      return tabla(['Cuota', 'Valor', 'Estado'], cuotas) + '<h2>Pagos registrados</h2>' + tabla(['Fecha', 'Monto', 'Medio'], pagos);
    }
  }
};

/* ============ Reporte mensual (.txt) ============ */
function descargar(nombre, texto, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([texto], { type: tipo }));
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(a.href);
}

function reporte(d, ym) {
  const [y, m] = ym.split('-'), lin = '-'.repeat(64);
  const ing = Calc.enMes(d.ingresos, ym), gas = Calc.enMes(d.gastos, ym);
  const pag = Calc.pagosActivos(d).filter(p => p.fecha.startsWith(ym)), s = Calc.saldoMensual(d, ym);
  const bloque = (titulo, filas) => ['', titulo, ...(filas.length ? filas : ['(sin movimientos)'])];
  return [
    `RESUMEN DE ${MESES[+m - 1].toUpperCase()} ${y}`, lin,
    ...bloque('INGRESOS', ing.map(i => `${fmtF(i.fecha)}  ${nombreDe(d.personas, i.personaId).padEnd(14)} ${i.concepto.padEnd(24)} ${money(i.monto)}`)),
    ...bloque('GASTOS', gas.map(g => `${fmtF(g.fecha)}  ${nombreDe(d.categorias, g.categoriaId).padEnd(14)} ${g.descripcion.padEnd(24)} ${money(g.monto)}  [${Calc.estadoGasto(d, g)}]`)),
    ...bloque('PAGOS', pag.map(p => `${fmtF(p.fecha)}  ${p.medio.padEnd(14)} ${gastoNom(d, p.gastoId).padEnd(24)} ${money(p.monto)}`)),
    '', lin, `Total de ingresos: ${money(s.ingresos)}`, `Total de gastos:   ${money(s.gastos)}`, `Saldo del mes:     ${money(s.saldo)}`
  ].join('\r\n');
}

/* ============ Eventos ============ */
const datosForm = form => Object.fromEntries(new FormData(form));

function enviar(id, accion, despues) {
  $(id).addEventListener('submit', e => {
    e.preventDefault();
    accion(datosForm(e.target));
    e.target.reset();
    if (despues) despues(e.target);
    UI.render();
  });
}

function init() {
  Store.load();
  const h = hoy();
  $('#mes').value = h.slice(0, 7);
  document.querySelectorAll('input[name="fecha"]').forEach(i => { i.value = h; });

  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => UI.mostrar(b.dataset.tab)));
  $('#mes').addEventListener('change', () => { if (ymActual()) UI.render(); });
  $('#tipo').addEventListener('change', e => { $('#cuotas').hidden = e.target.value !== 'temporal'; });

  const reponerFecha = f => { const i = f.querySelector('[name="fecha"]'); if (i) i.value = hoy(); $('#cuotas').hidden = true; };
  enviar('#f-gasto', Acciones.agregarGasto, reponerFecha);
  enviar('#f-ingreso', f => { if (f.personaId) Acciones.agregarIngreso(f); else alert('Agregá primero una persona en Administrar.'); }, reponerFecha);
  enviar('#f-persona', f => Acciones.agregarPersona(f.nombre.trim()));
  enviar('#f-categoria', f => Acciones.agregarCategoria(f.nombre.trim()));

  document.body.addEventListener('click', e => {
    const b = e.target.closest('[data-baja]');
    if (b && confirm('¿Eliminar este registro?')) { Acciones.baja(b.dataset.baja, b.dataset.id); UI.render(); }
  });

  $('#b-export').addEventListener('click', () => Store.exportar());
  $('#b-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (!confirm('Esto reemplaza los datos actuales. ¿Continuar?')) return;
      Store.importar(await file.text());
      UI.render();
    } catch (_) { alert('El archivo no es una copia válida.'); }
    e.target.value = '';
  });
  $('#b-reset').addEventListener('click', () => {
    if (confirm('Se borrarán todos tus datos de este navegador. ¿Seguro?')) { Store.reset(); UI.render(); }
  });

  $('#f-pago').addEventListener('submit', e => {
    e.preventDefault();
    const err = Acciones.registrarPago(datosForm(e.target));
    if (err) { alert(err); return; }
    e.target.reset();
    reponerFecha(e.target);
    UI.render();
  });

  $('#q-tipo').innerHTML = Object.entries(CONSULTAS).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('');
  $('#q-tipo').addEventListener('change', () => UI.consulta());
  $('#q-param').addEventListener('change', () => UI.consulta());
  $('#b-reporte').addEventListener('click', () => {
    const ym = ymActual();
    if (!ym) { alert('Elegí un mes.'); return; }
    const [y, m] = ym.split('-');
    descargar(`resumen_${MESES[+m - 1]}_${y}.txt`, '\ufeff' + reporte(Store.data, ym), 'text/plain;charset=utf-8');
  });

  UI.render();
}

document.addEventListener('DOMContentLoaded', init);
