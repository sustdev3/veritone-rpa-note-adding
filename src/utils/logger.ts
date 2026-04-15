import fs from "fs";
import path from "path";
import winston from "winston";

const logsDir = path.resolve("logs");

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(
    ({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`,
  ),
);

const logFilePath = path.join(logsDir, "rpa.log");

const logger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),
    new winston.transports.File({
      filename: logFilePath,
      format: logFormat,
    }),
  ],
});

// Clears the log file so each session contains only the current run's output.
export function resetLogFile(): void {
  fs.writeFileSync(logFilePath, "");
}

export default logger;
