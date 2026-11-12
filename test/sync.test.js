import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyData,
  hasRecords,
  mergeSnapshots,
  normalizeData,
} from "../sync.js";
import { getChargeSummary } from "../domain.js";

test("a new account starts with an empty portfolio", () => {
  assert.deepEqual(emptyData(), { properties: [], contracts: [], charges: [] });
  assert.equal(hasRecords(emptyData()), false);
});

test("migration keeps identical records once and appends local-only records", () => {
  const shared = { id: "p-shared", name: "Partilhado" };
  const result = mergeSnapshots(
    { properties: [shared], contracts: [], charges: [] },
    { properties: [shared, { id: "p-local", name: "Local" }], contracts: [], charges: [] },
  );
  assert.deepEqual(result.data.properties, [shared, { id: "p-local", name: "Local" }]);
  assert.equal(result.conflicts, 0);
});

test("conflicting local records are preserved as copies with linked contracts and charges", () => {
  const result = mergeSnapshots(
    {
      properties: [{ id: "p-1", name: "Cloud" }],
      contracts: [{ id: "c-1", propertyId: "p-1", monthlyRent: 1000 }],
      charges: [{ id: "charge-1", contractId: "c-1", payments: [{ amount: 1000 }] }],
    },
    {
      properties: [{ id: "p-1", name: "Local" }],
      contracts: [{ id: "c-1", propertyId: "p-1", monthlyRent: 1200 }],
      charges: [{ id: "charge-1", contractId: "c-1", payments: [{ amount: 600 }] }],
    },
  );

  assert.equal(result.conflicts, 3);
  assert.equal(result.data.properties.find((record) => record.id === "p-1").name, "Cloud");
  assert.equal(result.data.properties.length, 2);

  const localContract = result.data.contracts.find((record) => record.monthlyRent === 1200);
  assert.ok(localContract);
  assert.notEqual(localContract.id, "c-1");
  assert.notEqual(localContract.propertyId, "p-1");
  assert.equal(result.data.properties.find((record) => record.id === localContract.propertyId).name, "Local");

  const localCharge = result.data.charges.find((record) => record.payments[0].amount === 600);
  assert.ok(localCharge);
  assert.equal(localCharge.contractId, localContract.id);
  assert.notEqual(localCharge.id, "charge-1");
});

test("legacy contracts receive default archive fields without changing existing records", () => {
  const legacy = {
    properties: [{ id: "p-1", name: "Casa" }],
    contracts: [{ id: "c-1", propertyId: "p-1" }],
    charges: [{ id: "charge-1", contractId: "c-1", payments: [{ amount: 500 }] }],
  };
  const normalized = normalizeData(legacy);

  assert.deepEqual(normalized.contracts[0], {
    id: "c-1",
    propertyId: "p-1",
    status: "active",
    statusBeforeArchive: null,
    archivedAt: null,
    nonResidential: false,
    paymentAdvanceMonths: 0,
  });
  assert.deepEqual(normalized.charges, legacy.charges);
  assert.deepEqual(normalized.properties, legacy.properties);
});

test("shop and office properties apply withholding to existing gross charges and preserve payments", () => {
  const legacy = {
    properties: [
      { id: "p-shop", type: "Loja" },
      { id: "p-office", type: "Escritório" },
    ],
    contracts: [
      { id: "c-shop", propertyId: "p-shop", status: "active", monthlyRent: 1200 },
      { id: "c-office", propertyId: "p-office", status: "active", monthlyRent: 800 },
    ],
    charges: [
      { id: "charge-shop", contractId: "c-shop", period: "2027-02", amount: 1200, dueDate: "2027-02-05", payments: [{ amount: 300 }] },
      { id: "charge-office", contractId: "c-office", period: "2027-02", amount: 800, dueDate: "2027-02-05", payments: [] },
    ],
  };
  const normalized = normalizeData(legacy);
  const summary = getChargeSummary(normalized.contracts, normalized.charges, "2027-02", "2027-02-10");

  assert.deepEqual(normalized.contracts.map((contract) => contract.nonResidential), [true, true]);
  assert.deepEqual(normalized.charges.map((charge) => [charge.amount, charge.withholdingAmount, charge.netAmount]), [
    [1200, 300, 900],
    [800, 200, 600],
  ]);
  assert.equal(summary.total, 1500);
  assert.equal(summary.received, 300);
  assert.equal(summary.missing, 1200);
  assert.deepEqual(normalized.charges[0].payments, legacy.charges[0].payments);
});
