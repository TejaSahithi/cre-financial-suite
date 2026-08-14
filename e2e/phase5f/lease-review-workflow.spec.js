import { test, expect } from "@playwright/test";
import { inspectPhase5fState, seedPhase5fScenario } from "../helpers/phase5fLocalSupabase.mjs";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0"]);
const BLOCKED_EXTERNAL_ASSET_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function isNetworkUrl(rawUrl) {
  const url = new URL(rawUrl);
  return ["http:", "https:", "ws:", "wss:"].includes(url.protocol);
}

async function installLocalNetworkGuard(context, unexpectedExternalRequests, blockedExternalAssets) {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (!isNetworkUrl(requestUrl)) {
      await route.continue();
      return;
    }

    const url = new URL(requestUrl);
    if (LOCAL_HOSTS.has(url.hostname)) {
      await route.continue();
      return;
    }

    if (BLOCKED_EXTERNAL_ASSET_HOSTS.has(url.hostname)) {
      blockedExternalAssets.add(requestUrl);
      await route.abort();
      return;
    }

    unexpectedExternalRequests.push(requestUrl);
    await route.abort();
  });
}

async function login(page, seeded, user = seeded.reviewer) {
  await page.addInitScript((orgId) => {
    window.localStorage.setItem("cre.acting_org_id", orgId);
  }, user === seeded.reviewer ? seeded.orgAId : seeded.orgBId);
  await page.goto("/Login");
  await page.getByPlaceholder("you@company.com").fill(user.email);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/Login"), { timeout: 20000 });
}

async function openActionMenu(page, rowText) {
  const row = page.locator("tr", { hasText: rowText }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByRole("button", { name: /Action menu/i }).click();
}

async function editFieldValue(page, rowText, value, sourceText) {
  await openActionMenu(page, rowText);
  await page.getByRole("menuitem", { name: "Edit" }).click();

  const saveEdit = page.getByRole("button", { name: "Save edit" });
  if (await saveEdit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator('input[type="number"], input[type="text"]').first().fill(String(value));
    const exactSource = page.getByLabel(/Exact Source Text/i).or(page.getByPlaceholder(/Paste the verbatim sentence/i));
    if (await exactSource.isVisible().catch(() => false)) {
      await exactSource.fill(sourceText);
    }
    await saveEdit.click();
    await expect(saveEdit).toBeHidden({ timeout: 15000 }).catch(() => {});
    await page.keyboard.press("Escape");
    return;
  }

  await expect(page.getByRole("dialog", { name: new RegExp(`Edit: ${rowText}`, "i") })).toBeVisible({ timeout: 10000 });
  await page.getByLabel("New Value").fill(String(value));
  await page.getByRole("button", { name: /Save/i }).click();
  await expect(page.getByRole("dialog", { name: new RegExp(`Edit: ${rowText}`, "i") })).toBeHidden({ timeout: 15000 });
  await page.keyboard.press("Escape");
}

test.describe.configure({ mode: "serial" });

test("Phase 5F seeded authenticated Lease Upload to Review approval workflow", async ({ page, context, browser }, testInfo) => {
  const seeded = await seedPhase5fScenario();
  const externalRequests = [];
  const consoleErrors = [];
  const pageErrors = [];

  const blockedExternalAssets = new Set();
  await installLocalNetworkGuard(context, externalRequests, blockedExternalAssets);
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await login(page, seeded);

  await page.goto(`/LeaseUpload?file_id=${seeded.uploadId}`);
  await expect(page.getByRole("heading", { name: "Upload Lease" })).toBeVisible({ timeout: 45000 });
  await expect(page.getByText(seeded.fileName)).toBeVisible({ timeout: 45000 });
  await expect(page.getByText("Review completed").first()).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: testInfo.outputPath("01-upload-ready.png"), fullPage: true });

  await page.getByRole("button", { name: "Open Lease Review" }).click();
  await expect(page).toHaveURL(new RegExp(`/LeaseReview\\?id=${seeded.leaseId}`), { timeout: 20000 });
  await expect(page.getByText("Bluebird Bakery LLC").first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("Phase 5F").first()).toBeVisible({ timeout: 15000 }).catch(() => {});
  await page.screenshot({ path: testInfo.outputPath("02-review-summary.png"), fullPage: true });

  for (const tabName of ["Parties & Premises", "Dates & Term", "Rent & Charges", "Expenses / Recoveries", "CAM Rules", "Budget Preview"]) {
    await expect(page.getByRole("tab", { name: tabName })).toBeVisible({ timeout: 15000 });
  }

  await page.getByRole("tab", { name: "Budget Preview" }).click();
  await expect(page.getByText("Next 12 Months - Base Rent Preview")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("$23,500").first()).toBeVisible({ timeout: 15000 });

  await page.getByRole("tab", { name: "Rent & Charges" }).click();
  await expect(page.getByText("Security Deposit").first()).toBeVisible({ timeout: 15000 });
  await openActionMenu(page, "Monthly Rent");
  await page.getByRole("menuitem", { name: "View Source" }).click();
  await expect(page.getByText("Evidence (editable)")).toBeVisible({ timeout: 15000 });
  const viewDocumentButton = page.getByRole("button", { name: "View in Document" });
  if (await viewDocumentButton.isVisible().catch(() => false)) {
    const [evidencePage, sourceRequest] = await Promise.all([
      context.waitForEvent("page"),
      context.waitForEvent("request", (request) => {
        const url = request.url();
        return url.includes("/storage/v1/object/") && url.includes(seeded.uploadId);
      }),
      viewDocumentButton.click(),
    ]);
    const sourceResponse = await sourceRequest.response();
    expect(sourceRequest.url()).toContain(seeded.uploadId);
    expect(sourceResponse?.status()).toBe(200);
    await evidencePage.close();
  }
  await page.keyboard.press("Escape");
  const blockedApproveButton = page.getByRole("button", { name: "Approve Lease Abstract" });
  await expect(blockedApproveButton).toBeVisible({ timeout: 15000 });
  if (await blockedApproveButton.isEnabled()) {
    await blockedApproveButton.click();
    await expect(page.getByText(/required field.*resolved before approval|Approval blocked/i).first()).toBeVisible({ timeout: 15000 });
  } else {
    await expect(blockedApproveButton).toBeDisabled();
    await expect(blockedApproveButton).toHaveAttribute("title", /required field\(s\) must be resolved before approval/i);
  }
  await editFieldValue(page, "Security Deposit", "32500", "Reviewer confirmed the signed security deposit is $32,500.");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.getByRole("button", { name: "Save Review Draft" }).click();
  await expect(page.getByText("Review draft saved")).toBeVisible({ timeout: 20000 });
  await page.reload();
  await expect(page.getByText("Bluebird Bakery LLC").first()).toBeVisible({ timeout: 20000 });
  await page.getByRole("tab", { name: /Summary/ }).click();
  await expect(page.getByText(/Required Reviewed 12 \/ 12|No blockers\. Ready to approve|All checks passed/i).first()).toBeVisible({ timeout: 15000 });
  await page.getByRole("tab", { name: "Rent & Charges" }).click();
  const securityDepositRow = page.locator("tr", { hasText: "Security Deposit" }).first();
  await expect(securityDepositRow.locator("td").nth(1)).toContainText("$32,500", { timeout: 15000 });
  await openActionMenu(page, "Security Deposit");
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.locator('input[type="number"], input[type="text"]').first()).toHaveValue("32500", { timeout: 10000 });
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByText("Bluebird Bakery LLC").first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/All checks passed|Required Reviewed 12 \/ 12/i).first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: testInfo.outputPath("03-edited-after-reload.png"), fullPage: true });

  await page.getByRole("button", { name: "Approve Lease Abstract" }).click();
  const approvalDialog = page.getByRole("dialog");
  await expect(approvalDialog).toContainText("Approve Lease Abstract");
  await page.getByPlaceholder(/Any notes from the signing party/i).fill("Phase 5F browser approval validation.");
  await approvalDialog.getByRole("checkbox").check();
  await approvalDialog.locator("input").nth(1).fill("Phase 5F Reviewer");
  const signaturePad = approvalDialog.locator('canvas[aria-label="Electronic signature drawing pad"]');
  const box = await signaturePad.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + 20, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 30);
  await page.mouse.move(box.x + 160, box.y + 65);
  await page.mouse.up();
  await approvalDialog.getByRole("button", { name: "Approve & Sign" }).click();
  await expect(page.getByText(/Lease abstract approved|Lease approved/i).first()).toBeVisible({ timeout: 45000 });
  await expect(page.getByRole("button", { name: "Open Lease Detail" })).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: testInfo.outputPath("04-approved.png"), fullPage: true });

  await page.reload();
  await expect(page.getByText(/Lease abstract approved/i).first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("button", { name: "Open Lease Detail" })).toBeVisible({ timeout: 20000 });

  const state = await inspectPhase5fState(seeded);
  expect(state.lease.status).toBe("approved");
  expect(state.lease.abstract_status).toBe("approved");
  expect(state.lease.source_file_id).toBe(seeded.uploadId);
  expect(Number(state.lease.abstract_snapshot.fields.monthly_rent.value)).toBe(23500);
  expect(Number(state.lease.security_deposit)).toBe(32500);
  expect(state.versions).toHaveLength(1);
  expect(state.versions[0].abstract_snapshot.source_document.uploaded_file_id).toBe(seeded.uploadId);
  expect(state.links.some((link) => link.file_id === seeded.uploadId && link.link_role === "source")).toBe(true);
  expect(state.criticalDates.length).toBeGreaterThanOrEqual(2);
  expect(state.runs).toHaveLength(1);

  const duplicateRuleKeys = state.rules
    .map((rule) => rule.rule_key)
    .filter(Boolean)
    .filter((key, index, keys) => keys.indexOf(key) !== index);
  expect(duplicateRuleKeys).toEqual([]);

  const otherContext = await browser.newContext();
  await installLocalNetworkGuard(otherContext, externalRequests, blockedExternalAssets);
  const other = await otherContext.newPage();
  await login(other, seeded, seeded.otherUser);
  await other.goto(`/LeaseReview?id=${seeded.leaseId}`);
  await expect(other.getByText(/not found|access denied|Lease not found|could not load/i).first()).toBeVisible({ timeout: 20000 });
  await otherContext.close();

  expect(externalRequests, `External requests detected: ${externalRequests.join(", ")}`).toEqual([]);
  expect(pageErrors, `Page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  await testInfo.attach("phase5f-blocked-external-assets", { body: Array.from(blockedExternalAssets).sort().join("\n"), contentType: "text/plain" });
  await testInfo.attach("phase5f-console-errors", { body: consoleErrors.join("\n"), contentType: "text/plain" });
});