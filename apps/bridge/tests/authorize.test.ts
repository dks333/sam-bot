import { describe, expect, it } from "vitest";

import { authorizeSlackIdentity } from "../src/slack/authorize.js";

const policy = {
  allowedChannelIds: new Set(["C_ALLOWED"]),
  allowedEnterpriseId: "E_ALLOWED",
  allowedTeamId: "T_ALLOWED",
  allowedUserId: "U_ALLOWED",
};

describe("authorizeSlackIdentity", () => {
  it("accepts only the exact immutable identity tuple", () => {
    expect(
      authorizeSlackIdentity(
        {
          channelId: "C_ALLOWED",
          enterpriseId: "E_ALLOWED",
          teamId: "T_ALLOWED",
          userId: "U_ALLOWED",
        },
        policy,
      ),
    ).toEqual({ authorized: true });
  });

  it("accepts any channel when the workspace-wide channel policy is configured", () => {
    expect(
      authorizeSlackIdentity(
        {
          channelId: "C_ANY_CHANNEL",
          enterpriseId: "E_ALLOWED",
          teamId: "T_ALLOWED",
          userId: "U_ALLOWED",
        },
        { ...policy, allowedChannelIds: new Set(["*"]) },
      ),
    ).toEqual({ authorized: true });
  });

  it.each([
    [
      "team",
      {
        channelId: "C_ALLOWED",
        enterpriseId: "E_ALLOWED",
        teamId: "T_OTHER",
        userId: "U_ALLOWED",
      },
    ],
    [
      "user",
      {
        channelId: "C_ALLOWED",
        enterpriseId: "E_ALLOWED",
        teamId: "T_ALLOWED",
        userId: "U_OTHER",
      },
    ],
    [
      "channel",
      {
        channelId: "C_OTHER",
        enterpriseId: "E_ALLOWED",
        teamId: "T_ALLOWED",
        userId: "U_ALLOWED",
      },
    ],
    [
      "enterprise",
      {
        channelId: "C_ALLOWED",
        enterpriseId: "E_OTHER",
        teamId: "T_ALLOWED",
        userId: "U_ALLOWED",
      },
    ],
  ])("rejects a mismatched %s", (reason, identity) => {
    expect(authorizeSlackIdentity(identity, policy)).toEqual({ authorized: false, reason });
  });

  it("allows a DM channel only after the immutable team, user, and enterprise checks", () => {
    expect(
      authorizeSlackIdentity(
        {
          channelId: "D_PRIVATE",
          enterpriseId: "E_ALLOWED",
          teamId: "T_ALLOWED",
          userId: "U_ALLOWED",
        },
        policy,
        { directMessage: true },
      ),
    ).toEqual({ authorized: true });
    expect(
      authorizeSlackIdentity(
        {
          channelId: "D_PRIVATE",
          enterpriseId: "E_ALLOWED",
          teamId: "T_ALLOWED",
          userId: "U_OTHER",
        },
        policy,
        { directMessage: true },
      ),
    ).toEqual({ authorized: false, reason: "user" });
  });
});
