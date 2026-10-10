import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildFinancePutBody } from "./payments.js";

describe("buildFinancePutBody", () => {
  const existing = {
    id: "fin-1",
    category: "RENT",
    payments: [{ id: "pay-1", bankTransactionId: "bank-1" }],
  };

  it("preserves payments when the patch omits them", () => {
    const body = buildFinancePutBody(
      existing,
      { category: "OTHER" },
      { clearPayments: false, transactionId: "fin-1" },
    );
    assert.deepEqual(body.payments, existing.payments);
    assert.equal(body.category, "OTHER");
  });

  it("keeps existing payments when patch sends an empty array", () => {
    const body = buildFinancePutBody(
      existing,
      { payments: [] },
      { clearPayments: false, transactionId: "fin-1" },
    );
    assert.deepEqual(body.payments, existing.payments);
  });

  it("clears payments only when clearPayments is true", () => {
    const body = buildFinancePutBody(
      existing,
      { category: "OTHER" },
      { clearPayments: true, transactionId: "fin-1" },
    );
    assert.deepEqual(body.payments, []);
  });
});
