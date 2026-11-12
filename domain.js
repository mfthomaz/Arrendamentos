export function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseISODate(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addMonths(value, count) {
  const date = typeof value === "string" ? parseISODate(value) : new Date(value);
  const targetMonth = date.getMonth() + count;
  const firstOfTargetMonth = new Date(date.getFullYear(), targetMonth, 1);
  const lastDay = new Date(
    firstOfTargetMonth.getFullYear(),
    firstOfTargetMonth.getMonth() + 1,
    0,
  ).getDate();
  return toISODate(
    new Date(
      firstOfTargetMonth.getFullYear(),
      firstOfTargetMonth.getMonth(),
      Math.min(date.getDate(), lastDay),
    ),
  );
}

export function addDays(value, count) {
  const date = typeof value === "string" ? parseISODate(value) : new Date(value);
  date.setDate(date.getDate() + count);
  return toISODate(date);
}

export function periodBounds(period) {
  const [year, month] = period.split("-").map(Number);
  return {
    start: `${period}-01`,
    end: toISODate(new Date(year, month, 0)),
    days: new Date(year, month, 0).getDate(),
  };
}

export function getPaidAmount(charge) {
  return (charge.payments || []).reduce((total, payment) => total + Number(payment.amount || 0), 0);
}

export function removePayment(charge, paymentIndex) {
  if (!Array.isArray(charge.payments) || !Number.isInteger(paymentIndex)
    || paymentIndex < 0 || paymentIndex >= charge.payments.length) {
    throw new RangeError("Pagamento não encontrado.");
  }
  return {
    ...charge,
    payments: charge.payments.filter((_, index) => index !== paymentIndex),
  };
}

export function updateUnpaidCharges(charges, contract, fromPeriod) {
  if (contract.status !== "active") return charges;
  let changed = false;
  const updated = charges.map((charge) => {
    if (charge.contractId !== contract.id || charge.period < fromPeriod || charge.payments?.length) {
      return charge;
    }
    if (Number(charge.amount) === Number(contract.monthlyRent)) return charge;
    changed = true;
    return updateChargeWithholding({
      ...charge,
      amount: Number(contract.monthlyRent),
    }, contract);
  });
  return changed ? updated : charges;
}

export function isNonResidentialProperty(property) {
  return property?.type === "Loja" || property?.type === "Escritório";
}

export function getChargeNetAmount(charge, contract) {
  if (charge.netAmount != null) return Number(charge.netAmount);
  const grossAmount = Number(charge.amount || 0);
  const withholdingRate = charge.withholdingRate ?? (contract?.nonResidential ? 0.25 : 0);
  const withholdingAmount = Math.round((grossAmount * Number(withholdingRate) + Number.EPSILON) * 100) / 100;
  return grossAmount - withholdingAmount;
}

export function getChargeWithholding(charge, contract) {
  return Number(charge.amount || 0) - getChargeNetAmount(charge, contract);
}

export function updateChargeWithholding(charge, contract) {
  const amount = Number(charge.amount || 0);
  const withholdingRate = contract.nonResidential ? 0.25 : 0;
  const withholdingAmount = Math.round((amount * withholdingRate + Number.EPSILON) * 100) / 100;
  return {
    ...charge,
    withholdingRate,
    withholdingAmount,
    netAmount: amount - withholdingAmount,
  };
}

export function getChargeDueDate(contract, period) {
  const advanceMonths = Math.max(0, Math.min(12, Math.trunc(Number(contract.paymentAdvanceMonths) || 0)));
  const duePeriod = addMonths(`${period}-01`, -advanceMonths).slice(0, 7);
  const { days } = periodBounds(duePeriod);
  const dueDay = Math.min(Number(contract.paymentDueDay) || 1, days);
  return `${duePeriod}-${String(dueDay).padStart(2, "0")}`;
}

function stableRecordValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableRecordValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableRecordValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPaymentSubset(subset, superset) {
  const counts = new Map();
  for (const payment of superset) {
    const key = stableRecordValue(payment);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const payment of subset) {
    const key = stableRecordValue(payment);
    const count = counts.get(key) || 0;
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return true;
}

export function reclassifyChargePeriod(charges, contract, chargeId, targetPeriod) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetPeriod || "")) {
    throw new Error("Escolha um mês da renda válido.");
  }
  const source = charges.find((charge) => charge.id === chargeId);
  if (!source || source.contractId !== contract?.id) {
    throw new Error("Não encontrei esta cobrança. Atualize a página e tente novamente.");
  }
  if (source.period === targetPeriod) {
    throw new Error("A cobrança já está associada a esse mês da renda.");
  }

  const targetMatches = charges.filter((charge) => (
    charge.id !== source.id
    && charge.contractId === contract.id
    && charge.period === targetPeriod
  ));
  if (targetMatches.length > 1) {
    throw new Error("Já existem várias cobranças para esse mês. Não alterei nenhum dado.");
  }

  const next = charges.map((charge) => ({ ...charge, payments: (charge.payments || []).map((payment) => ({ ...payment })) }));
  const sourceCopy = next.find((charge) => charge.id === source.id);
  const expectedDueDate = getChargeDueDate(contract, targetPeriod);

  if (!targetMatches.length) {
    sourceCopy.period = targetPeriod;
    sourceCopy.dueDate = expectedDueDate;
    return { charges: next, merged: false, dueDate: expectedDueDate };
  }

  const targetCopy = next.find((charge) => charge.id === targetMatches[0].id);
  const omit = new Set(["id", "contractId", "period", "dueDate", "payments"]);
  const sourceTerms = Object.fromEntries(Object.entries(sourceCopy).filter(([key]) => !omit.has(key)));
  const targetTerms = Object.fromEntries(Object.entries(targetCopy).filter(([key]) => !omit.has(key)));
  if (stableRecordValue(sourceTerms) !== stableRecordValue(targetTerms)) {
    throw new Error("As cobranças têm valores ou condições diferentes. Não alterei nenhum dado.");
  }

  const sourcePayments = sourceCopy.payments || [];
  const targetPayments = targetCopy.payments || [];
  if (!isPaymentSubset(sourcePayments, targetPayments) && !isPaymentSubset(targetPayments, sourcePayments)) {
    throw new Error("Os históricos de pagamentos são diferentes. Não alterei nenhum dado.");
  }

  targetCopy.dueDate = expectedDueDate;
  targetCopy.payments = isPaymentSubset(targetPayments, sourcePayments)
    ? sourcePayments
    : targetPayments;
  const mergedCharges = next.filter((charge) => charge.id !== sourceCopy.id);
  return { charges: mergedCharges, merged: true, dueDate: expectedDueDate };
}

export function rescheduleFutureCharges(charges, contract, today = toISODate(new Date())) {
  return charges.map((charge) => (
    charge.contractId === contract.id && charge.dueDate >= today
      ? { ...charge, dueDate: getChargeDueDate(contract, charge.period) }
      : charge
  ));
}

export function getChargeStatus(charge, today = toISODate(new Date()), contract) {
  const paid = getPaidAmount(charge);
  if (paid >= getChargeNetAmount(charge, contract)) return "paid";
  if (paid > 0) return charge.dueDate < today ? "partial-overdue" : "partial";
  if (charge.dueDate < today) return "overdue";
  return "pending";
}

export function archiveContract(contract, archivedAt) {
  return {
    ...contract,
    status: "archived",
    statusBeforeArchive: contract.status === "archived"
      ? contract.statusBeforeArchive || "active"
      : contract.status,
    archivedAt,
  };
}

export function restoreContract(contract) {
  return {
    ...contract,
    status: contract.statusBeforeArchive || "active",
    statusBeforeArchive: null,
    archivedAt: null,
  };
}

export function createCharges(contracts, charges, period) {
  const { start, end } = periodBounds(period);
  const byContract = new Map(
    charges.filter((charge) => charge.period === period).map((charge) => [charge.contractId, charge]),
  );
  const result = [...charges];

  for (const contract of contracts) {
    if (contract.status !== "active" || contract.startDate > end || (contract.endDate && contract.endDate < start)) {
      continue;
    }
    if (byContract.has(contract.id)) continue;
    const charge = {
      id: `${contract.id}-${period}`,
      contractId: contract.id,
      period,
      amount: Number(contract.monthlyRent),
      dueDate: getChargeDueDate(contract, period),
      payments: [],
    };
    result.push(updateChargeWithholding(charge, contract));
  }
  return result;
}

export function getChargeSummary(contracts, charges, period, today = toISODate(new Date())) {
  const monthCharges = charges.filter((charge) => charge.dueDate.slice(0, 7) === period);
  const summary = {
    total: 0,
    received: 0,
    missing: 0,
    overdue: 0,
    overdueCount: 0,
    paidCount: 0,
    chargeCount: monthCharges.length,
  };

  const contractsById = new Map(contracts.map((contract) => [contract.id, contract]));
  for (const charge of monthCharges) {
    const paid = getPaidAmount(charge);
    const contract = contractsById.get(charge.contractId);
    const netAmount = getChargeNetAmount(charge, contract);
    const outstanding = Math.max(0, netAmount - paid);
    const status = getChargeStatus(charge, today, contract);
    summary.total += netAmount;
    summary.received += paid;
    summary.missing += outstanding;
    if (status === "overdue" || status === "partial-overdue") {
      summary.overdue += outstanding;
      summary.overdueCount += 1;
    }
    if (status === "paid") summary.paidCount += 1;
  }
  summary.collectionRate = summary.total ? Math.min(1, summary.received / summary.total) : 0;
  summary.activeContracts = contracts.filter((contract) => (
    contract.status === "active"
    && contract.startDate <= today
    && (!contract.endDate || contract.endDate >= today)
  )).length;
  return summary;
}

export function getUpcomingEvents(contracts, today, horizonMonths, noticesSent = {}) {
  const end = addMonths(today, horizonMonths);
  const events = [];
  const addEvent = (contract, type, date, title, completed = false) => {
    if (date < today || date > end) return;
    events.push({
      id: `${contract.id}-${type}-${date}`,
      contractId: contract.id,
      propertyId: contract.propertyId,
      tenantName: contract.tenantName,
      type,
      date,
      title,
      completed,
    });
  };

  for (const contract of contracts) {
    if (contract.status !== "active") continue;
    if (contract.adjustmentDate) {
      const noticeDate = addMonths(contract.adjustmentDate, -2);
      addEvent(
        contract,
        "notice",
        noticeDate,
        "Preparar aviso de atualização",
        Boolean(noticesSent[contract.id] || contract.noticeSent),
      );
      addEvent(contract, "adjustment", contract.adjustmentDate, "Data de atualização anual");
    }
    if (contract.endDate) {
      addEvent(contract, "expiry", contract.endDate, "Fim do contrato");
    }
  }

  const typeOrder = { notice: 0, expiry: 1, adjustment: 2 };
  return events.sort((left, right) => (
    left.date.localeCompare(right.date) || typeOrder[left.type] - typeOrder[right.type]
  ));
}

export function createDemoData(today = toISODate(new Date())) {
  const properties = [
    { id: "p-alfama", name: "Apartamento Alfama", address: "Rua dos Remédios, Lisboa", type: "Apartamento", bedrooms: 2, area: 78, notes: "" },
    { id: "p-cascais", name: "Casa da Guia", address: "Rua dos Bem Lembrados, Cascais", type: "Moradia", bedrooms: 3, area: 132, notes: "" },
    { id: "p-oeiras", name: "Vista do Mar", address: "Av. Marginal, Oeiras", type: "Apartamento", bedrooms: 1, area: 64, notes: "" },
    { id: "p-porto", name: "Cedofeita 42", address: "Rua de Cedofeita, Porto", type: "Apartamento", bedrooms: 2, area: 91, notes: "" },
    { id: "p-santarem", name: "Quinta do Jardim", address: "Rua do Jardim, Santarém", type: "Moradia", bedrooms: 3, area: 145, notes: "" },
  ];
  const contracts = [
    { id: "c-alfama", propertyId: "p-alfama", tenantName: "Inês Carvalho", tenantEmail: "ines@example.pt", monthlyRent: 1150, deposit: 2300, startDate: addMonths(today, -15), endDate: addMonths(today, 12), adjustmentDate: addMonths(today, 3), paymentDueDay: 5, status: "active", noticeSent: false },
    { id: "c-cascais", propertyId: "p-cascais", tenantName: "Miguel e Rita Sousa", tenantEmail: "miguel@example.pt", monthlyRent: 1450, deposit: 2900, startDate: addMonths(today, -8), endDate: addMonths(today, 18), adjustmentDate: addMonths(today, 4), paymentDueDay: 8, status: "active", noticeSent: false },
    { id: "c-oeiras", propertyId: "p-oeiras", tenantName: "João Martins", tenantEmail: "joao@example.pt", monthlyRent: 975, deposit: 1950, startDate: addMonths(today, -21), endDate: addMonths(today, 14), adjustmentDate: addMonths(today, 6), paymentDueDay: 15, status: "active", noticeSent: false },
    { id: "c-porto", propertyId: "p-porto", tenantName: "Sofia Almeida", tenantEmail: "sofia@example.pt", monthlyRent: 890, deposit: 1780, startDate: addMonths(today, -10), endDate: addMonths(today, 8), adjustmentDate: addMonths(today, 1), paymentDueDay: 1, status: "active", noticeSent: false },
  ];
  const period = today.slice(0, 7);
  let charges = createCharges(contracts, [], period);
  const initialPayments = {
    "c-alfama": [{ amount: 1150, date: addDays(today, -3) }],
    "c-oeiras": [{ amount: 975, date: addDays(today, -2) }],
    "c-porto": [{ amount: 400, date: addDays(today, -1) }],
  };
  charges = charges.map((charge) => ({
    ...charge,
    payments: initialPayments[charge.contractId] || [],
  }));
  return { properties, contracts, charges };
}
