import { describe, expect, it } from "vitest";
import { readPlatformConfig } from "./config.js";

const APP = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_SLUG: "commitcost",
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "shh",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
};

describe("readPlatformConfig", () => {
  it("defaults to local mode in development", () => {
    const c = readPlatformConfig({});
    expect(c.authMode).toBe("local");
    expect(c.github).toBeNull();
    expect(c.appUrl).toBe("http://localhost:3000");
    expect(c.sync).toEqual({ intervalHours: 6, days: 90 });
  });

  it("refuses local mode in production unless opted in", () => {
    expect(() => readPlatformConfig({ NODE_ENV: "production" })).toThrow(/Sign-in is not configured/);
    expect(readPlatformConfig({ NODE_ENV: "production", COMMITCOST_ALLOW_LOCAL_MODE: "1" }).authMode).toBe("local");
  });

  it("reads a complete GitHub App and unescapes the key", () => {
    const c = readPlatformConfig({ ...APP, COMMITCOST_URL: "https://cc.example.com/" });
    expect(c.authMode).toBe("github");
    expect(c.appUrl).toBe("https://cc.example.com");
    expect(c.github?.privateKey).toContain("\nabc\n");
    expect(c.github?.apiUrl).toBe("https://api.github.com");
  });

  it("lists every missing App setting without echoing values", () => {
    let message = "";
    try {
      readPlatformConfig({ GITHUB_APP_ID: "123", GITHUB_APP_CLIENT_SECRET: "super-secret-value" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/GITHUB_APP_SLUG[\s\S]*GITHUB_APP_CLIENT_ID[\s\S]*GITHUB_APP_PRIVATE_KEY/);
    expect(message).not.toContain("super-secret-value");
  });

  it("requires a strong secret in production", () => {
    expect(() => readPlatformConfig({ ...APP, NODE_ENV: "production" })).toThrow(/COMMITCOST_SECRET/);
    expect(readPlatformConfig({ ...APP, NODE_ENV: "production", COMMITCOST_SECRET: "s".repeat(32) }).secret).toBe("s".repeat(32));
  });

  it("validates the AWS principal", () => {
    expect(() => readPlatformConfig({ COMMITCOST_AWS_PRINCIPAL_ARN: "nope" })).toThrow(/PRINCIPAL_ARN/);
    expect(readPlatformConfig({ COMMITCOST_AWS_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/commitcost" }).aws.principalArn).toBe("arn:aws:iam::111122223333:role/commitcost");
  });
});
