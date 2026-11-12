import { isNonResidentialProperty, updateChargeWithholding } from "./domain.js";

export function emptyData() {
  return { properties: [], contracts: [], charges: [] };
}

export function normalizeData(data) {
  const normalized = { ...emptyData(), ...(data || {}) };
  const nonResidentialPropertyIds = new Set(
    normalized.properties.filter(isNonResidentialProperty).map((property) => property.id),
  );
  normalized.contracts = normalized.contracts.map((contract) => ({
    ...contract,
    status: contract.status || "active",
    statusBeforeArchive: contract.statusBeforeArchive ?? null,
    archivedAt: contract.archivedAt ?? null,
    nonResidential: Boolean(contract.nonResidential || nonResidentialPropertyIds.has(contract.propertyId)),
    paymentAdvanceMonths: Math.max(0, Math.min(12, Math.trunc(Number(contract.paymentAdvanceMonths) || 0))),
  }));
  const contractsById = new Map(normalized.contracts.map((contract) => [contract.id, contract]));
  normalized.charges = normalized.charges.map((charge) => {
    const contract = contractsById.get(charge.contractId);
    return contract?.nonResidential ? updateChargeWithholding(charge, contract) : charge;
  });
  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function cloneData(data) {
  return clone(normalizeData(data));
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function mergeRecordFields(baseRecord, remoteRecord, localRecord) {
  const merged = {};
  const fields = new Set([
    ...Object.keys(baseRecord || {}),
    ...Object.keys(remoteRecord || {}),
    ...Object.keys(localRecord || {}),
  ]);
  for (const field of fields) {
    const baseValue = baseRecord?.[field];
    const remoteValue = remoteRecord?.[field];
    const localValue = localRecord?.[field];
    const remoteChanged = stableValue(remoteValue) !== stableValue(baseValue);
    const localChanged = stableValue(localValue) !== stableValue(baseValue);
    if (remoteChanged && localChanged && stableValue(remoteValue) !== stableValue(localValue)) {
      return null;
    }
    const value = localChanged ? localValue : remoteChanged ? remoteValue : baseValue;
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

function newImportedId(id) {
  return `${id}-import-${crypto.randomUUID().slice(0, 8)}`;
}

function mergeRecords(remoteRecords, localRecords, baseRecords = null, relationshipMap = {}, relationshipField = "") {
  const remote = clone(remoteRecords || []);
  const remoteById = new Map(remote.map((record) => [record.id, record]));
  const idMap = new Map();
  let conflicts = 0;

  if (baseRecords) {
    const localById = new Map();
    const remappedRelationships = new Set();
    for (const localRecord of localRecords || []) {
      const record = clone(localRecord);
      if (relationshipField && relationshipMap.has(record[relationshipField])) {
        record[relationshipField] = relationshipMap.get(record[relationshipField]);
        remappedRelationships.add(record.id);
      }
      localById.set(record.id, record);
    }
    const baseById = new Map((baseRecords || []).map((record) => [record.id, record]));
    const ids = new Set([...remoteById.keys(), ...localById.keys(), ...baseById.keys()]);
    const result = [];

    for (const id of ids) {
      const remoteRecord = remoteById.get(id);
      const localRecord = localById.get(id);
      const baseRecord = baseById.get(id);

      if (remappedRelationships.has(id) && remoteRecord && localRecord) {
        result.push(remoteRecord);
        const copy = clone(localRecord);
        copy.id = newImportedId(copy.id);
        idMap.set(id, copy.id);
        result.push(copy);
        conflicts += 1;
        continue;
      }

      const remoteChanged = stableValue(remoteRecord) !== stableValue(baseRecord);
      const localChanged = stableValue(localRecord) !== stableValue(baseRecord);
      if (!localChanged) {
        if (remoteRecord) result.push(remoteRecord);
        continue;
      }
      if (!remoteChanged) {
        if (localRecord) result.push(localRecord);
        continue;
      }
      if (stableValue(remoteRecord) === stableValue(localRecord)) {
        if (remoteRecord) result.push(remoteRecord);
        continue;
      }
      if (remoteRecord && localRecord && baseRecord) {
        const mergedRecord = mergeRecordFields(baseRecord, remoteRecord, localRecord);
        if (mergedRecord) {
          result.push(mergedRecord);
          continue;
        }
      }
      if (remoteRecord) result.push(remoteRecord);
      if (localRecord) {
        if (!remoteRecord) {
          result.push(localRecord);
        } else {
          const copy = clone(localRecord);
          copy.id = newImportedId(copy.id);
          idMap.set(id, copy.id);
          result.push(copy);
          conflicts += 1;
        }
      } else {
        conflicts += 1;
      }
    }

    return { records: result, idMap, conflicts };
  }

  const result = remote;
  for (const localRecord of localRecords || []) {
    const record = clone(localRecord);
    if (relationshipField && relationshipMap.has(record[relationshipField])) {
      record[relationshipField] = relationshipMap.get(record[relationshipField]);
    }

    const existing = remoteById.get(record.id);
    const relationshipChanged = relationshipField
      && record[relationshipField] !== localRecord[relationshipField];
    if (existing && stableValue(existing) === stableValue(record)) continue;

    if (existing || relationshipChanged) {
      const originalId = record.id;
      record.id = newImportedId(originalId);
      idMap.set(originalId, record.id);
      conflicts += 1;
    }
    result.push(record);
    remoteById.set(record.id, record);
  }

  return { records: result, idMap, conflicts };
}

export function mergeSnapshots(remoteData, localData, baseData = null) {
  const remote = normalizeData(remoteData);
  const local = normalizeData(localData);
  const base = baseData ? normalizeData(baseData) : null;
  const properties = mergeRecords(remote.properties, local.properties, base?.properties);
  const contracts = mergeRecords(remote.contracts, local.contracts, base?.contracts, properties.idMap, "propertyId");
  const charges = mergeRecords(remote.charges, local.charges, base?.charges, contracts.idMap, "contractId");

  return {
    data: {
      ...clone(remote),
      properties: properties.records,
      contracts: contracts.records,
      charges: charges.records,
    },
    conflicts: properties.conflicts + contracts.conflicts + charges.conflicts,
  };
}

function withoutFields(record, fields) {
  return Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)));
}

function isMultisetSubset(subset, superset) {
  const counts = new Map();
  for (const value of superset) {
    const key = stableValue(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const value of subset) {
    const key = stableValue(value);
    const count = counts.get(key) || 0;
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return true;
}

function mergePaymentHistories(targetPayments, sourcePayments) {
  if (isMultisetSubset(targetPayments, sourcePayments)) return clone(sourcePayments);
  if (isMultisetSubset(sourcePayments, targetPayments)) return clone(targetPayments);
  throw new Error("Os históricos de pagamentos destes registos são diferentes. Não alterei nenhum dado.");
}

export function consolidateDuplicateProperties(data, keepPropertyId, removePropertyId) {
  if (!keepPropertyId || !removePropertyId || keepPropertyId === removePropertyId) {
    throw new Error("Escolha dois imóveis diferentes.");
  }

  const result = cloneData(data);
  const keepProperty = result.properties.find((property) => property.id === keepPropertyId);
  const removeProperty = result.properties.find((property) => property.id === removePropertyId);
  if (!keepProperty || !removeProperty) throw new Error("Não encontrei ambos os imóveis. Atualize a página e tente novamente.");
  if (stableValue(withoutFields(keepProperty, ["id", "address"]))
    !== stableValue(withoutFields(removeProperty, ["id", "address"]))) {
    throw new Error("Os dados dos imóveis diferem para além da morada. Não alterei nenhum dado.");
  }

  const keepContracts = result.contracts.filter((contract) => contract.propertyId === keepPropertyId);
  const removeContracts = result.contracts.filter((contract) => contract.propertyId === removePropertyId);
  if (keepContracts.length !== removeContracts.length) {
    throw new Error("Os imóveis têm contratos diferentes. Não alterei nenhum dado.");
  }

  const matchedContracts = [];
  const usedKeepContracts = new Set();
  for (const removeContract of removeContracts) {
    const signature = stableValue(withoutFields(removeContract, ["id", "propertyId"]));
    const matches = keepContracts.filter((contract) => (
      !usedKeepContracts.has(contract.id)
      && stableValue(withoutFields(contract, ["id", "propertyId"])) === signature
    ));
    if (matches.length !== 1) {
      throw new Error("Não consegui associar os contratos de forma inequívoca. Não alterei nenhum dado.");
    }
    usedKeepContracts.add(matches[0].id);
    matchedContracts.push([matches[0], removeContract]);
  }

  const removeChargeIds = new Set();
  let mergedChargeCount = 0;
  for (const [keepContract, removeContract] of matchedContracts) {
    const keepCharges = result.charges.filter((charge) => charge.contractId === keepContract.id);
    const removeCharges = result.charges.filter((charge) => charge.contractId === removeContract.id);
    const keepByPeriod = new Map();
    const removeByPeriod = new Map();
    for (const charge of keepCharges) {
      if (keepByPeriod.has(charge.period)) {
        throw new Error("Há várias cobranças do mesmo mês num contrato. Não alterei nenhum dado.");
      }
      keepByPeriod.set(charge.period, charge);
    }
    for (const charge of removeCharges) {
      if (removeByPeriod.has(charge.period)) {
        throw new Error("Há várias cobranças do mesmo mês num contrato. Não alterei nenhum dado.");
      }
      removeByPeriod.set(charge.period, charge);
    }

    for (const removeCharge of removeCharges) {
      const keepCharge = keepByPeriod.get(removeCharge.period);
      if (!keepCharge) {
        removeCharge.contractId = keepContract.id;
        mergedChargeCount += 1;
        continue;
      }
      const keepTerms = withoutFields(keepCharge, ["id", "contractId", "payments"]);
      const removeTerms = withoutFields(removeCharge, ["id", "contractId", "payments"]);
      if (stableValue(keepTerms) !== stableValue(removeTerms)) {
        throw new Error("Há cobranças do mesmo mês com valores ou datas diferentes. Não alterei nenhum dado.");
      }
      keepCharge.payments = mergePaymentHistories(keepCharge.payments || [], removeCharge.payments || []);
      removeChargeIds.add(removeCharge.id);
      mergedChargeCount += 1;
    }
  }

  const removeContractIds = new Set(removeContracts.map((contract) => contract.id));
  const keepContractIds = new Set(keepContracts.map((contract) => contract.id));
  result.properties = result.properties.filter((property) => property.id !== removePropertyId);
  result.contracts = result.contracts.filter((contract) => !removeContractIds.has(contract.id));
  result.charges = result.charges.filter((charge) => !removeChargeIds.has(charge.id));

  return {
    data: result,
    summary: {
      removedProperties: 1,
      mergedContracts: removeContracts.length,
      mergedCharges: mergedChargeCount,
      preservedPayments: result.charges
        .filter((charge) => keepContractIds.has(charge.contractId))
        .reduce((count, charge) => count + (charge.payments || []).length, 0),
    },
  };
}

export function hasRecords(data) {
  return Boolean(data && ["properties", "contracts", "charges"].some((key) => data[key]?.length));
}

export function createSupabaseClient(config) {
  const baseUrl = config.url.replace(/\/+$/, "");
  const apiKey = config.publishableKey;

  async function request(path, { method = "GET", token, body, prefer } = {}) {
    const headers = {
      apikey: apiKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    };
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const raw = await response.text();
    let result = null;
    if (raw) {
      try {
        result = JSON.parse(raw);
      } catch {
        throw new Error("O servidor Supabase devolveu uma resposta inválida.");
      }
    }
    if (!response.ok) {
      const error = new Error(result?.msg || result?.message || result?.error_description || result?.error || `Erro Supabase (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return { data: result, response };
  }

  function sessionFromAuthResponse(data) {
    if (!data?.access_token || !data?.refresh_token || !data?.user?.id) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
      user: data.user,
    };
  }

  return {
    async signIn(email, password) {
      const { data } = await request("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email, password },
      });
      return sessionFromAuthResponse(data);
    },
    async signUp(email, password) {
      const { data } = await request("/auth/v1/signup", {
        method: "POST",
        body: { email, password },
      });
      return sessionFromAuthResponse(data);
    },
    async refreshSession(session) {
      const { data } = await request("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: session.refreshToken },
      });
      return sessionFromAuthResponse(data);
    },
    async signOut(session) {
      await request("/auth/v1/logout", { method: "POST", token: session.accessToken });
    },
    async getUser(session) {
      const { data } = await request("/auth/v1/user", { token: session.accessToken });
      return data;
    },
    sessionFromUrl(hash) {
      const params = new URLSearchParams(hash.replace(/^#/, ""));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (!accessToken || !refreshToken) return null;
      return {
        accessToken,
        refreshToken,
        expiresAt: Number(params.get("expires_at"))
          || Math.floor(Date.now() / 1000) + Number(params.get("expires_in") || 3600),
        user: null,
      };
    },
    async getOwnerData(session, userId) {
      const filter = encodeURIComponent(userId);
      const { data } = await request(`/rest/v1/owner_data?user_id=eq.${filter}&select=user_id,data,revision,updated_at`, {
        token: session.accessToken,
      });
      return Array.isArray(data) ? data[0] || null : null;
    },
    async insertOwnerData(session, userId, data) {
      const { data: rows } = await request("/rest/v1/owner_data", {
        method: "POST",
        token: session.accessToken,
        body: { user_id: userId, data, revision: 1 },
        prefer: "return=representation",
      });
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async updateOwnerData(session, userId, revision, data) {
      const filter = encodeURIComponent(userId);
      const query = `/rest/v1/owner_data?user_id=eq.${filter}&revision=eq.${Number(revision)}`;
      const { data: rows } = await request(query, {
        method: "PATCH",
        token: session.accessToken,
        body: { data, revision: Number(revision) + 1, updated_at: new Date().toISOString() },
        prefer: "return=representation",
      });
      return Array.isArray(rows) ? rows[0] || null : null;
    },
  };
}
