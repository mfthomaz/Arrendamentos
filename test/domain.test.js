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
  getUpcomingEvents,
  restoreContract,
  updateChargeWithholding,
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
