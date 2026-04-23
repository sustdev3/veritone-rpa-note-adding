import { Page } from "playwright";
import logger from "../utils/logger";
import { randomDelay } from "../utils/shared/shared";

const LOGIN_URL = "https://www.adcourier.com/login.cgi?redirect=%3F";
const LOGIN_SUCCESS_PATTERN = /adcourier\.com\/?$/i;

export async function login(page: Page): Promise<void> {
  const username = process.env.ADCOURIER_EMAIL;
  const password = process.env.ADCOURIER_PASSWORD;

  if (!username)
    throw new Error("Missing required environment variable: ADCOURIER_EMAIL");
  if (!password)
    throw new Error(
      "Missing required environment variable: ADCOURIER_PASSWORD",
    );

  logger.info("Navigating to login page...");
  await page.goto(LOGIN_URL);
  await randomDelay();

  logger.info("Filling in username...");
  await page.locator('input[name="username"]').clear();
  await page
    .locator('input[name="username"]')
    .pressSequentially(username, { delay: 80 });

  logger.info("Filling in password...");
  await page.locator('input[name="password"]').clear();
  await page
    .locator('input[name="password"]')
    .pressSequentially(password, { delay: 80 });

  logger.info("Submitting login form...");
  await page.click("button#submit_button");
  await randomDelay();

  logger.info("Waiting for successful login redirect...");
  try {
    await page.waitForURL(LOGIN_SUCCESS_PATTERN, { timeout: 15000 });
  } catch {
    throw new Error(
      `Login failed or timed out after ${15000 / 1000}s — check credentials or login form selectors.`,
    );
  }

  logger.info("Login successful.");
}
