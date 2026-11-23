/* ==========================================================
   Armazenamento local de motoboys e entregas (localStorage).
   Os dados ficam só neste navegador/computador.
   ========================================================== */
window.Store = (function () {
  'use strict';
  const KEY = 'raio-barueri-motoboys';

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      return { motoboys: d?.motoboys || [], entregas: d?.entregas || [], lastMoto: d?.lastMoto || null };
    } catch { return { motoboys: [], entregas: [], lastMoto: null }; }
  }
  function save(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* ignora */ }
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /** Data local no formato AAAA-MM-DD (usada para agrupar por dia). */
  function dayKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  return {
    load, dayKey,
    addMoto(name, phone) {
      const d = load(); const m = { id: uid(), name, phone: phone || '' };
      d.motoboys.push(m); save(d); return m;
    },
    removeMoto(id) {
      const d = load();
      d.motoboys = d.motoboys.filter(m => m.id !== id);
      d.entregas = d.entregas.filter(e => e.motoboyId !== id);
      if (d.lastMoto === id) d.lastMoto = null;
      save(d);
    },
    addEntrega(e) {
      const d = load(); d.entregas.push({ id: uid(), ...e }); d.lastMoto = e.motoboyId; save(d);
    },
    removeEntrega(id) {
      const d = load(); d.entregas = d.entregas.filter(e => e.id !== id); save(d);
    }
  };
})();
