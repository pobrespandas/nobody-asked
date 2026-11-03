import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  registrationControl,
  reserveRegistrationLease,
} from "./registration-controls.js";

describe("registration control serialization", () => {
  const at = new Date("2026-11-03T12:00:00.000Z");

  it("resets an ended window and removes leases at the expiry boundary", () => {
    const result = registrationControl(
      {
        count: 10,
        windowStartedAt: Timestamp.fromDate(new Date(at.getTime() - 600_000)),
        pending: [
          { id: "expired", expiresAt: Timestamp.fromDate(at) },
          {
            id: "current",
            expiresAt: Timestamp.fromDate(new Date(at.getTime() + 1)),
          },
        ],
      },
      at,
    );
    expect(result.bucket).toEqual({ count: 0, windowStartedAt: at });
    expect(result.pending.map((entry) => entry.id)).toEqual(["current"]);
  });

  it("reserves identical leases but adds TTL only for source controls", () => {
    const control = registrationControl(undefined, at);
    const expires = new Date(at.getTime() + 900_000);
    const global = reserveRegistrationLease(
      control,
      "registration",
      expires,
      false,
    );
    const source = reserveRegistrationLease(
      control,
      "registration",
      expires,
      true,
    );
    expect(global).not.toHaveProperty("expireAt");
    expect(source.expireAt?.toDate()).toEqual(expires);
    expect(source.pending).toEqual(global.pending);
    expect(global.count).toBe(1);
    expect(control.pending).toEqual([]);
    expect(
      reserveRegistrationLease(
        control,
        "short",
        new Date(at.getTime() + 1),
        true,
      ).expireAt?.toDate(),
    ).toEqual(new Date(at.getTime() + 600_000));
  });
});
