import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertPeriodFieldsPreserved,
  assertRentCreateHasPeriod,
  assertUnitBookingHasPeriodOrCategory,
  buildFinancePutBody,
  looksLikeRentTransaction,
} from "./payments.js";

describe("buildFinancePutBody", () => {
  const existing = {
    id: "fin-1",
    category: "RENT",
    subject: "Miete 8/2026",
    amount: 550,
    correspondingMonth: 7,
    correspondingYear: 2026,
    transactionDate: "2026-08-01",
    dueDate: "2026-08-01",
    assignedContactId: "contact-1",
    senderName: "Felix Hettwer",
    payments: [{ id: "pay-1", bankTransactionId: "bank-1" }],
  };

  it("preserves payments when the patch omits them", () => {
    const body = buildFinancePutBody(
      existing,
      { markAsPaid: true },
      { clearPayments: false, transactionId: "fin-1" },
    );
    assert.deepEqual(body.payments, existing.payments);
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
      { markAsPaid: true },
      { clearPayments: true, transactionId: "fin-1" },
    );
    assert.deepEqual(body.payments, []);
  });

  it("merges identity fields so partial markAsPaid keeps month/date/contact", () => {
    const body = buildFinancePutBody(
      existing,
      { markAsPaid: true, paymentState: "PAID", openAmount: 0 },
      { clearPayments: false, transactionId: "fin-1" },
    );
    assert.equal(body.correspondingMonth, 7);
    assert.equal(body.correspondingYear, 2026);
    assert.equal(body.transactionDate, "2026-08-01");
    assert.equal(body.dueDate, "2026-08-01");
    assert.equal(body.assignedContactId, "contact-1");
    assert.equal(body.senderName, "Felix Hettwer");
    assert.equal(body.amount, 550);
    assert.equal(body.subject, "Miete 8/2026");
    assert.equal(body.markAsPaid, true);
    assert.equal(body.paymentState, "PAID");
  });

  it("allows intentional period changes when a new value is provided", () => {
    const body = buildFinancePutBody(
      existing,
      { correspondingMonth: 8, subject: "Miete 9/2026" },
      { clearPayments: false, transactionId: "fin-1" },
    );
    assert.equal(body.correspondingMonth, 8);
    assert.equal(body.subject, "Miete 9/2026");
    assert.equal(body.correspondingYear, 2026);
  });

  it("refuses clearing correspondingMonth/date without clearPeriodFields", () => {
    assert.throws(
      () =>
        buildFinancePutBody(
          existing,
          {
            correspondingMonth: null,
            correspondingYear: null,
            transactionDate: null,
          },
          { clearPayments: false, transactionId: "fin-1" },
        ),
      /clearPeriodFields=true/,
    );
  });

  it("allows clearing period fields when clearPeriodFields is true", () => {
    const body = buildFinancePutBody(
      existing,
      {
        correspondingMonth: null,
        correspondingYear: null,
        transactionDate: "2099-01-01",
        subject: "ZZZ Dublette",
      },
      {
        clearPayments: false,
        transactionId: "fin-1",
        clearPeriodFields: true,
      },
    );
    assert.equal(body.correspondingMonth, null);
    assert.equal(body.correspondingYear, null);
    assert.equal(body.transactionDate, "2099-01-01");
  });

  it("skips identity merge for bank-assign style patches", () => {
    const body = buildFinancePutBody(
      existing,
      { financeTransactionIds: ["rent-1"] },
      {
        clearPayments: false,
        transactionId: "fin-1",
        mergeIdentity: false,
      },
    );
    assert.deepEqual(body.financeTransactionIds, ["rent-1"]);
    assert.equal(body.correspondingMonth, undefined);
    assert.deepEqual(body.payments, existing.payments);
  });
});

describe("looksLikeRentTransaction / create guard", () => {
  it("detects Miete subjects", () => {
    assert.equal(
      looksLikeRentTransaction({ subject: "Miete 8/2026" }),
      true,
    );
  });

  it("detects RENT_COST category type", () => {
    assert.equal(
      looksLikeRentTransaction({
        subject: "Kaltmiete",
        costCategory: { categoryType: "RENT_COST", name: "Kaltmiete" },
      }),
      true,
    );
  });

  it("requires month/year on rent creates", () => {
    assert.throws(
      () =>
        assertRentCreateHasPeriod({
          subject: "Miete 8/2026",
          amount: 550,
        }),
      /correspondingMonth/,
    );
    assert.doesNotThrow(() =>
      assertRentCreateHasPeriod({
        subject: "Miete 8/2026",
        amount: 550,
        correspondingMonth: 7,
        correspondingYear: 2026,
      }),
    );
  });

  it("does not require period on non-rent creates", () => {
    assert.doesNotThrow(() =>
      assertRentCreateHasPeriod({
        subject: "Hausgeld Bewirtschaftung",
        amount: -100,
      }),
    );
  });

  it("refuses unit bookings without category or period", () => {
    assert.throws(
      () =>
        assertUnitBookingHasPeriodOrCategory({
          unitId: "unit-1",
        }),
      /assign_bank_to_finance/,
    );
    assert.doesNotThrow(() =>
      assertUnitBookingHasPeriodOrCategory({
        unitId: "unit-1",
        costCategoryId: "cat-1",
      }),
    );
    assert.doesNotThrow(() =>
      assertUnitBookingHasPeriodOrCategory({
        unitId: "unit-1",
        correspondingMonth: 7,
        correspondingYear: 2026,
      }),
    );
  });
});

describe("assertPeriodFieldsPreserved", () => {
  it("flags dropped rent period after update", () => {
    assert.throws(
      () =>
        assertPeriodFieldsPreserved(
          {
            subject: "Miete 8/2026",
            correspondingMonth: 7,
            correspondingYear: 2026,
            transactionDate: "2026-08-01",
          },
          {
            subject: "Miete 8/2026",
            correspondingMonth: null,
            correspondingYear: null,
            transactionDate: null,
          },
          { clearPeriodFields: false },
        ),
      /dropped rent\/period/,
    );
  });
});
