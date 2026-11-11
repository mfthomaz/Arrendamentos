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

export function getChargeStatus(charge, today = toISODate(new Date())) {
  const paid = getPaidAmount(charge);
  if (paid >= charge.amount) return "paid";
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
  const { start, end, days } = periodBounds(period);
  const byContract = new Map(
    charges.filter((charge) => charge.period === period).map((charge) => [charge.contractId, charge]),
  );
  const result = [...charges];

  for (const contract of contracts) {
    if (contract.status !== "active" || contract.startDate > end || (contract.endDate && contract.endDate < start)) {
      continue;
    }
    if (byContract.has(contract.id)) continue;
    const dueDay = Math.min(Number(contract.paymentDueDay) || 1, days);
    result.push({
      id: `${contract.id}-${period}`,
      contractId: contract.id,
      period,
      amount: Number(contract.monthlyRent),
      dueDate: `${period}-${String(dueDay).padStart(2, "0")}`,
      payments: [],
    });
  }
  return result;
}

export function getChargeSummary(contracts, charges, period, today = toISODate(new Date())) {
  const monthCharges = charges.filter((charge) => charge.period === period);
  const summary = {
    total: 0,
    received: 0,
    missing: 0,
    overdue: 0,
    overdueCount: 0,
    paidCount: 0,
    chargeCount: monthCharges.length,
  };

  for (const charge of monthCharges) {
    const paid = getPaidAmount(charge);
    const outstanding = Math.max(0, Number(charge.amount) - paid);
    const status = getChargeStatus(charge, today);
    summary.total += Number(charge.amount);
    summary.received += paid;
    summary.missing += outstanding;
    if (status === "overdue" || status === "partial-overdue") {
      summary.overdue += outstanding;
      summary.overdueCount += 1;
    }
    if (status === "paid") summary.paidCount += 1;
  }
  summary.collectionRate = summary.total ? summary.received / summary.total : 0;
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
