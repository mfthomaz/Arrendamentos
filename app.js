import {
  archiveContract,
  addMonths,
  createCharges,
  createDemoData,
  getChargeNetAmount,
  getChargeStatus,
  getChargeSummary,
  getChargeWithholding,
  getPaidAmount,
  getUpcomingEvents,
  isNonResidentialProperty,
  removePayment,
  rescheduleFutureCharges,
  restoreContract,
  toISODate,
  updateChargeWithholding,
} from "./domain.js";
import {
  createSupabaseClient,
  emptyData,
  hasRecords,
  mergeSnapshots,
  normalizeData,
} from "./sync.js";

const STORAGE_KEY = "casathomaz.v1";
const CONFIG_KEY = "casathomaz.supabase-config";
const SESSION_KEY = "casathomaz.supabase-session";
const LEGACY_OWNER_KEY = "casathomaz.legacy-owner";
const root = document.querySelector("#app-content");
const dialog = document.querySelector("#app-dialog");
const dialogContent = document.querySelector("#dialog-content");
const toast = document.querySelector("#toast");
const money = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "short", year: "numeric" });
const monthFormat = new Intl.DateTimeFormat("pt-PT", { month: "long", year: "numeric" });
const today = toISODate(new Date());
const currentPeriod = today.slice(0, 7);
const emptyConfig = { url: "", publishableKey: "" };

let supabaseConfig = readSupabaseConfig();
let supabase = isSupabaseConfigured(supabaseConfig) ? createSupabaseClient(supabaseConfig) : null;
let state = supabase ? emptyData() : loadState();
let activeView = "dashboard";
let selectedPeriod = currentPeriod;
let contractFilter = "all";
let approvedDialogClosures = 0;
let horizon = 6;
let toastTimer;
let authSession = null;
let authUser = null;
let remoteRevision = null;
let cloudStatus = supabase ? "signed-out" : "local";
let migrationChoice = null;
let syncTimer;
let syncPoller;
let syncPromise = null;
let syncAgain = false;
let pendingConflictCount = 0;
let authMode = "signin";

function isSupabaseConfigured(config) {
  return Boolean(config?.url && config?.publishableKey);
}

function readSupabaseConfig() {
  try {
    return { ...emptyConfig, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") };
  } catch {
    return { ...emptyConfig };
  }
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    if (supabase) return emptyData();
    const demo = createDemoData(today);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(demo));
    return demo;
  }
  const data = JSON.parse(saved);
  if (!data || !Array.isArray(data.properties) || !Array.isArray(data.contracts) || !Array.isArray(data.charges)) {
    throw new Error("Os dados guardados da CasaThomaz não têm um formato válido.");
  }
  return normalizeData(data);
}

function saveState(message) {
  if (authUser) {
    persistAccountCache(true);
    queueCloudSync();
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  if (message) showToast(message);
}

function ensureCharges(period) {
  const advanceMonths = Math.max(0, ...state.contracts
    .filter((contract) => contract.status === "active")
    .map((contract) => Number(contract.paymentAdvanceMonths) || 0));
  let next = state.charges;
  for (let offset = 0; offset <= advanceMonths; offset += 1) {
    const rentPeriod = addMonths(`${period}-01`, offset).slice(0, 7);
    next = createCharges(state.contracts, next, rentPeriod);
  }
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

function userDataKey(userId) {
  return `casathomaz.user-data.${userId}`;
}

function readAccountCache(userId) {
  try {
    const saved = JSON.parse(localStorage.getItem(userDataKey(userId)) || "null");
    if (!saved?.data || !Array.isArray(saved.data.properties) || !Array.isArray(saved.data.contracts) || !Array.isArray(saved.data.charges)) {
      return null;
    }
    return { data: normalizeData(saved.data), pending: Boolean(saved.pending) };
  } catch {
    return null;
  }
}

function persistAccountCache(pending = false) {
  if (!authUser) return;
  localStorage.setItem(userDataKey(authUser.id), JSON.stringify({ data: state, pending }));
}

function setCloudStatus(status, detail = "") {
  cloudStatus = status;
  const labels = {
    local: "Só neste dispositivo",
    "signed-out": "Inicie sessão para sincronizar",
    loading: "A carregar dados privados…",
    syncing: "A sincronizar…",
    synced: "Sincronizado",
    offline: "Offline · alterações guardadas neste dispositivo",
    error: "Erro de sincronização",
  };
  const statusElement = document.querySelector("#sync-label");
  if (statusElement) {
    statusElement.textContent = detail ? `${labels[status] || status} — ${detail}` : labels[status] || status;
    statusElement.dataset.status = status;
  }
  updateAccountActions();
}

function updateAccountActions() {
  const actions = document.querySelector("#account-actions");
  if (!actions) return;
  const installButton = window.deferredInstallPrompt
    ? '<button class="button button-secondary button-small" type="button" data-action="install-app">Instalar app</button>'
    : "";
  if (authUser) {
    const email = escapeHtml(authUser.email || "Conta");
    const backupButton = localStorage.getItem(`casathomaz.migration-backup.${authUser.id}`)
      ? '<button class="text-button backup-import-button" type="button" data-action="restore-local-backup">Importar cópia local</button>'
      : "";
    actions.innerHTML = `${installButton}${backupButton}<span class="cloud-state" role="status" id="cloud-state">${cloudStatus === "error" ? "!" : cloudStatus === "synced" ? "✓" : "↻"} ${escapeHtml(document.querySelector("#sync-label")?.textContent || "A sincronizar…")}</span><span class="user-chip"><span class="avatar" aria-hidden="true">${escapeHtml(email.slice(0, 2).toUpperCase())}</span><span class="user-name">${email}</span></span><button class="button button-secondary button-small" type="button" data-action="sign-out">Sair</button>`;
    return;
  }
  if (!supabase) {
    actions.innerHTML = `${installButton}<span class="local-state" role="status">Só neste dispositivo</span><button class="button button-secondary button-small" type="button" data-action="configure-supabase">Configurar sincronização</button>`;
  } else {
    actions.replaceChildren();
  }
}

function renderAuth(message = "") {
  document.body.classList.add("auth-required");
  document.querySelector(".sidebar").hidden = true;
  document.querySelector("#local-profile").hidden = true;
  updateAccountActions();
  root.innerHTML = `
    <section class="auth-page">
      <div class="auth-card">
        <span class="auth-brand-mark" aria-hidden="true">⌂</span>
        <p class="eyebrow">CASATHOMAZ · DADOS PRIVADOS</p>
        <h1>${migrationChoice ? "Importar carteira local?" : "Aceda à sua carteira"}</h1>
        ${migrationChoice
          ? renderMigrationOptions()
          : `<p class="auth-subtitle">Inicie sessão para carregar os seus imóveis, contratos e pagamentos sincronizados.</p>
            ${message ? `<p class="auth-message" role="status">${escapeHtml(message)}</p>` : ""}
            <form id="auth-form" data-mode="${authMode}">
              <label class="form-field">Email<input name="email" type="email" required autocomplete="email"></label>
              <label class="form-field">Palavra-passe<input name="password" type="password" required minlength="8" autocomplete="${authMode === "signup" ? "new-password" : "current-password"}"></label>
              <button class="button button-primary auth-submit" type="submit">${authMode === "signup" ? "Criar conta" : "Iniciar sessão"}</button>
            </form>
            <div class="auth-foot"><span>${authMode === "signup" ? "Já tem conta?" : "Novo na CasaThomaz?"}</span><button class="text-button" type="button" data-action="toggle-auth-mode" data-mode="${authMode === "signup" ? "signin" : "signup"}">${authMode === "signup" ? "Iniciar sessão" : "Criar conta"}</button></div>
            <button class="text-button auth-config-link" type="button" data-action="configure-supabase">Configuração do Supabase</button>`}
      </div>
    </section>`;
}

function renderMigrationOptions() {
  return `
    <p class="auth-subtitle">Encontrámos dados guardados neste navegador. Antes de os juntar, preservaremos uma cópia local de segurança.</p>
    <div class="migration-summary">
      <strong>${migrationChoice.local.properties.length} imóveis · ${migrationChoice.local.contracts.length} contratos · ${migrationChoice.local.charges.length} cobranças</strong>
      <span>${migrationChoice.remote ? "A conta Supabase já contém dados." : "A conta Supabase ainda não tem uma carteira."}</span>
    </div>
    <button class="button button-primary auth-submit" type="button" data-action="migrate-local">Juntar e sincronizar dados locais</button>
    <button class="button button-secondary auth-submit" type="button" data-action="skip-migration">Não importar agora</button>
    <p class="auth-footnote">Registos com o mesmo identificador mas valores diferentes serão mantidos como cópias separadas; não apagaremos os dados locais originais.</p>`;
}

function renderConfiguration(message = "") {
  document.body.classList.add("auth-required");
  document.querySelector(".sidebar").hidden = true;
  document.querySelector("#local-profile").hidden = true;
  updateAccountActions();
  root.innerHTML = `
    <section class="auth-page">
      <div class="auth-card auth-card-wide">
        <button class="text-button auth-back" type="button" data-action="close-configuration">← Voltar</button>
        <p class="eyebrow">LIGAÇÃO PRIVADA</p>
        <h1>Configurar sincronização</h1>
        <p class="auth-subtitle">Use o URL do seu projeto Supabase e a chave publicável (anon). Nunca introduza a chave <code>service_role</code>.</p>
        ${message ? `<p class="auth-message" role="status">${escapeHtml(message)}</p>` : ""}
        <form id="supabase-config-form">
          <label class="form-field">URL do projeto Supabase<input name="url" type="url" required placeholder="https://seu-projeto.supabase.co" value="${escapeHtml(supabaseConfig.url)}"></label>
          <label class="form-field">Chave publicável / anon<input name="publishableKey" type="password" required autocomplete="off" value="${escapeHtml(supabaseConfig.publishableKey)}"></label>
          <div class="config-note"><strong>Estas credenciais são guardadas só neste navegador.</strong><span>Configure-as uma vez em cada computador. A proteção dos dados é aplicada pelo login e pelas políticas RLS da base de dados.</span></div>
          <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-configuration">Cancelar</button><button class="button button-primary" type="submit">Guardar e continuar</button></div>
        </form>
      </div>
    </section>`;
}

function looksLikeSecretKey(key) {
    if (/^(sb_secret_|service_role)/i.test(key)) return true;
    const payload = key.split(".")[1];
    if (!payload) return false;
    try {
      const encoded = payload.replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
      return claims.role === "service_role";
    } catch {
      return false;
    }
}

function parseData(raw, description) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data || !Array.isArray(data.properties) || !Array.isArray(data.contracts) || !Array.isArray(data.charges)) {
    throw new Error(`${description} não têm um formato válido. Os dados originais foram preservados.`);
  }
  return normalizeData(data);
}

function readLegacyData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? parseData(raw, "Os dados locais") : null;
}

function storeSession(session) {
  authSession = session;
  authUser = session?.user || null;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
  updateAccountActions();
}

function readSavedSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

async function refreshSessionIfNeeded() {
  if (!authSession || authSession.expiresAt > Math.floor(Date.now() / 1000) + 90) return authSession;
  const refreshed = await supabase.refreshSession(authSession);
  if (!refreshed) throw new Error("A sessão expirou. Inicie sessão novamente.");
  storeSession(refreshed);
  return refreshed;
}

async function startCloudSync() {
  document.body.classList.add("auth-required");
  renderAuth("A verificar a sessão…");
  try {
    const callbackSession = supabase.sessionFromUrl(window.location.hash);
    if (callbackSession) {
      const user = await supabase.getUser(callbackSession);
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      storeSession({ ...callbackSession, user });
      await loadUserData();
      return;
    }
    const savedSession = readSavedSession();
    if (!savedSession?.refreshToken) {
      renderAuth();
      return;
    }
    storeSession(savedSession);
    if (savedSession.expiresAt <= Math.floor(Date.now() / 1000) + 90) {
      storeSession(await supabase.refreshSession(savedSession));
    }
    if (!authSession?.user?.id) throw new Error("Não foi possível renovar a sessão.");
    await loadUserData();
  } catch (error) {
    const savedSession = readSavedSession();
    const localCache = savedSession?.user?.id ? readAccountCache(savedSession.user.id) : null;
    if (!navigator.onLine && savedSession?.user?.id && localCache) {
      storeSession(savedSession);
      state = localCache.data;
      document.body.classList.remove("auth-required");
      document.querySelector(".sidebar").hidden = false;
      render();
      setCloudStatus("offline");
      return;
    }
    if (error.status === 401) storeSession(null);
    renderAuth(error.message || "Não foi possível carregar a carteira sincronizada.");
  }
}

async function loadUserData() {
  setCloudStatus("loading");
  const session = await refreshSessionIfNeeded();
  const [remote, localCache] = await Promise.all([
    supabase.getOwnerData(session, authUser.id),
    Promise.resolve(readAccountCache(authUser.id)),
  ]);
  const legacyOwner = localStorage.getItem(LEGACY_OWNER_KEY);
  const legacy = !localCache && (!legacyOwner || legacyOwner === authUser.id)
    ? readLegacyData()
    : null;

  if (legacy && hasRecords(legacy)) {
    migrationChoice = { local: legacy, remote, userId: authUser.id };
    renderAuth();
    return;
  }
  migrationChoice = null;

  if (remote) {
    remoteRevision = Number(remote.revision);
    if (localCache?.pending) {
      const merged = mergeSnapshots(remote.data, localCache.data);
      state = merged.data;
      pendingConflictCount = merged.conflicts;
      persistAccountCache(true);
      queueCloudSync();
    } else {
      state = parseData(remote.data, "Os dados da conta");
      persistAccountCache(false);
    }
  } else if (localCache && (localCache.pending || hasRecords(localCache.data))) {
    state = parseData(localCache.data, "Os dados pendentes");
    remoteRevision = null;
    persistAccountCache(true);
    queueCloudSync();
  } else {
    state = emptyData();
    remoteRevision = null;
    persistAccountCache(false);
    setCloudStatus("synced");
  }

  document.body.classList.remove("auth-required");
  document.querySelector(".sidebar").hidden = false;
  render();
  setCloudStatus(navigator.onLine ? "synced" : "offline");
  syncPoller ||= window.setInterval(checkRemoteChanges, 30000);
}

async function finishMigration(importLocal) {
  if (!migrationChoice) return;
  const { local, remote, userId } = migrationChoice;
  localStorage.setItem(`casathomaz.migration-backup.${userId}`, JSON.stringify(local));
  localStorage.setItem(LEGACY_OWNER_KEY, userId);
  remoteRevision = remote ? Number(remote.revision) : null;
  if (importLocal) {
    const merged = mergeSnapshots(remote?.data || emptyData(), local);
    state = merged.data;
    pendingConflictCount = merged.conflicts;
  } else {
    state = remote ? parseData(remote.data, "Os dados da conta") : emptyData();
    pendingConflictCount = 0;
  }
  migrationChoice = null;
  document.body.classList.remove("auth-required");
  document.querySelector(".sidebar").hidden = false;
  persistAccountCache(importLocal || !remote);
  render();
  if (importLocal || !remote) queueCloudSync();
  else setCloudStatus("synced");
}

function queueCloudSync() {
  if (!authUser || !supabase) return;
  persistAccountCache(true);
  if (!navigator.onLine) {
    setCloudStatus("offline");
    return;
  }
  setCloudStatus("syncing");
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(syncNow, 500);
}

async function syncNow() {
  if (!authUser || !supabase) return;
  if (!navigator.onLine) {
    setCloudStatus("offline");
    return;
  }
  if (syncPromise) {
    syncAgain = true;
    return syncPromise;
  }
  syncPromise = (async () => {
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const session = await refreshSessionIfNeeded();
        const payload = JSON.parse(JSON.stringify(state));
        if (remoteRevision === null) {
          try {
            const inserted = await supabase.insertOwnerData(session, authUser.id, payload);
            if (inserted) {
              remoteRevision = Number(inserted.revision);
              if (JSON.stringify(state) !== JSON.stringify(payload)) {
                persistAccountCache(true);
                continue;
              }
              persistAccountCache(false);
              localStorage.setItem(LEGACY_OWNER_KEY, authUser.id);
              const conflicts = pendingConflictCount;
              pendingConflictCount = 0;
              setCloudStatus("synced", conflicts ? `${conflicts} conflito(s) preservado(s) como cópias` : "");
              return;
            }
          } catch (error) {
            if (error.status !== 409) throw error;
          }
          const current = await supabase.getOwnerData(session, authUser.id);
          if (!current) throw new Error("Não foi possível criar nem carregar a carteira sincronizada.");
          remoteRevision = Number(current.revision);
          const merged = mergeSnapshots(current.data, state);
          state = merged.data;
          pendingConflictCount += merged.conflicts;
          persistAccountCache(true);
          continue;
        }

        const updated = await supabase.updateOwnerData(session, authUser.id, remoteRevision, payload);
        if (updated) {
          remoteRevision = Number(updated.revision);
          if (JSON.stringify(state) !== JSON.stringify(payload)) {
            persistAccountCache(true);
            continue;
          }
          persistAccountCache(false);
          localStorage.setItem(LEGACY_OWNER_KEY, authUser.id);
          const conflicts = pendingConflictCount;
          pendingConflictCount = 0;
          setCloudStatus("synced", conflicts ? `${conflicts} conflito(s) preservado(s) como cópias` : "");
          return;
        }
        const current = await supabase.getOwnerData(session, authUser.id);
        if (!current) {
          remoteRevision = null;
          continue;
        }
        remoteRevision = Number(current.revision);
        const merged = mergeSnapshots(current.data, state);
        state = merged.data;
        pendingConflictCount += merged.conflicts;
        persistAccountCache(true);
        render();
      }
      throw new Error("Houve alterações simultâneas. Os seus dados locais foram preservados; tente sincronizar novamente.");
    } catch (error) {
      if (error.status === 401) {
        storeSession(null);
        document.body.classList.add("auth-required");
        document.querySelector(".sidebar").hidden = true;
        renderAuth("A sessão terminou. Inicie sessão para continuar a sincronizar.");
      }
      setCloudStatus(navigator.onLine ? "error" : "offline", error.message);
    } finally {
      syncPromise = null;
      if (syncAgain) {
        syncAgain = false;
        syncNow();
      }
    }
  })();
  return syncPromise;
}

async function checkRemoteChanges() {
  if (!authUser || !navigator.onLine || syncPromise || migrationChoice) return;
  try {
    const session = await refreshSessionIfNeeded();
    const remote = await supabase.getOwnerData(session, authUser.id);
    const cache = readAccountCache(authUser.id);
    if (!remote) {
      if (cache?.pending) {
        remoteRevision = null;
        await syncNow();
      }
      return;
    }
    if (Number(remote.revision) === remoteRevision) {
      if (cache?.pending) await syncNow();
      return;
    }
    if (cache?.pending) {
      const merged = mergeSnapshots(remote.data, state);
      state = merged.data;
      remoteRevision = Number(remote.revision);
      pendingConflictCount += merged.conflicts;
      persistAccountCache(true);
      render();
      queueCloudSync();
      return;
    }
    state = parseData(remote.data, "Os dados da conta");
    remoteRevision = Number(remote.revision);
    persistAccountCache(false);
    render();
    setCloudStatus("synced");
  } catch (error) {
    setCloudStatus(navigator.onLine ? "error" : "offline", error.message);
  }
}

async function submitAuth(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const mode = form.dataset.mode;
  if (values.password.length < 8) {
    renderAuth("A palavra-passe deve ter pelo menos 8 caracteres.");
    return;
  }
  try {
    setCloudStatus("loading");
    const session = mode === "signup"
      ? await supabase.signUp(values.email.trim(), values.password)
      : await supabase.signIn(values.email.trim(), values.password);
    if (!session) {
      renderAuth(mode === "signup"
        ? "Conta criada. Confirme o endereço de email e depois inicie sessão."
        : "Não foi devolvida uma sessão. Verifique a configuração de confirmação de email no Supabase.");
      return;
    }
    storeSession(session);
    await loadUserData();
  } catch (error) {
    renderAuth(error.message);
  }
}

async function signOut() {
  const userId = authUser.id;
  if (readAccountCache(userId)?.pending && navigator.onLine) await syncNow();
  const session = authSession;
  localStorage.setItem(userDataKey(userId), JSON.stringify({
    data: state,
    pending: Boolean(readAccountCache(userId)?.pending),
  }));
  storeSession(null);
  authUser = null;
  authSession = null;
  remoteRevision = null;
  state = emptyData();
  document.body.classList.add("auth-required");
  document.querySelector(".sidebar").hidden = true;
  try {
    await supabase.signOut(session);
  } catch {
    showToast("Sessão local terminada; confirme a saída no servidor quando voltar a estar online.");
  }
  renderAuth();
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
    .filter((charge) => {
      const contract = state.contracts.find((item) => item.id === charge.contractId);
      return charge.dueDate.slice(0, 7) === currentPeriod && getChargeStatus(charge, today, contract) !== "paid";
    })
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
            const status = getChargeStatus(charge, today, contract);
            return `<div class="attention-row"><div class="attention-avatar" aria-hidden="true">${escapeHtml((contract?.tenantName || "?").split(" ").map((part) => part[0]).slice(0, 2).join(""))}</div><div class="attention-copy"><strong>${escapeHtml(contract?.tenantName || "Arrendatário")}</strong><span>${escapeHtml(property?.name || "Imóvel")} · vence ${formatDate(charge.dueDate)}</span></div><div class="attention-amount"><strong>${money.format(Math.max(0, getChargeNetAmount(charge, contract) - getPaidAmount(charge)))}</strong><span class="status-badge ${statusClass(status)}">${statusLabel(status)}</span></div></div>`;
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
            <div class="property-details"><span>${property.area ? `${escapeHtml(property.area)} m²` : "Área não indicada"}</span>${contract ? `<span>Arrendatário / empresa · ${escapeHtml(contract.tenantName)}</span><strong>${money.format(contract.monthlyRent)}<small> brutos / mês</small></strong>${contract.nonResidential ? `<span>Retenção (25%) · ${money.format(contract.monthlyRent * 0.25)} · líquido ${money.format(contract.monthlyRent * 0.75)}</span>` : ""}${nextAdjustment}` : '<span>Sem contrato ativo</span>'}</div>
            <div class="property-card-actions"><button class="button button-secondary button-small" type="button" data-action="edit-property" data-id="${escapeHtml(property.id)}">Editar imóvel</button>${contract ? `<button class="text-button" type="button" data-action="edit-contract" data-id="${escapeHtml(contract.id)}">Ver contrato</button>` : `<button class="text-button" type="button" data-action="new-contract" data-property-id="${escapeHtml(property.id)}">Adicionar contrato <span aria-hidden="true">→</span></button>`}</div>
          </div>
        </article>`;
      }).join("")}
    </section>` : `<section class="empty-state page-empty"><span class="empty-icon">⌂</span><h2>A sua carteira começa aqui</h2><p>Registe o seu primeiro imóvel e mantenha num só lugar os contratos e as rendas.</p><button class="button button-primary" type="button" data-action="new-property">Adicionar primeiro imóvel</button></section>`}`;
}

function renderContracts() {
  const allContracts = [...state.contracts].sort((a, b) => (a.endDate || "").localeCompare(b.endDate || ""));
  const contracts = allContracts.filter((contract) => (
    contractFilter === "all"
    || (contractFilter === "archived" ? contract.status === "archived" : contract.status !== "archived")
  ));
  const activeCount = state.contracts.filter((contract) => (
    contract.status === "active"
    && contract.startDate <= today
    && (!contract.endDate || contract.endDate >= today)
  )).length;
  return `
    <section class="page-heading">
      <div><p class="eyebrow">ARRENDAMENTOS</p><h1>Contratos</h1><p class="heading-subtitle">Arrendatários, rendas e datas importantes num só lugar.</p></div>
      <button class="button button-primary" type="button" data-action="new-contract"><span aria-hidden="true">＋</span> Novo contrato</button>
    </section>
    ${allContracts.length ? `<section class="panel table-panel">
      <div class="table-toolbar"><div><strong>${contracts.length} ${contracts.length === 1 ? "contrato" : "contratos"}</strong><span>Os contratos arquivados mantêm o histórico de rendas e pagamentos.</span></div><div class="contract-toolbar-actions"><label class="contract-filter"><span>Mostrar</span><select data-contract-filter><option value="all" ${contractFilter === "all" ? "selected" : ""}>Todos</option><option value="active" ${contractFilter === "active" ? "selected" : ""}>Não arquivados</option><option value="archived" ${contractFilter === "archived" ? "selected" : ""}>Arquivados</option></select></label><span class="table-toolbar-total">${activeCount} ativos</span></div></div>
      <div class="table-scroll"><table><thead><tr><th>Imóvel / arrendatário</th><th>Renda bruta / líquida</th><th>Início</th><th>Fim</th><th>Próxima atualização</th><th>Estado</th><th><span class="sr-only">Ações</span></th></tr></thead><tbody>
      ${contracts.length ? contracts.map((contract) => {
        const property = state.properties.find((item) => item.id === contract.propertyId);
        const isActive = contract.status === "active" && contract.startDate <= today && (!contract.endDate || contract.endDate >= today);
        const status = contract.status === "archived" ? "Arquivado" : isActive ? "Ativo" : "Terminado";
        const statusClassName = isActive ? "status-paid" : "status-neutral";
        const archiveAction = contract.status === "archived"
          ? `<button class="text-button" type="button" data-action="restore-contract" data-id="${escapeHtml(contract.id)}">Restaurar</button>`
          : `<button class="text-button" type="button" data-action="archive-contract" data-id="${escapeHtml(contract.id)}">Arquivar</button>`;
        const rent = `<strong>${money.format(contract.monthlyRent)}</strong>${contract.nonResidential ? `<span>Retenção 25% · ${money.format(contract.monthlyRent * 0.25)}</span><span>Líquido · ${money.format(contract.monthlyRent * 0.75)}</span>` : ""}`;
        return `<tr><td><strong>${escapeHtml(property?.name || "Imóvel removido")}</strong><span>${escapeHtml(contract.tenantName)}</span></td><td>${rent}</td><td>${formatDate(contract.startDate)}</td><td>${formatDate(contract.endDate)}</td><td>${formatDate(contract.adjustmentDate)}</td><td><span class="status-badge ${statusClassName}">${status}</span></td><td><div class="contract-actions"><button class="icon-button table-edit" type="button" aria-label="Editar contrato de ${escapeHtml(contract.tenantName)}" data-action="edit-contract" data-id="${escapeHtml(contract.id)}">↗</button>${archiveAction}</div></td></tr>`;
      }).join("") : `<tr><td class="contract-filter-empty" colspan="7">Não há contratos ${contractFilter === "archived" ? "arquivados" : "não arquivados"}.</td></tr>`}
      </tbody></table></div>
    </section>` : `<section class="empty-state page-empty"><span class="empty-icon">▤</span><h2>Ainda sem contratos</h2><p>Associe um contrato a um imóvel para acompanhar rendas e datas de atualização.</p><button class="button button-primary" type="button" data-action="new-contract">Criar contrato</button></section>`}`;
}

function renderPayments() {
  ensureCharges(selectedPeriod);
  const charges = state.charges
    .filter((charge) => charge.dueDate.slice(0, 7) === selectedPeriod)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const summary = getChargeSummary(state.contracts, state.charges, selectedPeriod, today);
  return `
    <section class="page-heading">
      <div><p class="eyebrow">CONTROLO DE RENDAS</p><h1>Rendas e pagamentos</h1><p class="heading-subtitle">Para lojas e escritórios, registe o valor líquido que o inquilino paga (75% da renda bruta).</p></div>
      <label class="period-picker"><span>Mês de pagamento</span><input type="month" value="${escapeHtml(selectedPeriod)}" data-period></label>
    </section>
    <section class="payment-summary-grid">
      <article class="summary-tile"><span>Previsto líquido</span><strong>${money.format(summary.total)}</strong><small>${summary.chargeCount} rendas</small></article>
      <article class="summary-tile"><span>Recebido</span><strong class="summary-green">${money.format(summary.received)}</strong><small>${summary.paidCount} rendas completas</small></article>
      <article class="summary-tile"><span>Em falta</span><strong class="summary-orange">${money.format(summary.missing)}</strong><small>${summary.overdueCount} em atraso</small></article>
    </section>
    ${charges.length ? `<section class="panel table-panel payment-table-panel">
      <div class="table-toolbar"><div><strong>Rendas a pagar em ${escapeHtml(formatMonth(selectedPeriod))}</strong><span>O mês da renda pode ser anterior ou posterior ao mês de pagamento.</span></div></div>
      <div class="table-scroll"><table><thead><tr><th>Imóvel / arrendatário</th><th>Mês da renda</th><th>Vencimento</th><th>Valor a pagar</th><th>Recebido</th><th>Em falta</th><th>Estado</th><th><span class="sr-only">Ação</span></th></tr></thead><tbody>
      ${charges.map((charge) => {
        const contract = state.contracts.find((item) => item.id === charge.contractId);
        const property = propertyForContract(charge.contractId);
        const paid = getPaidAmount(charge);
        const netAmount = getChargeNetAmount(charge, contract);
        const withholdingAmount = getChargeWithholding(charge, contract);
        const balance = Math.max(0, netAmount - paid);
        const status = getChargeStatus(charge, today, contract);
        const rent = withholdingAmount
          ? `<strong>${money.format(netAmount)}</strong><span>Líquido a pagar</span><span>Renda bruta · ${money.format(charge.amount)}</span><span>Retenção (25%) · ${money.format(withholdingAmount)}</span>`
          : `<strong>${money.format(netAmount)}</strong>`;
        const payments = charge.payments || [];
        const received = `<strong>${money.format(paid)}</strong>${payments.length ? `<div class="payment-records">${payments.map((payment, paymentIndex) => `<div class="payment-record"><span>${money.format(payment.amount)} · ${formatDate(payment.date)}</span><button class="text-button payment-delete-button" type="button" data-action="delete-payment" data-id="${escapeHtml(charge.id)}" data-payment-index="${paymentIndex}" aria-label="Eliminar pagamento de ${money.format(payment.amount)} de ${escapeHtml(formatDate(payment.date))}">Eliminar</button></div>`).join("")}</div>` : ""}`;
        return `<tr><td><strong>${escapeHtml(property?.name || "Imóvel")}</strong><span>${escapeHtml(contract?.tenantName || "")}</span></td><td>${formatMonth(charge.period)}</td><td>${formatDate(charge.dueDate)}</td><td>${rent}</td><td>${received}</td><td><strong>${money.format(balance)}</strong></td><td><span class="status-badge ${statusClass(status)}">${statusLabel(status)}</span></td><td>${balance > 0 ? `<button class="button button-secondary button-small" type="button" data-action="register-payment" data-id="${escapeHtml(charge.id)}">Registar pagamento</button>` : '<span class="paid-check" aria-label="Totalmente recebida">✓</span>'}</td></tr>`;
      }).join("")}
      </tbody></table></div>
    </section>` : `<section class="empty-state page-empty"><span class="empty-icon">€</span><h2>Sem rendas a pagar neste mês</h2><p>Não há cobranças com vencimento neste período. Pode selecionar outro mês ou adicionar um contrato.</p><button class="button button-primary" type="button" data-action="new-contract">Adicionar contrato</button></section>`}
    <p class="privacy-note"><span aria-hidden="true">ⓘ</span> ${authUser ? "Os registos são privados da sua conta Supabase e sincronizados entre dispositivos." : "Os registos são mantidos apenas neste navegador. A aplicação não liga a bancos nem processa pagamentos."}</p>`;
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
  document.body.classList.remove("auth-required");
  document.querySelector(".sidebar").hidden = false;
  document.querySelector("#local-profile").hidden = Boolean(authUser);
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
  updateAccountActions();
}

function showDialog(content) {
  dialogContent.innerHTML = content;
  const form = dialogContent.querySelector("form");
  if (form) {
    form.dataset.initialValues = JSON.stringify(Object.fromEntries(new FormData(form).entries()));
  }
  dialog.showModal();
  dialog.querySelector("input, select, textarea, button")?.focus();
}

function hasUnsavedFormChanges() {
  const form = dialogContent.querySelector("form");
  if (!form || !form.dataset.initialValues) return false;
  return JSON.stringify(Object.fromEntries(new FormData(form).entries())) !== form.dataset.initialValues;
}

function closeDialog(saved = false) {
  if (!dialog.open) return true;
  if (!saved && hasUnsavedFormChanges()
    && !window.confirm("Existem alterações por guardar. Quer descartá-las?")) {
    return false;
  }
  approvedDialogClosures += 1;
  dialog.close();
  dialogContent.replaceChildren();
  return true;
}

function openPropertyForm(property) {
  const editing = Boolean(property);
  showDialog(`
    <form id="property-form" data-id="${editing ? escapeHtml(property.id) : ""}">
      <div class="dialog-heading"><div><p class="eyebrow">${editing ? "ATUALIZAR REGISTO" : "NOVA PROPRIEDADE"}</p><h2 id="dialog-title">${editing ? "Editar imóvel" : "Adicionar imóvel"}</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <div class="form-grid">
        <label class="form-field form-field-wide">Nome do imóvel<input name="name" required maxlength="80" value="${escapeHtml(property?.name || "")}" placeholder="Ex.: Apartamento Alfama"></label>
        <label class="form-field form-field-wide">Morada<input name="address" required maxlength="160" value="${escapeHtml(property?.address || "")}" placeholder="Rua, localidade"></label>
        <label class="form-field">Tipo<select name="type"><option ${property?.type === "Apartamento" ? "selected" : ""}>Apartamento</option><option ${property?.type === "Moradia" ? "selected" : ""}>Moradia</option><option ${property?.type === "Loja" ? "selected" : ""}>Loja</option><option ${property?.type === "Escritório" ? "selected" : ""}>Escritório</option><option ${property?.type === "Outro" ? "selected" : ""}>Outro</option></select></label>
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
  const selectedPropertyId = contract?.propertyId || preferredPropertyId || state.properties[0].id;
  const selectedProperty = state.properties.find((property) => property.id === selectedPropertyId);
  const nonResidential = Boolean(contract?.nonResidential || isNonResidentialProperty(selectedProperty));
  const propertyOptions = state.properties.map((property) => `<option value="${escapeHtml(property.id)}" ${selectedPropertyId === property.id ? "selected" : ""}>${escapeHtml(property.name)}</option>`).join("");
  showDialog(`
    <form id="contract-form" data-id="${editing ? escapeHtml(contract.id) : ""}">
      <div class="dialog-heading"><div><p class="eyebrow">${editing ? "ATUALIZAR REGISTO" : "NOVO ARRENDAMENTO"}</p><h2 id="dialog-title">${editing ? "Editar contrato" : "Adicionar contrato"}</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <div class="form-grid">
        <label class="form-field form-field-wide">Imóvel<select name="propertyId" required>${propertyOptions}</select></label>
        <label class="form-field">Nome do arrendatário / empresa<input name="tenantName" required maxlength="100" value="${escapeHtml(contract?.tenantName || "")}"></label>
        <label class="form-field">Email do arrendatário<input name="tenantEmail" type="email" maxlength="160" value="${escapeHtml(contract?.tenantEmail || "")}" placeholder="Opcional"></label>
        <label class="form-field">Finalidade<select name="nonResidential"><option value="false" ${!nonResidential ? "selected" : ""}>Habitacional</option><option value="true" ${nonResidential ? "selected" : ""}>Não habitacional / empresa</option></select><small>Lojas e escritórios aplicam automaticamente a retenção de 25% e o líquido a receber.</small></label>
        <label class="form-field">Renda bruta mensal (€)<input name="monthlyRent" type="number" required min="0.01" step="0.01" value="${escapeHtml(contract?.monthlyRent ?? "")}"></label>
        <label class="form-field">Caução (€)<input name="deposit" type="number" min="0" step="0.01" value="${escapeHtml(contract?.deposit ?? 0)}"></label>
        <label class="form-field">Início do contrato<input name="startDate" type="date" required value="${escapeHtml(contract?.startDate || today)}"></label>
        <label class="form-field">Fim do contrato<input name="endDate" type="date" value="${escapeHtml(contract?.endDate || "")}"></label>
        <label class="form-field">Próxima atualização anual<input name="adjustmentDate" type="date" value="${escapeHtml(contract?.adjustmentDate || "")}"><small>O lembrete será agendado dois meses antes.</small></label>
        <label class="form-field">Dia de vencimento da renda<input name="paymentDueDay" type="number" required min="1" max="31" value="${escapeHtml(contract?.paymentDueDay ?? 8)}"></label>
        <label class="form-field">Antecedência do pagamento (meses)<input name="paymentAdvanceMonths" type="number" required min="0" max="12" step="1" value="${escapeHtml(contract?.paymentAdvanceMonths ?? 0)}"><small>0 = no mês da renda; 1 = no mês anterior. Aplica-se também às cobranças futuras já criadas.</small></label>
        ${contract?.status === "archived"
          ? '<div class="form-field"><span>Estado</span><span class="status-badge status-neutral">Arquivado</span></div>'
          : `<label class="form-field">Estado<select name="status"><option value="active" ${contract?.status !== "ended" ? "selected" : ""}>Ativo</option><option value="ended" ${contract?.status === "ended" ? "selected" : ""}>Terminado</option></select></label>`}
      </div>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button-primary" type="submit">${editing ? "Guardar alterações" : "Adicionar contrato"}</button></div>
    </form>`);
}

function openArchiveConfirmation(contract) {
  const property = state.properties.find((item) => item.id === contract.propertyId);
  showDialog(`
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">ENCERRAR REGISTO</p><h2 id="dialog-title">Arquivar contrato?</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <p class="notice-modal-intro">O contrato de ${escapeHtml(contract.tenantName)}${property ? `, no imóvel ${escapeHtml(property.name)}` : ""}, deixará de gerar novas cobranças e lembretes. O contrato e todos os registos de rendas e pagamentos existentes serão mantidos e continuarão consultáveis. Pode restaurá-lo mais tarde.</p>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button-danger" type="button" data-action="confirm-archive" data-contract-id="${escapeHtml(contract.id)}">Arquivar contrato</button></div>
    </div>`);
}

function openPaymentForm(charge) {
  const contract = state.contracts.find((item) => item.id === charge.contractId);
  const property = propertyForContract(charge.contractId);
  const netAmount = getChargeNetAmount(charge, contract);
  const withholdingAmount = getChargeWithholding(charge, contract);
  const balance = Math.max(0, netAmount - getPaidAmount(charge));
  showDialog(`
    <form id="payment-form" data-id="${escapeHtml(charge.id)}">
      <div class="dialog-heading"><div><p class="eyebrow">REGISTAR COBRANÇA</p><h2 id="dialog-title">Novo pagamento</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <div class="payment-context"><strong>${escapeHtml(property?.name || "Imóvel")}</strong><span>${escapeHtml(contract?.tenantName || "")} · ${escapeHtml(formatMonth(charge.period))}</span>${withholdingAmount ? `<small>Renda bruta: ${money.format(charge.amount)} · retenção (25%): ${money.format(withholdingAmount)}</small><small>Líquido a receber: ${money.format(netAmount)}</small>` : ""}<small>Valor em falta: ${money.format(balance)}</small></div>
      <div class="form-grid">
        <label class="form-field">Valor recebido (€)<input name="amount" type="number" required min="0.01" max="${balance}" step="0.01" value="${balance.toFixed(2)}"></label>
        <label class="form-field">Data do pagamento<input name="date" type="date" required max="${today}" value="${today}"></label>
      </div>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button-primary" type="submit">Guardar pagamento</button></div>
    </form>`);
}

function openPaymentDeletionConfirmation(charge, paymentIndex) {
  const payment = charge.payments?.[paymentIndex];
  if (!payment) return;
  const contract = state.contracts.find((item) => item.id === charge.contractId);
  const property = propertyForContract(charge.contractId);
  showDialog(`
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">CORRIGIR REGISTO</p><h2 id="dialog-title">Eliminar pagamento?</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Fechar">×</button></div>
      <div class="payment-context"><strong>${escapeHtml(property?.name || "Imóvel")}</strong><span>${escapeHtml(contract?.tenantName || "")} · ${escapeHtml(formatMonth(charge.period))}</span><small>${money.format(payment.amount)} recebidos em ${escapeHtml(formatDate(payment.date))}</small></div>
      <p class="notice-modal-intro">Será eliminado apenas este registo de pagamento. A cobrança e os restantes pagamentos serão mantidos, e o valor em falta será recalculado.</p>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancelar</button><button class="button button-danger" type="button" data-action="confirm-delete-payment" data-id="${escapeHtml(charge.id)}" data-payment-index="${paymentIndex}">Eliminar pagamento</button></div>
    </div>`);
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
  if (!closeDialog()) return;
  activeView = view;
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
  if (action === "install-app" && window.deferredInstallPrompt) {
    const prompt = window.deferredInstallPrompt;
    window.deferredInstallPrompt = null;
    await prompt.prompt();
    updateAccountActions();
    return;
  }
  if (action === "configure-supabase") {
    renderConfiguration();
    return;
  }
  if (action === "close-configuration") {
    if (supabase) renderAuth();
    else {
      document.body.classList.remove("auth-required");
      document.querySelector(".sidebar").hidden = false;
      render();
    }
    return;
  }
  if (action === "toggle-auth-mode") {
    authMode = button.dataset.mode;
    renderAuth();
    return;
  }
  if (action === "sign-out") {
    await signOut();
    return;
  }
  if (action === "migrate-local") {
    await finishMigration(true);
    return;
  }
  if (action === "restore-local-backup") {
    try {
      const local = parseData(localStorage.getItem(`casathomaz.migration-backup.${authUser.id}`), "A cópia local");
      const remote = await supabase.getOwnerData(await refreshSessionIfNeeded(), authUser.id);
      migrationChoice = { local, remote, userId: authUser.id };
      renderAuth();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "skip-migration") {
    await finishMigration(false);
    return;
  }
  if (action === "close-dialog") closeDialog();
  if (action === "new-property") openPropertyForm();
  if (action === "edit-property") openPropertyForm(state.properties.find((property) => property.id === id));
  if (action === "new-contract") openContractForm(null, propertyId);
  if (action === "edit-contract") openContractForm(state.contracts.find((contract) => contract.id === id));
  if (action === "archive-contract") {
    const contract = state.contracts.find((item) => item.id === id);
    if (contract && contract.status !== "archived") openArchiveConfirmation(contract);
    return;
  }
  if (action === "confirm-archive") {
    const contract = state.contracts.find((item) => item.id === contractId);
    if (contract && contract.status !== "archived") {
      Object.assign(contract, archiveContract(contract, today));
      saveState("Contrato arquivado. O histórico de rendas foi mantido.");
    }
    closeDialog(true);
    render();
    return;
  }
  if (action === "restore-contract") {
    const contract = state.contracts.find((item) => item.id === id);
    if (contract?.status === "archived") {
      Object.assign(contract, restoreContract(contract));
      ensureCharges(selectedPeriod);
      saveState("Contrato restaurado; o histórico de rendas foi mantido.");
      render();
    }
    return;
  }
  if (action === "register-payment") {
    ensureCharges(selectedPeriod);
    openPaymentForm(state.charges.find((charge) => charge.id === id));
    return;
  }
  if (action === "delete-payment") {
    const charge = state.charges.find((item) => item.id === id);
    const paymentIndex = Number.parseInt(button.dataset.paymentIndex, 10);
    if (charge && Number.isInteger(paymentIndex)) openPaymentDeletionConfirmation(charge, paymentIndex);
    return;
  }
  if (action === "confirm-delete-payment") {
    const charge = state.charges.find((item) => item.id === id);
    const paymentIndex = Number.parseInt(button.dataset.paymentIndex, 10);
    if (charge?.payments?.[paymentIndex]) {
      state.charges = state.charges.map((item) => (
        item.id === charge.id ? removePayment(item, paymentIndex) : item
      ));
      saveState("Pagamento eliminado. O valor em falta foi atualizado.");
    } else {
      showToast("Este pagamento já não está disponível. Atualize a página e tente novamente.");
    }
    closeDialog(true);
    render();
    return;
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
  if (event.target.matches("[data-contract-filter]")) {
    contractFilter = event.target.value;
    render();
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.matches("#auth-form")) {
    event.preventDefault();
    await submitAuth(form);
    return;
  }
  if (form.matches("#supabase-config-form")) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    let url;
    try {
      url = new URL(values.url.trim());
    } catch {
      renderConfiguration("Introduza um URL válido do projeto Supabase.");
      return;
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      renderConfiguration("O projeto Supabase deve usar HTTPS.");
      return;
    }
    if (!values.publishableKey.trim()) {
      renderConfiguration("Introduza a chave publicável (anon) do projeto.");
      return;
    }
    if (looksLikeSecretKey(values.publishableKey.trim())) {
      renderConfiguration("Esta parece ser uma chave secret/service-role. Nunca a introduza na aplicação de browser.");
      return;
    }
    if (url.search || url.hash) {
      renderConfiguration("O URL do projeto não deve incluir parâmetros nem fragmentos.");
      return;
    }
    supabaseConfig = {
      url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
      publishableKey: values.publishableKey.trim(),
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(supabaseConfig));
    supabase = createSupabaseClient(supabaseConfig);
    authMode = "signin";
    setCloudStatus("signed-out");
    renderAuth("Configuração guardada neste navegador.");
    return;
  }
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
    state = normalizeData(state);
    saveState(index >= 0 ? "Imóvel atualizado." : "Imóvel adicionado.");
    closeDialog(true);
    render();
    return;
  }

  if (form.matches("#contract-form")) {
    if (values.endDate && values.endDate < values.startDate) {
      showToast("A data de fim deve ser posterior ao início do contrato.");
      return;
    }
    const existing = state.contracts.find((item) => item.id === form.dataset.id);
    const selectedProperty = state.properties.find((property) => property.id === values.propertyId);
    const nonResidential = values.nonResidential === "true" || isNonResidentialProperty(selectedProperty);
    const nonResidentialChanged = Boolean(existing && existing.nonResidential !== nonResidential);
    const scheduleChanged = Boolean(existing && (
      Number(existing.paymentAdvanceMonths) !== Number(values.paymentAdvanceMonths)
      || Number(existing.paymentDueDay) !== Number(values.paymentDueDay)
    ));
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
      paymentAdvanceMonths: Number(values.paymentAdvanceMonths),
      status: existing?.status === "archived" ? "archived" : values.status,
      statusBeforeArchive: existing?.statusBeforeArchive ?? null,
      archivedAt: existing?.archivedAt ?? null,
      nonResidential,
      noticeSent: existing?.adjustmentDate === values.adjustmentDate
        ? existing.noticeSent
        : false,
    };
    if (existing) Object.assign(existing, contract);
    else state.contracts.push(contract);
    if (scheduleChanged) {
      state.charges = rescheduleFutureCharges(state.charges, contract, today);
    }
    if (nonResidentialChanged) {
      state.charges = state.charges.map((charge) => (
        charge.contractId === contract.id
          ? updateChargeWithholding(charge, contract)
          : charge
      ));
    }
    ensureCharges(selectedPeriod);
    saveState(existing ? "Contrato atualizado." : "Contrato adicionado.");
    closeDialog(true);
    render();
    return;
  }

  if (form.matches("#payment-form")) {
    const charge = state.charges.find((item) => item.id === form.dataset.id);
    if (!charge) return;
    const amount = Number(values.amount);
    const contract = state.contracts.find((item) => item.id === charge.contractId);
    const balance = Math.max(0, getChargeNetAmount(charge, contract) - getPaidAmount(charge));
    if (amount <= 0 || amount > balance) {
      showToast("O pagamento deve ser superior a zero e não pode exceder o valor em falta.");
      return;
    }
    charge.payments ||= [];
    charge.payments.push({ amount, date: values.date });
    saveState("Pagamento registado.");
    closeDialog(true);
    render();
  }
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    event.preventDefault();
    event.stopPropagation();
  }
});

dialog.addEventListener("pointerdown", (event) => {
  if (event.target === dialog) {
    event.preventDefault();
    event.stopPropagation();
  }
});

dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});

dialog.addEventListener("close", () => {
  if (approvedDialogClosures) approvedDialogClosures -= 1;
  else dialog.showModal();
});

function registerServiceWorker() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      setCloudStatus(cloudStatus, "PWA offline indisponível neste navegador");
    });
  }
}

function installApp() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    window.deferredInstallPrompt = event;
    updateAccountActions();
  });
  window.addEventListener("appinstalled", () => {
    window.deferredInstallPrompt = null;
    showToast("CasaThomaz instalada.");
    updateAccountActions();
  });
}

window.addEventListener("online", () => {
  if (authUser) {
    setCloudStatus("syncing");
    const pending = readAccountCache(authUser.id)?.pending;
    if (pending) syncNow().then(checkRemoteChanges);
    else checkRemoteChanges();
  } else if (!supabase) {
    setCloudStatus("local");
  }
});
window.addEventListener("offline", () => {
  if (authUser) setCloudStatus("offline");
});
window.addEventListener("focus", checkRemoteChanges);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkRemoteChanges();
});

registerServiceWorker();
installApp();
if (supabase) {
  startCloudSync();
} else {
  render();
}
