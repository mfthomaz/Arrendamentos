export function emptyData() {
  return { properties: [], contracts: [], charges: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function newImportedId(id) {
  return `${id}-import-${crypto.randomUUID().slice(0, 8)}`;
}

function mergeRecords(remoteRecords, localRecords, relationshipMap = {}, relationshipField = "") {
  const result = clone(remoteRecords || []);
  const remoteById = new Map(result.map((record) => [record.id, record]));
  const idMap = new Map();
  let conflicts = 0;

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

export function mergeSnapshots(remoteData, localData) {
  const remote = { ...emptyData(), ...(remoteData || {}) };
  const local = { ...emptyData(), ...(localData || {}) };
  const properties = mergeRecords(remote.properties, local.properties);
  const contracts = mergeRecords(remote.contracts, local.contracts, properties.idMap, "propertyId");
  const charges = mergeRecords(remote.charges, local.charges, contracts.idMap, "contractId");

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
