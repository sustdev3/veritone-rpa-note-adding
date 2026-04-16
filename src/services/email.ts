import nodemailer from "nodemailer";
import logger from "../utils/logger";
import { AdvertRunResult } from "../orchestration/candidate-processesor";

export async function sendErrorEmail(
  subject: string,
  body: string,
): Promise<void> {
  try {
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;

    if (!emailUser || !emailPass) {
      logger.warn(
        "Email credentials not configured. Skipping error notification.",
      );
      return;
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: emailUser,
        pass: emailPass,
      },
    });

    await transporter.sendMail({
      from: emailUser,
      to: "sustdev3@gmail.com",
      subject,
      text: body,
    });

    logger.info(`Error email sent successfully. Subject: ${subject}`);
  } catch (error) {
    logger.error(`Failed to send error email: ${(error as Error).message}`);
  }
}

export async function sendSuccessReportEmail(advertResults: AdvertRunResult[]): Promise<void> {
  try {
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;

    if (!emailUser || !emailPass) {
      logger.warn("Email credentials not configured. Skipping run report notification.");
      return;
    }

    const dateStr = new Date().toLocaleDateString("en-AU", {
      timeZone: "Australia/Sydney",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    const totalCandidates = advertResults.reduce((sum, r) => sum + r.candidatesProcessed, 0);
    const advertCount = advertResults.length;
    const subject = `RPA Run Report — ${dateStr} (${advertCount} advert${advertCount !== 1 ? "s" : ""} processed)`;

    const tableRows = advertResults.length > 0
      ? advertResults
          .map(
            r => `
        <tr>
          <td style="padding:8px 12px;border:1px solid #ddd;">${dateStr}</td>
          <td style="padding:8px 12px;border:1px solid #ddd;">${r.adrefNo}</td>
          <td style="padding:8px 12px;border:1px solid #ddd;">${r.advertTitle}</td>
          <td style="padding:8px 12px;border:1px solid #ddd;text-align:center;">${r.candidatesProcessed}</td>
        </tr>`,
          )
          .join("")
      : `<tr><td colspan="4" style="padding:8px 12px;border:1px solid #ddd;text-align:center;color:#888;">No adverts processed</td></tr>`;

    const html = `
      <html><body style="font-family:Arial,sans-serif;color:#333;">
        <h2 style="margin-bottom:16px;">RPA Run Report — ${dateStr}</h2>
        <table style="border-collapse:collapse;width:100%;max-width:700px;">
          <thead>
            <tr style="background:#f0f0f0;">
              <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Date</th>
              <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Reference Number</th>
              <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Advert Title</th>
              <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Candidates Processed</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
        <p style="margin-top:16px;color:#555;">${totalCandidates} candidate${totalCandidates !== 1 ? "s" : ""} processed across ${advertCount} advert${advertCount !== 1 ? "s" : ""}.</p>
      </body></html>`;

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: emailUser, pass: emailPass },
    });

    await transporter.sendMail({
      from: emailUser,
      to: "sustdev3@gmail.com",
      subject,
      html,
    });

    logger.info(`Run report email sent successfully. Subject: ${subject}`);
  } catch (error) {
    logger.error(`Failed to send run report email: ${(error as Error).message}`);
  }
}
