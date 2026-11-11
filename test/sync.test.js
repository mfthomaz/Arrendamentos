import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyData,
  hasRecords,
  mergeSnapshots,
  normalizeData,
} from "../sync.js";

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
  });
  assert.deepEqual(normalized.charges, legacy.charges);
  assert.deepEqual(normalized.properties, legacy.properties);
});
