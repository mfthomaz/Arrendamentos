import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveContract,
  addMonths,
  createCharges,
  getChargeNetAmount,
  getChargeStatus,
  getChargeSummary,
  getChargeWithholding,
  getChargeDueDate,
  getUpcomingEvents,
  getPaidAmount,
  removePayment,
  reclassifyChargePeriod,
  rescheduleFutureCharges,
  restoreContract,
  updateChargeWithholding,
  updateUnpaidCharges,
} from "../domain.js";

test("addMonths clamps the day to the last day of the destination month", () => {
  assert.equal(addMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2027-03-31", -1), "2027-02-28");
});

test("monthly charges are created only for contracts overlapping the selected month", () => {
  const contracts = [
    { id: "active", status: "active", startDate: "2027-02-15", endDate: "", monthlyRent: 1200, paymentDueDay: 31 },
    { id: "ended", status: "active", startDate: "2026-01-01", endDate: "2027-01-31", monthlyRent: 900, paymentDueDay: 5 },
    { id: "inactive", status: "ended", startDate: "2026-01-01", monthlyRent: 800, paymentDueDay: 5 },
  ];
  const charges = createCharges(contracts, [], "2027-02");
  assert.equal(charges.length, 1);
  assert.equal(charges[0].dueDate, "2027-02-28");
  assert.equal(charges[0].amount, 1200);
  assert.equal(createCharges(contracts, charges, "2027-02").length, 1);
});

test("payment status and summary distinguish partial, late, and complete charges", () => {
  const charges = [
    { contractId: "paid", period: "2027-02", amount: 1000, dueDate: "2027-02-05", payments: [{ amount: 1000 }] },
    { contractId: "partial", period: "2027-02", amount: 1000, dueDate: "2027-02-05", payments: [{ amount: 300 }] },
    { contractId: "late", period: "2027-02", amount: 900, dueDate: "2027-02-04", payments: [] },
    { contractId: "pending", period: "2027-02", amount: 800, dueDate: "2027-02-20", payments: [] },
  ];
  assert.deepEqual(charges.map((charge) => getChargeStatus(charge, "2027-02-10")), ["paid", "partial-overdue", "overdue", "pending"]);
  const summary = getChargeSummary([], charges, "2027-02", "2027-02-10");
  assert.equal(summary.total, 3700);
  assert.equal(summary.received, 1300);
  assert.equal(summary.missing, 2400);
  assert.equal(summary.overdue, 1600);
  assert.equal(summary.overdueCount, 2);
  assert.equal(summary.collectionRate, 1300 / 3700);
});

test("removing a mistaken payment preserves the charge and recalculates the balance", () => {
  const charge = {
    id: "charge-1",
    contractId: "c-1",
    period: "2027-02",
    amount: 1000,
    dueDate: "2027-02-05",
    payments: [
      { amount: 700, date: "2027-02-04" },
      { amount: 300, date: "2027-02-05" },
    ],
  };

  const updated = removePayment(charge, 0);
  const summary = getChargeSummary([], [updated], "2027-02", "2027-02-10");

  assert.equal(updated.id, charge.id);
  assert.deepEqual(charge.payments, [
    { amount: 700, date: "2027-02-04" },
    { amount: 300, date: "2027-02-05" },
  ]);
  assert.deepEqual(updated.payments, [{ amount: 300, date: "2027-02-05" }]);
  assert.equal(getPaidAmount(updated), 300);
  assert.equal(summary.received, 300);
  assert.equal(summary.missing, 700);
  assert.equal(getChargeStatus(updated, "2027-02-10"), "partial-overdue");
});

test("contract rent updates unpaid current and future charges without changing paid or past charges", () => {
  const contract = {
    id: "c-shop",
    status: "active",
    monthlyRent: 1074,
    nonResidential: true,
  };
  const charges = [
    { id: "current", contractId: "c-shop", period: "2026-11", amount: 1450, payments: [] },
    { id: "future", contractId: "c-shop", period: "2026-12", amount: 1200, payments: [] },
    { id: "past", contractId: "c-shop", period: "2026-10", amount: 1450, payments: [] },
    { id: "paid", contractId: "c-shop", period: "2026-11", amount: 1450, payments: [{ amount: 500, date: "2026-11-02" }] },
    { id: "other-contract", contractId: "c-other", period: "2026-11", amount: 900, payments: [] },
  ];

  const updated = updateUnpaidCharges(charges, contract, "2026-11");

  assert.equal(updated[0].amount, 1074);
  assert.equal(updated[0].withholdingAmount, 268.5);
  assert.equal(updated[0].netAmount, 805.5);
  assert.equal(updated[1].amount, 1074);
  assert.equal(updated[2].amount, 1450);
  assert.equal(updated[3].amount, 1450);
  assert.deepEqual(updated[3].payments, [{ amount: 500, date: "2026-11-02" }]);
  assert.equal(updated[4].amount, 900);
});

test("active contract totals exclude future and expired leases", () => {
  const contracts = [
    { status: "active", startDate: "2027-01-01", endDate: "2027-12-31" },
    { status: "active", startDate: "2027-03-01", endDate: "2027-12-31" },
    { status: "active", startDate: "2026-01-01", endDate: "2027-01-31" },
    { status: "ended", startDate: "2026-01-01", endDate: "2027-12-31" },
  ];
  assert.equal(getChargeSummary(contracts, [], "2027-02", "2027-02-01").activeContracts, 1);
});

test("annual adjustment notice is scheduled two calendar months before the adjustment", () => {
  const contracts = [
    { id: "a", status: "active", propertyId: "p1", tenantName: "Ana", adjustmentDate: "2027-04-30", endDate: "2027-06-30" },
  ];
  const events = getUpcomingEvents(contracts, "2027-02-01", 6);
  const notice = events.find((event) => event.type === "notice");
  assert.equal(notice.date, "2027-02-28");
  assert.equal(events.find((event) => event.type === "adjustment").date, "2027-04-30");
  assert.equal(events.find((event) => event.type === "expiry").date, "2027-06-30");
});

test("sent notices remain visible as completed and events respect the selected horizon", () => {
  const contracts = [
    { id: "a", status: "active", propertyId: "p1", tenantName: "Ana", adjustmentDate: "2027-04-01", endDate: "2027-10-01" },
  ];
  const events = getUpcomingEvents(contracts, "2027-02-01", 3, { a: true });
  assert.equal(events.some((event) => event.date === "2027-10-01"), false);
  assert.equal(events.find((event) => event.type === "notice").completed, true);
});

test("archiving preserves contract and payment history while stopping future charges and events", () => {
  const contract = {
    id: "c-1",
    status: "active",
    propertyId: "p-1",
    tenantName: "Ana",
    startDate: "2026-01-01",
    endDate: "2027-12-31",
    adjustmentDate: "2027-04-01",
    monthlyRent: 1000,
    paymentDueDay: 5,
  };
  const historicCharge = {
    id: "charge-1",
    contractId: "c-1",
    period: "2027-02",
    amount: 1000,
    dueDate: "2027-02-05",
    payments: [{ amount: 600, date: "2027-02-04" }],
  };
  const archived = archiveContract(contract, "2027-02-10");
  const charges = createCharges([archived], [historicCharge], "2027-03");

  assert.equal(archived.status, "archived");
  assert.equal(archived.archivedAt, "2027-02-10");
  assert.equal(archived.monthlyRent, contract.monthlyRent);
  assert.deepEqual(charges, [historicCharge]);
  assert.equal(getChargeSummary([archived], charges, "2027-02", "2027-02-10").activeContracts, 0);
  assert.deepEqual(getUpcomingEvents([archived], "2027-02-10", 6), []);
});

test("restoring an archived ended contract keeps its original status and clears archive metadata", () => {
  const archived = archiveContract({
    id: "c-ended",
    status: "ended",
    statusBeforeArchive: null,
    archivedAt: null,
    tenantName: "Rui",
  }, "2027-02-10");

  assert.deepEqual(restoreContract(archived), {
    id: "c-ended",
    status: "ended",
    statusBeforeArchive: null,
    archivedAt: null,
    tenantName: "Rui",
  });
});

test("non-residential charges retain 25 percent and track the 75 percent net rent", () => {
  const contract = {
    id: "c-shop",
    status: "active",
    nonResidential: true,
    startDate: "2027-01-01",
    monthlyRent: 1200,
    paymentDueDay: 8,
  };
  const charge = createCharges([contract], [], "2027-02")[0];
  const summary = getChargeSummary(
    [contract],
    [{ ...charge, payments: [{ amount: 450, date: "2027-02-08" }] }],
    "2027-02",
    "2027-02-10",
  );

  assert.equal(charge.amount, 1200);
  assert.equal(charge.withholdingRate, 0.25);
  assert.equal(charge.withholdingAmount, 300);
  assert.equal(getChargeNetAmount(charge, contract), 900);
  assert.equal(getChargeWithholding(charge, contract), 300);
  assert.equal(summary.total, 900);
  assert.equal(summary.received, 450);
  assert.equal(summary.missing, 450);
  assert.equal(summary.collectionRate, 0.5);
  assert.equal(getChargeStatus({ ...charge, payments: [{ amount: 900 }] }, "2027-02-10", contract), "paid");
});

test("legacy charges use the non-residential net amount without rewriting payment history", () => {
  const contract = {
    id: "c-shop",
    status: "active",
    nonResidential: true,
    startDate: "2027-01-01",
    monthlyRent: 1200,
  };
  const charge = {
    id: "old-charge",
    contractId: contract.id,
    period: "2027-02",
    amount: 1200,
    dueDate: "2027-02-08",
    payments: [{ amount: 400, date: "2027-02-08" }],
  };
  const summary = getChargeSummary([contract], [charge], "2027-02", "2027-02-10");

  assert.equal(getChargeNetAmount(charge, contract), 900);
  assert.equal(summary.total, 900);
  assert.equal(summary.received, 400);
  assert.equal(summary.missing, 500);
  assert.deepEqual(charge.payments, [{ amount: 400, date: "2027-02-08" }]);
});

test("changing a contract's use recalculates charge retention without changing gross rent or payments", () => {
  const contract = { id: "c-shop", nonResidential: true };
  const original = {
    id: "charge-1",
    amount: 1200,
    payments: [{ amount: 500, date: "2027-02-08" }],
  };

  assert.deepEqual(updateChargeWithholding(original, contract), {
    ...original,
    withholdingRate: 0.25,
    withholdingAmount: 300,
    netAmount: 900,
  });
  assert.deepEqual(updateChargeWithholding({ ...original, withholdingRate: 0.25, withholdingAmount: 300, netAmount: 900 }, { nonResidential: false }), {
    ...original,
    withholdingRate: 0,
    withholdingAmount: 0,
    netAmount: 1200,
  });
});

test("rent due one month in advance is listed in the payment month", () => {
  const contract = {
    id: "c-linda-velha",
    status: "active",
    startDate: "2027-01-01",
    monthlyRent: 1000,
    paymentDueDay: 8,
    paymentAdvanceMonths: 1,
  };
  const januaryRent = createCharges([contract], [], "2027-01")[0];
  const decemberSummary = getChargeSummary(
    [contract],
    [januaryRent],
    "2026-12",
    "2026-12-01",
  );

  assert.equal(getChargeDueDate(contract, "2027-01"), "2026-12-08");
  assert.equal(januaryRent.period, "2027-01");
  assert.equal(decemberSummary.chargeCount, 1);
  assert.equal(decemberSummary.total, 1000);
  assert.equal(decemberSummary.missing, 1000);
});

test("rent due in the same month retains its normal due date", () => {
  const contract = {
    id: "c-aveiro",
    status: "active",
    startDate: "2027-01-01",
    monthlyRent: 800,
    paymentDueDay: 8,
    paymentAdvanceMonths: 0,
  };
  const januaryRent = createCharges([contract], [], "2027-01")[0];

  assert.equal(januaryRent.dueDate, "2027-01-08");
  assert.equal(getChargeSummary([contract], [januaryRent], "2027-01").total, 800);
});

test("reclassifying a rent month recomputes its due date and preserves payments", () => {
  const contract = { id: "c-1", paymentDueDay: 8, paymentAdvanceMonths: 1 };
  const charges = [{
    id: "charge-nov",
    contractId: "c-1",
    period: "2026-11",
    amount: 900,
    dueDate: "2026-11-08",
    payments: [{ amount: 900, date: "2026-11-12" }],
  }];

  const result = reclassifyChargePeriod(charges, contract, "charge-nov", "2026-12");

  assert.equal(result.merged, false);
  assert.equal(result.charges.length, 1);
  assert.equal(result.charges[0].period, "2026-12");
  assert.equal(result.charges[0].dueDate, "2026-11-08");
  assert.deepEqual(result.charges[0].payments, [{ amount: 900, date: "2026-11-12" }]);
  assert.equal(charges[0].period, "2026-11");
});

test("reclassifying merges compatible duplicate rent entries without duplicating payments", () => {
  const contract = { id: "c-1", paymentDueDay: 8, paymentAdvanceMonths: 1 };
  const sharedPayment = { amount: 900, date: "2026-11-12" };
  const charges = [
    { id: "charge-nov", contractId: "c-1", period: "2026-11", amount: 900, dueDate: "2026-11-08", payments: [sharedPayment] },
    { id: "charge-dec", contractId: "c-1", period: "2026-12", amount: 900, dueDate: "2026-12-08", payments: [sharedPayment] },
  ];

  const result = reclassifyChargePeriod(charges, contract, "charge-nov", "2026-12");

  assert.equal(result.merged, true);
  assert.equal(result.charges.length, 1);
  assert.equal(result.charges[0].id, "charge-dec");
  assert.equal(result.charges[0].period, "2026-12");
  assert.equal(result.charges[0].dueDate, "2026-11-08");
  assert.deepEqual(result.charges[0].payments, [sharedPayment]);
});

test("reclassifying refuses incompatible payment histories without changing data", () => {
  const contract = { id: "c-1", paymentDueDay: 8, paymentAdvanceMonths: 1 };
  const charges = [
    { id: "charge-nov", contractId: "c-1", period: "2026-11", amount: 900, dueDate: "2026-11-08", payments: [{ amount: 700, date: "2026-11-12" }] },
    { id: "charge-dec", contractId: "c-1", period: "2026-12", amount: 900, dueDate: "2026-11-08", payments: [{ amount: 200, date: "2026-11-12" }] },
  ];
  const original = JSON.stringify(charges);

  assert.throws(
    () => reclassifyChargePeriod(charges, contract, "charge-nov", "2026-12"),
    /históricos de pagamentos/,
  );
  assert.equal(JSON.stringify(charges), original);
});

test("rescheduling changes future due dates and preserves past dates and payments", () => {
  const contract = {
    id: "c-1",
    paymentDueDay: 8,
    paymentAdvanceMonths: 1,
  };
  const charges = [
    { id: "future", contractId: "c-1", period: "2027-01", dueDate: "2027-01-08", payments: [] },
    { id: "past", contractId: "c-1", period: "2026-11", dueDate: "2026-11-08", payments: [{ amount: 500 }] },
  ];
  const rescheduled = rescheduleFutureCharges(charges, contract, "2026-12-01");

  assert.equal(rescheduled[0].dueDate, "2026-12-08");
  assert.equal(rescheduled[1].dueDate, "2026-11-08");
  assert.deepEqual(rescheduled[1].payments, [{ amount: 500 }]);
});
