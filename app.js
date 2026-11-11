import {
  addMonths,
  createCharges,
  createDemoData,
  getChargeStatus,
  getChargeSummary,
  getPaidAmount,
  getUpcomingEvents,
  toISODate,
} from "./domain.js";

const STORAGE_KEY = "casathomaz.v1";
const root = document.querySelector("#app-content");
const dialog = document.querySelector("#app-dialog");
const dialogContent = document.querySelector("#dialog-content");
const toast = document.querySelector("#toast");
const money = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "short", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric" });
const today = toISODate(new Date());
const currentPeriod = today.slice(0, 7);

let state = loadState();
let activeView = "dashboard";
let selectedPeriod = currentPeriod;
let horizon = 6;
let toastTimer;

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    const demo = createDemoData(today);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(demo));
    return demo;
  }
  const data = JSON.parse(saved);
  if (!data || !Array.isArray(data.properties) || !Array.isArray(data.contracts) || !Array.isArray(data.charges)) {
    throw new Error("Os dados guardados da CasaThomaz não têm um formato válido.");
  }
  return data;
}

function saveState(message) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (message) showToast(message);
}

function ensureCharges(period) {
  const next = createCharges(state.contracts, state.charges, period);
  if (next.length !== state.charges.length) {
    state.charges = next;
    saveState();
  }
}

function formatDate(value) {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  return dateFormat.format(new Date(year, month - 1, day));
}

function formatMonth(value) {
  const [year, month] = value.split("-").map(Number);
  const text = monthFormat.format(new Date(year, month - 1, 1));
  return text.charAt(0).toLocaleUpperCase("pt-PT") + text.slice(1);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function propertyForContract(contractId) {
  const contract = state.contracts.find((item) => item.id === contractId);
  return state.properties.find((item) => item.id === contract?.propertyId);
}

function activeContractFor(propertyId) {
  return state.contracts.find((contract) => (
    contract.propertyId === propertyId
    && contract.status === "active"
    && contract.startDate <= today
    && (!contract.endDate || contract.endDate >= today)
  ));
}

function statusLabel(status) {
  return {
    paid: "Recebida",
    partial: "Parcial",
    "partial-overdue": "Parcial em atraso",
    overdue: "Em atraso",
    pending: "Por pagar",
  }[status] || status;
}

function statusClass(status) {
  return `status-${status}`;
}

function renderEvent(event, compact = false) {
  const contract = state.contracts.find((item) => item.id === event.contractId);
  const property = propertyForContract(event.contractId);
  const icon = event.type === "notice" ? "↗" : event.type === "adjustment" ? "％" : "⌛";
  const [eventDay, ...eventMonth] = formatDate(event.date).split("/");
  const action = event.type === "notice" && !event.completed
    ? `<button class="text-button" type="button" data-action="prepare-notice" data-contract-id="${escapeHtml(event.contractId)}">Preparar aviso <span aria-hidden="true">→</span></button>`
    : event.type === "notice"
      ? '<span class="event-complete">Aviso marcado como enviado</span>'
      : "";
  return `
    <article class="event-row ${compact ? "event-row-compact" : ""} ${event.completed ? "is-complete" : ""}">
      <div class="event-date" aria-label="${formatDate(event.date)}"><span>${eventDay}</span><small>${eventMonth.join("/")}</small></div>
      <span class="event-icon event-icon-${event.type}" aria-hidden="true">${icon}</span>
      <div class="event-copy">
        <strong>${escapeHtml(event.title)}</strong>
        <span>${escapeHtml(property?.name || "Imóvel")} · ${escapeHtml(contract?.tenantName || "")}</span>
      </div>
      ${action}
    </article>`;
}

function renderDashboard() {
  ensureCharges(currentPeriod);
  const summary = getChargeSummary(state.contracts, state.charges, currentPeriod, today);
  const occupied = state.properties.filter((property) => activeContractFor(property.id)).length;
  const vacant = Math.max(0, state.properties.length - occupied);
  const events = getUpcomingEvents(state.contracts, today, horizon);
  const upcoming = events.slice(0, 4);
  const uncollected = state.charges
    .filter((charge) => charge.period === currentPeriod && getChargeStatus(charge, today) !== "paid")
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 4);
  const percent = Math.round(summary.collectionRate * 100);

  return `
    <section class="page-heading">
      <div>
        <p class="eyebrow">${formatDate(today)}</p>
        <h1>Olá, bem-vindo à sua casa.</h1>
        <p class="heading-subtitle">Acompanhe o que está a acontecer com os seus arrendamentos.</p>
      </div>
      <button class="button button-primary" type="button" data-action="new-contract"><span aria-hidden="true">＋</span> Novo contrato</button>
    </section>

    <section class="stats-grid" aria-label="Resumo da carteira">
      <article class="stat-card stat-card-properties">
        <div class="stat-top"><span>Os seus imóveis</span><span class="stat-icon" aria-hidden="true">⌂</span></div>
        <strong class="stat-value">${state.properties.length}</strong>
        <div class="stat-foot"><span class="positive-dot" aria-hidden="true"></span>${occupied} arrendados <span class="stat-separator">·</span> ${vacant} disponíveis</div>
      </article>
      <article class="stat-card">
        <div class="stat-top"><span>Contratos ativos</span><span class="stat-icon stat-icon-lilac" aria-hidden="true">▤</span></div>
        <strong class="stat-value">${summary.activeContracts}</strong>
        <div class="stat-foot">de ${state.properties.length} imóveis na carteira</div>
      </article>
      <article class="stat-card stat-card-received">
        <div class="stat-top"><span>Rendas recebidas</span><span class="stat-icon stat-icon-green" aria-hidden="true">↙</span></div>
        <strong class="stat-value">${money.format(summary.received)}</strong>
        <div class="stat-foot">${formatMonth(currentPeriod)} <span class="stat-separator">·</span> ${summary.paidCount} completas</div>
      </article>
      <article class="stat-card stat-card-missing">
        <div class="stat-top"><span>Por receber</span><span class="stat-icon stat-icon-orange" aria-hidden="true">!</span></div>
        <strong class="stat-value">${money.format(summary.missing)}</strong>
        <div class="stat-foot">${summary.overdueCount ? `<span class="warning-text">${summary.overdueCount} ${summary.overdueCount === 1 ? "renda em atraso" : "rendas em atraso"}</span>` : "Sem rendas em atraso"}</div>
      </article>
    </section>

    <section class="dashboard-grid">
      <article class="panel collection-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">COBRANÇAS</p><h2>Este mês</h2></div>
          <button class="text-button" type="button" data-view="payments">Ver cobranças <span aria-hidden="true">→</span></button>
        </div>
        <div class="collection-summary">
          <div class="collection-amount"><strong>${money.format(summary.received)}</strong><span>de ${money.format(summary.total)} previstos</span></div>
          <div class="collection-rate">${percent}<small>%</small></div>
        </div>
        <div class="progress-track" role="progressbar" aria-label="Percentagem de rendas recebidas" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
          <span style="width: ${percent}%"></span>
        </div>
        <div class="collection-legend"><span><i class="legend-dot received-dot"></i>Recebido</span><span><i class="legend-dot missing-dot"></i>Em falta ${money.format(summary.missing)}</span></div>
        <div class="collection-footer"><span>${summary.chargeCount} rendas previstas</span><span>${summary.overdueCount} em atraso</span></div>
      </article>

      <article class="panel property-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">A SUA CARTEIRA</p><h2>Imóveis</h2></div>
          <button class="icon-button" type="button" aria-label="Ver todos os imóveis" data-view="properties">→</button>
        </div>
        <div class="occupancy-visual">
          <div class="occupancy-ring" style="--occupied: ${state.properties.length ? Math.round((occupied / state.properties.length) * 100) : 0}%"><span>${state.properties.length ? Math.round((occupied / state.properties.length) * 100) : 0}%</span></div>
          <div class="occupancy-legend"><strong>${occupied} de ${state.properties.length}</strong><span>imóveis arrendados</span><small>${vacant} disponíveis</small></div>
        </div>
        <div class="property-mini-list">
          ${state.properties.slice(0, 3).map((property) => {
            const contract = activeContractFor(property.id);
            return `<div class="property-mini"><span class="property-mini-icon" aria-hidden="true">${property.type === "Moradia" ? "⌂" : "▦"}</span><span><strong>${escapeHtml(property.name)}</strong><small>${escapeHtml(property.address.split(",").slice(-1)[0].trim())}</small></span><span class="mini-status ${contract ? "mini-status-rented" : "mini-status-vacant"}">${contract ? "Arrendado" : "Disponível"}</span></div>`;
          }).join("") || '<p class="empty-inline">Adicione o primeiro imóvel para começar.</p>'}
        </div>
      </article>

      <article class="panel upcoming-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">PARA NÃO ESQUECER</p><h2>Próximas datas</h2></div>
          <label class="sr-only" for="dashboard-horizon">Horizonte da agenda</label>
          <select class="select-compact" id="dashboard-horizon" data-horizon>
            ${[3, 4, 5, 6].map((months) => `<option value="${months}" ${horizon === months ? "selected" : ""}>${months} meses</option>`).join("")}
          </select>
        </div>
        <div class="event-list">
          ${upcoming.map((event) => renderEvent(event, true)).join("") || '<div class="empty-state empty-state-small"><span class="empty-icon">✦</span><strong>Agenda tranquila</strong><p>Não há datas relevantes neste período.</p></div>'}
        </div>
        <button class="panel-link" type="button" data-view="agenda">Abrir agenda completa <span aria-hidden="true">→</span></button>
      </article>

      <article class="panel attention-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">ACOMPANHAMENTO</p><h2>Rendas por receber</h2></div>
          <span class="count-pill">${uncollected.length}</span>
        </div>
        <div class="attention-list">
          ${uncollected.map((charge) => {
            const contract = state.contracts.find((item) => item.id === charge.contractId);
            const property = propertyForContract(charge.contractId);
            const status = getChargeStatus(charge, today);
            return `<div class="attention-row"><div class="attention-avatar" aria-hidden="true">${escapeHtml((contract?.tenantName || "?").split(" ").map((part) => part[0]).slice(0, 2).join(""))}</div><div class="attention-copy"><strong>${escapeHtml(contract?.tenantName || "Arrendatário")}</strong><span>${escapeHtml(property?.name || "Imóvel")} · vence ${formatDate(charge.dueDate)}</span></div><div class="attention-amount"><strong>${money.format(Math.max(0, charge.amount - getPaidAmount(charge)))}</strong><span class="status-badge ${statusClass(status)}">${statusLabel(status)}</span></div></div>`;
          }).join("") || '<div class="empty-state empty-state-small"><span class="empty-icon">✓</span><strong>Tudo em dia</strong><p>Não há valores em falta neste mês.</p></div>'}
        </div>
        <button class="panel-link" type="button" data-view="payments">Acompanhar pagamentos <span aria-hidden="true">→</span></button>
      </article>
    </section>`;
}

function renderProperties() {
  return `
    <section class="page-heading">
      <div><p class="eyebrow">A SUA CARTEIRA</p><h1>Imóveis</h1><p class="heading-subtitle">${state.properties.length} ${state.properties.length === 1 ? "imóvel registado" : "imóveis registados"} · a carteira pode crescer consigo</p></div>
      <button class="button button-primary" type="button" data-action="new-property"><span aria-hidden="true">＋</span> Adicionar imóvel</button>
    </section>
    ${state.properties.length ? `<section class="property-grid" aria-label="Lista de imóveis">
      ${state.properties.map((property) => {
        const contract = activeContractFor(property.id);
        const nextAdjustment = contract?.adjustmentDate
          ? `<span class="property-detail">Atualização anual · ${formatDate(contract.adjustmentDate)}</span>`
          : "";
        return `<article class="property-card">
          <div class="property-card-art ${property.type === "Moradia" ? "house-art" : "flat-art"}" aria-hidden="true">
            <span class="art-sun"></span><span class="art-building"><i></i><i></i><i></i><i></i></span>
            <span class="property-type-tag">${escapeHtml(property.type)}</span>
            <span class="property-card-menu">${property.bedrooms} ${property.bedrooms === 1 ? "quarto" : "quartos"}</span>
          </div>
          <div class="property-card-body">
            <div class="property-card-title"><div><h2>${escapeHtml(property.name)}</h2><p>${escapeHtml(property.address)}</p></div><span class="mini-status ${contract ? "mini-status-rented" : "mini-status-vacant"}">${contract ? "Arrendado" : "Disponível"}</span></div>
            <div class="property-details"><span>${property.area ? `${escapeHtml(property.area)} m²` : "Área não indicada"}</span>${contract ? `<span>Arrendatário · ${escapeHtml(contract.tenantName)}</span><strong>${money.format(contract.monthlyRent)}<small> / mês</small></strong>${nextAdjustment}` : '<span>Sem contrato ativo</span>'}</div>
            <div class="property-card-actions"><button class="button button-secondary button-small" type="button" data-action="edit-property" data-id="${escapeHtml(property.id)}">Editar imóvel</button>${contract ? `<button class="text-button" type="button" data-action="edit-contract" data-id="${escapeHtml(contract.id)}">Ver contrato</button>` : `<button class="text-button" type="button" data-action="new-contract" data-property-id="${escapeHtml(property.id)}">Adicionar contrato <span aria-hidden="true">→</span></button>`}</div>
          </div>
        </article>`;
      }).join("")}
    </section>` : `<section class="empty-state page-empty"><span class="empty-icon">⌂</span><h2>A sua carteira começa aqui</h2><p>Registe o seu primeiro imóvel e mantenha num só lugar os contratos e as rendas.</p><button class="button button-primary" type="button" data-action="new-property">Adicionar primeiro imóvel</button></section>`}`;
}

function renderContracts() {
  const contracts = [...state.contracts].sort((a, b) => a.endDate.localeCompare(b.endDate));
  return `
    <section class="page-heading">
      <div><p class="eyebrow">ARRENDAMENTOS</p><h1>Contratos</h1><p class="heading-subtitle">Arrendatários, rendas e datas importantes num só lugar.</p></div>
      <button class="button button-primary" type="button" data-action="new-contract"><span aria-hidden="true">＋</span> Novo contrato</button>
    </section>
    ${contracts.length ? `<section class="panel table-panel">
      <div class="table-toolbar"><div><strong>${contracts.length} ${contracts.length === 1 ? "contrato" : "contratos"}</strong><span>Inclui contratos ativos e anteriores</span></div><span class="table-toolbar-total">${state.contracts.filter((c) => c.status === "active").length} ativos</span></div>
      <div class="table-scroll"><table><thead><tr><th>Imóvel / arrendatário</th><th>Renda mensal</th><th>Início</th><th>Fim</th><th>Próxima atualização</th><th>Estado</th><th><span class="sr-only">Ações</span></th></tr></thead><tbody>
      ${contracts.map((contract) => {
        const property = state.properties.find((item) => item.id === contract.propertyId);
        const isActive = contract.status === "active" && contract.startDate <= today && (!contract.endDate || contract.endDate >= today);
        return `<tr><td><strong>${escapeHtml(property?.name || "Imóvel removido")}</strong><span>${escapeHtml(contract.tenantName)}</span></td><td><strong>${money.format(contract.monthlyRent)}</strong></td><td>${formatDate(contract.startDate)}</td><td>${formatDate(contract.endDate)}</td><td>${formatDate(contract.adjustmentDate)}</td><td><span class="status-badge ${isActive ? "status-paid" : "status-neutral"}">${isActive ? "Ativo" : "Terminado"}</span></td><td><button class="icon-button table-edit" type="button" aria-label="Editar contrato de ${escapeHtml(contract.tenantName)}" data-action="edit-contract" data-id="${escapeHtml(contract.id)}">↗</button></td></tr>`;
      }).join("")}
      </tbody></table></div>
    </section>` : `<section class="empty-state page-empty"><span class="empty-icon">▤</span><h2>Ainda sem contratos</h2><p>Associe um contrato a um imóvel para acompanhar rendas e datas de atualização.</p><button class="button button-primary" type="button" data-action="new-contract">Criar contrato</button></section>`}`;
}

function renderPayments() {
  ensureCharges(selectedPeriod);
  const charges = state.charges
    .filter((charge) => charge.period === selectedPeriod)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const summary = getChargeSummary(state.contracts, state.charges, selectedPeriod, today);
  return `
    <section class="page-heading">
      <div><p class="eyebrow">CONTROLO DE RENDAS</p><h1>Rendas e pagamentos</h1><p class="heading-subtitle">Registe os pagamentos e identifique valores pendentes ou em atraso.</p></div>
      <label class="period-picker"><span>Período</span><input type="month" value="${escapeHtml(selectedPeriod)}" data-period></label>
    </section>
    <section class="payment-summary-grid">
      <article class="summary-tile"><span>Previsto</span><strong>${money.format(summary.total)}</strong><small>${summary.chargeCount} rendas</small></article>
      <article class="summary-tile"><span>Recebido</span><strong class="summary-green">${money.format(summary.received)}</strong><small>${summary.paidCount} rendas completas</small></article>
      <article class="summary-tile"><span>Em falta</span><strong class="summary-orange">${money.format(summary.missing)}</strong><small>${summary.overdueCount} em atraso</small></article>
    </section>
    ${charges.length ? `<section class="panel table-panel payment-table-panel">
      <div class="table-toolbar"><div><strong>Cobranças de ${escapeHtml(formatMonth(selectedPeriod))}</strong><span>Os valores só mudam quando regista um pagamento.</span></div></div>
      <div class="table-scroll"><table><thead><tr><th>Imóvel / arrendatário</th><th>Vencimento</th><th>Renda</th><th>Recebido</th><th>Em falta</th><th>Estado</th><th><span class="sr-only">Ação</span></th></tr></thead><tbody>
      ${charges.map((charge) => {
        const contract = state.contracts.find((item) => item.id === charge.contractId);
        const property = propertyForContract(charge.contractId);
        const paid = getPaidAmount(charge);
        const balance = Math.max(0, charge.amount - paid);
        const status = getChargeStatus(charge, today);
        return `<tr><td><strong>${escapeHtml(property?.name || "Imóvel")}</strong><span>${escapeHtml(contract?.tenantName || "")}</span></td><td>${formatDate(charge.dueDate)}</td><td><strong>${money.format(charge.amount)}</strong></td><td>${money.format(paid)}${charge.payments?.length ? `<span>Último · ${formatDate(charge.payments[charge.payments.length - 1].date)}</span>` : ""}</td><td><strong>${money.format(balance)}</strong></td><td><span class="status-badge ${statusClass(status)}">${statusLabel(status)}</span></td><td>${balance > 0 ? `<button class="button button-secondary button-small" type="button" data-action="register-payment" data-id="${escapeHtml(charge.id)}">Registar pagamento</button>` : '<span class="paid-check" aria-label="Totalmente recebida">✓</span>'}</td></tr>`;
      }).join("")}
      </tbody></table></div>
    </section>` : `<section class="empty-state page-empty"><span class="empty-icon">€</span><h2>Sem cobranças neste período</h2><p>Não há contratos ativos a cobrar neste mês. Pode selecionar outro período ou adicionar um contrato.</p><button class="button button-primary" type="button" data-action="new-contract">Adicionar contrato</button></section>`}
    <p class="privacy-note"><span aria-hidden="true">ⓘ</span> Os registos de cobrança são mantidos apenas neste navegador. A aplicação não liga a bancos nem processa pagamentos.</p>`;
}

function renderAgenda() {
  const events = getUpcomingEvents(state.contracts, today, horizon);
  const groups = new Map();
  events.forEach((event) => {
    const month = event.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(event);
  });
  return `
    <section class="page-heading">
      <div><p class="eyebrow">DATAS IMPORTANTES</p><h1>Agenda e avisos</h1><p class="heading-subtitle">Prepare-se para atualizações anuais e vencimentos de contrato.</p></div>
      <label class="period-picker horizon-picker"><span>Próximos</span><select data-horizon>${[3, 4, 5, 6].map((months) => `<option value="${months}" ${horizon === months ? "selected" : ""}>${months} meses</option>`).join("")}</select></label>
    </section>
    <section class="notice-explainer"><span class="notice-explainer-icon" aria-hidden="true">✦</span><div><strong>Lembretes de atualização anual</strong><p>A agenda cria uma tarefa para preparar o aviso dois meses antes da data de atualização que registou no contrato. A aplicação não envia notificações nem mensagens ao arrendatário.</p></div></section>
    ${events.length ? `<section class="agenda-groups">${[...groups.entries()].map(([month, monthEvents]) => `<div class="agenda-month"><h2>${escapeHtml(formatMonth(month))}</h2><div class="panel agenda-event-list">${monthEvents.map((event) => renderEvent(event)).join("")}</div></div>`).join("")}</section>` : `<section class="empty-state page-empty"><span class="empty-icon">▣</span><h2>Sem datas neste horizonte</h2><p>Quando um contrato tiver uma data de atualização ou fim, verá aqui os lembretes correspondentes.</p><button class="button button-secondary" type="button" data-view="contracts">Ver contratos</button></section>`}
    <p class="legal-note">As datas e textos são auxiliares de organização. Confirme os prazos, coeficientes e requisitos legais aplicáveis antes de comunicar qualquer atualização.</p>`;
}

const renderers = {
  dashboard: renderDashboard,
  properties: renderProperties,
  contracts: renderContracts,
  payments: renderPayments,
  agenda: renderAgenda,
};

function render() {
  root.innerHTML = renderers[activeView]();
  document.querySelectorAll(".nav-item").forEach((item) => {
    const isCurrent = item.dataset.view === activeView;
    item.classList.toggle("is-active", isCurrent);
    if (isCurrent) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelector("#today-label").textContent = formatDate(today);
  const pendingNotices = getUpcomingEvents(state.contracts, today, 6).filter((event) => event.type === "notice" && !event.completed).length;
  const count = document.querySelector("#agenda-count");
  count.hidden = !pendingNotices;
  count.textContent = pendingNotices || "";
}

function showDialog(content) {
  dialogContent.innerHTML = content;
  dialog.showModal();
  dialog.querySelector("input, select, textarea, button")?.focus();
}

function closeDialog() {
  if (dialog.open) dialog.close();
}

function openPropertyForm(property) {
  const editing = Boolean(property);
  showDialog(`
    <form id="property-form" data-id="${editing ? escapeHtml(property.id) : ""}">
      <div class="dialog-heading"><div><p class="eyebrow">${editing ? "ATUALIZAR REGISTO" : "NOVA PROPRIEDADE"}</p><h2 id="dialog-title">${editing ? "Editar imóvel" : "Adicionar imóvel"}</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <div class="form-grid">
        <label class="form-field form-field-wide">Nome do imóvel<input name="name" required maxlength="80" value="${escapeHtml(property?.name || "")}" placeholder="Ex.: Apartamento Alfama"></label>
        <label class="form-field form-field-wide">Morada<input name="address" required maxlength="160" value="${escapeHtml(property?.address || "")}" placeholder="Rua, localidade"></label>
        <label class="form-field">Tipo<select name="type"><option ${property?.type === "Apartamento" ? "selected" : ""}>Apartamento</option><option ${property?.type === "Moradia" ? "selected" : ""}>Moradia</option><option ${property?.type === "Outro" ? "selected" : ""}>Outro</option></select></label>
        <label class="form-field">Quartos<input name="bedrooms" type="number" min="0" max="99" value="${escapeHtml(property?.bedrooms ?? 1)}"></label>
        <label class="form-field">Área (m²)<input name="area" type="number" min="0" max="99999" value="${escapeHtml(property?.area ?? "")}" placeholder="Opcional"></label>
        <label class="form-field form-field-wide">Notas<textarea name="notes" rows="2" maxlength="500" placeholder="Opcional">${escapeHtml(property?.notes || "")}</textarea></label>
      </div>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button-primary" type="submit">${editing ? "Guardar alterações" : "Adicionar imóvel"}</button></div>
    </form>`);
}

function openContractForm(contract, preferredPropertyId) {
  if (!state.properties.length) {
    closeDialog();
    showToast("Adicione um imóvel antes de criar um contrato.");
    activeView = "properties";
    render();
    return;
  }
  const editing = Boolean(contract);
  const propertyOptions = state.properties.map((property) => `<option value="${escapeHtml(property.id)}" ${contract?.propertyId === property.id || preferredPropertyId === property.id ? "selected" : ""}>${escapeHtml(property.name)}</option>`).join("");
  showDialog(`
    <form id="contract-form" data-id="${editing ? escapeHtml(contract.id) : ""}">
      <div class="dialog-heading"><div><p class="eyebrow">${editing ? "ATUALIZAR REGISTO" : "NOVO ARRENDAMENTO"}</p><h2 id="dialog-title">${editing ? "Editar contrato" : "Adicionar contrato"}</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <div class="form-grid">
        <label class="form-field form-field-wide">Imóvel<select name="propertyId" required>${propertyOptions}</select></label>
        <label class="form-field">Nome do arrendatário<input name="tenantName" required maxlength="100" value="${escapeHtml(contract?.tenantName || "")}"></label>
        <label class="form-field">Email do arrendatário<input name="tenantEmail" type="email" maxlength="160" value="${escapeHtml(contract?.tenantEmail || "")}" placeholder="Opcional"></label>
        <label class="form-field">Renda mensal (€)<input name="monthlyRent" type="number" required min="0.01" step="0.01" value="${escapeHtml(contract?.monthlyRent ?? "")}"></label>
        <label class="form-field">Caução (€)<input name="deposit" type="number" min="0" step="0.01" value="${escapeHtml(contract?.deposit ?? 0)}"></label>
        <label class="form-field">Início do contrato<input name="startDate" type="date" required value="${escapeHtml(contract?.startDate || today)}"></label>
        <label class="form-field">Fim do contrato<input name="endDate" type="date" value="${escapeHtml(contract?.endDate || "")}"></label>
        <label class="form-field">Próxima atualização anual<input name="adjustmentDate" type="date" value="${escapeHtml(contract?.adjustmentDate || "")}"><small>O lembrete será agendado dois meses antes.</small></label>
        <label class="form-field">Dia de vencimento da renda<input name="paymentDueDay" type="number" required min="1" max="31" value="${escapeHtml(contract?.paymentDueDay ?? 8)}"></label>
        <label class="form-field">Estado<select name="status"><option value="active" ${contract?.status !== "ended" ? "selected" : ""}>Ativo</option><option value="ended" ${contract?.status === "ended" ? "selected" : ""}>Terminado</option></select></label>
      </div>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button-primary" type="submit">${editing ? "Guardar alterações" : "Adicionar contrato"}</button></div>
    </form>`);
}

function openPaymentForm(charge) {
  const contract = state.contracts.find((item) => item.id === charge.contractId);
  const property = propertyForContract(charge.contractId);
  const balance = Math.max(0, charge.amount - getPaidAmount(charge));
  showDialog(`
    <form id="payment-form" data-id="${escapeHtml(charge.id)}">
      <div class="dialog-heading"><div><p class="eyebrow">REGISTAR COBRANÇA</p><h2 id="dialog-title">Novo pagamento</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <div class="payment-context"><strong>${escapeHtml(property?.name || "Imóvel")}</strong><span>${escapeHtml(contract?.tenantName || "")} · ${escapeHtml(formatMonth(charge.period))}</span><small>Valor em falta: ${money.format(balance)}</small></div>
      <div class="form-grid">
        <label class="form-field">Valor recebido (€)<input name="amount" type="number" required min="0.01" max="${balance}" step="0.01" value="${balance.toFixed(2)}"></label>
        <label class="form-field">Data do pagamento<input name="date" type="date" required max="${today}" value="${today}"></label>
      </div>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button-primary" type="submit">Guardar pagamento</button></div>
    </form>`);
}

function openNotice(contract) {
  const property = state.properties.find((item) => item.id === contract.propertyId);
  const noticeDate = addMonths(contract.adjustmentDate, -2);
  const draft = `Exmo.(a) Sr.(a) ${contract.tenantName},\n\nEscrevo para o(a) informar de que a data prevista para a atualização anual da renda do imóvel ${property?.name || ""} é ${formatDate(contract.adjustmentDate)}. A renda mensal atualmente registada é ${money.format(contract.monthlyRent)}.\n\nEste texto é apenas um rascunho de apoio. Confirme o valor, o prazo e os requisitos aplicáveis antes de o enviar.\n\nCom os melhores cumprimentos`;
  showDialog(`
    <div class="dialog-heading"><div><p class="eyebrow">LEMBRETE · ${formatDate(noticeDate)}</p><h2 id="dialog-title">Preparar aviso ao arrendatário</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
    <p class="notice-modal-intro">Revise o texto e envie-o através do seu canal habitual. A CasaThomaz não envia emails nem notificações.</p>
    <label class="form-field">Rascunho do aviso<textarea id="notice-draft" rows="8">${escapeHtml(draft)}</textarea></label>
    <div class="notice-modal-meta"><span>${escapeHtml(contract.tenantName)}</span><span>${escapeHtml(property?.name || "Imóvel")}</span><span>Atualização · ${formatDate(contract.adjustmentDate)}</span></div>
    <div class="dialog-actions dialog-actions-between"><button class="button button-secondary" type="button" data-action="copy-notice">Copiar texto</button><div><button class="button button-secondary" type="button" data-action="close-dialog">Fechar</button><button class="button button-primary" type="button" data-action="mark-notice-sent" data-contract-id="${escapeHtml(contract.id)}">Marcar como enviado</button></div></div>`);
}

function setView(view) {
  if (!renderers[view]) return;
  activeView = view;
  closeDialog();
  render();
  document.querySelector("#main-content").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    event.preventDefault();
    setView(viewButton.dataset.view);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id, propertyId, contractId } = button.dataset;
  if (action === "close-dialog") closeDialog();
  if (action === "new-property") openPropertyForm();
  if (action === "edit-property") openPropertyForm(state.properties.find((property) => property.id === id));
  if (action === "new-contract") openContractForm(null, propertyId);
  if (action === "edit-contract") openContractForm(state.contracts.find((contract) => contract.id === id));
  if (action === "register-payment") {
    ensureCharges(selectedPeriod);
    openPaymentForm(state.charges.find((charge) => charge.id === id));
  }
  if (action === "prepare-notice") openNotice(state.contracts.find((contract) => contract.id === contractId));
  if (action === "copy-notice") {
    try {
      await navigator.clipboard.writeText(document.querySelector("#notice-draft").value);
      showToast("Texto copiado. Reveja-o antes de enviar.");
    } catch (error) {
      showToast("Não foi possível copiar. Selecione e copie o texto manualmente.");
    }
  }
  if (action === "mark-notice-sent") {
    const contract = state.contracts.find((item) => item.id === contractId);
    if (contract) {
      contract.noticeSent = true;
      saveState("Aviso marcado como enviado.");
      closeDialog();
      render();
    }
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-horizon]")) {
    horizon = Number(event.target.value);
    render();
  }
  if (event.target.matches("[data-period]")) {
    selectedPeriod = event.target.value || currentPeriod;
    ensureCharges(selectedPeriod);
    render();
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!form.matches("#property-form, #contract-form, #payment-form")) return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());

  if (form.matches("#property-form")) {
    const property = {
      id: form.dataset.id || `p-${crypto.randomUUID()}`,
      name: values.name.trim(),
      address: values.address.trim(),
      type: values.type,
      bedrooms: Number(values.bedrooms) || 0,
      area: Number(values.area) || 0,
      notes: values.notes.trim(),
    };
    const index = state.properties.findIndex((item) => item.id === property.id);
    if (index >= 0) state.properties[index] = property;
    else state.properties.push(property);
    saveState(index >= 0 ? "Imóvel atualizado." : "Imóvel adicionado.");
    closeDialog();
    render();
    return;
  }

  if (form.matches("#contract-form")) {
    if (values.endDate && values.endDate < values.startDate) {
      showToast("A data de fim deve ser posterior ao início do contrato.");
      return;
    }
    const existing = state.contracts.find((item) => item.id === form.dataset.id);
    const contract = {
      id: existing?.id || `c-${crypto.randomUUID()}`,
      propertyId: values.propertyId,
      tenantName: values.tenantName.trim(),
      tenantEmail: values.tenantEmail.trim(),
      monthlyRent: Number(values.monthlyRent),
      deposit: Number(values.deposit) || 0,
      startDate: values.startDate,
      endDate: values.endDate,
      adjustmentDate: values.adjustmentDate,
      paymentDueDay: Number(values.paymentDueDay),
      status: values.status,
      noticeSent: existing?.adjustmentDate === values.adjustmentDate
        ? existing.noticeSent
        : false,
    };
    if (existing) Object.assign(existing, contract);
    else state.contracts.push(contract);
    ensureCharges(selectedPeriod);
    saveState(existing ? "Contrato atualizado." : "Contrato adicionado.");
    closeDialog();
    render();
    return;
  }

  if (form.matches("#payment-form")) {
    const charge = state.charges.find((item) => item.id === form.dataset.id);
    if (!charge) return;
    const amount = Number(values.amount);
    const balance = Math.max(0, charge.amount - getPaidAmount(charge));
    if (amount <= 0 || amount > balance) {
      showToast("O pagamento deve ser superior a zero e não pode exceder o valor em falta.");
      return;
    }
    charge.payments ||= [];
    charge.payments.push({ amount, date: values.date });
    saveState("Pagamento registado.");
    closeDialog();
    render();
  }
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) closeDialog();
});

dialog.addEventListener("close", () => {
  dialogContent.replaceChildren();
});

render();
