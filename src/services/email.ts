import nodemailer from "nodemailer";
import logger from "../utils/logger";

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
