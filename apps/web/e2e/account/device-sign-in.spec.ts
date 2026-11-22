import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "../helpers/helpers";

test("signs a device in with the code it shows", async ({ page, request }, testInfo) => {
  await signup(page, `device-${Date.now()}@example.com`, "test-password-123", "Device owner");
  // The device asks for its code on its own, without the browser's cookies.
  const requested = await request.post("/api/auth/device/code", {
    data: { client_id: "e2e-device" },
  });
  expect(requested.ok()).toBe(true);
  const { user_code: userCode } = (await requested.json()) as { user_code: string };

  await page.goto("/device");
  await expect(page.getByRole("heading", { name: "Sign in a device" })).toBeVisible();
  await page.getByLabel("Code shown on the device").fill(userCode);
  await captureScreenshot(page, testInfo, "device-sign-in-code");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Sign in this device?" })).toBeVisible();
  await captureScreenshot(page, testInfo, "device-sign-in-confirm");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Device signed in" })).toBeVisible();
});
